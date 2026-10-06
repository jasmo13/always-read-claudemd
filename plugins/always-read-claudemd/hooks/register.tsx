import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin, PinnedFile } from '../types'
import {
  FILE_TOOLS,
  PROJECT_NAMES,
  SECTION_ID,
  THROTTLE_MS,
  TIERS,
  UNPIN_AFTER,
  countOf,
  displayPath,
  formatTokens,
  isAbsolute,
  isInside,
  keyOf,
  messagesLeft,
  pathsOf,
  render,
  tokensOf,
} from './pin'

const PANE = 'always-read-claudemd'
const COMMAND = 'claudemd'
const BAND_KEY = 'isBandShown'

const EMPTY: Pin = { files: [], raw: null, source: null }
const pinAtom = atom({ plugin: 'always-read-claudemd', key: 'pin' } as const, EMPTY)
const checkedAtom = atom({ plugin: 'always-read-claudemd', key: 'checkedAt' } as const, null)
const turnAtom = atom({ plugin: 'always-read-claudemd', key: 'turn' } as const, 0)
const changeAtom = atom({ plugin: 'always-read-claudemd', key: 'lastChange' } as const, null)
const bandAtom = atom({ plugin: 'always-read-claudemd', key: 'isBandShown' } as const, true)

const COMPACT_NOTE =
  "The user's CLAUDE.md instructions are pinned in the system prompt and remain in force after this compaction. In the summary, keep every user decision, correction or exception about those instructions, verbatim where possible; do not paraphrase, weaken or drop them."

// Mirrors whether anything is pinned, for the synchronous compaction hook.
let isPinned = false

async function mtimeOf($: EngineInterface, path: string): Promise<number | undefined> {
  return (await $.fs.stat(path).catch(() => undefined))?.mtimeMs
}

async function homeOf($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
}

async function placesOf($: EngineInterface) {
  return { root: await $.session.root().catch(() => undefined), home: await homeOf($).catch(() => undefined) }
}

/** The instruction files on disk where new ones can appear: user-level and the project's ancestors. */
async function discover($: EngineInterface): Promise<PinnedFile[]> {
  const found: PinnedFile[] = []

  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await homeOf($)
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
  const count = countOf(pin)
  $.ui.status(count === 0 ? 'CLAUDE.md: none found' : `CLAUDE.md pinned · ${count} file${count === 1 ? '' : 's'}`)
}

/** Stores a new pin and says so: status line, compaction flag, and the pane's last change. */
async function settle($: EngineInterface, pin: Pin, change?: string) {
  await update($, pinAtom, () => pin)
  isPinned = render(pin) !== null
  report($, pin)
  if (change !== undefined) {
    const turn = await read($, turnAtom)
    await update($, changeAtom, () => ({ text: change, turn }))
  }
}

const describe = (verb: string, paths: string[], places: { root?: string; home?: string }) =>
  `${verb} ${paths.map(p => displayPath(p, places)).join(', ')}`

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

  const edited: string[] = []
  const removed: string[] = []
  const added: string[] = []
  const files: PinnedFile[] = []
  for (const file of pin.files) {
    const mtimeMs = await mtimeOf($, file.path)
    if (mtimeMs === undefined) {
      removed.push(file.path)
      continue
    }
    if (mtimeMs === file.mtimeMs) {
      files.push(file)
      continue
    }
    const content = await $.fs.read(file.path).catch(() => undefined)
    if (typeof content !== 'string') {
      removed.push(file.path)
      continue
    }
    if (content !== file.content) edited.push(file.path)
    files.push({ ...file, content, mtimeMs })
  }

  const known = new Set(files.map(f => keyOf(f.path)))
  for (const file of await discover($)) {
    if (known.has(keyOf(file.path))) continue
    known.add(keyOf(file.path))
    files.push(file)
    added.push(file.path)
  }

  const hasChanged = edited.length + removed.length + added.length > 0
  if (!hasChanged && pin.source !== null) return

  const places = await placesOf($)
  const change = [
    ...(edited.length > 0 ? [describe('Edited', edited, places)] : []),
    ...(added.length > 0 ? [describe('Added', added, places)] : []),
    ...(removed.length > 0 ? [describe('Removed', removed, places)] : []),
  ].join('; ')
  // Raw text can't be patched per file: once the disk moves, pin what is on disk.
  const next: Pin = { files, raw: null, source: pin.source === 'engine' ? 'engine' : 'discovered' }
  await settle($, next, pin.source === null ? undefined : change)
  if (hasChanged && pin.source !== null) $.ui.toast('CLAUDE.md changed: re-pinned')
}

