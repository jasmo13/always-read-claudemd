# Always read claudemd

A Claude Code plugin that keeps your `CLAUDE.md` as the **first message** of every chat, word for word, and rewrites that message whenever the files change, so its rules are never lost when a conversation is compacted.

## Why

Claude Code puts your `CLAUDE.md` into the conversation's first message. When a long conversation is compacted, that message is replaced by a summary, and the rules can get paraphrased, weakened or lost. Claude then stops following them. A file edited mid-chat is only added further down, so the old text stays in the conversation too.

This plugin keeps one message, first in the chat, that holds your `CLAUDE.md` files exactly as they are on disk. It never touches the system prompt.

## What it does

The message is a system reminder, wrapped in the same `<system-reminder>` tags Claude Code puts around its own. It starts with *# CLAUDE.md*, says it's the user's instructions as they are on disk now, and then holds each file in full, headed by where it is and what it is.

| When | What happens |
| --- | --- |
| A chat starts | The plugin puts the `CLAUDE.md` message first. It holds every file Claude Code loaded: managed, user `~/.claude/CLAUDE.md`, project, `CLAUDE.local.md`, rules, auto-memory and `@imports`. From then on, Claude Code's own copy is left out of what Claude reads, so nothing is there twice. |
| A chat is resumed | If the files are unchanged, nothing happens. If they changed while it was closed, the message is rewritten before Claude reads anything. Subfolder files the message held stay pinned. |
| A pinned `CLAUDE.md` is edited, created or deleted between turns | The message is rewritten at once, in every open chat, with a toast: *CLAUDE.md changed: re-pinned*. A file created where there was none is in it within a second. The old text is gone from the chat, not just superseded. |
| A file changes while Claude is working, or Claude edits it | The message is rewritten as soon as the turn ends, before your next message. |
| Compaction (`/compact` or auto) | Claude Code summarizes the chat as usual. The `CLAUDE.md` message is then put back first, whole, never summarized. |
| `/clear` | The chat is emptied, and the `CLAUDE.md` message is put back. |
| You rewind (`/rewind`, or Esc twice) | The chat goes back to how it was, with the `CLAUDE.md` message it had then. If the files have changed since, the message is rewritten from disk at once, before your next message. Restoring code as well puts back any `CLAUDE.md` Claude edited, and the message it had then matches it. |
| No `CLAUDE.md` anywhere | It adds no message and no tokens. Its line reads *No CLAUDE.md found*. |
| Claude opens a file in a subfolder with its own `CLAUDE.md` | That subfolder's file is added to the message when the turn ends, marked *apply when working in &lt;folder&gt;*, with a toast: *CLAUDE.md pinned: ~/app/api/CLAUDE.md*. |
| 10 of your messages pass with no work in that subfolder | It's taken out of the message, with a toast: *CLAUDE.md unpinned: ~/app/api/CLAUDE.md*. Opening a file there again pins it again. |
| A subagent runs | It reads `CLAUDE.md` the way Claude Code gives it to subagents, unchanged. |

### Where it looks for files

- **At startup:** whatever Claude Code itself loads. That's `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), plus `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the working directory and every folder above it, and files such as `.claude/rules/*.md`. All of them are pinned, top-level folder first.
- **Whenever it checks:** the same user-level and parent-folder locations, so a file created there mid-chat is picked up.
- **Symlinks:** a `CLAUDE.md` that is a symbolic link, say to an `AGENTS.md`, is read through the link and watched where it points, so editing `AGENTS.md` re-pins it like editing the `CLAUDE.md` itself.
- **Subfolders:** a subfolder's `CLAUDE.md` is pinned once Claude opens a file in that folder (Read, Edit, Write, MultiEdit or NotebookEdit). Only folders Claude actually works in are pinned, so the rest of the repo costs nothing.

### Subfolder files

A subfolder's file stays pinned while Claude keeps working in that folder. Any tool call with a path inside it counts, searches included, and resets the count. After 10 of your messages with no work there, the file is unpinned. It also survives compaction and `/clear`, like the startup files.

Claude Code also adds the subfolder's file by itself when Claude first opens a file there. Claude reads that copy for the rest of the turn; once the `CLAUDE.md` message holds the file, Claude Code's copy is left out.

## How the message is rewritten

Claude Code has no way for a plugin to edit a message in place. What it does let a plugin do is answer a compaction. So when the files change, the plugin runs a compaction and answers it itself: nothing is summarized. The chat comes back exactly as it was, with the old `CLAUDE.md` message taken out and the new one put first.

- **The message itself isn't drawn in the chat.** The line and the pane show what's pinned, and a toast says when it changes.
- **Each rewrite shows in the chat** as */compact* and *Compacted* lines. That's the plugin's rewrite, not a summary. Claude Code draws those lines itself and doesn't let a plugin hide them.
- **It never happens partway through a turn.** It happens when a chat starts or resumes, when a turn ends, after a rewind, or at once when a file changes while Claude is idle.
- **The terminal and the desktop app work the same way.** The desktop app also brings the message up to date when it opens a chat that changed while it was in the background.
- **In `claude -p` and SDK apps that don't show the chat,** it only happens as a run starts. These runs print the last result they have, and a rewrite after the answer would replace it. A file changed during a run is in the message at the start of the next one. A subfolder file pinned during a `-p` run isn't carried into the next run.
- **After a real `/compact`,** Claude Code's summary may still mention what older versions of the files said, as history. The `CLAUDE.md` message above it is the current text, and it says so.

