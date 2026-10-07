# Always read claudemd

A Claude Code plugin that pins your `CLAUDE.md` into the **system prompt**, so its rules are never lost when a conversation is compacted.

## Why

Claude Code normally puts your `CLAUDE.md` into the conversation's *first message*. When a long conversation is compacted, that message is replaced by a summary, and the rules can get paraphrased, weakened or lost. Claude then stops following them.

The system prompt is sent with every request and is never summarized. This plugin moves the `CLAUDE.md` text there.

## What it does

| When | What happens |
| --- | --- |
| Conversation starts | The plugin captures the `CLAUDE.md` block Claude Code built (every tier: managed, user `~/.claude/CLAUDE.md`, project, `CLAUDE.local.md`, auto-memory, `@imports`). It removes that block from the first message and pins it at the end of the system prompt instead, so nothing is duplicated. |
| Before **every** model request | It re-checks the files on disk, at most once a second. Edits, newly created files and deletions are picked up at Claude's next step, even partway through a turn. It shows a toast: *CLAUDE.md changed: re-pinned*. |
| A pinned `CLAUDE.md` is edited, by anyone | Every open chat re-pins it at once, without waiting for its next message, and shows the same toast. |
| Compaction (`/compact` or auto) | It tells the summarizer the rules are pinned and still in force, and asks it to keep any decisions or exceptions about them verbatim. Anything you typed after `/compact` stays first. |
| No `CLAUDE.md` anywhere | It does nothing and adds no tokens. Its line reads *No CLAUDE.md found*. |
| Claude opens a file in a subfolder with its own `CLAUDE.md` | It pins that subfolder's file too, marked *apply when working in &lt;folder&gt;*, and shows a toast with where it is: *CLAUDE.md pinned: ~/app/api/CLAUDE.md*. |
| 10 of your messages pass with no work in that subfolder | It unpins the subfolder's file and shows a toast: *CLAUDE.md unpinned: ~/app/api/CLAUDE.md*. Opening a file there again pins it again. |

### Where it looks for files

- **At startup:** whatever Claude Code itself loads. That's `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), plus `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the working directory and every folder above it, and files such as `.claude/rules/*.md`. All of them are pinned, top-level folder first.
- **Before each request:** the same user-level and parent-folder locations, so a file created there mid-chat is picked up.
- **Subfolders:** a subfolder's `CLAUDE.md` is pinned once Claude opens a file in that folder (Read, Edit, Write, MultiEdit or NotebookEdit). Only folders Claude actually works in are pinned, so the rest of the repo costs nothing.

### Subfolder files

A subfolder's file stays pinned while Claude keeps working in that folder. Any tool call with a path inside it counts, searches included, and resets the count. After 10 of your messages with no work there, the file is unpinned. It also survives compaction and `/clear`, like the startup files.

Claude Code also adds the subfolder's file to the conversation by itself when Claude first opens a file there. That copy is an ordinary message, so it can appear twice until the next compaction removes it.

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

The plugin never writes to the chat; everything it reports is a toast. There's no refresh button, because the files are re-checked before every request. **Hide band** (`h`) / **Show band** (`s`) in the pane hides or shows the line, and so does `/claudemd band`, with a toast: *CLAUDE.md line hidden*. Your choice is kept for every chat, new or old, until you change it. Chats that are already open follow it at once.

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
