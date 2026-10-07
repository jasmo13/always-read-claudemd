import { atom, read, update } from 'claude-code'
import type { ClientElements, EngineInterface, Register, RenderElement, SessionMessage } from 'claude-code'

import type { Pin, PinnedFile } from '../types'
import {
  FILE_TOOLS,
  HEADER,
  PROJECT_NAMES,
  TIERS,
  UNPIN_AFTER,
  countOf,
  displayPath,
  filesOf,
  folderName,
  formatTokens,
  isAbsolute,
  isBlank,
  isInside,
  isMessage,
  keyOf,
  messagesLeft,
  pathsOf,
  render,
  bandLayout,
  scrollBar,
  scrolled,
  tabTitle,
  tokensOf,
} from './pin'

const PANE = 'always-read-claudemd'
const TITLE = 'CLAUDE.md'
const COMMAND = 'claudemd'
const BAND_KEY = 'isBandShown'

const EMPTY: Pin = { files: [], raw: null, source: null }
const pinAtom = atom({ plugin: 'always-read-claudemd', key: 'pin' } as const, EMPTY)
const turnAtom = atom({ plugin: 'always-read-claudemd', key: 'turn' } as const, 0)
const changeAtom = atom({ plugin: 'always-read-claudemd', key: 'lastChange' } as const, null)
const bandAtom = atom({ plugin: 'always-read-claudemd', key: 'isBandShown' } as const, true)
const viewingAtom = atom({ plugin: 'always-read-claudemd', key: 'viewing' } as const, null)
const paneTopAtom = atom({ plugin: 'always-read-claudemd', key: 'paneTop' } as const, 0)

// The turns running now, so a file changed between them rewrites the CLAUDE.md message at once.
const running = new Set<string>()
// Whether the CLAUDE.md message is being rewritten, so a second change waits for the first.
let isSwapping = false
// How many prompts the chat held when last drawn, so a rewind, which takes some away, is noticed.
let promptsSeen = 0
/**
 * Whether someone is watching the chat: the terminal, or an app showing it (the desktop app attaches
 * when it opens a chat). A run with neither (-p, a bare SDK app) prints the last result it has, and a
 * rewrite after the answer would be that result, so there the message is rewritten only as it starts.
 */
const isWatched = async ($: EngineInterface) => (await $.session.surfaces()).length > 0

/** Whether a message is the CLAUDE.md message. */
const isOwn = (m: SessionMessage) => m.role === 'user' && isMessage(m.text)

/**
 * The CLAUDE.md message as the chat holds it now; null when it has none. The history keeps the ones
 * each rewrite replaced, so the chat's own is the latest.
 */
async function heldText($: EngineInterface): Promise<string | null> {
  return (await $.session.messages()).findLast(isOwn)?.text ?? null
}

/** The CLAUDE.md message as it should be, as a message of the chat. */
const ownMessage = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

/**
 * Brings the CLAUDE.md message in step with disk: re-reads the files, and when what the chat holds
 * differs (or it holds none), compacts the chat in a way that only puts the message back first.
 */
async function refresh($: EngineInterface) {
  await sync($).catch(() => undefined)
  if (isSwapping) return
  const text = render(await read($, pinAtom))
  const held = await heldText($)
  if ((text?.trim() ?? null) === (held?.trim() ?? null)) return
  isSwapping = true
  try {
    await $.command.run({ command: 'compact' })
    // Which of Claude Code's copies are left out depends on what the message holds: ask again.
    $.ui.invalidate('prompt.attachment')
  } finally {
    isSwapping = false
  }
}

/**
 * A resumed chat's CLAUDE.md message as its transcript last wrote it; null for a chat that wasn't
 * resumed. Claude Code reloads a chat through the history each rewrite replaced (it links a rewritten
 * tool result to the old tool call), so the chat it loads can hold an older message than the last.
 */
let resumed: Promise<string | null> = Promise.resolve(null)

async function lastWritten($: EngineInterface, transcript: string): Promise<string | null> {
  const lines = String(await $.fs.read(transcript)).split('\n')
  // Each row is JSON: the header's line breaks are escaped there.
  const header = JSON.stringify(HEADER).slice(1, -1)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]?.includes(header)) continue
    const row = JSON.parse(lines[i] ?? '') as { type?: string; message?: { content?: unknown } }
    const content = row.message?.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (b as { text?: string }).text ?? '').join('') : ''
    if (row.type === 'user' && isMessage(text)) return text
  }
  return null
}