/**
 * Claude worked at these paths: keep the subfolder pins whose folder holds
 * one, and when it opened a file, pin the CLAUDE.md of each subfolder
 * between the project root and that file.
 */
async function touch($: EngineInterface, paths: string[], isFileTool: boolean): Promise<void> {
  if (paths.length === 0) return
  const root = await $.session.root()
  const turn = await read($, turnAtom)
  const pin = await read($, pinAtom)

  let hasTouched = false
  const added: string[] = []
  let files = pin.files
  const known = new Set(files.map(f => keyOf(f.path)))
  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : `${root}/${path}`
    files = files.map(f => {
      if (f.scope === undefined || f.lastUsedTurn === turn || !isInside(absolute, f.scope)) return f
      hasTouched = true
      return { ...f, lastUsedTurn: turn }
    })

    if (!isFileTool || !isInside(absolute, root)) continue
    const nested = await $.fs.ancestors({ names: PROJECT_NAMES, of: absolute, below: root }).catch(() => [])
    for (const entry of nested) {
      const kind = entry.name === 'CLAUDE.local.md' ? 'local' : 'project'
      for (const part of entry.parts) {
        if (known.has(keyOf(part.path))) continue
        known.add(keyOf(part.path))
        const mtimeMs = (await mtimeOf($, part.path)) ?? -1
        files = [...files, { path: part.path, kind, content: part.content, mtimeMs, scope: entry.dir, lastUsedTurn: turn }]
        added.push(part.path)
      }
    }
  }

  if (added.length === 0) {
    if (hasTouched) await update($, pinAtom, () => ({ ...pin, files }))
    return
  }
  const places = await placesOf($)
  await settle($, { ...pin, files, source: pin.source ?? 'discovered' }, describe('Pinned', added, places))
  $.ui.toast(`CLAUDE.md pinned: ${added.map(p => displayPath(p, places)).join(', ')}`)
}

/** A new user message: age the subfolder pins and unpin the ones unused for UNPIN_AFTER messages. */
async function age($: EngineInterface): Promise<void> {
  const turn = await update($, turnAtom, n => n + 1)
  const pin = await read($, pinAtom)
  const stale = pin.files.filter(f => f.scope !== undefined && messagesLeft(f, turn) === 0)
  if (stale.length === 0) return

  const places = await placesOf($)
  const files = pin.files.filter(f => !stale.includes(f))
  await settle($, { ...pin, files }, `${describe('Unpinned', stale.map(f => f.path), places)} (no work there for ${UNPIN_AFTER} messages)`)
  $.ui.toast(`CLAUDE.md unpinned: ${stale.map(f => displayPath(f.path, places)).join(', ')}`)
}

