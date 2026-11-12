// Which station a pi/omp tool call belongs to, and what to call it. Labels carry names, never content.
import { hostOf, isMemoryPath as isKnownMemoryPath, lastTwo, classifyShell } from '../hooks/map'
import type { Classified, Setup } from '../hooks/map'

/** The path a tool works on, whatever the host calls the field. */
const pathOf = (input: Record<string, unknown>): string => {
  for (const key of ['path', 'file_path', 'filePath', 'notebook_path']) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** pi and omp keep their memory under these folders; Claude's own folder counts too. */
const OWN_MEMORY = /\/\.(?:pi|omp)\/agent\/memory\//i

const isMemoryPath = (path: string, setup: Setup): boolean => {
  const p = path.replace(/\\/g, '/')
  return isKnownMemoryPath(path, setup) || OWN_MEMORY.test(p)
}

/** Stations for the tools both hosts share. */
const FILE_TOOLS: Record<string, true> = { read: true, write: true, edit: true, grep: true, glob: true, find: true, ls: true, lsp: true, ast_edit: true, ast_grep: true }

/** Tools that say something about the work itself, not a file or a command. */
const MEMORY_TOOLS: Record<string, true> = {
  memory_edit: true,
  retain: true,
  recall: true,
  reflect: true,
  checkpoint: true,
  rewind: true,
  new_context: true,
  context_notes: true,
}
const SKILL_TOOLS: Record<string, true> = { learn: true, manage_skill: true }
const AGENT_TOOLS: Record<string, true> = { task: true, wait: true, workflow: true }
const NET_TOOLS: Record<string, true> = { web_search: true, fetch: true, github: true }
const BROWSER_TOOLS: Record<string, true> = { browser: true, computer: true }

/**
 * The tool calls pi and omp make, on the same ten stations as the Claude mod.
 * Unknown tools — MCP servers, extensions and plugins — go by their own names, never by their input.
 */
export function classifyPi(tool: string, input: Record<string, unknown>, setup: Setup): Classified {
  const { t } = setup
  const lower = tool.toLowerCase()

  if (FILE_TOOLS[lower] === true) {
    const path = pathOf(input)
    if (lower === 'read' || lower === 'write' || lower === 'edit') {
      return { station: isMemoryPath(path, setup) ? 'memory' : 'files', label: lastTwo(path) || tool }
    }
    return { station: 'files', label: lastTwo(path) || tool }
  }

  if (lower === 'bash') {
    const description = (typeof input.description === 'string' && input.description) ||
      (typeof input.name === 'string' && input.name) ||
      (typeof input.cwd === 'string' && input.cwd) ||
      ''
    return classifyShell(typeof input.command === 'string' ? input.command : '', description, setup)
  }

  if (NET_TOOLS[lower] === true) {
    if (lower === 'web_search') return { station: 'web', label: t.webSearch }
    return { station: 'web', label: hostOf(typeof input.url === 'string' ? input.url : '') || lower }
  }

  if (BROWSER_TOOLS[lower] === true) {
    return { station: 'browser', label: hostOf(typeof input.url === 'string' ? input.url : '') || lower }
  }

  if (AGENT_TOOLS[lower] === true) {
    // Never `input.task` or `input.prompt`: those carry the assignment, not a name.
    const name = (typeof input.name === 'string' && input.name) || (typeof input.agent === 'string' && input.agent) || t.subagent
    return { station: 'agents', label: name }
  }

  if (lower === 'ask') return { station: 'you', label: t.questionForYou }
  if (lower === 'todo') return { station: 'model', label: 'todo' }
  if (SKILL_TOOLS[lower] === true) return { station: 'skills', label: lower.replace(/_/g, ' ') }
  if (MEMORY_TOOLS[lower] === true) return { station: 'memory', label: setup.memoryLabels.get(lower) ?? lower.replace(/_/g, ' ') }

  const mcp = /^mcp__(.+)$/.exec(tool)
  if (mcp !== null) {
    const rest = mcp[1] ?? ''
    let known: string | undefined
    for (const server of setup.memoryServers) {
      if (rest.startsWith(`${server}_`) || rest.startsWith(`${server}__`)) {
        known = server
        break
      }
    }
    const name = (known === undefined ? rest : rest.slice(known.length).replace(/^_+/, '')).replace(/_/g, ' ') || rest
    const id = typeof input.id === 'number' || (typeof input.id === 'string' && /^[\w-]{1,24}$/.test(input.id)) ? ` #${input.id}` : ''
    if (known !== undefined) return { station: 'memory', label: (setup.memoryLabels.get(name) ?? name) + id }
    if (/browser|chrome/i.test(rest)) return { station: 'browser', label: hostOf(typeof input.url === 'string' ? input.url : '') || name }
    return { station: 'web', label: name }
  }

  return { station: 'shell', label: tool }
}
