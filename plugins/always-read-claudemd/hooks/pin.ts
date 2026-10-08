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

const section = (file: PinnedFile) => `Contents of ${file.path} (${labelOf(file)}):\n\n${file.content.trim()}`

/**
 * The hidden block the plugin attaches to a message for Claude: each file in full, as it is on disk
 * now, then a line for each removed one. Null when there is nothing to send.
 */
export function blockOf(files: PinnedFile[], removed: PinnedFile[] = []): string | null {
  const shown = files.filter(f => f.content.trim() !== '')
  if (shown.length === 0 && removed.length === 0) return null
  const intro =
    shown.length === 0
      ? []
      : [
          "These are the user's CLAUDE.md instructions, exactly as they are on disk now. Their current text isn't in this conversation, so here it is: where anything earlier in the conversation differs, this is current. " +
            OVERRIDE,
        ]
  const gone = removed.map(f => `Removed: ${f.path} (${labelOf(f)}). Its instructions no longer apply.`)
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

// Claude Code leaves HTML comments out of the copy of a CLAUDE.md it gives Claude.
const withoutComments = (text: string) => plain(text.replace(/<!--[\s\S]*?-->/g, ''))

/** Every text in a message's content, tool results and tool inputs included, thinking left out. */
function textsOf(content: unknown, into: string[]) {
  if (typeof content === 'string') into.push(content)
  else if (Array.isArray(content)) for (const part of content) textsOf(part, into)
  else if (content !== null && typeof content === 'object') {
    const block = content as { type?: string; text?: unknown; content?: unknown; input?: unknown }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return
    if (typeof block.text === 'string') into.push(block.text)
    if (block.content !== undefined) textsOf(block.content, into)
    if (block.input !== null && typeof block.input === 'object') textsOf(Object.values(block.input), into)
  }
}

/**
 * The conversation as Claude reads it (its Messages API form) as one text to look files up in,
 * with `extra` texts Claude is about to be given. Read shows a file with a number before each
 * line, so the text is kept a second time without them.
 */
export function contextOf(messages: readonly unknown[], extra: readonly string[] = []): string {
  const texts = [...extra]
  for (const message of messages) textsOf((message as { content?: unknown }).content, texts)
  const text = texts.join('\n\n').replace(/\r\n?/g, '\n')
  return `${text}\n\n${text.replace(/^ *\d+(?:\t|→)/gm, '')}`
}

/** Whether the conversation holds a file's whole text as it is now; an empty file needs nothing. */
export function isHeld(content: string, context: string): boolean {
  const text = plain(content)
  if (text === '') return true
  const bare = withoutComments(content)
  return context.includes(text) || (bare !== '' && context.includes(bare))
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
