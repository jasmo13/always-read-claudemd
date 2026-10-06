import { expect, mock, test } from 'claude-code/testing'
import type { InstructionFile, On, PromptComposeSection, PromptContextInput, SessionMessage } from 'claude-code'

const HOME = 'C:/home'
const PROJECT = 'C:/work/app'
const PROJECT_MD = `${PROJECT}/CLAUDE.md`
const LOCAL_MD = `${PROJECT}/CLAUDE.local.md`
const USER_MD = `${HOME}/.claude/CLAUDE.md`
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
    const found = e.names.flatMap(name => {
      const file = disk.get(keyOf(`${PROJECT}/${name}`))
      if (file === undefined) return []
      return [{ dir: PROJECT, name, content: file.content, parts: [{ path: file.path, content: file.content }] }]
    })
    return { value: found } as never
  })
  mock.env(on, { USERPROFILE: HOME })
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
  expect(statuses[statuses.length - 1]).toBe('CLAUDE.md: none found')
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