/**
 * A rewind restores the chat as it was, CLAUDE.md message included, and that message can be older
 * than the files: the chat holds fewer prompts than before, and the message is brought in step with
 * disk before the next one.
 */
async function noticeRewind($: EngineInterface) {
  const prompts = await $.session.turns()
  const isBack = prompts < promptsSeen
  promptsSeen = prompts
  if (isBack && running.size === 0) await refresh($)
}

/** The CLAUDE.md message a chat opened in this process last had: its transcript's when resumed. */
async function lastHeld($: EngineInterface) {
  return (await resumed.catch(() => null)) ?? (await heldText($))
}

/** A chat resumed in a new process: what its CLAUDE.md message holds is what is pinned. */
async function recall($: EngineInterface) {
  if ((await read($, pinAtom)).source !== null) return
  const held = await lastHeld($)
  const files = held === null ? null : filesOf(held)
  if (files !== null && files.length > 0) await settle($, { files, raw: null, source: 'discovered' })
}

async function mtimeOf($: EngineInterface, path: string): Promise<number | undefined> {
  return (await $.fs.stat(path).catch(() => undefined))?.mtimeMs
}

async function homeOf($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
}

async function placesOf($: EngineInterface) {
  return { home: await homeOf($).catch(() => undefined) }
}

/** Claude Code's user folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
async function userDirOf($: EngineInterface): Promise<string | undefined> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await homeOf($)
  return configDir ?? (home === undefined ? undefined : `${home.replace(/[\\/]$/, '')}/.claude`)
}

/** The instruction files on disk where new ones can appear: user-level and the project's ancestors. */
async function discover($: EngineInterface): Promise<PinnedFile[]> {
  const found: PinnedFile[] = []

  const userDir = await userDirOf($)
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

/**
 * What the band and the terminal's status line say: how many files are pinned and their size, and
 * each subfolder file with its own count, the one closest to unpinning first.
 */
function lineOf(pin: Pin, turn: number) {
  const count = countOf(pin)
  const summary = `${count} ${count === 1 ? 'file' : 'files'}, ~${formatTokens(tokensOf(render(pin) ?? ''))} tokens`
  const nested = pin.files
    .flatMap(f => (f.scope === undefined ? [] : [{ folder: folderName(f.scope), left: messagesLeft(f, turn) }]))
    .sort((a, b) => a.left - b.left)
  return { count, summary, nested }
}

/**
 * The line itself, as the band and the status line both draw it: the dot, "CLAUDE.md pinned", the
 * summary in gray, then the first `folders` subfolder files and how many more there are.
 */
function pinnedLine(
  { Box, Text }: Pick<ClientElements, 'Box' | 'Text'>,
  { count, summary, nested }: ReturnType<typeof lineOf>,
  { folders, hasSummary }: { folders: number; hasSummary: boolean },
): RenderElement[] {
  const named = nested.slice(0, folders)
  return [
    <Box key="pinned" flexDirection="row" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
      <Box flexShrink={0}>{count === 0 ? <Text dimColor>○</Text> : <Text color="success">●</Text>}</Box>
      <Box flexShrink={0}>
        <Text dimColor={count === 0}>{count === 0 ? 'No CLAUDE.md found' : 'CLAUDE.md pinned'}</Text>
      </Box>
      {count > 0 && hasSummary && (
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {summary}
          </Text>
        </Box>
      )}
    </Box>,
    ...(named.length === 0
      ? []
      : [
          <Box key="folders" flexDirection="row" columnGap={2} flexShrink={0}>
            {named.map(({ folder, left }) => (
              <Box key={folder} flexShrink={0}>
                {left <= NEAR_UNPIN ? (
                  <Text color="warning">{`${folder} unpins in ${left}`}</Text>
                ) : (
                  <Text dimColor>{`${folder} unpins in ${left}`}</Text>
                )}
              </Box>
            ))}
            {nested.length > named.length && (
              <Box key="more" flexShrink={0}>
                <Text dimColor>{`+${nested.length - named.length} more`}</Text>
              </Box>
            )}
          </Box>,
        ]),
  ]
}

/**
 * The plugin's own files in Claude Code's store, one per place it was installed from
 * (`always-read-claudemd_<source>-<hash>.json`). A choice made in any chat is written there, so
 * every chat watches them. A fresh install has none until something is kept, so one is kept first.
 */
async function storeFiles($: EngineInterface): Promise<string[]> {
  const userDir = await userDirOf($)
  if (userDir === undefined) return []
  const dir = `${userDir}/plugins/store`
  const list = async () =>
    (await $.fs.list(dir).catch(() => []))
      .filter(f => f.name.startsWith(`${PANE}_`) && f.name.endsWith('.json'))
      .map(f => `${dir}/${f.name}`)
  const files = await list()
  if (files.length > 0) return files
  await $.store.set(BAND_KEY, await read($, bandAtom))
  return list()
}

/** Whether a path is one of the plugin's store files, in either slash and any case, as Windows allows. */
const isStoreFile = (path: string) => /\/plugins\/store\/always-read-claudemd_[^/]*\.json$/.test(keyOf(path))

/** Where each of these paths leads when it's a symbolic link, such as a CLAUDE.md that points to AGENTS.md. */
async function linkTargets($: EngineInterface, paths: string[]): Promise<string[]> {
  const targets: string[] = []
  for (const path of paths) {
    const real = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath
    if (real !== undefined && keyOf(real) !== keyOf(path)) targets.push(real)
  }
  return targets
}

/** Shows or hides the band as it was last chosen, in this chat or another. */
async function followBand($: EngineInterface) {
  const stored = await $.store.get(BAND_KEY).catch(() => undefined)
  if (typeof stored === 'boolean' && stored !== (await read($, bandAtom))) await update($, bandAtom, () => stored)
}

/** Stores a new pin and says so: the pane's last change, and the tab title. */
async function settle($: EngineInterface, pin: Pin, change?: string) {
  await update($, pinAtom, () => pin)
  if (change !== undefined) {
    const turn = await read($, turnAtom)
    await update($, changeAtom, () => ({ text: change, turn }))
  }
  await settleView($, pin).catch(() => undefined)
}

/** Where a file comes from, as the open file's view and its tab title say it. */
function detailOf(file: PinnedFile): string {
  return file.scope === undefined ? (TIERS[file.kind] ?? file.kind) : `Applies while Claude works in ${folderName(file.scope)}`
}
const RAW_DETAIL = 'As another plugin rewrote it'

/**
 * The pane's tab title for what it shows: the open file's name, where it comes from, its size and
 * that it's read-only, or the plain title.
 */
async function titleFor($: EngineInterface, viewing: string | null): Promise<string> {
  if (viewing === null) return TITLE
  const pin = await read($, pinAtom)
  if (viewing === RAW && pin.source === 'raw') return tabTitle(TITLE, RAW_DETAIL, tokensOf(pin.raw ?? ''))
  const file = pin.files.find(f => keyOf(f.path) === viewing)
  return file === undefined
    ? TITLE
    : tabTitle(displayPath(file.path, await placesOf($)), detailOf(file), tokensOf(file.content))
}

/**
 * The pin changed while the pane shows a file: back to the list if the file is gone, and a tab
 * title that names a file (the desktop's) kept to what the pane shows.
 */
async function settleView($: EngineInterface, pin: Pin) {
  const viewing = await read($, viewingAtom)
  if (viewing === null) return
  const isGone = !(viewing === RAW && pin.source === 'raw') && !pin.files.some(f => keyOf(f.path) === viewing)
  if (isGone) await update($, viewingAtom, () => null)
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane === undefined || pane.title === TITLE) return
  const title = await titleFor($, isGone ? null : viewing)
  if (title !== pane.title) await $.ui.open({ id: PANE, title })
}

