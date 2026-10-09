import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { InstructionFile, On, RenderElement, PromptContextInput, SessionMessage, UiPane } from 'claude-code'

import { bandLayout, blockOf, copiesOf, displayPath, isBlank, isHeld, isMessage, lastCopy, scrollBar, scrolled, tabTitle } from '../hooks/pin'

const HOME = 'C:/home'
const PROJECT = 'C:/work/app'
const PROJECT_MD = `${PROJECT}/CLAUDE.md`
const LOCAL_MD = `${PROJECT}/CLAUDE.local.md`
const USER_MD = `${HOME}/.claude/CLAUDE.md`
const API_MD = `${PROJECT}/api/CLAUDE.md`
const API_FILE = `${PROJECT}/api/orders.ts`
// How versions before 0.8.0 began the message, as older chats still hold it.
const OLD_HEADER = [
  '# CLAUDE.md',
  '',
  "This is the CLAUDE.md file: the user's instructions, exactly as they are on disk now. This message is kept first in the conversation and rewritten whenever the files change, so where anything later in the conversation disagrees with it, this message is current. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
].join('\n')

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const
const MESSAGE: SessionMessage = { role: 'user', text: 'hello', toolUses: [] }
const REPLY: SessionMessage = { role: 'assistant', text: 'Hi.', toolUses: [] }
const SUBMIT = { text: 'next', wait: false, origin: { kind: 'composer' } } as const

// The engine hands paths to fs hooks in the platform's own spelling.
const keyOf = (path: string) => path.replace(/\\/g, '/').toLowerCase()

/**
 * A fake file system, the session's environment and clock beneath the plugin. `links` maps a
 * symbolic link to the file it points at: like `$.fs.stat` and `$.fs.read`, the fake reads through it.
 */
function world(on: On, files: Record<string, string>, now: number, links: Record<string, string> = {}) {
  const disk = new Map<string, { path: string; content: string; mtimeMs: number }>()
  const write = (path: string, content: string) => {
    const mtimeMs = (disk.get(keyOf(path))?.mtimeMs ?? 0) + 1
    disk.set(keyOf(path), { path, content, mtimeMs })
  }
  const remove = (path: string) => disk.delete(keyOf(path))
  for (const [path, content] of Object.entries(files)) write(path, content)
  const linkOf = (path: string) => Object.entries(links).find(([from]) => keyOf(from) === keyOf(path))?.[1]
  const fileAt = (path: string) => disk.get(keyOf(linkOf(path) ?? path))

  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  on('fs.stat', (_$, e) => {
    const file = fileAt(e.path)
    if (file === undefined) throw missing(e.path)
    return { value: { kind: 'file', size: file.content.length, mtimeMs: file.mtimeMs, isLink: linkOf(e.path) !== undefined } } as never
  })
  on('fs.read', (_$, e) => {
    const file = fileAt(e.path)
    if (file === undefined) throw missing(e.path)
    return { value: file.content } as never
  })
  on('fs.ancestors', (_$, e) => {
    // Without `of`: the working directory's own files. With it: each folder
    // strictly below `below` down to the file's folder.
    const dirs: string[] = []
    if (e.of === undefined) {
      dirs.push(PROJECT)
    } else {
      const base = keyOf(e.below ?? '')
      const parts = keyOf(e.of).split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (dir.startsWith(`${base}/`)) dirs.push(dir)
      }
    }
    const found = dirs.flatMap(dir =>
      e.names.flatMap(name => {
        const file = disk.get(keyOf(`${dir}/${name}`))
        if (file === undefined) return []
        // Claude Code's loader leaves HTML comments out: here, a line of one.
        const content = file.content.replace(/^<!--.*-->\n?/gm, '')
        return [{ dir, name, content, parts: [{ path: file.path, content }] }]
      }),
    )
    return { value: found } as never
  })
  on('session.root', () => ({ value: PROJECT }) as never)
  mock.env(on, { USERPROFILE: HOME })
  // The plugin's store, shared by every chat.
  const stored = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }) as never)
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)
    return { value: undefined } as never
  })
  // What the engine draws where the plugin draws nothing: an empty box.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  const clock = mock.clock(on, { now })

  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })

  return { clock, statuses, stored, toasts, write, remove }
}

/**
 * The engine beneath the plugin: its first-message context (a claudeMd block
 * when files are given, and the files behind it) and a one-section system
 * prompt. Returns the context input to raise `prompt.context` with.
 */
function engine(on: On, files: InstructionFile[] | null, options: { rewrittenAs?: string } = {}): PromptContextInput {
  on('prompt.context', (_$, e) => {
    const { rewrittenAs } = options
    if (rewrittenAs === undefined) return { blocks: e.blocks, instructionFiles: files ?? [] }
    // A hook rewrote the claudeMd text: the files behind it become unknown.
    return { blocks: e.blocks.map(b => (b.name === 'claudeMd' ? { ...b, text: rewrittenAs } : b)) }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))

  return {
    blocks: [
      ...(files === null ? [] : [{ name: 'claudeMd', text: files.map(f => f.content).join('\n') }]),
      { name: 'currentDate', text: "Today's date is 2026-10-06." },
    ],
    instructionFiles: [],
  }
}

/** How Claude Code puts a block a prompt.submit hook attached into the message Claude reads. */
const hidden = (block: string) => `<system-reminder>\nprompt.submit hook additional context: ${block}\n</system-reminder>`