async function setBand($: EngineInterface, isShown: boolean) {
  await update($, bandAtom, () => isShown)
  await $.store.set(BAND_KEY, isShown).catch(() => undefined)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'CLAUDE.md' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Show what CLAUDE.md is pinned in the system prompt; "/claudemd band" shows or hides the band',
    }).catch(() => undefined)
    const stored = await $.store.get(BAND_KEY).catch(() => undefined)
    if (typeof stored === 'boolean') await update($, bandAtom, () => stored)
    await sync($, { force: true }).catch(() => undefined)

    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'band') {
      const isShown = !(await read($, bandAtom))
      await setBand($, isShown)
      return { text: isShown ? 'CLAUDE.md band shown.' : 'CLAUDE.md band hidden.' }
    }
    await openPane($)

    return { text: 'CLAUDE.md pane opened.' }
  })

  // Capture the engine's own CLAUDE.md block (every tier, @imports resolved)
  // and take it out of the first user message: it lives in the system prompt.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const block = context.blocks.find(b => b.name === 'claudeMd')
    // No block (none on disk, or a subagent that omits it): leave the pin as is;
    // sync notices deletions by itself.
    if (block === undefined || block.text.trim() === '') return context

    const old = await read($, pinAtom)
    const instructionFiles = context.instructionFiles ?? []
    const engineKeys = new Set(instructionFiles.map(f => keyOf(f.path)))
    // Subfolder pins outlive a re-read (compaction, /clear): the engine's block never holds them.
    const nested = old.files.filter(f => f.scope !== undefined && !engineKeys.has(keyOf(f.path)))
    const pin: Pin =
      instructionFiles.length === 0
        ? // Another plugin rewrote the text: pin it as is, and watch what is on disk.
          { files: [...(await discover($)), ...nested], raw: block.text, source: 'raw' }
        : {
            files: [
              ...(await Promise.all(
                instructionFiles.map(async f => ({
                  path: f.path,
                  kind: f.kind,
                  content: f.content,
                  mtimeMs: (await mtimeOf($, f.path)) ?? -1,
                })),
              )),
              ...nested,
            ],
            raw: null,
            source: 'engine',
          }
    await settle($, pin)

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

  on('prompt.submit', async ($, e, next) => {
    await age($).catch(() => undefined)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const paths = pathsOf(e as unknown as Record<string, unknown>)
    await touch($, paths, FILE_TOOLS.has(e.tool)).catch(() => undefined)

    return ran
  })

  // Synchronous on purpose: nothing here can fail and hold up a compaction.
  on('session.compact', ($, e, next) => {
    if (!isPinned) return next(e)

    return next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${COMPACT_NOTE}` : COMPACT_NOTE })
  })

  // The band above the prompt: one line, shown until hidden.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, bandAtom))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const pin = await read($, pinAtom)
    const turn = await read($, turnAtom)
    const count = countOf(pin)
    const nested = pin.files.filter(f => f.scope !== undefined)
    const soonest = nested.reduce<PinnedFile | undefined>(
      (best, f) => (best === undefined || messagesLeft(f, turn) < messagesLeft(best, turn) ? f : best),
      undefined,
    )
    const places = soonest === undefined ? {} : await placesOf($)
    const summary =
      count === 0
        ? 'CLAUDE.md: none found'
        : [
            `CLAUDE.md pinned · ${count} file${count === 1 ? '' : 's'}`,
            `~${formatTokens(tokensOf(render(pin) ?? ''))} tokens`,
            ...(soonest === undefined || soonest.scope === undefined
              ? []
              : [`${displayPath(soonest.scope, places)} unpins in ${messagesLeft(soonest, turn)}`]),
          ].join(' · ')

    return (
      <Box flexDirection="row">
        <Box flexGrow={1}>
          <Text dimColor={count === 0} wrap="truncate-end">
            {summary}
          </Text>
        </Box>
        <Button key="details" label="Details" hotkey="d" onPress={() => void openPane($)} />
        <Button key="hide" label="Hide" hotkey="h" onPress={() => setBand($, false)} />
      </Box>
    )
  })

  // The /claudemd pane: every pinned file, its tier and size, and what changed last.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const pin = await read($, pinAtom)
    const turn = await read($, turnAtom)
    const lastChange = await read($, changeAtom)
    const isBandShown = await read($, bandAtom)
    const places = await placesOf($)
    const count = countOf(pin)
    const text = render(pin)
    const shown = pin.source === 'raw' ? pin.files.filter(f => f.scope !== undefined) : pin.files

    return (
      <Box flexDirection="column">
        <Text bold>{count === 0 ? 'Nothing pinned' : 'Pinned in the system prompt'}</Text>
        <Text dimColor>
          {count === 0
            ? 'No CLAUDE.md found. Nothing is added to the system prompt.'
            : `${count} file${count === 1 ? '' : 's'} · ~${formatTokens(tokensOf(text ?? ''))} tokens · re-checked before every request`}
        </Text>
        {pin.source === 'raw' && (
          <Text dimColor>
            Another plugin rewrote the CLAUDE.md text, so it's pinned as rewritten until a file on disk changes.
          </Text>
        )}
        <Text> </Text>
        {shown.map(f => (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box flexGrow={1}>
                <Text wrap="truncate-middle">
                  {f.scope === undefined ? '● ' : '◐ '}
                  {displayPath(f.path, places)}
                </Text>
              </Box>
              <Text dimColor>
                {' '}
                {f.scope === undefined ? (TIERS[f.kind] ?? f.kind) : 'subfolder'} · ~{formatTokens(tokensOf(f.content))}
              </Text>
            </Box>
            {f.scope !== undefined && (
              <Text dimColor>
                {'   '}unpins after {messagesLeft(f, turn)} more message{messagesLeft(f, turn) === 1 ? '' : 's'} without
                work in {displayPath(f.scope, places)}
              </Text>
            )}
          </Box>
        ))}
        {lastChange !== null && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text dimColor>Last change: {lastChange.text}</Text>
          </Box>
        )}
        <Text> </Text>
        <Box flexDirection="row">
          <Button
            key="band"
            label={isBandShown ? 'Hide band' : 'Show band'}
            hotkey="b"
            onPress={() => setBand($, !isBandShown)}
          />
          <Button key="check" label="Check now" hotkey="c" onPress={() => sync($, { force: true })} />
        </Box>
      </Box>
    )
  })
}
