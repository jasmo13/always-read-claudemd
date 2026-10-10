# Always read claudemd

A Claude Code plugin that makes sure Claude has your `CLAUDE.md` as it is on disk now, word for word. When Claude doesn't have a file's current text, the plugin sends it as a **hidden part of your next message**. You don't see it in the chat, but Claude does, and it stays in that message, so Claude can refer back to it later.

**It never compacts a chat, never rewrites a message already sent, and never touches the system prompt.**

## Why

Claude Code gives Claude your `CLAUDE.md` when a chat starts, and again after a compaction. Between those times it can fall out of date:

- **Edits made outside Claude Code aren't sent.** If you change a `CLAUDE.md` in your editor, in another chat or with git mid-chat, Claude keeps working from the old text.
- **A compaction drops subfolder rules.** A `CLAUDE.md` in a subfolder Claude was working in only comes back when Claude opens a file there again, so until then Claude works without it.
- **You can't see which rules Claude is working under**, or how many tokens they cost.

## What it does

At each message you send, before it goes to Claude, the plugin reads the conversation exactly as Claude will read it, finds the latest complete copy of each file in it, and compares that copy with the file on disk.

- If Claude's latest copy **is** the file, exactly as it is now, nothing is sent.
- If it isn't, the file is sent in full with your message, with a toast: *CLAUDE.md edited and sent to Claude: ~/app/CLAUDE.md*. If Claude has no copy at all (a new file, or one a compaction dropped), the toast reads *CLAUDE.md sent to Claude: ~/app/CLAUDE.md*.

A message that sends nothing shows no toast.

Only a complete copy of that same file counts, and it has to be the whole file, nothing more and nothing less:

- **Claude Code's own copy**, and the plugin's earlier hidden blocks, each under a heading naming the file.
- **Claude's own Write** of the file, which holds its whole text.
- **A Read of the whole file.** The line numbers Read adds are ignored. A Read of part of the file doesn't count.
- **An Edit doesn't count.** It shows Claude only a snippet, so after an Edit the whole file goes with your next message.
- Nothing else counts: not your messages, Claude's replies or a command's output, even when they quote the file.

So deleting a line counts as a change too: Claude's old copy has more in it than the file now, so the new text is sent. Line endings and space at the very start or end don't count as differences.

Each file is read through Claude Code's own loader, so the plugin sees and sends it the way Claude Code gives it to Claude: without the HTML comments and frontmatter Claude Code leaves out. Changing only a comment sends nothing. A file left with nothing but comments counts as removed. A Read or Write of the file, comments and all, still counts as Claude's copy.

