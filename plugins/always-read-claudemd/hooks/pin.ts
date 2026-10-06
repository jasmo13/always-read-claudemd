import type { Pin, PinnedFile } from '../types'

export const SECTION_ID = 'always-read-claudemd:claudemd'
// The most often the files are re-checked; each check is a few stats.
export const THROTTLE_MS = 1000
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

const HEADER = [
  '# CLAUDE.md (pinned)',
  '',
  "These are the user's CLAUDE.md instructions. They are pinned in the system prompt, so they stay in force for the whole session, including after the conversation is compacted or summarized, and they are re-synced from disk whenever the files change.",
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
].join('\n')

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

function section(file: PinnedFile): string {
  const label =
    file.scope === undefined
      ? (LABELS[file.kind] ?? file.kind)
      : `subfolder instructions; apply when working in ${file.scope}`
  return `Contents of ${file.path} (${label}):\n\n${file.content.trim()}`
}

/** The pinned text the model reads, or null when there is nothing to pin. */
export function render(pin: Pin): string | null {
  const nested = pin.files.filter(f => f.scope !== undefined)
  const shown = pin.source === 'raw' ? nested : pin.files
  const parts = [
    ...(pin.source === 'raw' && (pin.raw ?? '').trim() !== '' ? [(pin.raw ?? '').trim()] : []),
    ...shown.filter(f => f.content.trim() !== '').map(section),
  ]

  return parts.length === 0 ? null : `${HEADER}\n\n${parts.join('\n\n')}`
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