/** How Claude Code gives Claude text of its own, its CLAUDE.md copies among it. */
const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`

/**
 * The chat beneath the plugin, as Claude reads it (`$.session.messages({ as: 'api' })`): each
 * message sent lands in it with the blocks hooks attached, and Claude Code's /compact replaces it
 * with a summary. `swaps` counts every /compact anyone ran: the plugin must never run one.
 */
function conversation($: Engine, on: On, history: unknown[] = []) {
  const chat = { api: [...history], blocks: [] as (string | undefined)[], swaps: 0 }
  on('session.messages', (_$, e) => ({ value: e.as === 'api' ? [...chat.api] : [MESSAGE, REPLY] }) as never)
  on('prompt.submit', (_$, e) => {
    const context = e.context ?? []
    chat.api.push({ role: 'user', content: [{ type: 'text', text: e.text }, ...context.map(c => ({ type: 'text', text: hidden(c) }))] })
    chat.blocks.push(context.length === 0 ? undefined : context.join('\n'))
    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('command.run', { command: 'compact' }, () => {
    chat.swaps += 1
    return {}
  })
  // Beneath the plugin, the summarizer answers with a summary and the last message.
  on('session.compact', (_$, e) => ({ messages: [{ role: 'user', text: 'Summary of the chat.', toolUses: [] }, ...e.messages.slice(-1)] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  let turns = 0
  return {
    chat,
    /** You send a message: the hidden block the plugin attached to it, if any. */
    send: async (text = 'next') => {
      await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
      return chat.blocks.at(-1)
    },
    /** Claude Code adds text to the conversation itself: its CLAUDE.md copy, a tool's result. */
    add: (text: string, role: 'user' | 'assistant' = 'user') => chat.api.push({ role, content: [{ type: 'text', text }] }),
    /** Claude calls a tool, and the result it reads. */
    tool: (name: string, input: Record<string, unknown>, result: string) => {
      chat.api.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${chat.api.length}`, name, input }] })
      chat.api.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${chat.api.length - 1}`, content: result }] })
    },
    /** A compaction: Claude Code replaces the conversation with a summary, then reads its files again. */
    compact: async (input: PromptContextInput) => {
      chat.api = [{ role: 'user', content: 'Summary of the chat.' }]
      await $.prompt.context(input)
    },
    /** A chat opens: in the terminal, or with nothing drawing it (the desktop app before it attaches, -p). */
    start: (isInteractive = true) => $.session.start({ cwd: PROJECT, surface: isInteractive ? 'terminal' : null, isInteractive }),
    /** The desktop app opens the chat. */
    attach: () => $.session.attach({ surface: 'desktop', clientId: 'desktop:default' }),
    /** A turn of the main chat: its work, then its end. */
    turn: async (work: () => Promise<unknown> = async () => undefined) => {
      const turnId = `turn-${(turns += 1)}`
      await $.turn.start({ text: 'go', turnId })
      await work()
      return $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
    },
  }
}

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const
const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const
// Where the pinned line is drawn: under the prompt in the terminal, as the band above it on the desktop.
const LINE = { terminal: HINT, desktop: BAND } as const
const PANE = {
  component: 'Pane',
  requestId: 'always-read-claudemd',
  props: { title: 'CLAUDE.md', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** Claude Code beneath a tool call: the tool ran. */
function tools(on: On) {
  on('tool.call', () => ({ result: 'ok' }) as never)
}

/** The files the pane lists as pinned, by where they are. */
async function pinned($: Engine): Promise<string[]> {
  const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...PANE })
  // Each file is a button that opens it.
  const buttons = await pane.findAll({ type: 'Button' })
  await pane.unmount()
  return buttons.map(b => b.text ?? '').filter(t => t.endsWith('.md'))
}

const PROJECT_LABEL = 'project instructions, checked into the codebase'
const copyOf = (path: string, label: string, text: string) => `Contents of ${path} (${label}):\n\n${text}`

test('a new chat: Claude Code gives Claude its CLAUDE.md, and the plugin adds nothing', async ($, on) => {
  world(on, { [PROJECT_MD]: 'Always use tabs.' }, 1_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Always use tabs.' }])
  const { chat, send, add, start } = conversation($, on)

  const context = await $.prompt.context(input)
  expect(context.blocks.map(b => b.name)).toEqual(['claudeMd', 'currentDate'])
  await start()
  // Claude Code adds its copy to the first message after the plugin's hooks run: it isn't sent twice.
  expect(await send('hello')).toBeUndefined()
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Always use tabs.')))
  expect(await send()).toBeUndefined()
  expect(chat.swaps).toBe(0)
  // The system prompt is Claude Code's own.
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
})

test('the plugin never compacts a chat, and leaves compaction to Claude Code', async ($, on) => {
  const { clock, write, remove } = world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 2_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { chat, send, start, attach, turn } = conversation($, on)
  tools(on)
  await $.prompt.context(input)

  // A chat starts, and is resumed.
  await start()
  await $.prompt.context(input)
  await start()
  // A CLAUDE.md is edited while Claude is idle, then during a turn, and a subfolder's is pinned.
  write(PROJECT_MD, 'Use spaces.')
  await turn(async () => {
    write(PROJECT_MD, 'Use both.')
    await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE })
  })
  // Messages are sent, a file is created, time passes, the desktop app opens the chat.
  for (let i = 0; i < 12; i++) await send()
  write(USER_MD, 'Answer briefly.')
  await clock.advance(60_000)
  await attach()
  const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'desktop', ...BAND })
  await band.unmount()
  // /clear, a run with nothing drawing it, and a file deleted.
  await $.prompt.context(input)
  await start(false)
  remove(PROJECT_MD)
  await send()
  expect(chat.swaps).toBe(0)

  // Claude Code's own compactions are its own: what it answers is kept as it is.
  const messages = [MESSAGE, REPLY]
  for (const trigger of ['manual', 'auto'] as const) {
    const done = await $.session.compact({ trigger, messages })
    expect(done.messages).toEqual([{ role: 'user', text: 'Summary of the chat.', toolUses: [] }, REPLY])
  }
})

test('an edit made outside Claude Code is sent with the next message, in full, and stays in the chat', async ($, on) => {
  const { clock, toasts, write } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 3_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { chat, send, add, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')))

  // Nothing is sent while you're idle, however long: only with a message.
  write(PROJECT_MD, 'Use spaces.\nRun the tests first.')
  await clock.advance(60_000)
  expect(toasts).toEqual([])
  const block = await send()
  expect(block?.startsWith('# CLAUDE.md\n\nThese are the user\'s CLAUDE.md instructions, exactly as they are on disk now.')).toBe(true)
  expect(block).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use spaces.\nRun the tests first.'))
  // One toast, and only when something is sent.
  expect(toasts).toEqual([`CLAUDE.md edited and sent to Claude: ${PROJECT_MD}`])

  // It's part of that message from then on, so Claude can go back to it, and it isn't sent again.
  expect(await send()).toBeUndefined()
  expect(await send()).toBeUndefined()
  expect(JSON.stringify(chat.api)).toContain('prompt.submit hook additional context: # CLAUDE.md')
  expect(chat.blocks.filter(b => b !== undefined)).toHaveLength(1)

  // The pane says what was sent.
  const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: `Edited and sent to Claude: ${PROJECT_MD}` })).toBeDefined()
  expect(toasts).toHaveLength(1)
  await pane.unmount()
})

test('messages typed while Claude works that join its turn together carry the block once', async ($, on) => {
  const { write } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 3_500_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { chat, send, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  chat.api.push({ role: 'user', content: copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.') })
  write(PROJECT_MD, 'Use spaces.')

  // Two messages typed over turn T1, both read by Claude at its next step: neither is in the
  // conversation when the other is checked.
  const typed = async (text: string) => {
    await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, turnId: 'T1' } as never)
    chat.api.pop()
    return chat.blocks.at(-1)
  }
  expect(await typed('first')).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use spaces.'))
  expect(await typed('second')).toBeUndefined()
  // A message sent later, in its own turn, is checked against the conversation alone.
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use spaces.'))
})

test("Claude's own Write holds the whole file; an Edit, which shows Claude a snippet, doesn't", async ($, on) => {
  const { write } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 3_500_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { send, add, tool, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')))

  const rules = 'Use spaces.\nRun the tests first.\nKeep commits small.'
  write(PROJECT_MD, rules)
  tool('Write', { file_path: PROJECT_MD, content: rules }, `File created successfully at: ${PROJECT_MD}`)
  expect(await send()).toBeUndefined()

  const edited = rules.replace('Use spaces.', 'Use both.')
  write(PROJECT_MD, edited)
  tool('Edit', { file_path: PROJECT_MD, old_string: 'Use spaces.', new_string: 'Use both.' }, `The file ${PROJECT_MD} has been updated. Here's a snippet:\n     1\tUse both.`)
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, edited))
})

