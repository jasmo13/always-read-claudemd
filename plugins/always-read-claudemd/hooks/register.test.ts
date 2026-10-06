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

import { bandLayout, scrollBar, scrolled, tabTitle } from './pin'

const HOME = 'C:/home'
const PROJECT = 'C:/work/app'
const PROJECT_MD = `${PROJECT}/CLAUDE.md`
const LOCAL_MD = `${PROJECT}/CLAUDE.local.md`
const USER_MD = `${HOME}/.claude/CLAUDE.md`
const API_MD = `${PROJECT}/api/CLAUDE.md`
const API_FILE = `${PROJECT}/api/orders.ts`
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
  on('session.root', () => ({ value: PROJECT }) as never)
  mock.env(on, { USERPROFILE: HOME })
  mock.store(on)
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

  return { clock, statuses, toasts, write, remove }
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
  const { statuses } = world(on, {}, 3_000_000)
  const input = engine(on, null)

  const context = await $.prompt.context(input)
  expect(context.blocks.map(b => b.name)).toEqual(['currentDate'])
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['intro'])
  expect(statuses[statuses.length - 1]).toBe('No CLAUDE.md found')
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
  // The band shows each one's own count, the one closest to unpinning first.
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...BAND })
    const counts = (await band.findAll({ type: 'Text' })).filter(t => /unpins in/.test(t.text ?? ''))
    expect(counts.map(t => t.text)).toEqual(['api/ unpins in 1', 'web/ unpins in 5'])
    // Each in its own color: the one about to unpin in the warning color, the other dim.
    expect(counts[0]?.props.color).toBe('warning')
    expect(counts[1]?.props.color).toBeUndefined()
    expect(await band.find({ text: /more$/ })).toBeUndefined()
    await band.unmount()
  }

  // With more than two, the band names the two closest to unpinning and counts the rest.
  for (const dir of ['docs', 'lib']) await $.tool.call({ tool: 'Read', tool_use_id: dir, file_path: `${PROJECT}/${dir}/x.ts` })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...BAND })
    const texts = (await band.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.filter(t => /unpins in/.test(t))).toEqual(['api/ unpins in 1', 'web/ unpins in 5'])
    expect(texts).toContain('+2 more')
    await band.unmount()

    // Narrow, it names one folder and counts the rest, and drops the file and token summary.
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

test('the band shows what is pinned and hides; the pane lists each file and brings the band back', async ($, on) => {
  world(on, { [PROJECT_MD]: 'Use tabs.', [API_MD]: 'Validate every endpoint.' }, 10_000_000)
  const input = engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }])
  tools(on)
  await $.prompt.context(input)
  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: API_FILE })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...BAND })
    expect(await band.find({ text: 'CLAUDE.md pinned' })).toBeDefined()
    expect(await band.find({ text: /^2 files, ~/ })).toBeDefined()
    // Alone, it has no rule above it.
    expect(await band.find({ text: /^─+$/ })).toBeUndefined()

    const pane = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...PANE })
    expect(await pane.find({ text: /CLAUDE\.md$/ })).toBeDefined()
    expect(await pane.find({ text: 'api/CLAUDE.md' })).toBeDefined()
    expect(await pane.find({ text: /^Unpins after 10 more messages/ })).toBeDefined()
    expect(await band.find({ text: 'api/ unpins in 10' })).toBeDefined()

    await band.press({ key: 'hide' })
    expect(await band.find({ text: /CLAUDE\.md pinned/ })).toBeUndefined()
    expect(await pane.find({ key: 'band', text: 'Show band' })).toBeDefined()

    await pane.press({ key: 'band' })
    expect(await band.find({ text: /CLAUDE\.md pinned/ })).toBeDefined()
    await band.unmount()
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

test('/claudemd opens the pane on the list, and leaves an open pane as it is', async ($, on) => {
  // The panes Claude Code has open, as the engine would list them.
  const panes: UiPane[] = []
  on('ui.open', (_$, e) => {
    if (!panes.some(p => p.id === e.id)) {
      panes.push({ id: e.id, title: e.title ?? '', isShown: true, isFocused: true, isPlaced: true })
    }
    return { value: { isPlaced: true } } as never
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
  await run()
  expect((await pane.find({ type: 'Markdown' }))?.text).toBe('Use tabs.')
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
    expect(await pane.find({ key: 'band', text: 'Hide band' })).toBeDefined()
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

test("on the desktop the open file's name and size stay in the pane's tab title", async ($, on) => {
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
  expect(titles).toEqual(['CLAUDE.md, ~3 tokens'])
  await pane.press({ key: 'back' })
  expect(titles[titles.length - 1]).toBe('CLAUDE.md')

  // A subfolder file shows its folder; when it's unpinned, the pane goes back to the list and its title.
  await pane.press({ key: `open:${keyOf(API_MD)}` })
  expect(titles[titles.length - 1]).toBe('api/CLAUDE.md, ~6 tokens')
  for (let i = 0; i < 10; i++) await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1500)
  expect(titles[titles.length - 1]).toBe('CLAUDE.md')
  expect(await pane.find({ type: 'Markdown' })).toBeUndefined()
  await pane.unmount()

  expect(tabTitle('~/.claude/CLAUDE.md', 1200)).toBe('.claude/CLAUDE.md, ~1.2k tokens')
})

test("the band keeps another plugin's band above it", async ($, on) => {
  // Another plugin's band, beneath this one in the chain.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'Usage: 42%') as RenderElement
  })
  world(on, { [PROJECT_MD]: 'Use tabs.' }, 12_000_000)
  await $.prompt.context(engine(on, [{ path: PROJECT_MD, kind: 'project', content: 'Use tabs.' }]))

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'always-read-claudemd', surface, ...BAND })
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
    await $.command.run({
      command: 'claudemd',
      args: 'band',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
    await band.unmount()
  }
})

test('/claudemd band shows and hides the band', async ($, on) => {
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
  expect(toasts.slice(-2)).toEqual(['CLAUDE.md band hidden', 'CLAUDE.md band shown'])
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
