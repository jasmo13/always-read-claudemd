import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin, PinnedFile } from '../types'

const PLUGIN = 'always-read-claudemd'
const SECTION_ID = `${PLUGIN}:claudemd`
// The most often the files are re-checked; each check is a few stats.
const THROTTLE_MS = 1000
// Where a project-level instruction file can appear, in every directory from
// the filesystem root down to the working directory.
const PROJECT_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']

const EMPTY: Pin = { files: [], raw: null, source: null }
const pinAtom = atom({ plugin: 'always-read-claudemd', key: 'pin' } as const, EMPTY)
const checkedAtom = atom({ plugin: 'always-read-claudemd', key: 'checkedAt' } as const, null)

const LABELS: Record<string, string> = {
  managed: "organization's managed policy",
  user: "user's private global instructions for all projects",
  project: 'project instructions, checked into the codebase',
  local: "user's private project instructions, not checked in",
  memory: "user's auto-memory, persists across conversations",
}

const HEADER = [
  '# CLAUDE.md (pinned)',
  '',
  "These are the user's CLAUDE.md instructions. They are pinned in the system prompt, so they stay in force for the whole session, including after the conversation is compacted or summarized, and they are re-synced from disk whenever the files change.",
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
].join('\n')

const COMPACT_NOTE =
  "The user's CLAUDE.md instructions are pinned in the system prompt and remain in force after this compaction. In the summary, keep every user decision, correction or exception about those instructions, verbatim where possible; do not paraphrase, weaken or drop them."

// Mirrors whether anything is pinned, for the synchronous compaction hook.
let isPinned = false

const keyOf = (path: string) => path.replace(/\\/g, '/').toLowerCase()

async function mtimeOf($: EngineInterface, path: string): Promise<number | undefined> {
  return (await $.fs.stat(path).catch(() => undefined))?.mtimeMs
}

/** The pinned text the model reads, or null when there is nothing to pin. */
export function render(pin: Pin): string | null {
  const body =
    pin.source === 'raw'
      ? (pin.raw ?? '').trim()
      : pin.files
          .filter(f => f.content.trim() !== '')
          .map(f => `Contents of ${f.path} (${LABELS[f.kind] ?? f.kind}):\n\n${f.content.trim()}`)
          .join('\n\n')

  return body === '' ? null : `${HEADER}\n\n${body}`
}

/** The instruction files on disk where new ones can appear: user-level and the project's ancestors. */
async function discover($: EngineInterface): Promise<PinnedFile[]> {
  const found: PinnedFile[] = []

  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const userDir = configDir ?? (home === undefined ? undefined : `${home.replace(/[\\/]$/, '')}/.claude`)
  if (userDir !== undefined) {
    const path = `${userDir}/CLAUDE.md`
    const mtimeMs = await mtimeOf($, path)
    const content = mtimeMs === undefined ? undefined : await $.fs.read(path).catch(() => undefined)
    if (mtimeMs !== undefined && typeof content === 'string') {
      found.push({ path, kind: 'user', content, mtimeMs })
    }
  }

  const ancestors = await $.fs.ancestors({ names: PROJECT_NAMES }).catch(() => [])
  for (const entry of ancestors) {
    const kind = entry.name === 'CLAUDE.local.md' ? 'local' : 'project'
    for (const part of entry.parts) {
      found.push({ path: part.path, kind, content: part.content, mtimeMs: (await mtimeOf($, part.path)) ?? -1 })
    }
  }

  return found
}

function report($: EngineInterface, pin: Pin) {
  const count = pin.source === 'raw' ? Math.max(1, pin.files.length) : pin.files.length
  $.ui.status(count === 0 ? 'CLAUDE.md: none found' : `CLAUDE.md pinned · ${count} file${count === 1 ? '' : 's'}`)
}

/**
 * Re-checks the pinned files against disk: re-reads any whose mtime moved,
 * drops deleted ones, and adds new ones. At most once per THROTTLE_MS.
 */
export async function sync($: EngineInterface, options: { force?: boolean } = {}): Promise<void> {
  const now = await $.clock.now()
  const last = await read($, checkedAtom)
  if (options.force !== true && last !== null && now - last < THROTTLE_MS) return
  await update($, checkedAtom, () => now)

  const pin = await read($, pinAtom)
  isPinned = render(pin) !== null

  let hasChanged = false
  const files: PinnedFile[] = []
  for (const file of pin.files) {
    const mtimeMs = await mtimeOf($, file.path)
    if (mtimeMs === undefined) {
      hasChanged = true // deleted
      continue
    }
    if (mtimeMs === file.mtimeMs) {
      files.push(file)
      continue
    }
    const content = await $.fs.read(file.path).catch(() => undefined)
    if (typeof content !== 'string') {
      hasChanged = true
      continue
    }
    hasChanged ||= content !== file.content
    files.push({ ...file, content, mtimeMs })
  }

  const known = new Set(files.map(f => keyOf(f.path)))
  for (const file of await discover($)) {
    if (known.has(keyOf(file.path))) continue
    known.add(keyOf(file.path))
    files.push(file)
    hasChanged = true
  }

  if (!hasChanged && pin.source !== null) return

  // Raw text can't be patched per file: once the disk moves, pin what is on disk.
  const next: Pin = { files, raw: null, source: pin.source === 'engine' ? 'engine' : 'discovered' }
  await update($, pinAtom, () => next)
  isPinned = render(next) !== null
  report($, next)
  if (hasChanged && pin.source !== null) $.ui.toast('CLAUDE.md changed: re-pinned')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await sync($, { force: true }).catch(() => undefined)

    return started
  })

  // Capture the engine's own CLAUDE.md block (every tier, @imports resolved)
  // and take it out of the first user message: it lives in the system prompt.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const block = context.blocks.find(b => b.name === 'claudeMd')
    // No block (none on disk, or a subagent that omits it): leave the pin as is;
    // sync notices deletions by itself.
    if (block === undefined || block.text.trim() === '') return context

    const pin: Pin =
      context.instructionFiles === undefined || context.instructionFiles.length === 0
        ? // Another plugin rewrote the text: pin it as is, and watch what is on disk.
          { files: await discover($), raw: block.text, source: 'raw' }
        : {
            files: await Promise.all(
              context.instructionFiles.map(async f => ({
                path: f.path,
                kind: f.kind,
                content: f.content,
                mtimeMs: (await mtimeOf($, f.path)) ?? -1,
              })),
            ),
            raw: null,
            source: 'engine',
          }
    await update($, pinAtom, () => pin)
    isPinned = render(pin) !== null
    report($, pin)

    return { blocks: context.blocks.filter(b => b !== block) }
  })

  // Every model request: re-sync from disk, then pin the text last in the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare')) return composed

    await sync($).catch(() => undefined)
    const text = render(await read($, pinAtom))
    if (text === null) return composed

    return {
      sections: [
        ...composed.sections.filter(s => s.id !== SECTION_ID),
        { id: SECTION_ID, text, scope: 'session' as const },
      ],
    }
  })

  // Tell the summarizer the rules stay in force, after any instructions typed after /compact.
  // Synchronous on purpose: nothing here can fail and hold up a compaction.
  on('session.compact', ($, e, next) => {
    if (!isPinned) return next(e)

    return next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${COMPACT_NOTE}` : COMPACT_NOTE })
  })
}
