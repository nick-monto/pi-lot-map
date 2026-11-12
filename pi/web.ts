// A browser window onto the same drawing: the Claude pane's SVG, served on loopback.
// Only the token path is answered, only from this machine, and only for reading.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { delimiter, join } from 'node:path'

export type FrameServer = { url: string; close: () => Promise<void> }

/** The page asks for the next frame as fast as the browser draws, and gives up when hidden. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lot-map</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0a0c11}
@media (prefers-color-scheme:light){html,body{background:#f5f2ea}}
#map{width:100vw;height:100vh}
#map svg{width:100%;height:100%;display:block}
</style></head><body><div id="map"></div>
<script>
var map = document.getElementById('map');
var last = 0, busy = false, dead = 0;
function tick(now) {
  requestAnimationFrame(tick);
  if (document.hidden || busy || now - last < 33) return;
  last = now; busy = true;
  fetch('frame', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
    .then(function (svg) { map.innerHTML = svg; dead = 0; })
    .catch(function () { if (++dead === 20) document.title = 'lot-map (closed)'; })
    .finally(function () { busy = false; });
}
requestAnimationFrame(tick);
</script></body></html>`

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

const originOf = (host: string): boolean => /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)

/**
 * Frames on `127.0.0.1`, under a random path so another page cannot guess the address.
 * `frame` is called per request, so the drawing is always current.
 */
export function serveFrames(options: { frame: () => string; port?: number }): Promise<FrameServer> {
  const token = randomBytes(24).toString('hex')
  const prefix = `/${token}`
  const server = createServer((req, res) => {
    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, { ...HEADERS, 'content-type': type })
      if (req.method === 'HEAD' || status === 304) res.end()
      else res.end(body)
    }
    if (!originOf(req.headers.host ?? '')) return send(403, 'text/plain; charset=utf-8', 'Forbidden\n')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      return send(405, 'text/plain; charset=utf-8', 'Method not allowed\n')
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === prefix) {
      res.writeHead(308, { location: `${prefix}/`, ...HEADERS })
      return res.end()
    }
    if (path === `${prefix}/`) return send(200, 'text/html; charset=utf-8', PAGE)
    if (path === `${prefix}/frame`) {
      try {
        return send(200, 'image/svg+xml; charset=utf-8', options.frame())
      } catch {
        return send(500, 'text/plain; charset=utf-8', 'Frame failed\n')
      }
    }
    return send(404, 'text/plain; charset=utf-8', 'Not found\n')
  })
  const { promise, resolve, reject } = Promise.withResolvers<FrameServer>()
  server.once('error', reject)
  server.listen(options.port ?? 0, '127.0.0.1', () => {
    server.off('error', reject)
    server.unref()
    const { port } = server.address() as AddressInfo
    resolve({
      url: `http://127.0.0.1:${port}${prefix}/`,
      close: () => {
        const closed = Promise.withResolvers<void>()
        server.closeAllConnections?.()
        server.close(() => closed.resolve())
        return closed.promise
      },
    })
  })
  return promise
}

const quote = (path: string): string => `"${path}"`

const onPath = (names: readonly string[]): string | undefined => {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name)
      try {
        accessSync(path, constants.X_OK)
        return path
      } catch {
        // Not in this directory.
      }
    }
  }
  return undefined
}

/** A browser that can open a window without tabs or an address bar, when one is installed. */
const appBrowser = (): string | undefined => {
  const env = process.env
  const candidates: string[] = []
  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA !== undefined) candidates.push(join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'))
    if (env.ProgramFiles !== undefined) candidates.push(join(env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'))
    if (env['ProgramFiles(x86)'] !== undefined) candidates.push(join(env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else if (env.WSL_DISTRO_NAME !== undefined || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    candidates.push('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe')
    candidates.push('/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe')
    candidates.push('/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    candidates.push('/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe')
  } else {
    return onPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'])
  }
  return candidates.find(path => existsSync(path))
}

/** Open `url` in an app window when possible; a `browser` setting overrides the choice. */
export async function openWindow(url: string, browser?: string): Promise<boolean> {
  const attempt = (line: string): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const child = spawn(line, { shell: true, detached: true, stdio: 'ignore' })
    child.once('error', () => done(false))
    child.once('spawn', () => {
      child.unref()
      done(true)
    })
    return promise
  }

  if (browser !== undefined && browser !== '') {
    return attempt(browser.includes('{}') ? browser.replaceAll('{}', url) : `${browser} ${url}`)
  }
  const app = appBrowser()
  if (app !== undefined && await attempt(`${quote(app)} --app=${url} --window-size=980,900`)) return true
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd /c start ""' : 'xdg-open'
  return attempt(`${opener} ${url}`)
}
