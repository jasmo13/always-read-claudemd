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
| `hooks/register.ts` | Hooks: capturing the CLAUDE.md block, pinning it in the system prompt, re-syncing from disk, the compaction note |
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

- Update this README whenever a change adds a feature or changes what the plugin pins or how it behaves.
- To release, bump `version` in `plugins/always-read-claudemd/.claude-plugin/plugin.json`.

## License

[MIT](LICENSE)
