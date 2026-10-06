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

The status line shows *CLAUDE.md pinned · N files* while it is active.

### Where it looks for new files

`~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), plus `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the working directory and every parent directory. Files Claude Code loaded at startup, such as `.claude/rules/*.md`, are tracked by path too.

`CLAUDE.md` files in subfolders are still loaded by Claude Code itself, on demand, when it works in those folders. This plugin leaves them alone.

## Install

In Claude Code:

```
/plugin marketplace add jasmo13/always-read-claudemd
/plugin install always-read-claudemd@always-read-claudemd
```

Or point Claude Code at a local checkout:

```bash
claude --plugin-dir ./plugins/always-read-claudemd
```

The plugin uses Claude Code's function-hooks API (`hooks/register.ts`), which is in early access in recent Claude Code builds.

## Develop

```bash
claude plugin validate plugins/always-read-claudemd
```

```bash
claude plugin test plugins/always-read-claudemd
```

## License

MIT