## The line and the pane

Both use your theme's own colors, so they look right in light and dark themes, in the terminal and the desktop app. Color only ever means something: a green dot when files are pinned, and a warning color when a subfolder file is 3 messages or fewer from being unpinned.

**The line** says what's pinned, in every chat until you hide it. *CLAUDE.md pinned* is in the text color, and the rest in gray:

```
● CLAUDE.md pinned  4 files, ~1.2k tokens  api/ unpins in 3  web/ unpins in 7
```

Each subfolder file has its own count of messages left before it's unpinned. The line names the two closest to being unpinned, and adds *+N more* when there are others. The pane lists them all.

In the terminal, it's the status line under the prompt, below the mode line, so nothing is added above the prompt. The rest of the row is cut off when the terminal is too narrow for it all. `/claudemd` opens and closes the pane.

In the desktop app, which has no line under the prompt, it's a band above the prompt instead, with two buttons:

- **Details** (`o`) opens the pane.
- **Hide** (`x`) hides the band.

These keys work while the band is focused, with a click or `ctrl+x tab`. They differ from the keys in usage-mod's band menu, so the two bands never fight over a key. On a narrow band, it names one subfolder file, then drops the file count and size.

If other plugins also draw bands above the prompt, they're all shown. This one comes last, next to the prompt, with a blank row and a line separating it from theirs. With no other band, there's no line.

**The pane** opens with `/claudemd`. In the desktop app:

```
● 2 files pinned  ~376 tokens                  h: Hide band
───────────────────────────────────────────────────────────
Kept in sync with disk. Press a file to read it.

Loaded at startup
1: ~/app/CLAUDE.md                                     ~114
   This project, shared with the team

Subfolders
2: ~/app/api/CLAUDE.md                                  ~87
   Unpins after 10 more messages without work here

Last change
Pinned ~/app/api/CLAUDE.md                     this message
```

In the terminal, the button reads **Hide status line**. Everything above the rule stays put and everything under it scrolls with the mouse wheel or the page keys, so a long file never pushes that button out of sight. A scroll bar on the right shows where you are, whenever there's more than fits. The desktop app scrolls the pane itself, with its own scroll bar, so there the whole pane scrolls, top included. So that you always know which file is open, the pane's tab title names it, where it comes from and its size, such as *~/app/CLAUDE.md: This project, shared with the team (~1.7k tokens, read-only)*. Both leave a margin between the text and the pane's edges.

The pane's frame and background come from Claude Code's theme. If the pane looks dark in a light terminal, choose a light theme with `/theme`.

- **Loaded at startup** lists the files Claude Code loaded when the chat began, each with where it comes from: yours for every project, this project's shared file, your private one for this project, your organization's policy or auto memory.
- **Subfolders** lists the subfolder files, each with how many more messages before it's unpinned.
- **Last change** is what was last edited, added, removed, pinned or unpinned, and when.

Every file is named by where it is, with `~` for your home folder, so a project's file says which project it's in. Press a file's name to read it, or its number (`1`–`9`) in the terminal. The pane shows that file read-only, exactly as it's pinned now, with **Back** (`b`) in the top row to return to the list. Where the file comes from and its size sit above the line, so what scrolls is the file itself.

`/claudemd` opens the pane, on the list of files, or closes it when it's open. Pinning runs in the background either way.

Apart from the `CLAUDE.md` message and the */compact* lines each rewrite leaves, the plugin never writes to the chat; everything it reports is a toast. There's no refresh button, because the files are watched, and checked again every second and at every turn. **Hide band** (`h`) / **Show band** (`s`) in the pane hides or shows the line, and so does `/claudemd band`, with a toast: *CLAUDE.md line hidden*. Your choice is kept for every chat, new or old, until you change it. Chats that are already open follow it at once.

## Installing

This repository is its own plugin marketplace, so two commands install it, whether or not you've added a marketplace before. In a terminal:

```bash
claude plugin marketplace add jasmo13/always-read-claudemd
```

```bash
claude plugin install always-read-claudemd@always-read-claudemd
```

Then open a new chat, or restart the desktop app. The line shows *CLAUDE.md pinned*: under the prompt in the terminal, above it in the desktop app. You need to be able to read this repository on GitHub. While it's private, that means being signed in to GitHub as someone with access, the same as for `git clone`.

To try it from a local copy in the terminal without installing:

```bash
claude --plugin-dir path/to/always-read-claudemd/plugins/always-read-claudemd
```

The plugin uses Claude Code's function-hook plugin API, and it was built and tested on Claude Code 2.1.292.

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
| `hooks/register.tsx` | Hooks: capturing the files Claude Code loaded, keeping the `CLAUDE.md` message first and rewriting it, leaving out Claude Code's own copies, re-syncing from disk, subfolder pins, the band and the pane |
| `hooks/pin.ts` | Pure helpers: the `CLAUDE.md` message and reading it back, paths, token estimates |
| `tests/register.test.ts` | Tests |
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

`tsc` reads `tsconfig.json`, which points to the types Claude Code writes into the plugin's `.claude-plugin/types/` folder the first time it loads the plugin, for example with `claude --plugin-dir`. Git ignores that folder through a `.gitignore` Claude Code writes inside it.

In the same pull request:

- Update this README whenever a change adds a feature or changes what the plugin pins, what the band and pane show, or how it behaves.
- To release, bump `version` in `plugins/always-read-claudemd/.claude-plugin/plugin.json`.

## License

[MIT](LICENSE)