| When | What happens |
| --- | --- |
| A chat starts, is resumed, or after `/clear` | Nothing extra. Claude Code gives Claude its `CLAUDE.md` with that message, so the plugin sends nothing. It notes which files Claude Code loaded: managed, user `~/.claude/CLAUDE.md`, project, `CLAUDE.local.md`, rules, auto-memory and `@imports`. |
| A `CLAUDE.md` is edited outside Claude Code | With your next message, the new text is sent, with one toast: *CLAUDE.md edited and sent to Claude*. Opening the pane shows the edit sooner. |
| Claude edits a `CLAUDE.md` | A Write needs nothing more. After an Edit, the whole file is sent with your next message. |
| You send messages while Claude is working | Each is checked the same way. When several reach Claude together, the block goes with the first only. |
| A compaction (`/compact`, or Claude Code's own when the chat is full) | Claude Code gives Claude its startup files again, so they aren't sent twice. Any pinned subfolder file it dropped is sent with your next message. |
| A new `CLAUDE.md` appears | It's pinned and sent with your next message. |
| A file is deleted, emptied, or left with nothing but comments | This covers a `CLAUDE.md`, a rules file, an `@import` or auto-memory. If Claude has a copy of it, your next message says once that it was removed and no longer applies. |
| Claude opens a file in a subfolder with its own `CLAUDE.md` | That file is pinned, with a toast: *CLAUDE.md pinned: ~/app/api/CLAUDE.md*. Claude Code gives Claude a copy itself; the plugin sends it only if that copy is missing or out of date. |
| 10 of your messages pass with no work in that subfolder | It's unpinned, with a toast: *CLAUDE.md unpinned: ~/app/api/CLAUDE.md*. It isn't sent again after a compaction, but while Claude still has a copy, an edit or deletion is still sent. Opening a file there again pins it again. |
| No `CLAUDE.md` anywhere | Nothing is sent. Its line reads *No CLAUDE.md found*. |
| A subagent runs | It reads `CLAUDE.md` the way Claude Code gives it to subagents, unchanged. |

### The hidden block

The block goes with your message as context added by a hook, the same way Claude Code adds its own reminders. Claude reads it as part of that message, wrapped in `<system-reminder>` tags. It isn't drawn in the chat in the terminal or the desktop app. It's saved with the message, so it's still there on later turns and when you resume the chat, and Claude can refer back to it. It looks like this:

```
# CLAUDE.md

These are the user's CLAUDE.md instructions, exactly as they are on disk now. Their current text isn't in this conversation, so here it is: where anything earlier in the conversation differs, this is current. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

Contents of C:\Users\you\app\CLAUDE.md (project instructions, checked into the codebase):

Use spaces.
Run the tests first.

Contents of C:\Users\you\app\api\CLAUDE.md (subfolder instructions; apply when working in C:\Users\you\app\api):

Validate every endpoint.

Removed: C:\Users\you\app\CLAUDE.local.md. Its instructions no longer apply.
```

Only the files Claude lacks are in it. Once a file's text has been sent, the block is Claude's latest copy, so it isn't sent again until the file changes.

Chats from versions before 0.9.0 may hold the `CLAUDE.md` message those versions put first. It's still never drawn in the chat, and Claude still counts its text.

### Where it looks for files

- **At startup:** whatever Claude Code itself loads. That's `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), plus `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the working directory and every folder above it, and files such as `.claude/rules/*.md`. All of them are pinned, top-level folder first.
- **At each of your messages:** every pinned file is read again, and the user-level and parent-folder locations are checked for new files. This is the only check that decides what Claude is sent, and nothing is sent while you're idle.
- **For the line and the pane, as a chat opens and then once a second:** the files are checked on disk, so the line and the pane show them as they are now. A `CLAUDE.md` created, edited or deleted while you're idle shows within a second, and the line has them before your first message, though the desktop app doesn't load its `CLAUDE.md` until you send one. A file open in the pane follows its edits within a second too, and when it's deleted the pane goes back to the list. This check only feeds the line and the pane, and only while one of them is shown: it pins nothing and decides nothing about what Claude is sent. That waits for your next message.
- **When you open the pane, press a file in it, or go back to the list:** the files are also read from disk right then, so the pane doesn't wait for the next second.
- **Symlinks:** a `CLAUDE.md` that is a symbolic link, say to an `AGENTS.md`, is read through the link, so editing `AGENTS.md` counts as editing the `CLAUDE.md` itself.
- **Subfolders:** a subfolder's `CLAUDE.md` is pinned once Claude opens a file in that folder (Read, Edit, Write, MultiEdit or NotebookEdit). Only folders Claude actually works in are pinned, so the rest of the repo costs nothing.

### Subfolder files

A subfolder's file stays pinned while Claude keeps working in that folder. Any tool call with a path inside it counts, searches included, and resets the count. After 10 of your messages with no work there, the file is unpinned.

Unpinning doesn't take the file out of the chat: Claude keeps the copy it has. So until a compaction drops that copy, the file is still checked at each message, and if you edit or delete it, Claude is sent the new text or told it was removed. After the compaction it isn't sent again, unless Claude works in that folder again.

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
As on disk now. Press a file to read it.

Loaded at startup
1: ~/app/CLAUDE.md                                     ~114
   This project, shared with the team

Subfolders
2: ~/app/api/CLAUDE.md                                  ~87
   Unpins after 10 more messages without work here

Last change
Edited and sent to Claude: ~/app/api/CLAUDE.md this message
```

In the terminal, the button reads **Hide status line**. Everything above the rule stays put and everything under it scrolls with the mouse wheel or the page keys, so a long file never pushes that button out of sight. A scroll bar on the right shows where you are, whenever there's more than fits. The desktop app scrolls the pane itself, with its own scroll bar, so there the whole pane scrolls, top included. So that you always know which file is open, the pane's tab title names it, where it comes from and its size, such as *~/app/CLAUDE.md: This project, shared with the team (~1.7k tokens, read-only)*. Both leave a margin between the text and the pane's edges.

The pane's frame and background come from Claude Code's theme. If the pane looks dark in a light terminal, choose a light theme with `/theme`.

- **Loaded at startup** lists the files Claude Code loaded when the chat began, each with where it comes from: yours for every project, this project's shared file, your private one for this project, your organization's policy or auto memory.
- **Subfolders** lists the subfolder files, each with how many more messages before it's unpinned.
- **Last change** is the last thing that happened, and when: a file edited, added, removed, pinned or unpinned, or sent to Claude. An edit sent with your message reads *Edited and sent to Claude*.

Every file is named by where it is, with `~` for your home folder, so a project's file says which project it's in. Press a file's name to read it, or its number (`1`–`9`) in the terminal. The pane shows that file read-only, as it is on disk now (edits show within a second) and as Claude gets it, without HTML comments, with **Back** (`b`) in the top row to return to the list. Where the file comes from and its size sit above the line, so what scrolls is the file itself.

`/claudemd` opens the pane, on the list of files, or closes it when it's open. **Esc** closes it too, as it does other panes, while the pane has the keyboard. Pinning runs in the background either way.

Apart from the hidden block, the plugin never writes to the chat; everything it reports is a toast. It shows one only when:

- it sends Claude a file;
- it pins or unpins a subfolder file;
- you open or close the pane: *CLAUDE.md pane opened.*, *CLAUDE.md pane closed; /claudemd opens it again.*;
- you hide or show the line.

There's no refresh button: opening the pane or a file in it reads the files from disk. **Hide band** (`h`) / **Show band** (`s`) in the pane hides or shows the line, and so does `/claudemd band`, with a toast: *CLAUDE.md line hidden*. Your choice is kept for every chat, new or old, until you change it. Chats that are already open follow it at their next message.

The terminal, the desktop app and `claude -p` work the same way.

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

The plugin uses Claude Code's function-hook plugin API, and it was built and tested on Claude Code 2.1.292 in the terminal and 2.1.293 in the desktop app.

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
| `hooks/register.tsx` | Hooks: capturing the files Claude Code loaded, reading files through Claude Code's loader, checking the conversation at each message and attaching the hidden block, re-syncing from disk, subfolder pins, the band and the pane, and the line's and the pane's once-a-second look at the disk |
| `hooks/pin.ts` | Pure helpers: the hidden block, finding each file's latest copy in the conversation, paths, token estimates |
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

- Update this README whenever a change adds a feature or changes what the plugin pins, what it sends Claude, what the band and pane show, or how it behaves.
- To release, bump `version` in `plugins/always-read-claudemd/.claude-plugin/plugin.json`.

## License

[MIT](LICENSE)
