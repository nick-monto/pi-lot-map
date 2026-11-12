// A work map for pi and omp: the stations the session touches, drawn above the editor.
// Claude's pane is an HTML surface; this is the same board drawn in cells and theme colors.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { clean, drawMap, setupFrom, shortModel } from '../hooks/map'
import type { Setup } from '../hooks/map'
import type { Board, Entry, StationId, Status } from '../types'
import { classifyPi } from './classify'
import { renderWidget } from './render'
import { openWindow, serveFrames } from './web'
import type { FrameServer } from './web'

/** The surface a host actually gives an extension; both pi and omp satisfy it. */
type HostContext = {
  hasUI?: boolean
  mode?: string
  model?: { id?: string } | null
  agent?: { kind?: string; id?: string }
  ui?: {
    notify?: (message: string, type?: string) => void
    setWidget?: (key: string, content: unknown, options?: { placement?: string }) => void
    theme?: { fg?: (color: string, text: string) => string }
    requestRender?: () => void
  }
  getContextUsage?: () => { percent?: number | null } | undefined
  sessionManager?: { getBranch?: () => unknown[]; getSessionName?: () => string | undefined; getSessionId?: () => string; getCwd?: () => string }
}

/** What a widget component receives; only these two members are used. */
type WidgetSurface = { terminal?: { rows?: number }; requestRender?: () => void }

type Host = {
  on: <E>(event: string, handler: (event: E, ctx: HostContext) => unknown) => void
  registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: HostContext) => unknown }) => void
  events?: { on: (channel: string, listener: (data: unknown) => void) => () => void }
}

type Config = { view: 'auto' | 'map' | 'feed'; enabled: boolean; placement: 'aboveEditor' | 'belowEditor'; webPort: number; browser?: string }

const KEY = 'lot-map'
const KEEP = 80
const TICK_MS = 150

const isOmp = (ctx: HostContext): boolean => typeof ctx.agent?.kind === 'string'
const isMain = (ctx: HostContext): boolean => ctx.agent?.kind !== 'sub'

/** Frames and tool results are host-defined; every field read from them is checked. */
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/** The settings file, one per host, and a way to point elsewhere for a run. */
function configFile(omp: boolean): string {
  if (process.env.LOT_MAP_CONFIG !== undefined && process.env.LOT_MAP_CONFIG !== '') return process.env.LOT_MAP_CONFIG
  return join(homedir(), omp ? '.omp' : '.pi', 'agent', 'lot-map.json')
}

function readConfig(omp: boolean): { setup: Setup; config: Config } {
  const options: Record<string, unknown> = { coreName: omp ? 'OMP' : 'PI', memoryServers: ['memory'] }
  try {
    const parsed = record(JSON.parse(readFileSync(configFile(omp), 'utf8')))
    if (parsed !== undefined) Object.assign(options, parsed)
  } catch {
    // No settings, or settings that cannot be read: the defaults stand.
  }
  const view = options.view === 'map' || options.view === 'feed' ? options.view : 'auto'
  const webPort = typeof options.webPort === 'number' && Number.isInteger(options.webPort) && options.webPort > 0 && options.webPort < 65_536 ? options.webPort : 0
  const browser = typeof options.browser === 'string' && options.browser.trim() !== '' ? options.browser.trim() : undefined
  return {
    setup: setupFrom(options),
    config: {
      view,
      enabled: options.enabled === true,
      placement: options.placement === 'below' ? 'belowEditor' : 'aboveEditor',
      webPort,
      ...(browser !== undefined ? { browser } : {}),
    },
  }
}

