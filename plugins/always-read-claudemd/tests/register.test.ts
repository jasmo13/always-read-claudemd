import { expect, mock, test } from 'claude-code/testing'
import type {
  InstructionFile,
  On,
  RenderElement,
  PromptComposeSection,
  PromptContextInput,
  SessionMessage,
  UiPane,
} from 'claude-code'

import { bandLayout, displayPath, isBlank, scrollBar, scrolled, tabTitle } from '../hooks/pin'

const HOME = 'C:/home'
const PROJECT = 'C:/work/app'
const PROJECT_MD = `${PROJECT}/CLAUDE.md`
const LOCAL_MD = `${PROJECT}/CLAUDE.local.md`
const USER_MD = `${HOME}/.claude/CLAUDE.md`
const API_MD = `${PROJECT}/api/CLAUDE.md`
const API_FILE = `${PROJECT}/api/orders.ts`
// The plugin's file in Claude Code's store, which every chat watches.
const STORE_FILE = `${HOME}/.claude/plugins/store/always-read-claudemd_inline-abc123.json`
const SECTION_ID = 'always-read-claudemd:claudemd'

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const
const MESSAGE: SessionMessage = { role: 'user', text: 'hello', toolUses: [] }

// The engine hands paths to fs hooks in the platform's own spelling.
const keyOf = (path: string) => path.replace(/\\/g, '/').toLowerCase()

/** A fake file system, the session's environment and clock beneath the plugin. */
function world(on: On, files: Record<string, string>, now: number) {
  const disk = new Map<string, { path: string; content: string; mtimeMs: number }>()
  const write = (path: string, content: string) => {
    const mtimeMs = (disk.get(keyOf(path))?.mtimeMs ?? 0) + 1
    disk.set(keyOf(path), { path, content, mtimeMs })
  }
  const remove = (path: string) => disk.delete(keyOf(path))
  for (const [path, content] of Object.entries(files)) write(path, content)

  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  on('fs.stat', (_$, e) => {
    const file = disk.get(keyOf(e.path))
    if (file === undefined) throw missing(e.path)
    return { value: { kind: 'file', size: file.content.length, mtimeMs: file.mtimeMs, isLink: false } } as never
  })
  on('fs.read', (_$, e) => {
    const file = disk.get(keyOf(e.path))
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
        return [{ dir, name, content: file.content, parts: [{ path: file.path, content: file.content }] }]
      }),
    )
    return { value: found } as never
  })
  on('fs.list', (_$, e) => {
    const dir = `${keyOf(e.path)}/`
    const names = [...disk.values()].flatMap(f => {
      const rest = keyOf(f.path).startsWith(dir) ? f.path.slice(dir.length) : ''
      return rest === '' || rest.includes('/') ? [] : [{ name: rest, kind: 'file' }]
    })
    return { value: names } as never
  })
  on('session.root', () => ({ value: PROJECT }) as never)
  mock.env(on, { USERPROFILE: HOME })
  // The plugin's store, shared by every chat: a write lands in its file on disk.
  const stored = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }) as never)
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)
    write(STORE_FILE, JSON.stringify(Object.fromEntries(stored)))
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
  on('prompt.submit', (_$, e) => ({ text: e.text }))
}

const pinned = (sections: readonly PromptComposeSection[]) => sections.find(s => s.id === SECTION_ID)

test('moves CLAUDE.md out of the first message and into the system prompt', async ($, on) => {
  world(on, { [PROJECT_MD]: 'Always use tabs.' }, 1_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Always use tabs.' }])

  const context = await $.prompt.context(input)
  expect(context.blocks.map(b => b.name)).toEqual(['currentDate'])

  const { sections } = await $.prompt.compose(COMPOSE)
  const section = pinned(sections)
  expect(sections[sections.length - 1]?.id).toBe(SECTION_ID)
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('Always use tabs.')
  expect(section?.text).toContain('project instructions')
})

test('pins what is on disk when the system prompt renders before the context', async ($, on) => {
  world(on, { [PROJECT_MD]: 'Never commit to main.', [USER_MD]: 'Answer briefly.' }, 2_000_000)
  engine(on, null)

  const { sections } = await $.prompt.compose(COMPOSE)
  expect(pinned(sections)?.text).toContain('Never commit to main.')
  expect(pinned(sections)?.text).toContain('Answer briefly.')
})

test('with no CLAUDE.md anywhere it adds nothing and leaves the context alone', async ($, on) => {
  world(on, {}, 3_000_000)
  const input = engine(on, null)

  const context = await $.prompt.context(input)
  expect(context.blocks.map(b => b.name)).toEqual(['currentDate'])
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['intro'])
  const hint = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...HINT })
  expect(await hint.find({ text: 'No CLAUDE.md found' })).toBeDefined()
  await hint.unmount()
})

