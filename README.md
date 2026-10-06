# always-read-claudemd

A Claude Code plugin that pins your `CLAUDE.md` into the **system prompt**, so its rules are never lost when a conversation is compacted.

## Why

Claude Code normally puts your `CLAUDE.md` into the conversation's *first message*. When a long conversation is compacted, that message is replaced by a summary, and the rules can get paraphrased, weakened or lost. Claude then stops following them.

The system prompt is sent with every request and is never summarized. This plugin moves the `CLAUDE.md` text there.

## What it does

| When | What happens |
| --- | --- |
| Conversation starts | The plugin captures the `CLAUDE.md` block Claude Code built (every tier: managed, user `~/.claude/CLAUDE.md`, project, `CLAUDE.local.md`, auto-memory, `@imports`). It removes that block from the first message and pins it at the end of the system prompt instead, so nothing is duplicated. |
| Before **every** model request | It re-checks the files on disk, at most once a second. Edits, newly created files and deletions are picked up at Claude's next step, even partway through a turn. It shows a toast: *CLAUDE.md changed: re-pinned*. |
| Compaction (`/compact` or auto) | It tells the summarizer the rules are pinned and still in force, and asks it to keep any decisions or exceptions about them verbatim. Anything you typed after `/compact` stays first. |
| No `CLAUDE.md` anywhere | It does nothing and adds no tokens. The status line reads *CLAUDE.md: none found*. |
| Claude opens a file in a subfolder with its own `CLAUDE.md` | It pins that subfolder's file too, marked *apply when working in &lt;folder&gt;*, and shows a toast: *CLAUDE.md pinned: api/CLAUDE.md*. |
| 10 of your messages pass with no work in that subfolder | It unpins the subfolder's file and shows a toast: *CLAUDE.md unpinned: api/CLAUDE.md*. Opening a file there again pins it again. |

The status line shows *CLAUDE.md pinned · N files* while it is active.

### Where it looks for files

- **At startup:** whatever Claude Code itself loads. That's `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), plus `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the working directory and every folder above it, and files such as `.claude/rules/*.md`. All of them are pinned, top-level folder first.
- **Before each request:** the same user-level and parent-folder locations, so a file created there mid-chat is picked up.
- **Subfolders:** a subfolder's `CLAUDE.md` is pinned once Claude opens a file in that folder (Read, Edit, Write, MultiEdit or NotebookEdit). Only folders Claude actually works in are pinned, so the rest of the repo costs nothing.

### Subfolder files

A subfolder's file stays pinned while Claude keeps working in that folder. Any tool call with a path inside it counts, searches included, and resets the count. After 10 of your messages with no work there, the file is unpinned. It also survives compaction and `/clear`, like the startup files.

Claude Code also adds the subfolder's file to the conversation by itself when Claude first opens a file there. That copy is an ordinary message, so it can appear twice until the next compaction removes it.

## The band and the pane

**The band** is one line above the prompt, shown in every chat until you hide it:

```
CLAUDE.md pinned · 4 files · ~1.2k tokens · api unpins in 7      [ Details ] [ Hide ]
```

- **Details** (`d`) opens the pane.
- **Hide** (`h`) hides the band.

**The pane** opens with `/claudemd`. It shows:

- how many files are pinned and roughly how many tokens they take up
- each file's path, tier (user, project, local, managed, memory or subfolder) and size
- for subfolder files, how many more messages before they're unpinned
- the last change: what was edited, added, removed, pinned or unpinned

It has two buttons:

- **Show band** / **Hide band** (`b`)
- **Check now** (`c`), which re-reads the files on disk straight away

`/claudemd band` also shows or hides the band. Your choice is kept for every chat, new or old, until you change it.

## Installing

This repository is its own plugin marketplace, so two commands install it, whether or not you've added a marketplace before. In a terminal:

```bash
claude plugin marketplace add jasmo13/always-read-claudemd
```

```bash
claude plugin install always-read-claudemd@always-read-claudemd
```

Then open a new chat, or restart the desktop app. The status line shows *CLAUDE.md pinned · N files*. You need to be able to read this repository on GitHub. While it's private, that means being signed in to GitHub as someone with access, the same as for `git clone`.

To try it from a local copy in the terminal without installing:

```bash
claude --plugin-dir path/to/always-read-claudemd/plugins/always-read-claudemd
```

The plugin uses Claude Code's function-hook plugin API, and it was built and tested on Claude Code 2.1.288.

### Updating

Releases come from `main`. After a new version is merged, update with:

```bash
claude plugin marketplace update always-read-claudemd
```

```bash
claude plugin update always-read-claudemd@always-read-claudemd
```

Then reopen your chats or restart the app.

## Developing

The plugin lives in `plugins/always-read-claudemd/`; the repository root holds the marketplace (`.claude-plugin/marketplace.json`).

| Path | Contents |
| --- | --- |
| `hooks/register.tsx` | Hooks: capturing the CLAUDE.md block, pinning it in the system prompt, re-syncing from disk, subfolder pins, the compaction note, the band and the pane |
| `hooks/pin.ts` | Pure helpers: the pinned text, paths, token estimates |
| `hooks/register.test.ts` | Tests |
| `types/index.d.ts` | Types for the values the plugin keeps between reloads |
| `.claude-plugin/plugin.json` | The plugin's manifest and version |

Before opening a pull request, run these from `plugins/always-read-claudemd/`:

```bash
claude plugin test .
```

```bash
npx -p typescript tsc -p .
```

```bash
claude plugin validate .
```

`tsc` reads the `tsconfig.json` and types Claude Code writes into the plugin folder the first time it loads the plugin, for example with `claude --plugin-dir`. Both are git-ignored.

In the same pull request:

- Update this README whenever a change adds a feature or changes what the plugin pins, what the band and pane show, or how it behaves.
- To release, bump `version` in `plugins/always-read-claudemd/.claude-plugin/plugin.json`.

## License

[MIT](LICENSE)
