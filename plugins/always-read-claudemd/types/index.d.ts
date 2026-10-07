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
  /**
   * For a subfolder's CLAUDE.md, pinned once Claude worked in it: the folder
   * it applies to. Absent for the files loaded at startup.
   */
  scope?: string
  /** For a subfolder's file: the user message count when Claude last worked in its folder. */
  lastUsedTurn?: number
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

/** The latest change to what is pinned, as the pane words it. */
export type PinChange = { text: string; turn: number }

declare module 'claude-code' {
  interface PluginState {
    'always-read-claudemd': {
      pin: Pin
      /** User messages sent this session; subfolder pins age by it. */
      turn: number
      lastChange: PinChange | null
      isBandShown: boolean
      /** The file the pane shows read-only (its path, or `raw` for rewritten text); null for the list. */
      viewing: string | null
      /** How many rows the pane's body is scrolled, under its fixed toolbar. */
      paneTop: number
    }
  }
}