test('a line deleted from either end, or edits by both you and Claude, send the file as it is now', async ($, on) => {
  const rules = 'Use tabs.\nRun the tests first.'
  const { write } = world(on, { [PROJECT_MD]: rules }, 3_600_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: rules }])
  const { send, add, tool, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, rules)))
  expect(await send()).toBeUndefined()

  // Claude's copy holds the shorter file, but has more in it: it isn't the file.
  write(PROJECT_MD, 'Use tabs.')
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.'))
  write(PROJECT_MD, rules)
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, rules))
  write(PROJECT_MD, 'Run the tests first.')
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Run the tests first.'))

  // Claude writes the file, then you edit it: the file is neither, so it's sent.
  write(PROJECT_MD, 'Rule A.')
  tool('Write', { file_path: PROJECT_MD, content: 'Rule A.' }, `File created successfully at: ${PROJECT_MD}`)
  write(PROJECT_MD, 'Rule A.\nRule B.')
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Rule A.\nRule B.'))

  // You edit it, then Claude writes over your edit: the file is what Claude wrote.
  write(PROJECT_MD, 'Rule C.')
  write(PROJECT_MD, 'Rule D.')
  tool('Write', { file_path: PROJECT_MD, content: 'Rule D.' }, `File created successfully at: ${PROJECT_MD}`)
  expect(await send()).toBeUndefined()

  // Claude's Edit adds a line, then you delete it: the snippet and the copy sent after it both
  // have the file's text in them, and neither is the file.
  write(PROJECT_MD, 'Rule D.\nRule E.')
  tool('Edit', { file_path: PROJECT_MD, old_string: 'Rule D.', new_string: 'Rule D.\nRule E.' }, `The file ${PROJECT_MD} has been updated.`)
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Rule D.\nRule E.'))
  write(PROJECT_MD, 'Rule D.')
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Rule D.'))
  expect(await send()).toBeUndefined()
})

test('a subfolder CLAUDE.md unpinned while Claude still has a copy is kept current', async ($, on) => {
  const { write, remove } = world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 3_700_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { send, add, start, turn } = conversation($, on)
  tools(on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')))
  await turn(() => $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE }))
  add(reminder(`Contents of ${API_MD}:\n\nValidate every endpoint.`))
  for (let i = 0; i < 10; i++) expect(await send()).toBeUndefined()
  expect(await pinned($)).not.toContain(API_MD)

  // Edited while unpinned: Claude's copy is out of date, so the new text is sent. It stays unpinned.
  write(API_MD, 'Validate every endpoint.\nLog every error.')
  expect(await send()).toContain(copyOf(API_MD, `subfolder instructions; apply when working in ${PROJECT}/api`, 'Validate every endpoint.\nLog every error.'))
  expect(await send()).toBeUndefined()
  expect(await pinned($)).not.toContain(API_MD)

  // Deleted: reported removed, once.
  remove(API_MD)
  expect(await send()).toBe(`# CLAUDE.md\n\nRemoved: ${API_MD}. Its instructions no longer apply.`)
  expect(await send()).toBeUndefined()
})

test('a file Claude read in full counts, line numbers and all; part of one does not', async ($, on) => {
  const rules = 'Use tabs.\nRun the tests first.'
  world(on, { [PROJECT_MD]: rules }, 4_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: rules }])
  const { chat, send, tool, start, compact } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')

  // After a compaction Claude Code gives its files again, so nothing is sent; then a summary alone.
  await compact(input)
  expect(await send()).toBeUndefined()
  chat.api = [{ role: 'user', content: 'Summary of the chat.' }]
  tool('Read', { file_path: PROJECT_MD, limit: 1 }, '     1\tUse tabs.')
  expect(await send()).toContain(rules)

  chat.api = [{ role: 'user', content: 'Summary of the chat.' }]
  tool('Read', { file_path: PROJECT_MD }, '     1\tUse tabs.\n     2\tRun the tests first.')
  expect(await send()).toBeUndefined()
})

test('a compaction drops a subfolder CLAUDE.md: the next message brings it back', async ($, on) => {
  const { toasts } = world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 4_500_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { chat, send, add, start, turn, compact } = conversation($, on)
  tools(on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')))

  // Claude opens a file in api/: the folder's CLAUDE.md is pinned, and Claude Code gives Claude a copy.
  await turn(() => $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE }))
  expect(toasts.some(t => t.startsWith('CLAUDE.md pinned:'))).toBe(true)
  add(reminder(`Contents of ${API_MD}:\n\nValidate every endpoint.`))
  expect(await send()).toBeUndefined()

  // A compaction: Claude Code gives the startup files again, not the subfolder's.
  await compact(input)
  const block = await send()
  // The fake disk names folders in lower case.
  expect(block).toContain(copyOf(API_MD, `subfolder instructions; apply when working in ${keyOf(PROJECT)}/api`, 'Validate every endpoint.'))
  expect(block).not.toContain('Use tabs.')
  // Claude Code adds its own copy of the startup files to that message, after the plugin's hooks.
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')))
  expect(await send()).toBeUndefined()
})

