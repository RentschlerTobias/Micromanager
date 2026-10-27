// The `look` tool of the visual workers: a page, a drawing or an image of their directory as a picture, rendered by the
// plugin on the host.
//
// A browser cannot run in the worker sandbox (found 2026-10-27): Chromium's own sandbox needs user namespaces, which
// bubblewrap refuses inside, and its process singleton needs socket(AF_UNIX), which sandbox-runtime's seccomp filter
// blocks for every worker (unblocking it would open D-Bus, Docker and agent sockets to all of them). So the plugin
// renders: headless Chromium with its own sandbox on, a throwaway profile, the worker's directory served from
// 127.0.0.1, and a resolver that knows no host but that one and the hosts the job may reach. Full-page shots go through
// the DevTools protocol over --remote-debugging-pipe (spike, 2026-10-27: 0.3 s for a 1000 x 2219 page).

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { homedir, tmpdir } from "node:os"
import { extname, join, relative, resolve, sep } from "node:path"

const IMAGES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }
const PAGES = new Set([".html", ".htm", ".svg"])
const MIME: Readonly<Record<string, string>> = {
  ...IMAGES, ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".ico": "image/x-icon", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain",
}

// The tallest full-page shot: a vision model scales it down anyway, and an endless page should not make a huge file.
export const MAX_HEIGHT = 8000

// The browser to render with: the first Chromium found on PATH, in Playwright's cache, or the macOS app.
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave-browser", "brave"]
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    for (const n of names) if (existsSync(join(dir, n))) return join(dir, n)
  }
  const pw = join(env.HOME ?? homedir(), ".cache", "ms-playwright")
  try {
    for (const d of readdirSync(pw).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
      for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) if (existsSync(join(pw, d, sub))) return join(pw, d, sub)
    }
  } catch {
    // no Playwright cache
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  return existsSync(mac) ? mac : undefined
}

// Whether a host matches what the job may reach: "api.example.com" or "*.example.com".
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase()
  return allowed.some((a) => {
    const p = a.toLowerCase()
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h !== p.slice(2) : h === p
  })
}

// Chromium's resolver: nothing resolves but the plugin's own server and the allowed hosts.
export function resolverRules(allowed: readonly string[]): string {
  return ["MAP * ~NOTFOUND", "EXCLUDE 127.0.0.1", ...allowed.map((a) => `EXCLUDE ${a}`)].join(", ")
}

export type Target =
  | { readonly kind: "image"; readonly file: string; readonly mime: string }
  | { readonly kind: "page"; readonly rel: string } // a path below dir, served from 127.0.0.1
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "error"; readonly text: string }

// What a look asks for, checked: a path inside the worker's directory, or a URL on a host the job may reach.
export function lookTarget(input: { path?: string; url?: string }, dir: string, allowed: readonly string[]): Target {
  const path = input.path?.trim()
  const url = input.url?.trim()
  if (!path && !url) return { kind: "error", text: "Name a path in your directory (a page, an svg, an image, or a directory with an index.html) or a url." }
  if (url) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { kind: "error", text: `${url} is no URL.` }
    }
    if (!/^https?:$/.test(u.protocol)) return { kind: "error", text: "Only http and https URLs; a file of yours goes in path." }
    if (!hostAllowed(u.hostname, allowed)) return { kind: "error", text: `${u.hostname} is not a host this job may reach. Build the page and look at it by its path, or ask for the host with request_network.` }
    return { kind: "url", url: u.toString() }
  }
  const root = resolve(dir)
  const full = resolve(root, path!)
  if (full !== root && !full.startsWith(root + sep)) return { kind: "error", text: `${path} is outside your directory.` }
  if (!existsSync(full)) return { kind: "error", text: `${path} does not exist. Build the page first (e.g. npm run build) and look at its output.` }
  const rel = relative(root, full).split(sep).join("/")
  if (forbidden(rel)) return { kind: "error", text: `${path} is not shown.` }
  if (statSync(full).isDirectory()) {
    if (!existsSync(join(full, "index.html"))) return { kind: "error", text: `${path} has no index.html; name the page.` }
    return { kind: "page", rel: rel ? `${rel}/` : "" }
  }
  const ext = extname(full).toLowerCase()
  if (IMAGES[ext]) return { kind: "image", file: full, mime: IMAGES[ext]! }
  if (PAGES.has(ext)) return { kind: "page", rel }
  return { kind: "error", text: `${path} is no page or image (html, svg, png, jpg, gif, webp).` }
}

// Files the static server never hands out: environment files, git's own and the plugin's.
function forbidden(rel: string): boolean {
  return rel.split("/").some((part) => /^\.env(\..*)?$/.test(part) && !/^\.env\.example$/.test(part) || part === ".git" || part === ".micromanager" || part === ".jev-micromanager")
}

// The worker's directory over http on 127.0.0.1, read-only, so absolute asset paths (/assets/x.css) resolve.
export async function serveDir(dir: string): Promise<{ origin: string; close(): Promise<void> }> {
  const root = resolve(dir)
  const server: Server = createServer((req, res) => {
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
    } catch {
      res.writeHead(400).end()
      return
    }
    let full = resolve(root, `.${path}`)
    if ((full !== root && !full.startsWith(root + sep)) || forbidden(relative(root, full).split(sep).join("/"))) {
      res.writeHead(403).end()
      return
    }
    try {
      if (statSync(full).isDirectory()) full = join(full, "index.html")
      const body = readFileSync(full)
      res.writeHead(200, { "content-type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((ok, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => ok())
  })
  const port = (server.address() as { port: number }).port
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(() => ok())) }
}