/** One row as it is kept: newest rows, plus every background call still open, however old. */
const kept = (entries: Entry[]): Entry[] => {
  const from = entries.length - KEEP
  return from <= 0 ? entries : entries.filter((e, i) => i >= from || (e.status === 'run' && e.task !== undefined))
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'

type Start = {
  station: StationId
  label: string
  from?: Entry['from']
  status?: Status
  agentId?: string
  mark?: Entry['mark']
  uncounted?: boolean
  startedAt?: number
  endedAt?: number
  patch?: Partial<Pick<Board, 'model' | 'step' | 'switchedAt'>>
}

type ToolStart = { toolCallId?: string; toolName?: string; args?: Record<string, unknown> }
type ToolEnd = ToolStart & { isError?: boolean; result?: unknown }

export default function lotMap(host: Host): void {
  let board: Board = { entries: [], counts: {} }
  let setup = setupFrom({})
  let config: Config = { view: 'auto', enabled: false, placement: 'aboveEditor', webPort: 0 }
  let serial = 0
  let current: HostContext | undefined
  let surfaceRows = 0
  let attached = false
  let enabled = true
  let requestRender: (() => void) | undefined
  let stopTicker: (() => void) | undefined
  let lastActivity = 0
  let turnEntry: string | undefined
  let web: FrameServer | undefined
  /** A subagent's own extension instance keeps no board: the parent draws it from the task frames. */
  let serving = true
  const toolEntries = new Map<string, string>()
  const agentEntries = new Map<string, string>()

  const now = (): number => Date.now()
  const newId = (): string => `${now().toString(36)}${(serial++).toString(36)}`

  const paint = (color: string, text: string): string => {
    const theme = current?.ui?.theme
    try {
      return typeof theme?.fg === 'function' ? theme.fg(color, text) : text
    } catch {
      return text
    }
  }

  function view(): 'map' | 'feed' {
    if (config.view !== 'auto') return config.view
    const rows = surfaceRows || process.stdout.rows || 24
    return rows >= 32 ? 'map' : 'feed'
  }

  function stop(): void {
    stopTicker?.()
    stopTicker = undefined
  }

  function tick(): void {
    requestRender?.()
    const busy = board.entries.some(e => e.status === 'run')
    if (!busy && now() - lastActivity > 4000) stop()
  }

  /** A change on the map: paint it now, and keep the clocks moving while anything runs. */
  function kick(): void {
    lastActivity = now()
    requestRender?.()
    if (stopTicker === undefined && attached) {
      const timer = setInterval(tick, TICK_MS)
      ;(timer as { unref?: () => void }).unref?.()
      stopTicker = () => clearInterval(timer)
    }
  }

  function begin(start: Start): string {
    const at = start.startedAt ?? now()
    const entry: Entry = {
      id: newId(),
      station: start.station,
      label: start.label,
      from: start.from ?? 'core',
      startedAt: at,
      status: start.status ?? 'run',
      ...(start.status !== undefined ? { endedAt: start.endedAt ?? at } : {}),
      ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
      ...(start.mark !== undefined ? { mark: start.mark } : {}),
    }
    board = {
      ...board,
      ...start.patch,
      entries: kept([...board.entries, entry]),
      counts: start.uncounted ? board.counts : { ...board.counts, [entry.station]: (board.counts[entry.station] ?? 0) + 1 },
      ...(isFault(entry.status) && entry.station !== 'you' ? { faults: { ...board.faults, [entry.station]: (board.faults?.[entry.station] ?? 0) + 1 } } : {}),
      ...(entry.agentId !== undefined && !(board.agents ?? []).includes(entry.agentId) ? { agents: [...(board.agents ?? []), entry.agentId].slice(-12) } : {}),
    }
    kick()
    return entry.id
  }

  function finish(id: string | undefined, status: Status, patch?: Pick<Board, 'context'>): void {
    if (id === undefined) return
    const open = board.entries.find(e => e.id === id && e.status === 'run')
    if (open === undefined) return
    board = {
      ...board,
      ...patch,
      entries: board.entries.map(e => (e === open ? { ...e, status, endedAt: now() } : e)),
      ...(isFault(status) ? { faults: { ...board.faults, [open.station]: (board.faults?.[open.station] ?? 0) + 1 } } : {}),
    }
    kick()
  }

  /** A call that started work going on after it answered stays open under that work's id. */
  function background(id: string | undefined, task: string): void {
    if (id === undefined) return
    board = { ...board, entries: board.entries.map(e => (e.id === id && e.status === 'run' ? { ...e, task } : e)) }
    kick()
  }

  function settle(task: string, status: Status): void {
    const open = board.entries.find(e => e.task === task && e.status === 'run')
    finish(open?.id, status)
  }

  /** The job ids and their endings from an async-result delivery, and nothing else it carries. */
  function settleJobs(jobs: unknown): void {
    if (!Array.isArray(jobs)) return
    for (const item of jobs) {
      const job = record(item)
      if (typeof job?.jobId !== 'string') continue
      settle(job.jobId, job.status === 'failed' ? 'err' : 'ok')
    }
  }

  function context(): Pick<Board, 'context'> {
    try {
      const percent = current?.getContextUsage?.()?.percent
      return typeof percent === 'number' ? { context: percent } : {}
    } catch {
      return {}
    }
  }

  function attach(ctx: HostContext): void {
    if (ctx.hasUI !== true || !enabled || !isMain(ctx)) return
    current = ctx
    const ui = ctx.ui
    if (ui?.setWidget === undefined) return
    ui.setWidget(
      KEY,
      (surface: WidgetSurface) => {
        surfaceRows = typeof surface?.terminal?.rows === 'number' ? surface.terminal.rows : 0
        requestRender = typeof surface?.requestRender === 'function' ? () => surface.requestRender?.() : undefined
        return {
          render: (width: number) => renderWidget(board, now(), setup, width, view(), paint),
          invalidate: () => {},
        }
      },
      { placement: config.placement },
    )
    attached = true
    kick()
  }

  function detach(ctx: HostContext): void {
    attached = false
    requestRender = undefined
    stop()
    try {
      ctx.ui?.setWidget?.(KEY, undefined)
    } catch {
      // A surface that cannot clear the widget is left to its next render.
    }
  }

  /** The same drawing, in a browser window: only the token path is served, and only to this machine. */
  async function openWeb(ctx: HostContext): Promise<void> {
    // The window is named after the session, the folder it works in when the session has no name, and the tail of
    // its id, which tells two windows in one project apart and matches the end of the session's own file name.
    // Read per page load, so a window opened again shows the name the session has by then.
    const title = (): string => {
      const manager = (current ?? ctx).sessionManager
      const name = clean(manager?.getSessionName?.() ?? '', 80) || clean(basename(manager?.getCwd?.() ?? ''), 80) || 'lot-map'
      const id = (manager?.getSessionId?.() ?? '').replace(/\W/g, '').slice(-8)
      return id === '' ? name : `${name} [${id}]`
    }
    if (web === undefined) {
      try {
        web = await serveFrames({ port: config.webPort, title, frame: () => drawMap(board, now(), setup) })
      } catch {
        if (config.webPort !== 0) {
          try {
            web = await serveFrames({ port: 0, title, frame: () => drawMap(board, now(), setup) })
          } catch {
            // No port to be had.
          }
        }
      }
      if (web === undefined) {
        ctx.ui?.notify?.('The work map could not open a port.', 'error')
        return
      }
    }
    const opened = await openWindow(web.url, config.browser)
    ctx.ui?.notify?.(opened ? `Work map opened: ${web.url}` : `Work map: ${web.url}`, 'info')
  }

  /** A row that failed before it could report back is settled when the answer is ready. */
  function settleStale(): void {
    const stale = new Set(board.entries.filter(e => e.status === 'run' && e.task === undefined && e.agentId === undefined))
    if (stale.size === 0) return
    const at = now()
    board = { ...board, entries: board.entries.map(e => (stale.has(e) ? { ...e, status: 'ok' as const, endedAt: at } : e)) }
    kick()
  }

  function toolStarted(event: ToolStart): void {
    const seen = classifyPi(event.toolName ?? 'tool', event.args ?? {}, setup)
    toolEntries.set(event.toolCallId ?? '', begin({ ...seen, from: 'core' }))
  }

  function toolEnded(event: ToolEnd): void {
    const callId = event.toolCallId ?? ''
    const id = toolEntries.get(callId)
    toolEntries.delete(callId)
    if (id === undefined) return
    const job = record(record(event.result)?.details)?.async
    const state = record(job)?.state
    const jobId = record(job)?.jobId
    if (event.isError !== true && state === 'running' && typeof jobId === 'string') {
      background(id, jobId)
      return
    }
    finish(id, event.isError === true ? 'err' : 'ok')
  }

  host.on('session_start', (_event, ctx) => {
    serving = isMain(ctx)
    const loaded = readConfig(isOmp(ctx))
    setup = loaded.setup
    config = loaded.config
    enabled = loaded.config.enabled
    board = { entries: [], counts: {}, model: ctx.model?.id }
    toolEntries.clear()
    agentEntries.clear()
    turnEntry = undefined
    attach(ctx)
    kick()
  })

  host.on('session_shutdown', (_event, ctx) => {
    detach(ctx)
    void web?.close()
    web = undefined
  })

  host.on('input', (event: { source?: string; text?: string }, ctx) => {
    if (!serving || !isMain(ctx) || event.source === 'extension' || (event.text ?? '').trim() === '') return
    board = { ...board, faults: {} }
    begin({ station: 'you', label: setup.t.newMessage, from: 'inbound', status: 'ok' })
  })

  host.on('turn_start', (event: { turnIndex?: number }, ctx) => {
    if (!isMain(ctx)) return
    const model = ctx.model?.id
    const step = (event.turnIndex ?? 0) + 1
    turnEntry = begin({
      station: 'model',
      label: model === undefined ? setup.t.step(step) : `${shortModel(model)} · ${setup.t.step(step)}`,
      patch: { ...(model !== undefined ? { model } : {}), step },
    })
  })

  host.on('turn_end', (_event, ctx) => {
    if (!isMain(ctx)) return
    finish(turnEntry, 'ok', context())
    turnEntry = undefined
  })

  host.on('model_select', (event: { previousModel?: { id?: string }; model?: { id?: string } }, ctx) => {
    const before = event.previousModel?.id
    const after = event.model?.id ?? ctx.model?.id
    if (after === undefined) return
    board = { ...board, model: after, switchedAt: now() }
    if (before !== undefined && before !== after) {
      begin({ station: 'model', label: `${shortModel(before)} → ${shortModel(after)}`, status: 'ok', mark: 'switch', uncounted: true })
    }
    kick()
  })

  host.on('tool_execution_start', (event: ToolStart, ctx) => {
    if (!isMain(ctx)) return
    toolStarted(event)
  })

  host.on('tool_execution_end', (event: ToolEnd, ctx) => {
    if (!isMain(ctx)) return
    toolEnded(event)
  })

  host.on('agent_end', (_event, ctx) => {
    if (!isMain(ctx)) return
    const last = board.entries[board.entries.length - 1]
    if (last?.mark !== 'done') begin({ station: 'you', label: setup.t.answerReady, status: 'ok', mark: 'done' })
    settleStale()
  })

  host.on('session_compact', (_event, ctx) => {
    if (!isMain(ctx)) return
    const id = begin({ station: 'model', label: setup.t.compacting })
    finish(id, 'ok', context())
  })

  // omp only: a tool waiting on the person's approval, and how it was answered.
  host.on('tool_approval_requested', (event: { toolCallId?: string; toolName?: string }, ctx) => {
    if (!isMain(ctx)) return
    const id = begin({ station: 'hooks', label: `approval · ${event.toolName ?? 'tool'}` })
    if (event.toolCallId !== undefined) toolEntries.set(`approval:${event.toolCallId}`, id)
  })

  host.on('tool_approval_resolved', (event: { toolCallId?: string; approved?: boolean }, ctx) => {
    if (!isMain(ctx)) return
    const key = `approval:${event.toolCallId ?? ''}`
    const id = toolEntries.get(key)
    toolEntries.delete(key)
    finish(id, event.approved === true ? 'ok' : 'block')
  })

  // Background work reports itself as a custom message; only the job ids and their endings are read.
  host.on('message_start', (event: { message?: unknown }, ctx) => {
    if (!isMain(ctx)) return
    const message = record(event.message)
    if (message?.customType !== 'async-result') return
    settleJobs(record(message.details)?.jobs)
  })

  // A delivery that starts the next turn is already in the branch when that turn begins.
  host.on('agent_start', (_event, ctx) => {
    const branch = ctx.sessionManager?.getBranch?.() ?? []
    for (const entry of branch.slice(-40)) {
      const item = record(entry)
      const message = record(item?.message) ?? item
      if (message?.customType !== 'async-result') continue
      settleJobs(record(message.details)?.jobs)
    }
  })

  // omp only: subagents run in sessions of their own; their frames arrive on the shared bus.
  host.events?.on('task:subagent:lifecycle', data => {
    if (!serving) return
    const frame = record(data)
    if (frame === undefined || typeof frame.id !== 'string') return
    if (frame.status === 'started') {
      board = { ...board, agents: [...(board.agents ?? []).filter(a => a !== frame.id), frame.id].slice(-12) }
      if (agentEntries.has(frame.id)) {
        kick()
        return
      }
      const label = typeof frame.description === 'string' && frame.description !== '' ? frame.description : typeof frame.agent === 'string' ? frame.agent : setup.t.subagent
      agentEntries.set(frame.id, begin({ station: 'agents', label, agentId: frame.id }))
      return
    }
    const status = frame.status === 'failed' || frame.status === 'aborted' ? 'err' : 'ok'
    finish(agentEntries.get(frame.id), status)
    agentEntries.delete(frame.id)
    settle(frame.id, status)
    board = { ...board, agents: (board.agents ?? []).filter(a => a !== frame.id) }
    kick()
  })

  host.events?.on('task:subagent:event', data => {
    if (!serving) return
    const frame = record(data)
    const inner = record(frame?.event)
    const agent = frame?.id
    if (typeof agent !== 'string' || inner === undefined || typeof inner.toolCallId !== 'string') return
    const key = `${agent}:${inner.toolCallId}`
    if (inner.type === 'tool_execution_start') {
      const seen = classifyPi(typeof inner.toolName === 'string' ? inner.toolName : 'tool', record(inner.args) ?? {}, setup)
      toolEntries.set(key, begin({ ...seen, from: 'agents', agentId: agent }))
      return
    }
    if (inner.type === 'tool_execution_end') {
      finish(toolEntries.get(key), inner.isError === true ? 'err' : 'ok')
      toolEntries.delete(key)
    }
  })

  host.registerCommand('lot-map', {
    description: 'Toggle the work map above the editor, or open the browser view (on, off, map, feed, auto, web)',
    handler: async (args, ctx) => {
      const word = args.trim().toLowerCase()
      if (word === 'web') {
        await openWeb(ctx)
        return
      }
      if (word === 'map' || word === 'feed' || word === 'auto') {
        config = { ...config, view: word }
        enabled = true
      } else if (word === 'on') {
        enabled = true
      } else if (word === 'off') {
        enabled = false
      } else {
        enabled = !enabled
      }
      if (!enabled) {
        detach(ctx)
        ctx.ui?.notify?.('Work map closed.', 'info')
        return
      }
      attach(ctx)
      ctx.ui?.notify?.(word === 'map' || word === 'feed' || word === 'auto' ? `Work map: ${word}.` : 'Work map opened.', 'info')
    },
  })
}