test('a new CLAUDE.md is sent; a deleted one Claude still has is reported removed, once', async ($, on) => {
  const { toasts, write, remove } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 5_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { send, add, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')))

  // Created where nothing was watched: found when the message is sent.
  write(LOCAL_MD, 'My local rule.')
  expect(await send()).toContain(copyOf(LOCAL_MD, "user's private project instructions, not checked in", 'My local rule.'))
  expect(toasts.at(-1)).toBe(`CLAUDE.md sent to Claude: ${LOCAL_MD}`)

  remove(LOCAL_MD)
  const block = await send()
  expect(block).toBe(`# CLAUDE.md\n\nRemoved: ${LOCAL_MD}. Its instructions no longer apply.`)
  expect(toasts.at(-1)).toBe(`CLAUDE.md sent to Claude: ${LOCAL_MD} (removed)`)
  expect(await send()).toBeUndefined()
  expect(toasts).toHaveLength(2)
})

test('a deleted rules file or @import Claude Code loaded is reported removed too', async ($, on) => {
  const RULES_MD = `${PROJECT}/.claude/rules/style.md`
  const IMPORT_MD = `${PROJECT}/docs/conventions.md`
  const { remove } = world(on, { [PROJECT_MD]: 'Use tabs.\n@docs/conventions.md', [RULES_MD]: 'Short names.', [IMPORT_MD]: 'Small commits.' }, 5_500_000)
  const files: InstructionFile[] = [
    { path: PROJECT_MD, kind: 'project', content: 'Use tabs.\n@docs/conventions.md' },
    { path: RULES_MD, kind: 'project', content: 'Short names.' },
    { path: IMPORT_MD, kind: 'project', content: 'Small commits.', parent: PROJECT_MD },
  ]
  const input = engine(on, files)
  const { send, add, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(files.map(f => copyOf(f.path, PROJECT_LABEL, f.content)).join('\n\n')))

  remove(RULES_MD)
  remove(IMPORT_MD)
  expect(await send()).toBe(
    `# CLAUDE.md\n\nRemoved: ${RULES_MD}. Its instructions no longer apply.\n\nRemoved: ${IMPORT_MD}. Its instructions no longer apply.`,
  )
  expect(await send()).toBeUndefined()
})

test('a chat that opens shows its files on the line before any message, and sends nothing', async ($, on) => {
  const { toasts } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 5_400_000)
  engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { chat, start } = conversation($, on)

  await start()
  for (const surface of ['terminal', 'desktop'] as const) {
    const line = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...LINE[surface] })
    expect(await line.find({ text: 'CLAUDE.md pinned' })).toBeDefined()
    await line.unmount()
  }
  expect(chat.blocks).toEqual([])
  expect(toasts).toEqual([])
})

test('the line looks at the disk once a second, and only the line: nothing is pinned or sent', async ($, on) => {
  const { clock, toasts, write, remove } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 5_450_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { chat, send, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  const lines = await Promise.all(
    (['terminal', 'desktop'] as const).map(surface => $.ui.mount({ plugin: 'always-read-claudemd', surface, ...LINE[surface] })),
  )
  for (const line of lines) expect(await line.find({ text: /^1 file, ~/ })).toBeDefined()

  // A CLAUDE.md created while you're idle shows within a second.
  write(LOCAL_MD, 'My local rule.')
  await clock.advance(1000)
  for (const line of lines) expect(await line.find({ text: /^2 files, ~/ })).toBeDefined()

  // Every one deleted: the line says so within a second.
  remove(PROJECT_MD)
  remove(LOCAL_MD)
  await clock.advance(1000)
  for (const line of lines) expect(await line.find({ text: 'No CLAUDE.md found' })).toBeDefined()

  // What is pinned, and what Claude is sent, wait for your message.
  expect(await pinned($)).toEqual([PROJECT_MD])
  expect(chat.blocks).toEqual([])
  expect(toasts).toEqual([])
  write(LOCAL_MD, 'My local rule.')
  await send()
  expect(chat.blocks.at(-1)).toContain('My local rule.')
  expect(chat.blocks.at(-1)).toContain(`Removed: ${PROJECT_MD}.`)
  for (const line of lines) await line.unmount()
})

test('with no CLAUDE.md anywhere nothing is sent', async ($, on) => {
  world(on, {}, 5_500_000)
  engine(on, null)
  const { send, start } = conversation($, on)

  await start()
  expect(await send('hello')).toBeUndefined()
  const hint = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...HINT })
  expect(await hint.find({ text: 'No CLAUDE.md found' })).toBeDefined()
  await hint.unmount()
})

test('pins and sends what is on disk when Claude Code has not said which files it read', async ($, on) => {
  world(on, { [PROJECT_MD]: 'Never commit to main.', [USER_MD]: 'Answer briefly.' }, 6_000_000)
  engine(on, null)
  const { send, start } = conversation($, on)

  await start()
  const block = await send('hello')
  expect(block).toContain('Never commit to main.')
  expect(block).toContain('Answer briefly.')
})

test('an older chat keeps the CLAUDE.md message an older version put first: it counts, and is never drawn', async ($, on) => {
  const old = (line: string) =>
    `<system-reminder>\n# CLAUDE.md\n\n${line} IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n${copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')}\n</system-reminder>`
  const messages = [
    old("This is the CLAUDE.md file: the user's instructions, exactly as they were on disk when this conversation was last compacted. If a later message in the conversation shows a newer version of one of these files, the newer version is current."),
    old(OLD_HEADER.split('\n\n')[1]?.replace(/ IMPORTANT:.*$/, '') ?? ''),
  ]
  // Claude Code beneath draws a user message as its text.
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, e.props.text) as RenderElement
  })
  world(on, { [PROJECT_MD]: 'Use tabs.' }, 6_500_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { send, start } = conversation($, on, [{ role: 'user', content: messages[0] }])
  await $.prompt.context({ ...input, blocks: [] })
  await start()
  expect(await send()).toBeUndefined()

  const row = (text: string) =>
    $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', component: 'UserMessage', props: { text, origin: { kind: 'unclassified' }, isExpanded: false } } as never)
  for (const text of messages) {
    expect(isMessage(text)).toBe(true)
    const message = await row(text)
    expect(await message.find({ text: /Use tabs\./ })).toBeUndefined()
    await message.unmount()
  }
  const prompt = await row('hello')
  expect(await prompt.find({ text: 'hello' })).toBeDefined()
  await prompt.unmount()
})