export interface Shot {
  readonly width: number
  readonly height?: number // the viewport; a full-page shot takes the page's height
  readonly fullPage: boolean
  readonly timeoutMs?: number
}

// One screenshot of url, PNG bytes. The browser is started for it and gone afterwards, its profile with it.
export async function screenshot(chromium: string, url: string, shot: Shot, allowed: readonly string[]): Promise<Buffer> {
  const profile = mkdtempSync(join(tmpdir(), "mm-look-"))
  const browser = spawn(chromium, [
    "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-sync", "--disable-background-networking", "--hide-scrollbars", "--mute-audio",
    `--host-resolver-rules=${resolverRules(allowed)}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] })
  let stderr = ""
  browser.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
  const toBrowser = browser.stdio[3] as NodeJS.WritableStream
  const fromBrowser = browser.stdio[4] as NodeJS.ReadableStream
  let id = 0
  let buf = ""
  const pending = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>()
  const events: { method: string; sessionId?: string }[] = []
  const waiters: { method: string; sessionId?: string; ok: () => void }[] = []
  fromBrowser.on("data", (d: Buffer) => {
    buf += d.toString()
    let i: number
    while ((i = buf.indexOf("\0")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)) as { id?: number; method?: string; sessionId?: string; result?: Record<string, unknown>; error?: { message: string } }
      buf = buf.slice(i + 1)
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)!(m)
        pending.delete(m.id)
      } else if (m.method) {
        const w = waiters.findIndex((x) => x.method === m.method && x.sessionId === m.sessionId)
        if (w >= 0) waiters.splice(w, 1)[0]!.ok()
        else events.push({ method: m.method, sessionId: m.sessionId })
      }
    }
  })
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((ok, fail) => {
      const n = ++id
      pending.set(n, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result ?? {})))
      toBrowser.write(`${JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
    })
  const event = (method: string, sessionId: string) =>
    new Promise<void>((ok) => {
      const i = events.findIndex((e) => e.method === method && e.sessionId === sessionId)
      if (i >= 0) {
        events.splice(i, 1)
        ok()
      } else waiters.push({ method, sessionId, ok })
    })
  const exited = new Promise<never>((_, fail) => browser.once("exit", (code) => fail(new Error(`the browser ended (${code}): ${stderr.trim().split("\n").pop() ?? ""}`))))
  const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`no picture within ${(shot.timeoutMs ?? 30_000) / 1000} s`)), shot.timeoutMs ?? 30_000).unref())
  const work = (async () => {
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string }
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string }
    await send("Page.enable", {}, sessionId)
    const height = shot.height ?? 800
    await send("Emulation.setDeviceMetricsOverride", { width: shot.width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
    const loaded = event("Page.loadEventFired", sessionId)
    const nav = (await send("Page.navigate", { url }, sessionId)) as { errorText?: string }
    if (nav.errorText) throw new Error(`${url} did not load: ${nav.errorText}`)
    await loaded
    // Web fonts and late layout: a short settle after load.
    await new Promise((r) => setTimeout(r, 300))
    let clipHeight = height
    if (shot.fullPage) {
      const m = (await send("Page.getLayoutMetrics", {}, sessionId)) as { cssContentSize?: { height: number } }
      clipHeight = Math.min(MAX_HEIGHT, Math.max(height, Math.ceil(m.cssContentSize?.height ?? height)))
    }
    const r = (await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: shot.fullPage, clip: { x: 0, y: 0, width: shot.width, height: clipHeight, scale: 1 } }, sessionId)) as { data: string }
    return Buffer.from(r.data, "base64")
  })()
  try {
    return await Promise.race([work, exited, timeout])
  } finally {
    exited.catch(() => undefined)
    browser.kill("SIGKILL")
    rmSync(profile, { recursive: true, force: true })
  }
}

export interface LookResult {
  readonly text: string
  readonly image?: { readonly data: Buffer; readonly mime: string }
}

// One look: the checks, then the picture. dir: the worker's directory; allowed: the hosts its job may reach.
// chromium: the browser to use, null for none.
export async function look(input: { path?: string; url?: string; width?: string; height?: string; full?: string }, dir: string, allowed: readonly string[], chromium: string | null = findChromium() ?? null): Promise<LookResult> {
  const target = lookTarget(input, dir, allowed)
  if (target.kind === "error") return { text: target.text }
  if (target.kind === "image") {
    const data = readFileSync(target.file)
    return { text: `${relative(dir, target.file)} (${data.length} bytes)`, image: { data, mime: target.mime } }
  }
  if (!chromium) return { text: "No browser is installed where the plugin runs (chromium, google-chrome or Playwright's chromium), so pages cannot be shown. Images still can." }
  const width = clamp(Number(input.width) || 1280, 320, 2560)
  const height = input.height ? clamp(Number(input.height) || 800, 240, 4000) : 800
  const fullPage = !/^(false|no|0)$/i.test(input.full?.trim() ?? "")
  if (target.kind === "url") {
    const data = await screenshot(chromium, target.url, { width, height, fullPage }, allowed)
    return { text: `${target.url} at ${width} px${fullPage ? ", the whole page" : ""}`, image: { data, mime: "image/png" } }
  }
  const server = await serveDir(dir)
  try {
    const data = await screenshot(chromium, `${server.origin}/${target.rel}`, { width, height, fullPage }, allowed)
    return { text: `${target.rel || "index.html"} at ${width} px${fullPage ? ", the whole page" : ""}; only your directory and the hosts this job may reach load`, image: { data, mime: "image/png" } }
  } finally {
    await server.close()
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)))
