// The map as a terminal widget: a small ring of stations over a feed of the newest rows.
// Colors come from the host's theme, so a light terminal reads as well as a dark one.
import { STATIONS, describeNow, foldRows, formatMs, shortModel } from '../hooks/map'
import type { Setup } from '../hooks/map'
import type { Board, Entry, StationId } from '../types'

type Paint = (color: string, text: string) => string

const ANSI = /^\u001b\[[0-9;]*m/
const ESCAPE = '\u001b'

/** A line cut to the room it has, keeping its colors. */
function clip(text: string, max: number): string {
  if (max <= 0) return ''
  const cut = plainLength(text) > max
  const limit = cut ? max - 1 : max
  let out = ''
  let shown = 0
  for (let i = 0; i < text.length; ) {
    if (text.startsWith(ESCAPE, i)) {
      const code = ANSI.exec(text.slice(i))
      if (code !== null) {
        out += code[0]
        i += code[0].length
        continue
      }
    }
    if (shown >= limit) {
      if (cut) out += '…'
      return out.includes(ESCAPE) ? `${out}\u001b[0m` : out
    }
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 32)
    out += ch
    shown++
    i += ch.length
  }
  return out
}

const plainLength = (text: string): number => {
  let n = 0
  for (let i = 0; i < text.length; ) {
    if (text.startsWith(ESCAPE, i)) {
      const code = ANSI.exec(text.slice(i))
      if (code !== null) {
        i += code[0].length
        continue
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 32)
    n++
    i += ch.length
  }
  return n
}

/** A character grid with a color per cell; rows are painted in runs, so a line carries few escapes. */
class Grid {
  readonly rows: (string | undefined)[][]
  readonly colors: (string | undefined)[][]

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rows = Array.from({ length: height }, () => Array<string | undefined>(width).fill(undefined))
    this.colors = Array.from({ length: height }, () => Array<string | undefined>(width).fill(undefined))
  }

  set(x: number, y: number, ch: string, color: string): void {
    const col = Math.round(x)
    const row = Math.round(y)
    if (col < 0 || row < 0 || col >= this.width || row >= this.height) return
    this.rows[row]![col] = ch
    this.colors[row]![col] = color
  }

  text(x: number, y: number, text: string, color: string): void {
    let col = Math.round(x)
    for (const ch of text) {
      this.set(col, y, ch, color)
      col++
    }
  }

  lines(paint: Paint): string[] {
    return this.rows.map((row, y) => {
      let line = ''
      let run = ''
      let runColor: string | undefined
      const flush = (): void => {
        if (run === '') return
        line += runColor === undefined ? run : paint(runColor, run)
        run = ''
      }
      for (let x = 0; x < this.width; x++) {
        const ch = row[x] ?? ' '
        const color = this.colors[y]![x]
        if (color !== runColor) {
          flush()
          runColor = color
        }
        run += ch
      }
      flush()
      return line
    })
  }
}

const MAP_W = 38
const MAP_H = 9
const CX = 19
const CY = 4
const RX = 15
const RY = 3.2

/** The point on the ring, turned by the layout and rounded to a cell. */
function place(i: number, shift: number): { x: number; y: number } {
  const a = ((i + shift) * 2 * Math.PI) / STATIONS.length
  return { x: Math.round(CX + RX * Math.sin(a)), y: Math.round(CY - RY * Math.cos(a)) }
}

const indexOf = (station: StationId): number => STATIONS.findIndex(s => s.id === station)

/** A dot every other step along a spoke, so the line reads as a route and not as a border. */
function spoke(grid: Grid, from: { x: number; y: number }, to: { x: number; y: number }, color: string, skipStart: number, skipEnd: number): void {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  const steps = Math.max(8, Math.round(length * 3))
  for (let k = 0; k <= steps; k++) {
    if (k % 2 === 1) continue
    const t = k / steps
    if (t * length < skipStart || (1 - t) * length < skipEnd) continue
    grid.set(from.x + dx * t, from.y + dy * t, '·', color)
  }
}

/** The pulse of a call still flying: from the core, or from the agents station, toward its own. */
function pulse(grid: Grid, entry: Entry, now: number, shift: number, lane: number): void {
  const age = now - entry.startedAt
  if (age < 0 || age > 800) return
  const target = place(indexOf(entry.station), shift)
  const origin = entry.from === 'agents' ? place(indexOf('agents'), shift) : { x: CX, y: CY }
  const dx = target.x - origin.x
  const dy = target.y - origin.y
  const length = Math.hypot(dx, dy) || 1
  // Several calls on one spoke fly side by side.
  const ox = (-dy / length) * lane
  const oy = (dx / length) * lane
  const t = 0.2 + 0.74 * Math.min(1, Math.max(0, age / 800))
  const color = entry.status === 'err' || entry.status === 'block' ? 'error' : 'accent'
  grid.set(origin.x + dx * t + ox, origin.y + dy * t + oy, '●', color)
}

