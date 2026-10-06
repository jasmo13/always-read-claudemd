# always-read-claudemd

A Claude Code plugin that moves CLAUDE.md out of the conversation's first message and pins it in the system prompt, so its rules survive compaction. It also pins subfolder CLAUDE.md files while Claude works in them, and shows a band above the prompt and a `/claudemd` pane.

## Working rules

- Never merge pull requests. Open them and tell the user; they squash-merge themselves.
- Before opening a pull request, run `claude plugin test`, `tsc` and `claude plugin validate` in `plugins/always-read-claudemd/`, and all three must pass.
- Update `README.md` in the same pull request whenever a change adds a feature or changes behavior.
- Use Claude Sonnet 5.5 (`model: "sonnet"`) on high reasoning for any research subagent.
- Commit or push only when the user asks. Work on a feature branch, never on `main`.
- Ask before committing test fixtures, such as sample CLAUDE.md files made only to try the plugin out.

## Repository layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace: this repository lists its one plugin |
| `plugins/always-read-claudemd/.claude-plugin/plugin.json` | The plugin's manifest, version and types path |
| `plugins/always-read-claudemd/hooks/hooks.json` | Names the hooks module, `./register.tsx` |
| `plugins/always-read-claudemd/hooks/register.tsx` | Every hook: capture, pin, sync, subfolder pins, compaction note, band, pane |
| `plugins/always-read-claudemd/hooks/pin.ts` | Pure helpers: the pinned text, paths, token estimates, labels |
| `plugins/always-read-claudemd/hooks/register.test.ts` | Tests, run with `claude plugin test` |
| `plugins/always-read-claudemd/types/index.d.ts` | The `$.state` contract: every value the plugin keeps |
| `README.md` | Install, update and develop instructions, and what the plugin does |

## How the plugin works

### Capture and pin

1. `prompt.context` fires once per conversation and again after each compaction or `/clear`. The plugin runs `next(e)`, finds the `claudeMd` block, keeps its `instructionFiles`, and returns the blocks without it.
2. `prompt.compose` fires before every model request. The plugin re-syncs from disk, then appends one section, `always-read-claudemd:claudemd`, with `scope: 'session'`.
3. When another plugin rewrote the `claudeMd` text, `instructionFiles` is empty or missing. The plugin then pins the rewritten text as is (`source: 'raw'`) until a file on disk changes.

### Keeping it fresh

- `sync` runs at most once a second. It stats every pinned file, re-reads the ones whose mtime moved, drops deleted ones and adds new ones found where CLAUDE.md files can appear.
- New files are looked for in the user folder (`$CLAUDE_CONFIG_DIR` or `~/.claude`) and in the working directory and every folder above it.
- Each change is recorded as the pane's "Last change" and shown as a toast.

### Subfolder pins

- `tool.call` runs `next(e)` first, then looks at the tool's path arguments (`file_path`, `notebook_path`, `path`).
- A file tool (Read, Edit, Write, MultiEdit, NotebookEdit) in a folder with its own CLAUDE.md pins that file, scoped to its folder, found through `$.fs.ancestors`.
- Any tool call with a path inside a pinned folder, searches included, resets that pin's count.
- `prompt.submit` counts the person's messages. After 10 without work in a folder, its file is unpinned.

### Compaction

`session.compact` is synchronous on purpose. It adds a note to the summarizer's instructions saying the rules are pinned and still in force, after anything the person typed after `/compact`.

## The band and the pane

- The band hook calls `next(e)` first and draws the other plugins' bands above its own line. The slot holds one tree, so returning without them would hide every other plugin's band.
- The pane has a fixed toolbar and scrolls its own body under it, through a `ui.scroll` hook.
- `/claudemd` opens the pane only when it's closed. An open pane is left as it is.
- The plugin never writes to the chat. Commands return no text, and everything it reports is a toast or the status line.

### Design rules

- Colors are theme keys (`success`, `warning`) or `dimColor`, never raw colors or backgrounds, so everything reads in light and dark themes.
- Color carries state only: green for pinned, warning for a subfolder file 3 or fewer messages from unpinning.
- No middle-dot strings joining facts. Use spacing between Boxes, or a short sentence.
- No arrows in button labels, and no all-caps labels.
- Every row is cut to fit (`wrap="truncate-…"`) rather than wrapped, so narrow panes stay tidy.
- Tier names are in plain words: "This project, shared with the team", not "project".

## Plugin API notes

- Every hook is `($, e, next)`. `next(e)` runs the plugins beneath and then the engine.
- Op-event hooks in tests return `{ value }`.
- An atom's `plugin` and `key` must be string literals, or validation fails.
- A render hook never writes state. Write from a button's `onPress` or from another event.
- `$.store` keeps values across sessions; `$.state` keeps them for one session, through hot reloads.
- Module variables reset on every hot reload.

## Testing

- Every new behavior gets a test in `hooks/register.test.ts`.
- UI tests loop over `['terminal', 'desktop'] as const`, so nothing depends on one surface.
- `world()` fakes the disk, environment, clock, store and toasts. Register every mock before the first `$` call.
- Test hooks sit beneath the plugin and stand in for the engine. Anything the engine would answer, such as `ui.panes`, a test answers itself.
- Windows paths arrive with backslashes, so the fake disk keys paths through `keyOf`.

### Commands

From `plugins/always-read-claudemd/`:

```bash
claude plugin test .
```

```bash
npx -p typescript tsc -p .
```

```bash
claude plugin validate .
```

## Developing live

- Hot reload loads the copy in the session's dev-mods folder, not this repository. After changing anything, copy the changed files there.
- To try the terminal surface, run `claude --plugin-dir plugins/always-read-claudemd "/claudemd"` in a terminal tab, then close the tab when done.

## Writing style for the README and the UI

- Short, plain sentences in active voice. Name things by what the person sees, not by how the code works.
- Sentence case for headings and labels.
- One shell command per fenced block, tagged `bash`.
- A button's label says what it does, and the toast after it uses the same verb.

## Releasing

- Bump `version` in `plugins/always-read-claudemd/.claude-plugin/plugin.json` for each release.
- Releases come from `main`. People update with `claude plugin marketplace update` and then `claude plugin update`.
