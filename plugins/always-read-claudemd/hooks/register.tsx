import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

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
  folderName,
  formatTokens,
  isAbsolute,
  isInside,
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
const checkedAtom = atom({ plugin: 'always-read-claudemd', key: 'checkedAt' } as const, null)
const turnAtom = atom({ plugin: 'always-read-claudemd', key: 'turn' } as const, 0)
const changeAtom = atom({ plugin: 'always-read-claudemd', key: 'lastChange' } as const, null)
const bandAtom = atom({ plugin: 'always-read-claudemd', key: 'isBandShown' } as const, true)
const viewingAtom = atom({ plugin: 'always-read-claudemd', key: 'viewing' } as const, null)
const paneTopAtom = atom({ plugin: 'always-read-claudemd', key: 'paneTop' } as const, 0)

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

/** The status line's text. */
function statusOf(pin: Pin): string {
  const count = countOf(pin)
  return count === 0 ? 'No CLAUDE.md found' : `CLAUDE.md pinned, ${count} ${count === 1 ? 'file' : 'files'}`
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

/** Whether a path is an instruction file by its name: CLAUDE.md or CLAUDE.local.md. */
const isInstructionFile = (path: string) => /(^|\/)claude(\.local)?\.md$/.test(keyOf(path))

/** Shows or hides the band as it was last chosen, in this chat or another. */
async function followBand($: EngineInterface) {
  const stored = await $.store.get(BAND_KEY).catch(() => undefined)
  if (typeof stored === 'boolean' && stored !== (await read($, bandAtom))) await update($, bandAtom, () => stored)
}

/** Stores a new pin and says so: compaction flag, the pane's last change, and the tab title. */
async function settle($: EngineInterface, pin: Pin, change?: string) {
  await update($, pinAtom, () => pin)
  isPinned = render(pin) !== null
  if (change !== undefined) {
    const turn = await read($, turnAtom)
    await update($, changeAtom, () => ({ text: change, turn }))
  }
  await settleView($, pin).catch(() => undefined)
}

/** The pane's tab title for what it shows: the open file's name and size, or the plain title. */
async function titleFor($: EngineInterface, viewing: string | null): Promise<string> {
  if (viewing === null) return TITLE
  const pin = await read($, pinAtom)
  if (viewing === RAW && pin.source === 'raw') return tabTitle(TITLE, tokensOf(pin.raw ?? ''))
  const file = pin.files.find(f => keyOf(f.path) === viewing)
  return file === undefined ? TITLE : tabTitle(displayPath(file.path, await placesOf($)), tokensOf(file.content))
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Show what CLAUDE.md is pinned in the system prompt; "/claudemd band" shows or hides the band',
    }).catch(() => undefined)
    // An older version pinned its status among the engine's notices; the line lives under the prompt now.
    $.ui.status(undefined)
    await followBand($)
    await sync($, { force: true }).catch(() => undefined)

    return started
  })

  // Every chat watches the plugin's store files and the CLAUDE.md files it pins, so a choice made in
  // another chat, or a file edited anywhere, shows in each open chat at once, not at its next message.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const pinned = (await read($, pinAtom)).files.map(f => f.path)
    const found = (await discover($).catch(() => [])).map(f => f.path)
    const files = [...(await storeFiles($).catch(() => [])), ...pinned, ...found]
    const watched = files.filter((path, i) => files.findIndex(p => keyOf(p) === keyOf(path)) === i)
    return watched.length === 0 ? result : { ...result, watchPaths: [...(result.watchPaths ?? []), ...watched] }
  })

  // Known by name, so a hot reload (which keeps the watch but forgets the module's variables) still hears it.
  on('classic.FileChanged', ($, e, next) => {
    if (isStoreFile(e.file_path)) void followBand($).catch(() => undefined)
    else if (isInstructionFile(e.file_path)) void sync($, { force: true }).catch(() => undefined)
    return next(e)
  })

  // Answers with toasts and the pane alone: nothing is written to the chat.
  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'band') {
      const isShown = !(await read($, bandAtom))
      await setBand($, isShown)
      $.ui.toast(isShown ? 'CLAUDE.md band shown' : 'CLAUDE.md band hidden')
      return {}
    }
    await openPane($)

    return {}
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

  // The status line: a row of its own under the hint line below the prompt, which only the terminal
  // draws. ($.ui.status would pin it above, among the engine's notices, under a warning sign.)
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await next(e)
    if (e.surface !== 'terminal') return hint
    const { Box, Text } = $.ui.resolve(e)
    const pin = await read($, pinAtom)
    const count = countOf(pin)

    return (
      <Box flexDirection="column">
        {hint}
        <Box key="status" flexDirection="row" columnGap={1}>
          <Box flexShrink={0}>{count === 0 ? <Text dimColor>○</Text> : <Text color="success">●</Text>}</Box>
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {statusOf(pin)}
            </Text>
          </Box>
        </Box>
      </Box>
    )
  })

  // The band above the prompt: one quiet line, shown until hidden, beneath any other plugin's band.
  // Colors are theme keys or dim alone, never raw, so it reads in light and dark themes.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, bandAtom))) return next(e)

    // The slot holds one tree, so draw the other plugins' bands too rather than replacing them,
    // then a blank row and a rule, and this one last, at the bottom, next to the prompt.
    const others = await next(e)
    const hasOthers = !(others.type === 'Box' && (others.children ?? []).length === 0)
    const { Box, Button, Text } = $.ui.resolve(e)
    const pin = await read($, pinAtom)
    const turn = await read($, turnAtom)
    const count = countOf(pin)
    // Each subfolder file with its own count, the one closest to unpinning first; the band names
    // the first two, or one when the band is narrow, and counts the rest, which the pane lists.
    const nested = pin.files
      .flatMap(f => (f.scope === undefined ? [] : [{ folder: folderName(f.scope), left: messagesLeft(f, turn) }]))
      .sort((a, b) => a.left - b.left)
    const summary = `${count} ${count === 1 ? 'file' : 'files'}, ~${formatTokens(tokensOf(render(pin) ?? ''))} tokens`
    // What fits the band's width: fewer folders first, then no summary. The desktop draws its
    // buttons as keys in boxes, a few cells wider than the terminal's.
    const fit = bandLayout(e.props.bodyColumns, {
      status: count === 0 ? '○ No CLAUDE.md found' : '● CLAUDE.md pinned',
      summary,
      folders: nested.map(({ folder, left }) => `${folder} unpins in ${left}`),
      buttons: e.surface === 'terminal' ? 19 : 25,
    })
    const named = nested.slice(0, fit.folders)

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
          <Box flexDirection="row" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
            <Box flexShrink={0}>
              {count === 0 ? <Text dimColor>○</Text> : <Text color="success">●</Text>}
            </Box>
            <Box flexShrink={0}>
              <Text dimColor={count === 0}>{count === 0 ? 'No CLAUDE.md found' : 'CLAUDE.md pinned'}</Text>
            </Box>
            {count > 0 && fit.hasSummary && (
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor wrap="truncate-end">
                  {summary}
                </Text>
              </Box>
            )}
          </Box>
          {named.length > 0 && (
            <Box flexDirection="row" columnGap={2} flexShrink={0}>
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
            </Box>
          )}
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            <Button key="details" label="Details" hotkey="d" plain dimColor onPress={() => void openPane($)} />
            <Button key="hide" label="Hide" hotkey="h" plain dimColor onPress={() => setBand($, false)} />
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
    const bandButton = isBandShown ? (
      <Button key="band" label="Hide band" hotkey="h" plain dimColor onPress={() => setBand($, false)} />
    ) : (
      <Button key="band" label="Show band" hotkey="s" plain dimColor onPress={() => setBand($, true)} />
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
        ? { name: 'CLAUDE.md', detail: 'As another plugin rewrote it', content: pin.raw ?? '' }
        : opened === undefined
          ? undefined
          : {
              name: displayPath(opened.path, places),
              detail:
                opened.scope === undefined
                  ? (TIERS[opened.kind] ?? opened.kind)
                  : `Applies while Claude works in ${folderName(opened.scope)}`,
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
