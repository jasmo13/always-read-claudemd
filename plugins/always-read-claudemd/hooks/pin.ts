import type { Pin, PinnedFile } from '../types'

// Where an instruction file can appear in a directory.
export const PROJECT_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']
// A subfolder's CLAUDE.md is unpinned after this many user messages with no work in its folder.
export const UNPIN_AFTER = 10
// Tools whose path argument means Claude opened a file there, so its folder's CLAUDE.md applies.
export const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const LABELS: Record<string, string> = {
  managed: "organization's managed policy",
  user: "user's private global instructions for all projects",
  project: 'project instructions, checked into the codebase',
  local: "user's private project instructions, not checked in",
  memory: "user's auto-memory, persists across conversations",
}

// What each tier is, as the pane words it for the person.
export const TIERS: Record<string, string> = {
  managed: "Your organization's policy",
  user: 'Yours, for every project',
  project: 'This project, shared with the team',
  local: 'This project, only on your machine',
  memory: 'Auto memory',
}

const OVERRIDE = 'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

// How versions before 0.9.0 began the CLAUDE.md message they put first in a chat at a compaction.
// Older chats still hold one, and the chat never draws it.
const OLD_HEADERS = [
  "This is the CLAUDE.md file: the user's instructions, exactly as they were on disk when this conversation was last compacted.",
  "This is the CLAUDE.md file: the user's instructions, exactly as they are on disk now. This message is kept first",
].map(line => `# CLAUDE.md\n\n${line}`)

/** Whether a message's text is the CLAUDE.md message a version before 0.9.0 put first in the chat. */
export function isMessage(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('<system-reminder>') || !trimmed.endsWith('</system-reminder>')) return false
  const body = trimmed.slice('<system-reminder>'.length).trim()
  return OLD_HEADERS.some(header => body.startsWith(header))
}

export const keyOf = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export const isAbsolute = (path: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(path)

/** Whether `path` is `dir` or lies under it. */
export const isInside = (path: string, dir: string) => {
  const p = keyOf(path)
  const d = keyOf(dir)
  return p === d || p.startsWith(`${d}/`)
}

/** The path arguments of a tool call: a file it opens, or a folder it searches. */
export function pathsOf(input: Record<string, unknown>): string[] {
  return ['file_path', 'notebook_path', 'path'].flatMap(name => {
    const value = input[name]
    return typeof value === 'string' && value !== '' ? [value] : []
  })
}

const SUBFOLDER = 'subfolder instructions; apply when working in '

const labelOf = (file: PinnedFile) => (file.scope === undefined ? (LABELS[file.kind] ?? file.kind) : `${SUBFOLDER}${file.scope}`)

const section = (file: PinnedFile) => `Contents of ${file.path} (${labelOf(file)}):\n\n${plain(file.content)}`

/**
 * The hidden block the plugin attaches to a message for Claude: each file in full, as it is on disk
 * now and as Claude Code loads it, then a line for each one removed or emptied. Null when
 * there is nothing to send.
 */
export function blockOf(files: PinnedFile[], removed: string[] = []): string | null {
  const shown = files.filter(f => plain(f.content) !== '')
  if (shown.length === 0 && removed.length === 0) return null
  const intro =
    shown.length === 0
      ? []
      : [
          "These are the user's CLAUDE.md instructions, exactly as they are on disk now. Their current text isn't in this conversation, so here it is: where anything earlier in the conversation differs, this is current. " +
            OVERRIDE,
        ]
  const gone = removed.map(path => `Removed: ${path}. Its instructions no longer apply.`)
  return ['# CLAUDE.md', ...intro, ...shown.map(section), ...gone].join('\n\n')
}

/** Everything pinned, as the hidden block would carry it all: what the line and the pane size. */
export function pinnedText(pin: Pin): string {
  const raw = pin.source === 'raw' ? (pin.raw ?? '').trim() : ''
  const files = pin.source === 'raw' ? pin.files.filter(f => f.scope !== undefined) : pin.files
  return [raw, blockOf(files) ?? ''].filter(t => t !== '').join('\n\n')
}

/** Text as it's compared: line endings as LF, and no space at either end. */
const plain = (text: string) => text.replace(/\r\n?/g, '\n').trim()

/**
 * One place the conversation shows Claude a file: a complete copy, under the heading or the tool
 * call that names the file (`head`), or the line saying it was removed (`text` null). A heading's
 * text runs on to the end of the text it's in; `isHeld` finds where the file ends.
 */
export type Copy = { head: string; text: string | null; isHeading: boolean }

// Claude Code's copies and the hidden block both head a file "Contents of <path>:" or
// "Contents of <path> (<label>):"; the block says a file was removed with a line of its own.
const MARKS = /^(?:Contents of (.+):\n\n|Removed: (.+)\. Its instructions no longer apply\.$)/gm
const REMINDERS = /<system-reminder>([\s\S]*?)(?:<\/system-reminder>|$)/g

// Read numbers each line ("12\t"; a last empty line keeps only its number) and can have notes added after the file.
const NUMBERED = /^ *\d+(?:\t|→|$)/
const readText = (result: string) => {
  const lines = (result.replace(/\r\n?/g, '\n').split('\n\n<system-reminder>')[0] ?? '').split('\n')
  return lines.every(line => NUMBERED.test(line)) ? lines.map(line => line.replace(NUMBERED, '')).join('\n') : null
}

type Block = { type?: string; text?: unknown; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }

/**
 * Every copy of a file the conversation shows Claude, in order (its Messages API form), then those
 * in `extra`, texts Claude is about to be given: Claude Code's copies and the hidden blocks, by
 * their headings; a Write's content; and a Read's result when it read the whole file.
 */
export function copiesOf(messages: readonly unknown[], extra: readonly string[] = []): Copy[] {
  const copies: Copy[] = []
  const marksIn = (text: string) => {
    for (const mark of text.matchAll(MARKS)) {
      const end = (mark.index ?? 0) + mark[0].length
      copies.push({ head: mark[1] ?? mark[2] ?? '', text: mark[1] === undefined ? null : text.slice(end), isHeading: true })
    }
  }
  // Claude Code's copies and the hidden blocks reach Claude as reminders: a file quoted anywhere
  // else, such as a command's output, isn't one.
  const scan = (text: string) => {
    for (const reminder of text.replace(/\r\n?/g, '\n').matchAll(REMINDERS)) marksIn(reminder[1] ?? '')
  }
  const calls = new Map<string, Block>()
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') scan(content)
    if (!Array.isArray(content)) continue
    for (const block of content as Block[]) {
      if (block.type === 'text' && typeof block.text === 'string') scan(block.text)
      if (block.type === 'tool_use' && block.id !== undefined) calls.set(block.id, block)
      if (block.type !== 'tool_result') continue
      const result =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? (block.content as Block[]).flatMap(b => (typeof b.text === 'string' ? [b.text] : [])).join('\n')
            : ''
      const call = calls.get(block.tool_use_id ?? '')
      const input = call?.input ?? {}
      const path = input.file_path
      if (!block.is_error && typeof path === 'string') {
        if (call?.name === 'Write' && typeof input.content === 'string') copies.push({ head: path, text: input.content, isHeading: false })
        const isWhole = input.limit === undefined && (input.offset === undefined || Number(input.offset) <= 1)
        const text = call?.name === 'Read' && isWhole ? readText(result) : null
        if (text !== null) copies.push({ head: path, text, isHeading: false })
      }
      // Claude Code adds a subfolder's CLAUDE.md to the result of the tool that opened a file there.
      scan(result)
    }
  }
  for (const text of extra) marksIn(text.replace(/\r\n?/g, '\n'))
  return copies
}