function drawRing(board: Board, now: number, setup: Setup): Grid {
  const grid = new Grid(MAP_W, MAP_H)
  const shift = setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0

  STATIONS.forEach((s, i) => spoke(grid, { x: CX, y: CY }, place(i, shift), 'border', 4, 2))

  const flights = board.entries.filter(e => now - e.startedAt < 800 && e.status !== 'ok')
  flights.forEach(entry => {
    const peers = flights.filter(e => e.station === entry.station && e.from === entry.from)
    const lane = (peers.indexOf(entry) - (peers.length - 1) / 2) * 1
    pulse(grid, entry, now, shift, lane)
  })

  STATIONS.forEach((s, i) => {
    const p = place(i, shift)
    const name = setup.t.stations[s.id]
    const code = [...name].slice(0, 3).join('').toUpperCase()
    const count = board.counts[s.id] ?? 0
    const running = board.entries.some(e => e.station === s.id && e.status === 'run')
    const fault = (board.faults?.[s.id] ?? 0) > 0
    const memory = s.id === 'memory' && count > 0
    const color = fault ? 'error' : running ? (memory ? 'success' : 'accent') : memory ? 'success' : count > 0 ? 'text' : 'muted'
    const x = Math.min(Math.max(1, p.x - 1), MAP_W - 4)
    grid.text(x, p.y, code, color)
    if (count > 0) grid.text(x + 3, p.y, count > 9 ? '+' : String(count), 'dim')
    if (fault) grid.set(x - 2, p.y, '!', 'error')
  })

  // The core: how full the context is, what this is, and the model at work.
  const percent = board.context === undefined ? '' : `${Math.round(Math.max(0, Math.min(100, board.context)))}%`
  const center = (text: string, y: number, color: string, max = 11): void => {
    const shown = [...text].slice(0, max).join('')
    grid.text(CX - Math.floor([...shown].length / 2), y, shown, color)
  }
  if (percent !== '') center(percent, CY - 1, (board.context ?? 0) >= 90 ? 'error' : (board.context ?? 0) >= 70 ? 'warning' : 'dim', 4)
  center(setup.core, CY, 'text', 11)
  if (board.model !== undefined) center((shortModel(board.model).split('/').pop() ?? '').trim(), CY + 1, 'muted', 11)

  return grid
}

const MARK: Record<string, string> = { run: '●', ok: '·', err: '✕', block: '✕' }

function feedLines(board: Board, now: number, setup: Setup, width: number, rows: number, paint: Paint): string[] {
  const { t } = setup
  const shown = foldRows(board.entries, rows)
  if (shown.length === 0) return [paint('dim', clip(t.nothingYet, width))]

  const column = Math.min(9, Math.max(...Object.values(t.stations).map(name => [...name].length)))
  return shown.map(({ entry, times }) => {
    const isSwitch = entry.mark === 'switch'
    const mark = isSwitch ? '◆' : (MARK[entry.status] ?? '·')
    const took = entry.endedAt === undefined ? formatMs(now - entry.startedAt, t) : entry.endedAt > entry.startedAt ? formatMs(entry.endedAt - entry.startedAt, t) : ''
    const more = times > 1 ? ` +${times - 1}` : ''
    const station = t.stations[entry.station]
    const left = `${mark} ${station.padEnd(column)} `
    const right = `${more}${took === '' ? '' : `  ${took}`}`
    const room = Math.max(4, width - plainLength(left) - plainLength(right))
    const label = clip(entry.label, room)
    const color = isSwitch || entry.status === 'run' ? 'accent' : entry.status === 'ok' ? 'dim' : 'error'
    const line = `${paint(color, left)}${paint(color, label)}${paint('dim', right)}`
    return clip(line, width)
  })
}

/** The whole widget: a line about the present, the ring when there is room, the tally, and the newest rows. */
export function renderWidget(board: Board, now: number, setup: Setup, width: number, view: 'map' | 'feed', paint: Paint): string[] {
  const { t } = setup
  const out: string[] = []
  const running = board.entries.some(e => e.status === 'run')
  out.push(clip(paint(running ? 'accent' : 'muted', describeNow(board, t)), width))

  if (view === 'map' && width >= MAP_W) {
    out.push(...drawRing(board, now, setup).lines(paint))
    const tally = STATIONS.filter(s => (board.counts[s.id] ?? 0) > 0).map(s => `${t.stations[s.id]} ${board.counts[s.id]}`).join(' · ')
    out.push(clip(paint('dim', tally === '' ? t.noCounts : tally), width))
  }

  out.push(...feedLines(board, now, setup, width, view === 'map' ? 4 : 8, paint))
  return out
}
