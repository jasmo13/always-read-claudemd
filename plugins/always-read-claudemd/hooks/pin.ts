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

// Short tier names for the pane and band.
export const TIERS: Record<string, string> = {
  managed: 'managed',
  user: 'user',
  project: 'project',
  local: 'local',
  memory: 'memory',
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

/** A path as the pane shows it: relative to the project, `~` for the home folder, else whole. */
export function displayPath(path: string, places: { root?: string; home?: string }): string {
  const { root, home } = places
  if (root !== undefined && root !== '' && isInside(path, root) && keyOf(path) !== keyOf(root)) {
    return path.slice(root.replace(/[\\/]+$/, '').length + 1)
  }
  if (home !== undefined && home !== '' && isInside(path, home)) {
    return `~${path.slice(home.replace(/[\\/]+$/, '').length)}`
  }
  return path
}