test('text another plugin rewrote stands for the startup files until they change on disk', async ($, on) => {
  const { write } = world(on, { [PROJECT_MD]: 'Rule A.' }, 7_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Rule A.' }], { rewrittenAs: 'Rewritten rule A.' })
  const { send, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  expect(await send('hello')).toBeUndefined()

  write(PROJECT_MD, 'Rule B.')
  expect(await send()).toContain('Rule B.')
})

test("a file's comments are left out as Claude Code's own loader leaves them out", async ($, on) => {
  const { write } = world(on, { [PROJECT_MD]: 'Use tabs.\n<!-- for people -->\n' }, 7_500_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.\n' }])
  const { send, add, tool, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')))

  // A comment changed: Claude's copy is still the file as Claude Code loads it.
  write(PROJECT_MD, 'Use tabs.\n<!-- for the team -->\n')
  expect(await send()).toBeUndefined()
  // A rule added: the file is sent as Claude Code loads it.
  write(PROJECT_MD, 'Use tabs.\n<!-- for the team -->\nRun the tests.\n')
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.\nRun the tests.'))
  // Claude read the whole file, comment and all: it has it.
  write(PROJECT_MD, 'Use spaces.\n<!-- for the team -->\n')
  tool('Read', { file_path: PROJECT_MD }, '1\tUse spaces.\n2\t<!-- for the team -->\n3')
  expect(await send()).toBeUndefined()
  // Nothing but a comment left: to Claude, it's removed.
  write(PROJECT_MD, '<!-- for the team -->\n')
  expect(await send()).toContain(`Removed: ${PROJECT_MD}. Its instructions no longer apply.`)
})

test('the hidden block holds each file whole, under a heading naming where it is and what it is', () => {
  const block = blockOf([
    { path: USER_MD, kind: 'user', content: 'Answer briefly.\n', mtimeMs: 1 },
    { path: API_MD, kind: 'project', content: 'Validate every endpoint.', mtimeMs: 1, scope: `${PROJECT}/api` },
    { path: LOCAL_MD, kind: 'local', content: '  ', mtimeMs: 1 },
  ])
  expect(block).toBe(
    [
      '# CLAUDE.md',
      "These are the user's CLAUDE.md instructions, exactly as they are on disk now. Their current text isn't in this conversation, so here it is: where anything earlier in the conversation differs, this is current. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
      `Contents of ${USER_MD} (user's private global instructions for all projects):\n\nAnswer briefly.`,
      `Contents of ${API_MD} (subfolder instructions; apply when working in ${PROJECT}/api):\n\nValidate every endpoint.`,
    ].join('\n\n'),
  )
  expect(blockOf([])).toBeNull()

  // Claude's latest copy of a file must be its whole text as it is now: as Claude Code loads it, or
  // as it is on disk. Windows line endings and Read's line numbers don't count as differences.
  const loaded = 'Use tabs.\r\nRun the tests.'
  const rules = 'Use tabs.\r\n<!-- for the team -->\r\nRun the tests.'
  const latest = (...messages: unknown[]) => lastCopy(PROJECT_MD, copiesOf(messages))
  const given = (path: string, text: string) => ({ role: 'user', content: reminder(copyOf(path, PROJECT_LABEL, text)) })
  const read = (input: Record<string, unknown>, result: string) => [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: result }] },
  ]
  expect(isHeld(loaded, latest(given(PROJECT_MD, 'Use tabs.\n\nRun the tests.')), rules)).toBe(false)
  expect(isHeld(loaded, latest(given(PROJECT_MD, 'Use tabs.\nRun the tests.')), rules)).toBe(true)
  expect(isHeld(loaded, latest(...read({ file_path: PROJECT_MD }, '1\tUse tabs.\n2\t<!-- for the team -->\n3\tRun the tests.\n4\n\n<system-reminder>\nA note.\n</system-reminder>')), rules)).toBe(true)

  // A copy with more in it than the file isn't the file: a line deleted from either end since.
  expect(isHeld('Use tabs.', latest(given(PROJECT_MD, 'Use tabs.\nRun the tests.')))).toBe(false)
  expect(isHeld('Run the tests.', latest(given(PROJECT_MD, 'Use tabs.\nRun the tests.')))).toBe(false)
  // Only the latest copy counts.
  expect(isHeld('Use tabs.', latest(given(PROJECT_MD, 'Use tabs.'), given(PROJECT_MD, 'Use spaces.')))).toBe(false)
  // Not copies of this file: another file's, a part of it read, the text quoted outside a reminder, Claude's thinking.
  expect(isHeld('Use tabs.', latest(given(API_MD, 'Use tabs.')))).toBe(false)
  expect(isHeld('Use tabs.\nRun the tests.', latest(...read({ file_path: PROJECT_MD, offset: 1, limit: 1 }, '1\tUse tabs.')))).toBe(false)
  expect(isHeld('Use tabs.', latest({ role: 'user', content: copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.') }))).toBe(false)
  expect(isHeld('Use tabs.', latest({ role: 'assistant', content: [{ type: 'thinking', thinking: reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')) }] }))).toBe(false)

  // An empty file is held when Claude has no text of it, or was told it was removed.
  expect(isHeld('', latest())).toBe(true)
  expect(isHeld('', latest(given(PROJECT_MD, 'Use tabs.')))).toBe(false)
  expect(isHeld('', latest(given(PROJECT_MD, 'Use tabs.'), { role: 'user', content: hidden(blockOf([], [PROJECT_MD]) ?? '') }))).toBe(true)
})

test('unpins a subfolder CLAUDE.md after 10 messages without work there', async ($, on) => {
  const { toasts } = world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 9_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { send, start, turn } = conversation($, on)
  tools(on)
  await $.prompt.context(input)
  await start()
  await turn(() => $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE }))
  const pins = async (count: number) => {
    for (let i = 0; i < count; i++) await send()
    return pinned($)
  }

  // Work in the folder (a search counts) resets the count.
  expect(await pins(6)).toContain(API_MD)
  await turn(() => $.tool.call({ tool: 'Grep', tool_use_id: 't2', pattern: 'x', path: `${PROJECT}/api` }))
  expect(await pins(9)).toContain(API_MD)
  const after = await pins(1)
  expect(after).not.toContain(API_MD)
  expect(after).toContain(PROJECT_MD)
  expect(toasts.some(t => t.startsWith('CLAUDE.md unpinned:'))).toBe(true)

  // Opening a file there again pins it again.
  await turn(() => $.tool.call({ tool: 'Read', tool_use_id: 't3', file_path: API_FILE }))
  expect(await pinned($)).toContain(API_MD)
})

test('each subfolder CLAUDE.md counts down on its own, and the startup files never unpin', async ($, on) => {
  const WEB_MD = `${PROJECT}/web/CLAUDE.md`
  world(
    on,
    {
      [PROJECT_MD]: 'Use tabs.',
      [API_MD]: 'Validate every endpoint.',
      [WEB_MD]: 'Keep pages accessible.',
      [`${PROJECT}/docs/CLAUDE.md`]: 'Write in plain words.',
      [`${PROJECT}/lib/CLAUDE.md`]: 'No side effects.',
    },
    9_900_000,
  )
  tools(on)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { send, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE })
  const pins = async (count: number) => {
    for (let i = 0; i < count; i++) await send()
    return pinned($)
  }

  // The web folder's file is pinned 4 messages after the api folder's, so it unpins 4 messages later.
  await pins(4)
  await $.tool.call({ tool: 'Read', tool_use_id: 't2', file_path: `${PROJECT}/web/page.tsx` })
  const both = await pins(5)
  expect(both).toContain(API_MD)
  expect(both).toContain(WEB_MD)
  // The line shows each one's own count, the one closest to unpinning first.
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...LINE[surface] })
    const counts = (await band.findAll({ type: 'Text' })).filter(t => /unpins in/.test(t.text ?? ''))
    expect(counts.map(t => t.text)).toEqual(['api/ unpins in 1', 'web/ unpins in 5'])
    // Each in its own color: the one about to unpin in the warning color, the other dim.
    expect(counts[0]?.props.color).toBe('warning')
    expect(counts[1]?.props.color).toBeUndefined()
    expect(await band.find({ text: /more$/ })).toBeUndefined()
    await band.unmount()
  }

  // With more than two, the line names the two closest to unpinning and counts the rest.
  for (const dir of ['docs', 'lib']) await $.tool.call({ tool: 'Read', tool_use_id: dir, file_path: `${PROJECT}/${dir}/x.ts` })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...LINE[surface] })
    const texts = (await band.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.filter(t => /unpins in/.test(t))).toEqual(['api/ unpins in 1', 'web/ unpins in 5'])
    expect(texts).toContain('+2 more')
    await band.unmount()

    // The status line has no width to measure, so it's cut to fit instead.
    if (surface === 'terminal') continue
    // A narrow band names one folder and counts the rest, and drops the file and token summary.
    const NARROW = { ...BAND, props: { ...BAND.props, bodyColumns: 80 } }
    const narrow = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...NARROW })
    const shown = (await narrow.findAll({ type: 'Text' })).map(t => t.text)
    expect(shown.filter(t => /unpins in/.test(t))).toEqual(['api/ unpins in 1'])
    expect(shown).toContain('+3 more')
    expect(shown.some(t => /tokens$/.test(t))).toBe(false)
    expect(shown).toContain('CLAUDE.md pinned')
    await narrow.unmount()
  }
  // 10 messages since the api folder, 6 since the web folder.
  const one = await pins(1)
  expect(one).not.toContain(API_MD)
  expect(one).toContain(WEB_MD)
  expect(await pins(3)).toContain(WEB_MD)
  const none = await pins(1)
  expect(none).not.toContain(WEB_MD)
  // The startup file stays through it all.
  expect(none).toContain(PROJECT_MD)
  expect(await pins(20)).toContain(PROJECT_MD)
})

