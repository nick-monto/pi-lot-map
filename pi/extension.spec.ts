import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { drawMap, setupFrom } from '../hooks/map'
import type { Board } from '../types'
import { classifyPi } from './classify'
import lotMap from './index'
import { renderWidget } from './render'

const setup = setupFrom({ coreName: 'OMP', memoryServers: ['memory'] })

test('pi and omp tools land on the stations the Claude mod uses', () => {
  const at = (tool: string, input: Record<string, unknown> = {}) => classifyPi(tool, input, setup).station
  expect(at('read', { path: '/repo/src/app.ts' })).toBe('files')
  expect(at('grep', { pattern: 'secret' })).toBe('files')
  expect(at('lsp', {})).toBe('files')
  expect(at('bash', { command: 'git push origin main' })).toBe('web')
  expect(at('bash', { command: 'cat src/app.ts | grep x' })).toBe('files')
  expect(at('bash', { command: 'npm install' })).toBe('web')
  expect(at('bash', { command: 'make test' })).toBe('shell')
  expect(at('web_search', { query: 'private' })).toBe('web')
  expect(at('fetch', { url: 'https://example.com/x' })).toBe('web')
  expect(at('browser', { url: 'https://example.com' })).toBe('browser')
  expect(at('task', { name: 'Explore', task: 'private assignment' })).toBe('agents')
  expect(at('wait', {})).toBe('agents')
  expect(at('retain', { text: 'private' })).toBe('memory')
  expect(at('recall', { query: 'private' })).toBe('memory')
  expect(at('manage_skill', {})).toBe('skills')
  expect(at('ask', {})).toBe('you')
  expect(at('mcp__memory_search', { query: 'private' })).toBe('memory')
  expect(at('read', { path: '/home/me/.pi/agent/memory/notes.md' })).toBe('memory')
  expect(at('mcp__other_thing', {})).toBe('web')
  expect(at('unknown_plugin_tool', { secret: 'x' })).toBe('shell')
})

test('labels carry names and numbers, never what was searched or written', () => {
  const label = (tool: string, input: Record<string, unknown> = {}) => classifyPi(tool, input, setup).label
  expect(label('read', { path: '/a/b/c/content.ts' })).toBe('c/content.ts')
  expect(label('bash', { command: 'recall add "private words"' })).toBe('recall')
  expect(label('task', { task: 'private assignment' })).toBe('subagent')
  expect(label('web_search', { query: 'private query' })).toBe('web search')
  expect(label('fetch', { url: 'https://user:pw@example.com/private?token=1' })).toBe('example.com')
  expect(label('mcp__memory_search', { query: 'private', id: 7 })).toBe('search #7')
})

const board: Board = {
  entries: [
    { id: '1', station: 'files', label: 'src/app.ts', from: 'core', startedAt: 1_000, endedAt: 1_200, status: 'ok' },
    { id: '2', station: 'memory', label: 'recall', from: 'agents', startedAt: 1_300, status: 'run', agentId: 'A' },
    { id: '3', station: 'shell', label: 'make test', from: 'core', startedAt: 1_400, endedAt: 1_500, status: 'err' },
  ],
  counts: { files: 3, memory: 1, shell: 2, web: 12, agents: 1 },
  faults: { shell: 1 },
  model: 'example-model-1',
  context: 82,
  agents: ['A'],
}

test('the widget stays inside the width it is given', () => {
  for (const width of [24, 38, 44, 80]) {
    for (const view of ['map', 'feed'] as const) {
      const lines = renderWidget(board, 2_000, setup, width, view, (_color, text) => text)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect([...line].length).toBeLessThanOrEqual(width)
    }
  }
})

test('the map keeps its header, nine rows, tally and feed', () => {
  const map = renderWidget(board, 2_000, setup, 44, 'map', (_color, text) => text)
  expect(map.length).toBe(1 + 9 + 1 + 3)
  expect(map[0]).toContain('context 82%')
  expect(map[1 + 9]).toContain('Files 3')
  expect(map.join('\n')).toContain('Memory')

  const feed = renderWidget(board, 2_000, setup, 44, 'feed', (_color, text) => text)
  expect(feed.length).toBe(1 + 3)
})

