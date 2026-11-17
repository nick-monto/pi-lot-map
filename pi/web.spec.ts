import { expect, test } from 'bun:test'
import { request } from 'node:http'

import { serveFrames } from './web'

type Reply = { status: number; headers: Record<string, unknown>; body: string }

/** A plain request, with the host header under the caller's control. */
const get = (url: string, options: { host?: string; method?: string } = {}): Promise<Reply> => {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>()
  const target = new URL(url)
  const headers: Record<string, string> = { host: options.host ?? target.host }
  const req = request(
    { hostname: '127.0.0.1', port: target.port, path: target.pathname, method: options.method ?? 'GET', headers, setHost: false },
    res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    },
  )
  req.once('error', reject)
  req.end()
  return promise
}

test('the page and its frames are served under the token, and nowhere else', async () => {
  let calls = 0
  const server = await serveFrames({
    frame: () => {
      calls++
      return '<svg xmlns="http://www.w3.org/2000/svg"/>'
    },
  })
  try {
    const page = await get(server.url)
    expect(page.status).toBe(200)
    expect(String(page.headers['content-type'])).toContain('text/html')
    expect(page.body).toContain('requestAnimationFrame')

    const frame = await get(`${server.url}frame`)
    expect(frame.status).toBe(200)
    expect(String(frame.headers['content-type'])).toContain('image/svg+xml')
    expect(frame.body).toContain('<svg')
    expect(calls).toBe(1)

    const bare = await get(server.url.slice(0, -1))
    expect(bare.status).toBe(308)
    expect(bare.headers.location).toBe(new URL(server.url).pathname)

    expect((await get(new URL(server.url).origin + '/')).status).toBe(404)
    expect((await get(new URL(server.url).origin + `/${'a'.repeat(48)}/`)).status).toBe(404)
    expect((await get(server.url, { method: 'POST' })).status).toBe(405)
  } finally {
    await server.close()
  }
})

test('the window is named after the session, and the name cannot read as markup', async () => {
  let name = `lot-map: a<b & "c" it's`
  const titled = await serveFrames({ frame: () => '<svg/>', title: () => name })
  try {
    expect((await get(titled.url)).body).toContain('<title>lot-map: a&#60;b &#38; &#34;c&#34; it&#39;s</title>')
    // A window opened again after the session was renamed shows the new name.
    name = 'lot-map: renamed'
    expect((await get(titled.url)).body).toContain('<title>lot-map: renamed</title>')
  } finally {
    await titled.close()
  }
  const plain = await serveFrames({ frame: () => '<svg/>' })
  try {
    expect((await get(plain.url)).body).toContain('<title>lot-map</title>')
  } finally {
    await plain.close()
  }
})

test('a foreign host cannot read the map', async () => {
  const server = await serveFrames({ frame: () => '<svg/>' })
  try {
    expect((await get(`${server.url}frame`, { host: 'evil.example' })).status).toBe(403)
    expect((await get(server.url, { host: 'evil.example' })).status).toBe(403)
  } finally {
    await server.close()
  }
})

test('a broken drawing answers 500 and leaves the page up', async () => {
  const server = await serveFrames({
    frame: () => {
      throw new Error('no frame')
    },
  })
  try {
    expect((await get(`${server.url}frame`)).status).toBe(500)
    expect((await get(server.url)).status).toBe(200)
  } finally {
    await server.close()
  }
})