test('the line shows what is pinned and hides; the pane lists each file and brings the line back', async ($, on) => {
  world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 10_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  tools(on)
  await $.prompt.context(input)
  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE })

  for (const surface of ['terminal', 'desktop'] as const) {
    const line = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...LINE[surface] })
    expect(await line.find({ text: 'CLAUDE.md pinned' })).toBeDefined()
    expect(await line.find({ text: /^2 files, ~/ })).toBeDefined()
    // Alone, it has no rule above it.
    expect(await line.find({ text: /^─+$/ })).toBeUndefined()

    const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...PANE })
    expect(await pane.find({ text: /CLAUDE\.md$/ })).toBeDefined()
    // Each file by where it is, so a project's file says which project.
    expect(await pane.find({ text: `${PROJECT}/api/CLAUDE.md` })).toBeDefined()
    expect(await pane.find({ text: /^Unpins after 10 more messages/ })).toBeDefined()
    expect(await line.find({ text: 'api/ unpins in 10' })).toBeDefined()

    // The pane's button names the line as it's drawn there.
    const name = surface === 'terminal' ? 'status line' : 'band'
    if (surface === 'desktop') {
      // Keys no other band here uses: usage-mod's menu takes c, d, h, m and s.
      expect((await line.find({ key: 'details' }))?.props.hotkey).toBe('o')
      expect((await line.find({ key: 'hide' }))?.props.hotkey).toBe('x')
      await line.press({ key: 'hide' })
    } else {
      // The status line has no buttons: the pane and /claudemd show and hide it.
      expect(await line.find({ type: 'Button' })).toBeUndefined()
      await pane.press({ key: 'band' })
    }
    expect(await line.find({ text: /CLAUDE\.md pinned/ })).toBeUndefined()
    expect(await pane.find({ key: 'band', text: `Show ${name}` })).toBeDefined()

    await pane.press({ key: 'band' })
    expect(await line.find({ text: /CLAUDE\.md pinned/ })).toBeDefined()
    expect(await pane.find({ key: 'band', text: `Hide ${name}` })).toBeDefined()
    await line.unmount()
    await pane.unmount()
  }
})

test('the pane opens a file read-only and goes back to the list', async ($, on) => {
  world(on, { [PROJECT_MD]: '# Rules\n\nUse tabs.' }, 13_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: '# Rules\n\nUse tabs.' }]))

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...PANE })
    await pane.press({ key: `open:${keyOf(PROJECT_MD)}` })
    expect((await pane.find({ type: 'Markdown' }))?.text).toBe('# Rules\n\nUse tabs.')
    expect(await pane.find({ text: /read-only/ })).toBeDefined()

    await pane.press({ key: 'back' })
    expect(await pane.find({ type: 'Markdown' })).toBeUndefined()
    expect(await pane.find({ text: /1 file pinned/ })).toBeDefined()
    await pane.unmount()
  }
})

test('opening a file in the pane reads it from disk, with no watcher and no timer', async ($, on) => {
  const { write } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 13_500_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))

  // Changed on disk with no word from Claude Code's watcher.
  write(PROJECT_MD, 'Use spaces.')
  const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...PANE })
  await pane.press({ key: `open:${keyOf(PROJECT_MD)}` })
  expect((await pane.find({ type: 'Markdown' }))?.text).toBe('Use spaces.')

  // Created where nothing was watched: listed once the pane goes back to the list.
  write(LOCAL_MD, 'My local rule.')
  await pane.press({ key: 'back' })
  expect(await pane.find({ text: LOCAL_MD })).toBeDefined()
  await pane.unmount()
})

test('/claudemd opens the pane on the list, and closes it when it is open', async ($, on) => {
  // The panes Claude Code has open, as the engine would list them.
  const panes: UiPane[] = []
  on('ui.open', (_$, e) => {
    if (!panes.some(p => p.id === e.id)) {
      panes.push({ id: e.id, title: e.title ?? '', isShown: true, isFocused: true, isPlaced: true })
    }
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', (_$, e) => {
    const at = panes.findIndex(p => p.id === e.id)
    if (at >= 0) panes.splice(at, 1)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [...panes] }) as never)
  const { toasts } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 14_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))
  const run = () =>
    $.command.run({
      command: 'claudemd',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })

  expect((await run()).text).toBeUndefined()
  expect(panes.map(p => p.id)).toEqual(['always-read-claudemd'])
  expect(toasts).toEqual(['CLAUDE.md pane opened'])

  const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...PANE })
  await pane.press({ key: `open:${keyOf(PROJECT_MD)}` })
  expect((await pane.find({ type: 'Markdown' }))?.text).toBe('Use tabs.')
  // Run again, it closes the pane; once more, it opens it on the list.
  expect((await run()).text).toBeUndefined()
  expect(panes).toEqual([])
  await run()
  expect(panes.map(p => p.id)).toEqual(['always-read-claudemd'])
  expect(await pane.find({ type: 'Markdown' })).toBeUndefined()
  expect(toasts).toEqual(['CLAUDE.md pane opened', 'CLAUDE.md pane closed; /claudemd opens it again.', 'CLAUDE.md pane opened'])
  await pane.unmount()
})