const describe = (verb: string, paths: string[], places: { root?: string; home?: string }) =>
  `${verb} ${paths.map(p => displayPath(p, places)).join(', ')}`

/** Re-checks the pinned files against disk: re-reads any whose mtime moved, drops deleted ones, and adds new ones. */
async function sync($: EngineInterface): Promise<void> {
  const pin = await read($, pinAtom)

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
    if (content.trim() !== file.content.trim()) edited.push(file.path)
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
  if (!hasChanged && pin.source !== null) {
    // Same text, but a file read back from the chat's message now has its mtime.
    if (files.some((f, i) => f !== pin.files[i])) await update($, pinAtom, () => ({ ...pin, files }))
    return
  }

  const places = await placesOf($)
  const change = [
    ...(edited.length > 0 ? [describe('Edited', edited, places)] : []),
    ...(added.length > 0 ? [describe('Added', added, places)] : []),
    ...(removed.length > 0 ? [describe('Removed', removed, places)] : []),
  ].join('; ')
  // Raw text can't be patched per file: once the disk moves, pin what is on disk.
  const next: Pin = { files, raw: null, source: pin.source === 'engine' ? 'engine' : 'discovered' }
  await settle($, next, pin.source === null ? undefined : change)
  if (pin.source !== null) $.ui.toast('CLAUDE.md changed: re-pinned')
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

// The Markdown element draws at most this many characters.
const VIEW_LIMIT = 10_000
const RAW = 'raw'
// A divider: longer than any band or pane is wide, set in a Box wider still so it never wraps, inside
// a one-row Box that clips it to fit, so no surface cuts it short with an ellipsis or shows a second line.
const RULE = '─'.repeat(500)
const RULE_COLUMNS = 1000
// A subfolder pin this close to unpinning is shown in the theme's warning color.
const NEAR_UNPIN = 3
// Columns of space between the pane's edges and its text.
const MARGIN = 1

/** How long ago a change was, in the person's messages. */
const ago = (messages: number) =>
  messages <= 0 ? 'this message' : messages === 1 ? '1 message ago' : `${messages} messages ago`

// How far the pane's body can scroll, from its last drawing; the ui.scroll hook clamps to it.
let paneMaxTop = 0
// Whether the pane last drew its own window under a fixed top, so the ui.scroll hook moves it.
let paneScrollsItself = false

/** About how many rows markdown takes at a width: each line wrapped, plus a gap after headings. */
function markdownRows(markdown: string, columns: number): number {
  return markdown
    .split('\n')
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)) + (/^#{1,6} /.test(line) ? 1 : 0), 0)
}