test('a long label is cut, and the map shows a fault as a mark', () => {
  const long: Board = { ...board, entries: [{ id: '1', station: 'files', label: 'x'.repeat(200), from: 'core', startedAt: 1_000, status: 'ok' }], faults: { files: 1 } }
  const map = renderWidget(long, 2_000, setup, 44, 'map', (_color, text) => text)
  expect(map[1 + 9]).toContain('Files 3')
  expect(map.slice(1, 10).some(line => line.includes('!'))).toBe(true)
  expect(map[map.length - 1]).toContain('…')
})

test('the extension entry loads against the shared helpers', () => {
  expect(typeof lotMap).toBe('function')
})

test('the shared drawing still gives the browser view a whole SVG', () => {
  const svg = drawMap(board, 2_000, setup)
  expect(svg).toMatch(/^<svg\b/)
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  expect(svg).toContain('>OMP<')
})

test('subagentNames keeps two subagents’ calls out of one folded row', () => {
  const two: Board = {
    entries: [
      { id: '1', station: 'files', label: 'a.ts', from: 'agents', agentId: 'A', startedAt: 1_000, endedAt: 1_100, status: 'ok' },
      { id: '2', station: 'files', label: 'b.ts', from: 'agents', agentId: 'B', startedAt: 1_200, endedAt: 1_300, status: 'ok' },
    ],
    counts: { files: 2 },
  }
  const rows = (s: typeof setup) => renderWidget(two, 2_000, s, 60, 'feed', (_color, text) => text)
  expect(rows(setup)).toHaveLength(2)
  expect(rows(setupFrom({ subagentNames: true }))).toHaveLength(3)
})

test('with contextCost a row says what it added to the context, marked shared when a turn’s growth is split', () => {
  const paid: Board = {
    entries: [
      { id: '1', station: 'files', label: 'a.ts', from: 'core', startedAt: 1_000, endedAt: 1_085, status: 'ok', tokens: 42_000 },
      { id: '2', station: 'shell', label: 'b', from: 'core', startedAt: 1_100, endedAt: 1_150, status: 'ok', tokens: 14_000, shared: true },
    ],
    counts: { files: 2 },
  }
  const lines = (s: typeof setup) => renderWidget(paid, 2_000, s, 60, 'feed', (_color, text) => text).join('\n')
  expect(lines(setup)).not.toContain('+42k')
  expect(lines(setupFrom({ contextCost: true }))).toContain('85 ms +42k')
  expect(lines(setupFrom({ contextCost: true }))).toContain('~+14k')
})

test('a turn’s growth lands on the calls it answered, one turn later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-map-'))
  const settings = join(dir, 'lot-map.json')
  writeFileSync(settings, JSON.stringify({ enabled: true, view: 'feed', contextCost: true }))
  process.env.LOT_MAP_CONFIG = settings
  try {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    let widget: ((surface: unknown) => { render: (width: number) => string[] }) | undefined
    const ctx = {
      hasUI: true,
      agent: { kind: 'main' },
      model: { id: 'm' },
      getContextUsage: () => ({ tokens, percent: tokens / 1_000, contextWindow: 100_000 }),
      ui: {
        setWidget: (_key: string, content: unknown) => {
          widget = content as typeof widget
        },
        notify: () => {},
      },
    }
    let tokens = 1_000
    lotMap({ on: (name, handler) => void handlers.set(name, handler), registerCommand: () => {} } as unknown as Parameters<typeof lotMap>[0])
    const fire = async (name: string, event: unknown): Promise<void> => {
      await handlers.get(name)?.(event, ctx)
    }

    await fire('session_start', {})
    await fire('turn_start', { turnIndex: 0 })
    await fire('tool_execution_start', { toolCallId: 'a', toolName: 'read', args: { path: 'a.ts' } })
    await fire('tool_execution_end', { toolCallId: 'a', toolName: 'read' })
    await fire('turn_end', {})
    tokens = 1_500
    await fire('turn_start', { turnIndex: 1 })
    await fire('turn_end', {})

    expect(widget).toBeDefined()
    const shown = widget!({ terminal: { rows: 40 }, requestRender: () => {} }).render(60).join('\n')
    expect(shown).toContain('+500')
  } finally {
    delete process.env.LOT_MAP_CONFIG
    rmSync(dir, { recursive: true, force: true })
  }
})