test('re-syncs edits, new files and deletions made outside Claude Code', async ($, on) => {
  const { clock, toasts, write, remove } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 4_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))
  await $.prompt.compose(COMPOSE)

  write(PROJECT_MD, 'Use two spaces.')
  await clock.advance(1500)
  let text = pinned((await $.prompt.compose(COMPOSE)).sections)?.text
  expect(text).toContain('Use two spaces.')
  expect(text).not.toContain('Use tabs.')
  expect(toasts).toContain('CLAUDE.md changed: re-pinned')

  write(LOCAL_MD, 'My local rule.')
  await clock.advance(1500)
  text = pinned((await $.prompt.compose(COMPOSE)).sections)?.text
  expect(text).toContain('Use two spaces.')
  expect(text).toContain('My local rule.')

  remove(PROJECT_MD)
  remove(LOCAL_MD)
  await clock.advance(1500)
  expect(pinned((await $.prompt.compose(COMPOSE)).sections)).toBeUndefined()
})

test('checks the disk at most once a second', async ($, on) => {
  const { clock, write } = world(on, { [PROJECT_MD]: 'Rule A.' }, 5_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Rule A.' }]))
  await $.prompt.compose(COMPOSE)

  write(PROJECT_MD, 'Rule B.')
  expect(pinned((await $.prompt.compose(COMPOSE)).sections)?.text).toContain('Rule A.')
  await clock.advance(1000)
  expect(pinned((await $.prompt.compose(COMPOSE)).sections)?.text).toContain('Rule B.')
})

test('pins text another plugin rewrote, until the files on disk change', async ($, on) => {
  const { clock, write } = world(on, { [PROJECT_MD]: 'Rule A.' }, 6_000_000)
  await $.prompt.context(
    engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Rule A.' }], { rewrittenAs: 'Rewritten rule A.' }),
  )
  expect(pinned((await $.prompt.compose(COMPOSE)).sections)?.text).toContain('Rewritten rule A.')

  write(PROJECT_MD, 'Rule B.')
  await clock.advance(1500)
  const text = pinned((await $.prompt.compose(COMPOSE)).sections)?.text
  expect(text).toContain('Rule B.')
  expect(text).not.toContain('Rewritten rule A.')
})

test('tells the summarizer the rules stay in force, after the typed instructions', async ($, on) => {
  world(on, { [PROJECT_MD]: 'Use tabs.' }, 7_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  let instructions: string | undefined
  on('session.compact', (_$, e) => {
    instructions = e.instructions
    return { messages: [{ ...MESSAGE, text: 'summary' }] }
  })

  await $.prompt.context(input)
  await $.session.compact({ trigger: 'manual', messages: [MESSAGE], instructions: 'keep the plan' })
  expect(instructions?.startsWith('keep the plan')).toBe(true)
  expect(instructions).toContain('pinned in the system prompt')
})

test('pins a subfolder CLAUDE.md once Claude opens a file there, and keeps it through a re-read', async ($, on) => {
  const { toasts } = world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 8_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  tools(on)
  await $.prompt.context(input)
  expect(pinned((await $.prompt.compose(COMPOSE)).sections)?.text).not.toContain('Validate every endpoint.')

  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE })
  let text = pinned((await $.prompt.compose(COMPOSE)).sections)?.text
  expect(text).toContain('Validate every endpoint.')
  expect(text).toContain('apply when working in')
  expect(toasts.some(t => t.startsWith('CLAUDE.md pinned:'))).toBe(true)

  // Compaction or /clear re-reads the engine's block, which never holds subfolder files.
  await $.prompt.context(input)
  text = pinned((await $.prompt.compose(COMPOSE)).sections)?.text
  expect(text).toContain('Use tabs.')
  expect(text).toContain('Validate every endpoint.')
})

test('unpins a subfolder CLAUDE.md after 10 messages without work there', async ($, on) => {
  const { clock, toasts } = world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 9_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  tools(on)
  await $.prompt.context(input)
  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE })

  const send = async (count: number) => {
    for (let i = 0; i < count; i++) await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    await clock.advance(1500)
    return pinned((await $.prompt.compose(COMPOSE)).sections)?.text ?? ''
  }

  // Work in the folder (a search counts) resets the count.
  expect(await send(6)).toContain('Validate every endpoint.')
  await $.tool.call({ tool: 'Grep', tool_use_id: 't2', pattern: 'x', path: `${PROJECT}/api` })
  expect(await send(9)).toContain('Validate every endpoint.')
  const text = await send(1)
  expect(text).not.toContain('Validate every endpoint.')
  expect(text).toContain('Use tabs.')
  expect(toasts.some(t => t.startsWith('CLAUDE.md unpinned:'))).toBe(true)

  // Opening a file there again pins it again.
  await $.tool.call({ tool: 'Read', tool_use_id: 't3', file_path: API_FILE })
  expect(await send(0)).toContain('Validate every endpoint.')
})