test('a long file scrolls under the toolbar, which stays put', async ($, on) => {
  const long = Array.from({ length: 60 }, (_, i) => `- Rule ${i + 1}.`).join('\n')
  world(on, { [PROJECT_MD]: long }, 15_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: long }]))
  const SHORT = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } } }

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...SHORT })
    await pane.press({ key: `open:${keyOf(PROJECT_MD)}` })
    const body = async () => (await pane.findAll({ type: 'Box' })).find(b => b.props.position === 'relative')?.props.top

    const boxes = await pane.findAll({ type: 'Box' })
    const bar = boxes.find(b => b.props.key === 'scrollbar')
    // A margin keeps the text off the pane's edges on every surface.
    expect(boxes[0]?.props.paddingX).toBe(1)
    if (surface === 'terminal') {
      // The top is drawn outside the clipped body the plugin scrolls, so it never moves.
      expect(await body()).toBe(0)
      expect(boxes[0]?.props.height).toBe(12)
      expect(boxes.some(b => b.props.overflow === 'hidden' && b.props.flexGrow === 1)).toBe(true)
    } else {
      // The desktop scrolls the pane itself, with its own scroll bar, so it's drawn whole, not clipped.
      expect(await body()).toBeUndefined()
      expect(boxes[0]?.props.height).toBeUndefined()
      expect(bar).toBeUndefined()
    }
    // Rows that shrink can shrink below their text, so the top rows fit a narrow pane.
    expect(boxes.filter(b => b.props.flexShrink === 1).every(b => b.props.minWidth === 0)).toBe(true)
    // Where the file comes from sits in the fixed top, above the rule; the body starts with the file.
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
    const rule = texts.findIndex(t => /^─+$/.test(t))
    expect(texts.indexOf('This project, shared with the team')).toBeLessThan(rule)
    expect(texts.findIndex(t => /tokens, read-only$/.test(t))).toBeLessThan(rule)
    expect((await pane.find({ type: 'Markdown' }))?.text).toBe(long)
    if (surface === 'desktop') {
      await pane.press({ key: 'back' })
      await pane.unmount()
      continue
    }
    // The plugin draws the scroll bar beside the body: a thumb on a dim track, at the top.
    expect(bar).toBeDefined()
    const marks = (await pane.findAll({ type: 'Text' })).filter(t => t.text === '┃' || t.text === '│')
    expect(marks.length).toBe(8)
    expect(marks[0]?.text).toBe('┃')
    expect(marks[7]?.text).toBe('│')
    // In the theme's colors, so the handle reads on a light or a dark pane.
    expect(marks[0]?.props.color).toBe('text')
    expect(marks[7]?.props.color).toBe('subtle')
    expect(await pane.find({ key: 'back' })).toBeDefined()
    expect(await pane.find({ key: 'band', text: 'Hide status line' })).toBeDefined()
    await pane.press({ key: 'back' })
    await pane.unmount()
  }

  // 60 rules in the 8 rows under the fixed top: 52 rows can scroll.
  expect(scrolled(0, 3, 52)).toBe(3)
  expect(scrolled(50, 10, 52)).toBe(52)
  expect(scrolled(2, -5, 52)).toBe(0)
  expect(scrolled(0, 1, 0)).toBe(0)

  // The thumb's size is the share shown, and it moves from the top to the bottom of the track.
  const thumb = (bar: boolean[] | null) => (bar ?? []).flatMap((isThumb, row) => (isThumb ? [row] : []))
  expect(scrollBar(10, 10, 0)).toBeNull()
  expect(scrollBar(10, 20, 0)).toEqual([true, true, true, true, true, false, false, false, false, false])
  expect(thumb(scrollBar(10, 20, 10))).toEqual([5, 6, 7, 8, 9])
  expect(thumb(scrollBar(10, 62, 0))).toEqual([0, 1])
  expect(thumb(scrollBar(10, 62, 52))).toEqual([8, 9])
  expect(thumb(scrollBar(10, 1000, 500)).length).toBe(1)
})

test("on the desktop the open file's name, where it comes from and its size stay in the pane's tab title", async ($, on) => {
  // The pane Claude Code has open, retitled by each later open, as the engine would.
  const panes: UiPane[] = [{ id: 'always-read-claudemd', title: 'CLAUDE.md', isShown: true, isFocused: true, isPlaced: true }]
  const titles: string[] = []
  on('ui.open', (_$, e) => {
    titles.push(e.title ?? '')
    panes[0] = { ...panes[0]!, title: e.title ?? '' }
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: [...panes] }) as never)
  const { clock } = world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 16_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  tools(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.prompt.context(input)
  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE })
  const scrolledDown = { ...PANE, props: { ...PANE.props, scroll: { offset: 5, bodyRows: 12 } } }

  // The terminal keeps its top in the pane, so its title never changes.
  const still = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...PANE })
  await still.press({ key: `open:${keyOf(PROJECT_MD)}` })
  await still.press({ key: 'back' })
  await still.unmount()
  expect(titles).toEqual([])

  // The desktop scrolls the whole pane, so it's drawn whole, with nothing riding or clipped.
  const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'desktop', ...scrolledDown })
  await pane.press({ key: `open:${keyOf(PROJECT_MD)}` })
  const boxes = await pane.findAll({ type: 'Box' })
  expect(boxes[0]?.props.height).toBeUndefined()
  expect(boxes.some(b => typeof b.props.marginTop === 'number' && b.props.marginTop < 0)).toBe(false)
  expect(titles).toEqual([`${PROJECT}/CLAUDE.md: This project, shared with the team (~3 tokens, read-only)`])
  await pane.press({ key: 'back' })
  expect(titles[titles.length - 1]).toBe('CLAUDE.md')

  // A subfolder file shows its folder; when it's unpinned, the pane goes back to the list and its title.
  await pane.press({ key: `open:${keyOf(API_MD)}` })
  expect(titles[titles.length - 1]).toBe(`${PROJECT}/api/CLAUDE.md: Applies while Claude works in api/ (~6 tokens, read-only)`)
  for (let i = 0; i < 10; i++) await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1500)
  expect(titles[titles.length - 1]).toBe('CLAUDE.md')
  expect(await pane.find({ type: 'Markdown' })).toBeUndefined()
  await pane.unmount()

  expect(tabTitle('~/.claude/CLAUDE.md', 'Yours, for every project', 1200)).toBe('~/.claude/CLAUDE.md: Yours, for every project (~1.2k tokens, read-only)')
  // Under the home folder, a file's location starts with ~, in forward slashes.
  expect(displayPath('C:\\home\\proj\\CLAUDE.md', { home: HOME })).toBe('~/proj/CLAUDE.md')
  expect(displayPath(`${PROJECT}/CLAUDE.md`, { home: HOME })).toBe(`${PROJECT}/CLAUDE.md`)
})