const names = (head: string, path: string) => {
  const h = keyOf(head)
  const k = keyOf(path)
  return h === k || h.startsWith(`${k} (`)
}

/** The text Claude saw last of a file: its latest copy; null when there's none, or Claude was last told it was removed. */
export function lastCopy(path: string, copies: readonly Copy[]): string | null {
  let last: string | null = null
  for (const copy of copies) if (names(copy.head, path)) last = copy.text
  return last
}

// Where a copy under a heading can end: the end of its text, Claude Code's closing tag, or the next file.
const ENDS = /^(?:$|<\/system-reminder>|Contents of |Removed: )/

/**
 * Whether Claude's latest copy of a file (`lastCopy`) is the file's whole text as it is now: the
 * copy must be that text and nothing more. `content` is the file as Claude Code loads it, `raw` as
 * it is on disk. An empty file is held when Claude has no text of it.
 */
export function isHeld(content: string, copy: string | null, raw = content): boolean {
  const shown = plain(content)
  if (copy === null) return shown === ''
  const seen = plain(copy)
  // Claude Code's copy and the hidden block show the file as Claude Code loads it; a Write or a Read, as it is on disk.
  const wants = shown === '' ? [''] : [shown, plain(raw)]
  return wants.some(want => seen.startsWith(want) && ENDS.test(seen.slice(want.length).trimStart()))
}

// A heading's path, before the label some headings add.
const HEADED = /^(.*?\.md)(?: \(.*\))?$/i

/** Whether a path has a subfolder file's name: CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md. */
export const isSubfolderName = (path: string) => /[\\/](?:\.claude[\\/])?CLAUDE(?:\.local)?\.md$/i.test(path)

/**
 * The instruction files Claude has a copy of under a heading, from Claude Code or a hidden block:
 * each path once. A file unpinned or deleted since is still checked while its copy is here.
 */
