/** One instruction file whose text is pinned, as last read. */
export type PinnedFile = {
  /** Absolute path. */
  path: string
  /** `managed`, `user`, `project`, `local` or `memory`. */
  kind: string
  /** The file's text as last read. */
  content: string
  /** Last modification seen, ms since the epoch; -1 when not yet stat'd. */
  mtimeMs: number
}

/**
 * What is pinned: the files behind it, or `raw` text when another plugin
 * rewrote the claudeMd block (then `files` are the ones on disk, watched for
 * changes, and the first change replaces the raw text with them).
 */
export type Pin = {
  files: PinnedFile[]
  raw: string | null
  /** Where the current pin came from. */
  source: 'engine' | 'discovered' | 'raw' | null
}

declare module 'claude-code' {
  interface PluginState {
    'always-read-claudemd': { pin: Pin; checkedAt: number | null }
  }
}