test('each subfolder CLAUDE.md counts down on its own, and the startup files never unpin', async ($, on) => {
  const WEB_MD = `${PROJECT}/web/CLAUDE.md`
  const { clock } = world(
    on,
    {
      [PROJECT_MD]: 'Use tabs.',
      [API_MD]: 'Validate every endpoint.',
      [WEB_MD]: 'Keep pages accessible.',
      [`${PROJECT}/docs/CLAUDE.md`]: 'Write in plain words.',
      [`${PROJECT}/lib/CLAUDE.md`]: 'No side effects.',
    },
    9_500_000,
  )
  tools(on)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))
  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE })

  const send = async (count: number) => {
    for (let i = 0; i < count; i++) await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    await clock.advance(1500)
    return pinned((await $.prompt.compose(COMPOSE)).sections)?.text ?? ''
  }

  // The web folder's file is pinned 4 messages after the api folder's, so it unpins 4 messages later.
  await send(4)
  await $.tool.call({ tool: 'Read', tool_use_id: 't2', file_path: `${PROJECT}/web/page.tsx` })
  const both = await send(5)
  expect(both).toContain('Validate every endpoint.')
  expect(both).toContain('Keep pages accessible.')
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
  const one = await send(1)
  expect(one).not.toContain('Validate every endpoint.')
  expect(one).toContain('Keep pages accessible.')
  expect(await send(3)).toContain('Keep pages accessible.')
  const none = await send(1)
  expect(none).not.toContain('Keep pages accessible.')
  // The startup file stays through it all.
  expect(none).toContain('Use tabs.')
  expect(await send(20)).toContain('Use tabs.')
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
  world(on, { [PROJECT_MD]: 'Use tabs.' }, 14_000_000)
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

  const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface: 'terminal', ...PANE })
  await pane.press({ key: `open:${keyOf(PROJECT_MD)}` })
  expect((await pane.find({ type: 'Markdown' }))?.text).toBe('Use tabs.')
  // Run again, it closes the pane; once more, it opens it on the list.
  expect((await run()).text).toBeUndefined()
  expect(panes).toEqual([])
  await run()
  expect(panes.map(p => p.id)).toEqual(['always-read-claudemd'])
  expect(await pane.find({ type: 'Markdown' })).toBeUndefined()
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

test("another chat's band choice and an edited CLAUDE.md show here as soon as the files change", async ($, on) => {
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  const { clock, stored, toasts, write } = world(on, { [PROJECT_MD]: 'Use tabs.' }, 18_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))
  const changed = (path: string) =>
    $.classic.FileChanged({ session_id: 's1', transcript_path: '', cwd: PROJECT, hook_event_name: 'FileChanged', file_path: path, event: 'change' } as never)

  // A fresh install keeps its choice first, so there is a store file to watch, beside the pinned files.
  const started = await $.classic.SessionStart({
    session_id: 's1',
    transcript_path: '',
    cwd: PROJECT,
    hook_event_name: 'SessionStart',
    source: 'startup',
  } as never)
  expect(started.watchPaths).toEqual([STORE_FILE, PROJECT_MD])

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...LINE[surface] })
    expect(await band.find({ text: 'CLAUDE.md pinned' })).toBeDefined()

    // Another chat hides the band: its write changes the store file, reported in Windows' spelling.
    stored.set('isBandShown', false)
    await changed(STORE_FILE.replace(/\//g, '\\').toUpperCase())
    await clock.advance(10)
    expect(await band.find({ text: 'CLAUDE.md pinned' })).toBeUndefined()
    stored.set('isBandShown', true)
    await changed(STORE_FILE)
    await clock.advance(10)
    expect(await band.find({ text: 'CLAUDE.md pinned' })).toBeDefined()
    await band.unmount()
  }

  // A CLAUDE.md edited anywhere is pinned again at once, not at this chat's next message.
  write(PROJECT_MD, 'Use spaces.')
  await changed(PROJECT_MD)
  await clock.advance(10)
  expect(toasts).toContain('CLAUDE.md changed: re-pinned')
  expect(pinned((await $.prompt.compose(COMPOSE)).sections)?.text).toContain('Use spaces.')
})