/** Opens the pane on its list of files; an open pane is left as it is. */
async function openPane($: EngineInterface) {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) return
  await update($, viewingAtom, () => null)
  await update($, paneTopAtom, () => 0)
  await $.ui.open({ id: PANE, title: TITLE })
}

// /claudemd: opens the pane, or closes it when it's open. The terminal has no band, so no Details
// button; the command is the way in and out.
async function togglePane($: EngineInterface) {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.close({ id: PANE })
  else await openPane($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Open or close the pane showing what CLAUDE.md is pinned; "/claudemd band" shows or hides its line',
    }).catch(() => undefined)
    await followBand($)
    await recall($).catch(() => undefined)
    // A new chat gets its CLAUDE.md message first; a resumed one has it rewritten if the files changed.
    await refresh($).catch(() => undefined)

    return started
  })

  // Every chat watches the plugin's store files and the CLAUDE.md files it pins, and where any of
  // them links to, so a choice made in another chat, or a file edited anywhere, shows in each open
  // chat at once, not at its next message.
  on('classic.SessionStart', async ($, e, next) => {
    // Raised before Claude Code reads its files for a resumed chat, and before session.start.
    if (e.agent_id === undefined && e.source === 'resume') resumed = lastWritten($, e.transcript_path)
    const result = await next(e)
    // /clear empties the chat, its CLAUDE.md message with it: put it back once the clear is done.
    if (e.agent_id === undefined && e.source === 'clear') void $.clock.sleep(0).then(() => refresh($)).catch(() => undefined)
    const pinned = (await read($, pinAtom)).files.map(f => f.path)
    const found = (await discover($).catch(() => [])).map(f => f.path)
    const instructions = [...pinned, ...found]
    const files = [
      ...(await storeFiles($).catch(() => [])),
      ...instructions,
      ...(await linkTargets($, instructions).catch(() => [])),
    ]
    const watched = files.filter((path, i) => files.findIndex(p => keyOf(p) === keyOf(path)) === i)
    return watched.length === 0 ? result : { ...result, watchPaths: [...(result.watchPaths ?? []), ...watched] }
  })

  // Known by name, so a hot reload (which keeps the watch but forgets the module's variables) still
  // hears it. Every other watched path is an instruction file, or the file one links to: between
  // turns the CLAUDE.md message is rewritten at once, during one when the turn ends.
  on('classic.FileChanged', ($, e, next) => {
    if (isStoreFile(e.file_path)) void followBand($).catch(() => undefined)
    else void isWatched($).then(isOn => (running.size === 0 && isOn ? refresh($) : sync($))).catch(() => undefined)
    return next(e)
  })

  // An app opened the chat (the desktop app, after it was in the background): files changed while no
  // one watched are put in the CLAUDE.md message now, before the next message.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (running.size === 0) void $.clock.sleep(0).then(() => refresh($)).catch(() => undefined)
    return attached
  })

  // Answers with toasts and the pane alone: nothing is written to the chat.
  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'band') {
      const isShown = !(await read($, bandAtom))
      await setBand($, isShown)
      // The terminal shows this line under the prompt, the desktop as the band; a command can't
      // tell which surface ran it, so the toast names neither.
      $.ui.toast(isShown ? 'CLAUDE.md line shown' : 'CLAUDE.md line hidden')
      return {}
    }
    await togglePane($)

    return {}
  })

  // Capture the engine's own CLAUDE.md block (every tier, @imports resolved): the CLAUDE.md message
  // carries the same files.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const block = context.blocks.find(b => b.name === 'claudeMd')
    // No block (none on disk, or a subagent that omits it): leave the pin as is;
    // sync notices deletions by itself.
    if (block === undefined || block.text.trim() === '') return context

    const old = await read($, pinAtom)
    const instructionFiles = context.instructionFiles ?? []
    const engineKeys = new Set(instructionFiles.map(f => keyOf(f.path)))
    // Subfolder pins outlive a re-read (compaction, /clear): the engine's block never holds them. A
    // resumed chat can read its files before session.start recalls its pin: they are in its message.
    const held = old.source === null ? await lastHeld($).catch(() => null) : null
    const kept = held === null ? old.files : (filesOf(held) ?? [])
    const nested = kept.filter(f => f.scope !== undefined && !engineKeys.has(keyOf(f.path)))
    const pin: Pin =
      instructionFiles.length === 0
        ? // Another plugin rewrote the text: pin it as is, and watch what is on disk.
          { files: [...(await discover($)), ...nested], raw: block.text, source: 'raw' }
        : {
            files: [
              ...(await Promise.all(
                instructionFiles.map(async f => {
                  const mtimeMs = (await mtimeOf($, f.path)) ?? -1
                  // Claude Code's copy can be older than the disk (a file edited since it read it): the
                  // copy read from disk at this mtime wins, and a pinned file that has changed since
                  // is re-read at the next check.
                  const mine = old.files.find(p => keyOf(p.path) === keyOf(f.path))
                  if (mine !== undefined && mine.mtimeMs === mtimeMs) return { path: f.path, kind: f.kind, content: mine.content, mtimeMs }
                  return { path: f.path, kind: f.kind, content: f.content, mtimeMs: mine === undefined ? mtimeMs : -1 }
                }),
              )),
              ...nested,
            ],
            raw: null,
            source: 'engine',
          }
    await settle($, pin)

    return context
  })

  // Claude Code's own copies of the files ride with messages as attachments: the whole set with the
  // first message (and again when a file changes), and a subfolder's file when Claude works there.
  // Once the chat has the CLAUDE.md message, the main chat reads them there alone: its copies are
  // left out, a subfolder's once the message holds it. A subagent keeps its own.
  on('prompt.attachment', async ($, e, next) => {
    const shown = await next(e)
    if (e.agentId !== undefined || shown.text === null) return shown
    if (e.type !== 'instructions' && e.type !== 'nested_memory') return shown
    const held = await heldText($).catch(() => null)
    if (held === null) return shown
    if (e.type === 'instructions') return { text: null }
    const [, path] = /^Contents of (.+?):\s*$/m.exec(e.text) ?? []
    const isHeld = path !== undefined && (filesOf(held) ?? []).some(f => keyOf(f.path) === keyOf(path))
    return isHeld ? { text: null } : shown
  })

  on('prompt.submit', async ($, e, next) => {
    await age($).catch(() => undefined)
    return next(e)
  })

  // Claude opened a file: pin its subfolder's CLAUDE.md, put in the CLAUDE.md message when the turn ends.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await touch($, pathsOf(e as unknown as Record<string, unknown>), FILE_TOOLS.has(e.tool)).catch(() => undefined)
    return ran
  })

  on('turn.start', ($, e, next) => {
    running.add(e.turnId)
    return next(e)
  })

  // A turn ended: if the files changed while it ran, or a subfolder's file was pinned or unpinned,
  // the CLAUDE.md message is rewritten now, before the next message.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    running.delete(e.turnId)
    if (e.agentId === undefined && running.size === 0 && (await isWatched($))) await refresh($).catch(() => undefined)
    return done
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await sync($).catch(() => undefined)
    const text = render(await read($, pinAtom))

    // The plugin's own compaction: nothing is summarized. The chat stays as it is, with the old
    // CLAUDE.md message taken out and the new one put first.
    if (isSwapping) {
      const rest = e.messages.filter(m => !isOwn(m))
      return { messages: text === null ? rest : [ownMessage(text), ...rest] }
    }

    // Any other compaction summarizes as usual, and the CLAUDE.md message goes back first, whole.
    const compacted = await next(e)
    if (compacted.messages === undefined) return compacted
    const rest = compacted.messages.filter(m => !isOwn(m))
    return { ...compacted, messages: text === null ? rest : [ownMessage(text), ...rest] }
  })

  // The chat doesn't draw the CLAUDE.md message: the line and the pane show what is pinned, and a
  // toast says when it changes. (The /compact that rewrites it is drawn by Claude Code, which never
  // asks a plugin to draw the rows it caused.)
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!isMessage(e.props.text.trim())) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // The status line: in the terminal the band's line moves here, to a row of its own under the hint
  // line below the prompt, which only the terminal draws, so there's no band above the prompt.
  // ($.ui.status would pin it above, among the engine's notices, under a warning sign.) The band
  // choice shows and hides it. The row has no width to measure, so the summary is cut to fit.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)
    if (e.surface !== 'terminal' || !(await read($, bandAtom))) return hint
    const { Box, Text } = $.ui.resolve(e)
    const line = lineOf(await read($, pinAtom), await read($, turnAtom))

    return (
      <Box flexDirection="column">
        {hint}
        <Box key="status" flexDirection="row" columnGap={2}>
          {pinnedLine({ Box, Text }, line, { folders: 2, hasSummary: true })}
        </Box>
      </Box>
    )
  })

  // The band above the prompt, on the desktop: one quiet line, shown until hidden, beneath any other
  // plugin's band. The terminal draws the same line under the prompt instead (see PromptHint).
  // Colors are theme keys or dim alone, never raw, so it reads in light and dark themes.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Claude Code redraws this slot after a rewind, on every surface.
    void noticeRewind($).catch(() => undefined)
    if (e.surface === 'terminal' || e.props.hasSurvey || !(await read($, bandAtom))) return next(e)

    // The slot holds one tree, so draw the other plugins' bands too rather than replacing them,
    // then a blank row and a rule, and this one last, at the bottom, next to the prompt.
    const others = await next(e)
    const hasOthers = !isBlank(others)
    const { Box, Button, Text } = $.ui.resolve(e)
    const line = lineOf(await read($, pinAtom), await read($, turnAtom))
    // The band names the first two subfolder files, or one when it's narrow, and counts the rest,
    // which the pane lists. What fits its width: fewer folders first, then no summary. The desktop
    // draws its buttons as keys in boxes.
    const fit = bandLayout(e.props.bodyColumns, {
      status: line.count === 0 ? '○ No CLAUDE.md found' : '● CLAUDE.md pinned',
      summary: line.summary,
      folders: line.nested.map(({ folder, left }) => `${folder} unpins in ${left}`),
      buttons: 25,
    })

    return (
      <Box flexDirection="column">
        {others}
        {hasOthers && (
          <Box marginTop={1} height={1} overflow="hidden">
            <Box width={RULE_COLUMNS} flexShrink={0}>
              <Text dimColor>{RULE}</Text>
            </Box>
          </Box>
        )}
        <Box flexDirection="row" columnGap={2}>
          {pinnedLine({ Box, Text }, line, fit)}
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            <Button key="details" label="Details" hotkey="o" plain dimColor onPress={() => void openPane($)} />
            <Button key="hide" label="Hide" hotkey="x" plain dimColor onPress={() => setBand($, false)} />
          </Box>
        </Box>
      </Box>
    )
  })

  // The /claudemd pane: a fixed toolbar, then a body the plugin scrolls itself (see ui.scroll),
  // so the toolbar stays put. Rows are cut to fit rather than wrapped; color carries state only.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const pin = await read($, pinAtom)
    const turn = await read($, turnAtom)
    const lastChange = await read($, changeAtom)
    const isBandShown = await read($, bandAtom)
    const viewing = await read($, viewingAtom)
    const top = await read($, paneTopAtom)
    const places = await placesOf($)
    const count = countOf(pin)
    const text = render(pin)
    // The terminal sends the wheel and page keys here, so there the pane is clipped to its height
    // and scrolls its own body under a fixed top. Other surfaces, the desktop app among them, scroll
    // the whole pane themselves, top included, so there it's drawn whole and the open file's name
    // and size go in the pane's tab title, which stays put.
    const isFixed = e.surface === 'terminal'
    // The width text wraps at: the body less its margins, and the scroll bar with its gap.
    const columns = Math.max(1, e.props.bodyColumns - 2 * MARGIN - (isFixed ? 2 : 0))
    const view = (id: string | null) => () =>
      void (async () => {
        await update($, viewingAtom, () => id)
        await update($, paneTopAtom, () => 0)
        if (!isFixed) await $.ui.open({ id: PANE, title: await titleFor($, id) })
      })().catch(() => undefined)

    // The toolbar and its rule: drawn above the scrolled body, so they never move.
    // In the terminal the band's line is the status line under the prompt, so the button names that.
    const lineName = isFixed ? 'status line' : 'band'
    const bandButton = isBandShown ? (
      <Button key="band" label={`Hide ${lineName}`} hotkey="h" plain dimColor onPress={() => setBand($, false)} />
    ) : (
      <Button key="band" label={`Show ${lineName}`} hotkey="s" plain dimColor onPress={() => setBand($, true)} />
    )
    // The fixed top: the toolbar, then `sub` a row below it when there is one, then a rule; the
    // body scrolls under it.
    const frame = (left: RenderElement, body: RenderElement, bodyRows: number, sub?: RenderElement) => {
      const shownRows = Math.max(1, e.props.scroll.bodyRows - (sub === undefined ? 2 : 4))
      paneScrollsItself = isFixed
      paneMaxTop = isFixed ? Math.max(0, bodyRows - shownRows) : 0
      const offset = Math.min(top, paneMaxTop)
      const toolbar = (
        <Box flexDirection="row" columnGap={2} flexShrink={0}>
          <Box flexDirection="row" columnGap={2} flexGrow={1} flexShrink={1} minWidth={0}>
            {left}
          </Box>
          <Box flexShrink={0}>{bandButton}</Box>
        </Box>
      )
      const divider = (
        <Box height={1} flexShrink={0} overflow="hidden">
          <Box width={RULE_COLUMNS} flexShrink={0}>
            <Text dimColor>{RULE}</Text>
          </Box>
        </Box>
      )
      if (!isFixed) {
        return (
          <Box flexDirection="column" paddingX={MARGIN}>
            {toolbar}
            {sub}
            {divider}
            {body}
          </Box>
        )
      }
      const bar = scrollBar(shownRows, bodyRows, offset)
      return (
        <Box flexDirection="column" height={e.props.scroll.bodyRows} paddingX={MARGIN}>
          {toolbar}
          {sub}
          {divider}
          <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} columnGap={1}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Box flexDirection="column" flexShrink={0} position="relative" top={offset === 0 ? 0 : -offset}>
                {body}
              </Box>
            </Box>
            {bar !== null && (
              <Box key="scrollbar" flexDirection="column" width={1} flexShrink={0}>
                {bar.map((isThumb, i) =>
                  // The theme's own text color stands out on the pane's background, light or dark.
                  isThumb ? (
                    <Text key={`${i}`} color="text">
                      ┃
                    </Text>
                  ) : (
                    <Text key={`${i}`} color="subtle">
                      │
                    </Text>
                  ),
                )}
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    // One file, read-only, with a way back to the list.
    const opened = viewing === null ? undefined : pin.files.find(f => keyOf(f.path) === viewing)
    const shown =
      viewing === RAW && pin.source === 'raw'
        ? { name: 'CLAUDE.md', detail: RAW_DETAIL, content: pin.raw ?? '' }
        : opened === undefined
          ? undefined
          : {
              name: displayPath(opened.path, places),
              detail: detailOf(opened),
              content: opened.content,
            }
    if (shown !== undefined) {
      const isCut = shown.content.length > VIEW_LIMIT
      const isEmpty = shown.content.trim() === ''
      return frame(
        <Box flexDirection="row" columnGap={2} flexShrink={1} minWidth={0}>
          <Box flexShrink={0}>
            <Button key="back" label="Back" hotkey="b" plain onPress={view(null)} />
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-start">
              {shown.name}
            </Text>
          </Box>
        </Box>,
        <Box flexDirection="column">
          {isEmpty ? (
            <Text dimColor>This file is empty.</Text>
          ) : (
            <Markdown text={shown.content.slice(0, VIEW_LIMIT)} />
          )}
          {isCut && (
            <Box marginTop={1}>
              <Text dimColor>The rest is cut off here, but the whole file is pinned.</Text>
            </Box>
          )}
        </Box>,
        (isEmpty ? 1 : markdownRows(shown.content.slice(0, VIEW_LIMIT), columns)) + (isCut ? 2 : 0),
        // Where the file comes from, in the fixed top, so the scrolled body starts with the file itself.
        <Box flexDirection="row" columnGap={2} flexShrink={0} marginTop={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {shown.detail}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{`~${formatTokens(tokensOf(shown.content))} tokens, read-only`}</Text>
          </Box>
        </Box>,
      )
    }

    if (count === 0) {
      return frame(
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>○</Text>
          <Text bold>Nothing pinned</Text>
        </Box>,
        <Box flexDirection="column">
          <Text>No CLAUDE.md was found for this project.</Text>
          <Text dimColor>Create CLAUDE.md in the project folder and it's pinned on your next message.</Text>
        </Box>,
        2,
      )
    }

    const heading = (title: string) => (
      <Box marginTop={1}>
        <Text bold>{title}</Text>
      </Box>
    )
    // Each file's name is a button that opens it; the first nine take a digit.
    let rows = 0
    const row = (key: string, name: string, tokens: string, detail: string, isNear = false) => {
      rows += 1
      const hotkey = rows <= 9 ? { hotkey: `${rows}` } : {}
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Button key={`open:${key}`} label={name} plain {...hotkey} onPress={view(key)} />
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{`~${tokens}`}</Text>
            </Box>
          </Box>
          <Box paddingLeft={3}>
            {isNear ? (
              <Text color="warning" wrap="truncate-end">
                {detail}
              </Text>
            ) : (
              <Text dimColor wrap="truncate-end">
                {detail}
              </Text>
            )}
          </Box>
        </Box>
      )
    }
    const always = pin.source === 'raw' ? [] : pin.files.filter(f => f.scope === undefined)
    const nested = pin.files.filter(f => f.scope !== undefined)
    const isRaw = pin.source === 'raw'
    // Rows the body takes: the hint, each section's gap and heading, two a file, the last change.
    const bodyRows =
      1 +
      (isRaw || always.length > 0 ? 2 : 0) +
      (nested.length > 0 ? 2 : 0) +
      (lastChange !== null ? 3 : 0) +
      2 * ((isRaw ? 1 : 0) + always.length + nested.length)

    return frame(
      <Box flexDirection="row" columnGap={2} flexShrink={1} minWidth={0}>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Text color="success">●</Text>
          <Text bold>{`${count} ${count === 1 ? 'file' : 'files'} pinned`}</Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">{`~${formatTokens(tokensOf(text ?? ''))} tokens`}</Text>
        </Box>
      </Box>,
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          Kept in sync with disk. Press a file to read it.
        </Text>

        {isRaw && heading('Loaded at startup')}
        {isRaw &&
          row(RAW, 'CLAUDE.md', formatTokens(tokensOf(pin.raw ?? '')), 'As another plugin rewrote it, until a file changes')}
        {always.length > 0 && heading('Loaded at startup')}
        {always.map(f =>
          row(keyOf(f.path), displayPath(f.path, places), formatTokens(tokensOf(f.content)), TIERS[f.kind] ?? f.kind),
        )}

        {nested.length > 0 && heading('Subfolders')}
        {nested.map(f => {
          const left = messagesLeft(f, turn)
          return row(
            keyOf(f.path),
            displayPath(f.path, places),
            formatTokens(tokensOf(f.content)),
            `Unpins after ${left} more ${left === 1 ? 'message' : 'messages'} without work here`,
            left <= NEAR_UNPIN,
          )
        })}

        {lastChange !== null && heading('Last change')}
        {lastChange !== null && (
          <Box flexDirection="row" columnGap={2}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end">{lastChange.text}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{ago(turn - lastChange.turn)}</Text>
            </Box>
          </Box>
        )}
      </Box>,
      bodyRows,
    )
  })

  // The wheel and scroll keys over the pane move its body; the top above it stays put.
  // A pane drawn whole, where it doesn't scroll itself, is scrolled by the engine, as usual.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!paneScrollsItself) return next(e)
    const top = await read($, paneTopAtom)
    const moved = scrolled(top, e.by, paneMaxTop)
    if (moved !== top) await update($, paneTopAtom, () => moved)
    return {}
  })
}