export function copiedPaths(copies: readonly Copy[]): string[] {
  const paths = new Map<string, string>()
  for (const copy of copies) {
    const path = copy.isHeading ? HEADED.exec(copy.head)?.[1] : undefined
    if (path !== undefined && !paths.has(keyOf(path))) paths.set(keyOf(path), path)
  }
  return [...paths.values()]
}

/** A subfolder's file Claude has a copy of that isn't pinned, as the hidden block names it. */
export function unpinnedFile(path: string, content: string): PinnedFile {
  const scope = path.replace(/[\\/][^\\/]*$/, '').replace(/[\\/]\.claude$/i, '')
  return { path, kind: /CLAUDE\.local\.md$/i.test(path) ? 'local' : 'project', content, mtimeMs: -1, scope }
}

/** How many files the pin carries, as the band and status line count them. */
export function countOf(pin: Pin): number {
  if (pin.source !== 'raw') return pin.files.length
  return 1 + pin.files.filter(f => f.scope !== undefined).length
}

/** A rough token count: about four characters a token. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4)

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/** User messages left before a subfolder's file is unpinned for lack of work in its folder. */
export function messagesLeft(file: PinnedFile, turn: number): number {
  return Math.max(0, UNPIN_AFTER - (turn - (file.lastUsedTurn ?? turn)))
}

/**
 * Where a file is, as the pane, its tab title and the toasts show it: the whole path, with `~` for
 * the home folder and forward slashes, so a project's CLAUDE.md says which project it's in.
 */
export function displayPath(path: string, places: { home?: string }): string {
  const { home } = places
  const shown = home !== undefined && home !== '' && isInside(path, home) ? `~${path.slice(home.replace(/[\\/]+$/, '').length)}` : path
  return shown.replace(/\\/g, '/')
}

/** A folder's own name, as the band shows it: `api/` for `C:\work\app\api`. */
export const folderName = (dir: string) => `${dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir}/`

/** The pane's tab title while a file is open: where it is, where it comes from, and its size. */
export function tabTitle(shown: string, detail: string, tokens: number): string {
  return `${shown}: ${detail} (~${formatTokens(tokens)} tokens, read-only)`
}

/** Where a scroll by `by` rows lands, kept between the top and the last row that can scroll into view. */
export const scrolled = (top: number, by: number, max: number) => Math.max(0, Math.min(Math.max(0, max), top + by))

/**
 * A scroll bar `shown` rows tall for content `total` rows tall scrolled `top` rows: true where the
 * thumb is. Null when everything fits, so there is nothing to scroll.
 */
export function scrollBar(shown: number, total: number, top: number): boolean[] | null {
  if (shown < 1 || total <= shown) return null
  const thumb = Math.max(1, Math.round((shown * shown) / total))
  const start = Math.round(((shown - thumb) * Math.min(top, total - shown)) / (total - shown))
  return Array.from({ length: shown }, (_, row) => row >= start && row < start + thumb)
}

/** Cells a row of texts takes, two apart. */
const rowWidth = (texts: string[]) => texts.reduce((n, t) => n + t.length, 0) + 2 * Math.max(0, texts.length - 1)

/**
 * What the band fits in `columns`: how many subfolder counts it names (two, then one with the rest
 * counted), and whether it keeps the file and token summary, dropped before the last folder.
 */
export function bandLayout(
  columns: number,
  parts: { status: string; summary: string; folders: string[]; buttons: number },
): { folders: number; hasSummary: boolean } {
  const n = parts.folders.length
  const tries =
    n === 0
      ? [{ folders: 0, hasSummary: true }]
      : [
          { folders: Math.min(2, n), hasSummary: true },
          { folders: 1, hasSummary: true },
          { folders: 1, hasSummary: false },
        ]
  const fits = tries.find(({ folders, hasSummary }) => {
    const more = n - folders
    const texts = [
      parts.status,
      ...(hasSummary ? [parts.summary] : []),
      ...parts.folders.slice(0, folders),
      ...(more > 0 ? [`+${more} more`] : []),
      'x'.repeat(parts.buttons),
    ]
    return rowWidth(texts) <= columns
  })
  return fits ?? { folders: 0, hasSummary: false }
}

// True for a tree that draws nothing. Beneath every band, the engine answers with a placeholder,
// { type: 'engine' }, that draws nothing in this slot; empty Boxes and nulls draw nothing either.
export function isBlank(node: unknown): boolean {
  if (node === null || node === undefined || typeof node === 'boolean' || node === '') return true
  if (Array.isArray(node)) return node.every(isBlank)
  if (typeof node !== 'object') return false
  const { type, children = [] } = node as { type?: string; children?: unknown[] }
  return type === 'engine' || (type === 'Box' && children.every(isBlank))
}