test('no rule is drawn for a band slot that draws nothing', () => {
  // What the engine hands a band hook when no other plugin draws a band.
  expect(isBlank({ type: 'engine', ref: 1 })).toBe(true)
  expect(isBlank({ type: 'Box', props: {}, children: [{ type: 'engine', ref: 1 }, false] })).toBe(true)
  expect(isBlank({ type: 'Box', props: {}, children: [] })).toBe(true)
  expect(isBlank({ type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['Usage'] }] })).toBe(false)
})

test("the band keeps another plugin's band above it, and the terminal leaves theirs alone", async ($, on) => {
  // Another plugin's band, beneath this one in the chain.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'Usage: 42%') as RenderElement
  })
  world(on, { [PROJECT_MD]: 'Use tabs.' }, 12_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))

  // The terminal draws this line under the prompt, so above it there's theirs alone, with no rule.
  const terminal = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...BAND })
  expect((await terminal.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Usage: 42%'])
  await terminal.unmount()

  const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'desktop', ...BAND })
  // Theirs first, then a rule, then this band last, at the bottom.
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text)
  const rule = texts.findIndex(t => /^─+$/.test(t))
  expect(texts[rule]?.length).toBe(500)
  expect(texts.indexOf('Usage: 42%')).toBe(0)
  expect(rule).toBeGreaterThan(0)
  expect(texts.indexOf('CLAUDE.md pinned')).toBeGreaterThan(rule)

  await band.press({ key: 'hide' })
  expect(await band.find({ text: 'Usage: 42%' })).toBeDefined()
  expect(await band.find({ text: /CLAUDE\.md pinned/ })).toBeUndefined()
  await band.unmount()
})

test('/claudemd band shows and hides the line', async ($, on) => {
  const { toasts } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 11_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))
  const run = () =>
    $.command.run({
      command: 'claudemd',
      args: 'band',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  expect((await run()).text).toBeUndefined()
  expect((await run()).text).toBeUndefined()
  expect(toasts.slice(-2)).toEqual(['CLAUDE.md line hidden', 'CLAUDE.md line shown'])
})

test('the band drops what does not fit: a folder first, then the summary, then the last folder', () => {
  const parts = {
    status: '● CLAUDE.md pinned', // 18
    summary: '4 files, ~1.2k tokens', // 21
    folders: ['api/ unpins in 3', 'web/ unpins in 7', 'lib/ unpins in 9'], // 16 each
    buttons: 19,
  }
  // Two folders and "+1 more": 18 + 21 + 16 + 16 + 7 + 19, and 5 gaps of 2.
  expect(bandLayout(107, parts)).toEqual({ folders: 2, hasSummary: true })
  expect(bandLayout(106, parts)).toEqual({ folders: 1, hasSummary: true })
  expect(bandLayout(70, parts)).toEqual({ folders: 1, hasSummary: false })
  expect(bandLayout(40, parts)).toEqual({ folders: 0, hasSummary: false })
  // With no subfolder files, only the summary is at stake.
  expect(bandLayout(120, { ...parts, folders: [] })).toEqual({ folders: 0, hasSummary: true })
  expect(bandLayout(30, { ...parts, folders: [] })).toEqual({ folders: 0, hasSummary: false })
})

test('in the terminal the line sits under the hint line below the prompt, styled as the band', async ($, on) => {
  const { statuses } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 17_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))

  for (const surface of ['terminal', 'desktop'] as const) {
    const hint = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...HINT })
    const texts = await hint.findAll({ type: 'Text' })
    const name = texts.find(t => t.text === 'CLAUDE.md pinned')
    if (surface === 'terminal') {
      // A green dot, the name in the text color, and the summary in gray.
      expect(texts.find(t => t.text === '●')?.props.color).toBe('success')
      expect(name?.props.dimColor).toBe(false)
      expect(texts.find(t => /^1 file, ~\d+ tokens$/.test(t.text ?? ''))?.props.dimColor).toBe(true)
    } else {
      // Only the terminal draws a line there; the desktop has the band.
      expect(name).toBeUndefined()
    }
    await hint.unmount()
  }
  // Never pinned among the engine's notices, where it would sit above the mode line under a warning sign.
  expect(statuses.filter(s => s !== undefined)).toEqual([])
})

test("a band choice made in another chat shows here at the next message", async ($, on) => {
  const { stored } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 18_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { send, start } = conversation($, on)
  await $.prompt.context(input)
  await start()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...LINE[surface] })
    expect(await band.find({ text: 'CLAUDE.md pinned' })).toBeDefined()

    // Another chat hides the band, then shows it again: kept in the store every chat shares.
    stored.set('isBandShown', false)
    await send()
    expect(await band.find({ text: 'CLAUDE.md pinned' })).toBeUndefined()
    stored.set('isBandShown', true)
    await send()
    expect(await band.find({ text: 'CLAUDE.md pinned' })).toBeDefined()
    await band.unmount()
  }
})

test('a CLAUDE.md that links to AGENTS.md is read through the link', async ($, on) => {
  const AGENTS_MD = `${PROJECT}/AGENTS.md`
  const { toasts, write } = world(on, { [AGENTS_MD]: 'Use tabs.' }, 23_000_000, { [PROJECT_MD]: AGENTS_MD })
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  const { chat, send, add, start } = conversation($, on)
  await $.prompt.context(input)
  await start()
  await send('hello')
  add(reminder(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use tabs.')))

  // Only AGENTS.md is edited: CLAUDE.md, read through the link, has changed with it.
  write(AGENTS_MD, 'Use spaces.')
  expect(await send()).toContain(copyOf(PROJECT_MD, PROJECT_LABEL, 'Use spaces.'))
  expect(toasts).toEqual([`CLAUDE.md edited and sent to Claude: ${PROJECT_MD}`])
  expect(chat.swaps).toBe(0)
})
