// The `playwright` tool of the visual workers: a real Playwright browser on the host, driving the page a worker built.
// `look` answers "what does it look like"; this answers "what happens when I click it", and records the run.
//
// Same boundary as `look` (src/look.ts): the page is served from the worker's own directory on 127.0.0.1, Chromium runs
// outside the worker sandbox, and every request is checked against the job's granted hosts. Unlike `look`, the worker
// does not hand over JavaScript: it names steps, and this module maps each to a Playwright call. A worker-written script
// would run with the user's rights in the plugin's process — the hole the whole sandbox exists to close — so the step
// list is the interface, and Playwright stays the engine behind it.

import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"

import type { Browser, BrowserContext, Video } from "playwright-core"

import { findChromium, hostAllowed, lookTarget, MAX_IMAGE_BYTES, resolverRules, serveDir } from "./look.ts"

// A run is bounded in every dimension a worker could spend the host's time and space on.
export const MAX_STEPS = 80
export const MAX_SHOTS = 6
export const MAX_IMAGES = 8
export const MAX_ARTIFACT_BYTES = 40 * 1024 * 1024
export const MAX_SHOT_HEIGHT = 8000
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 300_000
const MAX_TEXT = 4000 // one eval result or one console line, in characters

export interface BrowserStep {
  readonly action: string
  readonly args: readonly (string | number)[]
}

export interface BrowserImage {
  readonly data: Buffer
  readonly mime: string
}

export interface BrowserResult {
  readonly text: string
  readonly images: readonly BrowserImage[]
  readonly artifacts: readonly string[]
}

export interface BrowserOptions {
  readonly base: string // where artifacts go when the worker names no `out`: the job's media directory
  readonly label?: string // the task, for the artifact folder's name
  readonly chromium?: string | null // injected by tests; undefined means "find one"
  readonly env?: NodeJS.ProcessEnv
}

const fail = (text: string): BrowserResult => ({ text, images: [], artifacts: [] })
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)))
const truthy = (value: string | undefined): boolean => /^(true|yes|1|on)$/i.test((value ?? "").trim())
const within = (root: string, file: string): boolean => file === root || file.startsWith(root + sep)
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!

// The step language. Deliberately a list of verbs, not code: each maps to one Playwright call, so the engine keeps its
// auto-waiting and selector syntax (css, text=, role=, [data-testid=…]) without handing the worker the process.
const SELECTOR_ACTIONS = new Set(["click", "dblclick", "hover", "focus", "check", "uncheck", "waitFor", "waitHidden", "scrollTo"])
const POINT_ACTIONS = new Set(["scroll", "wheel", "viewport"])
const FLAG_ACTIONS = new Set(["back", "forward", "reload"])

const ACTIONS = [
  "goto", "click", "dblclick", "hover", "focus", "check", "uncheck", "fill", "type", "press", "select", "upload",
  "waitFor", "waitHidden", "waitText", "sleep", "idle", "scroll", "wheel", "scrollTo", "viewport", "eval", "shot",
  "pdf", "back", "forward", "reload",
]

// "goto": "/dashboard" | "https://granted.host/x" — a path is the served directory, a URL must be a granted host.
// Every other value shape is checked here, before a browser starts, so a typo costs a sentence and not a minute.
export function parseSteps(text: string | undefined): BrowserStep[] {
  const raw = (text ?? "").trim()
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("steps is not JSON; give an array like [{\"click\":\"#start\"},{\"shot\":\"after.png\"}]")
  }
  if (!Array.isArray(value)) throw new Error("steps must be a JSON array of objects, one action per object")
  if (value.length > MAX_STEPS) throw new Error(`steps has ${value.length} actions; a run is limited to ${MAX_STEPS}`)
  return value.map((entry, i) => {
    const at = `step ${i + 1}`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at}: every step is an object like {"click":"#start"}`)
    const keys = Object.keys(entry)
    if (keys.length !== 1) throw new Error(`${at}: one action per step, got ${keys.length ? keys.join(", ") : "none"}`)
    const action = keys[0]!
    if (!ACTIONS.includes(action)) throw new Error(`${at}: unknown action "${action}"; one of ${ACTIONS.join(", ")}`)
    return { action, args: argsOf(action, (entry as Record<string, unknown>)[action], at) }
  })
}

function argsOf(action: string, value: unknown, at: string): (string | number)[] {
  const bad = (wanted: string): Error => {
    const got = typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? JSON.stringify(value) : String(value)
    return new Error(`${at}: ${action} takes ${wanted}, got ${got}`)
  }
  const text = (v: unknown): string => {
    if (typeof v !== "string" || !v.trim()) throw bad("a non-empty string")
    return v
  }
  const count = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad("a number of milliseconds")
    return v
  }
  const pair = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || v.length !== 2 || v.some((x) => typeof x !== "string")) throw bad(`[${what}, …]`)
    return v as string[]
  }
  const point = (v: unknown): number[] => {
    if (!Array.isArray(v) || v.length !== 2 || v.some((x) => typeof x !== "number")) throw bad("[x, y] numbers")
    return v as number[]
  }
  if (SELECTOR_ACTIONS.has(action)) return [text(value)]
  if (action === "fill" || action === "waitText") { const [a, b] = pair(value, "selector"); return [a!, b!] }
  if (action === "press" || action === "select" || action === "upload") {
    const [a, b] = pair(value, action === "upload" ? "selector, path" : "selector, value")
    return [a!, b!]
  }
  if (action === "type") {
    if (!Array.isArray(value) || value.length < 2 || value.length > 3 || typeof value[0] !== "string" || typeof value[1] !== "string") throw bad('[selector, text] or [selector, text, delay]')
    const delay = value[2] === undefined ? 0 : Number(value[2])
    if (!Number.isFinite(delay) || delay < 0) throw bad('[selector, text] or [selector, text, delay]')
    return [value[0], value[1], Math.round(delay)]
  }
  if (POINT_ACTIONS.has(action)) return point(value)
  if (action === "sleep" || action === "idle") return [value === true ? 0 : count(value)]
  if (action === "shot") {
    if (Array.isArray(value)) { const [a, b] = pair(value, "selector, name"); return [a!, b!] }
    return [text(value)]
  }
  if (FLAG_ACTIONS.has(action)) {
    if (value !== true && value !== "") throw bad('true (for example {"back":true})')
    return []
  }
  // goto, eval, pdf and anything else with a single string
  return [text(value)]
}

// One step's worth of extra network access: hostAllowed counts a port that the granted host names, as `look` does.
function navAllowed(url: string, localOrigin: string | undefined, allowed: readonly string[]): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!/^https?:$/.test(u.protocol)) return false
  return u.origin === localOrigin || hostAllowed(u.host, allowed)
}

// Where the tool's files go: the worker's named directory, or the job's media folder (outside every worktree, so a
// recording never lands in a commit by accident).
function artifactDirFor(out: string | undefined, dir: string, base: string, label: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)
  if (out?.trim()) {
    const root = realpathSync(dir)
    const full = resolve(root, out.trim())
    if (!within(root, full)) throw new Error(`${out} is outside your directory.`)
    mkdirSync(full, { recursive: true })
    const real = realpathSync(full)
    if (!within(root, real)) throw new Error(`${out} resolves outside your directory.`)
    return real
  }
  const name = `${label ? `${label.replace(/[^\w.-]+/g, "-")}-` : ""}${stamp}`
  const full = join(base, name)
  mkdirSync(full, { recursive: true })
  return full
}

// A file inside the artifact directory, checked after its parent is made real: a worker can plant a symlink there.
function artifactFile(root: string, name: string, fallback: string): string {
  const clean = name.trim() || fallback
  const full = resolve(root, clean)
  if (!within(root, full)) throw new Error(`${name} leaves the artifact directory.`)
  mkdirSync(dirname(full), { recursive: true })
  const parent = realpathSync(dirname(full))
  if (!within(realpathSync(root), parent)) throw new Error(`${name} resolves outside the artifact directory.`)
  return full
}

function findTool(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""]
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, name + ext)
      try {
        if (statSync(file).isFile()) return file
      } catch {
        // not here
      }
    }
  }
  return undefined
}

// Playwright records video through its own ffmpeg build, which `playwright install` puts beside the browsers. A system
// ffmpeg is enough for that role (spike, 2026-10-30: a 1.9 s WebM, frames readable), so a missing download is filled
// with a link to the one on PATH rather than a 150 MB browser install.
export function ffmpegRevision(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve("playwright-core/package.json")
    const json = JSON.parse(readFileSync(join(dirname(pkg), "browsers.json"), "utf8")) as { browsers?: { name?: string; revision?: string }[] }
    return json.browsers?.find((b) => b.name === "ffmpeg")?.revision
  } catch {
    return undefined
  }
}

const FFMEG_NAMES: Record<string, string | undefined> = { linux: "ffmpeg-linux", darwin: "ffmpeg-mac", win32: "ffmpeg-win64.exe" }
const ffmpegName = (): string | undefined => FFMEG_NAMES[process.platform]

export interface Ffmpeg {
  readonly ok: boolean
  readonly bin?: string // the executable to cut keyframes with
  readonly why?: string
}

export function ensureFfmpeg(env: NodeJS.ProcessEnv = process.env): Ffmpeg {
  const exe = ffmpegName()
  const revision = ffmpegRevision()
  if (!exe || !revision) return { ok: false, why: "this platform or Playwright build has no ffmpeg" }
  const home = env.HOME || homedir()
  // Playwright reads PLAYWRIGHT_BROWSERS_PATH when it is loaded, and its default is this cache. A link for the one
  // binary video needs belongs exactly where `npx playwright install ffmpeg` would have put it; the browsers themselves
  // are never touched, because the system Chromium is launched by path.
  const root = env.PLAYWRIGHT_BROWSERS_PATH?.trim() || join(home, ".cache", "ms-playwright")
  const target = join(root, `ffmpeg-${revision}`, exe)
  if (existsSync(target)) return { ok: true, bin: findTool("ffmpeg", env) ?? target }
  const system = findTool("ffmpeg", env)
  if (!system) return { ok: false, why: "no ffmpeg on PATH and Playwright's own ffmpeg is not installed" }
  try {
    mkdirSync(dirname(target), { recursive: true })
    try {
      symlinkSync(system, target)
    } catch {
      copyFileSync(system, target)
    }
    return { ok: true, bin: system }
  } catch (err) {
    return { ok: false, why: `could not place ffmpeg at ${target}: ${message(err)}` }
  }
}

// A still from a video, so the model sees what the recording shows; the file itself is for the user.
async function keyframes(bin: string, video: string, dir: string, limit: number): Promise<BrowserImage[]> {
  const probe = findTool("ffprobe") ?? join(dirname(bin), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
  if (!existsSync(probe)) return []
  const duration = await new Promise<number>((ok) => {
    const child = spawn(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", video], { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    child.stdout.on("data", (d: Buffer) => (out += d.toString()))
    child.once("error", () => ok(0))
    child.once("close", () => ok(Number(out.trim()) || 0))
  })
  if (!(duration > 0)) return []
  const out: BrowserImage[] = []
  for (const fraction of [0.15, 0.4, 0.65, 0.9].slice(0, limit)) {
    const file = join(dir, `frame-${Math.round(fraction * 100)}.png`)
    const at = (duration * fraction).toFixed(2)
    const made = await new Promise<boolean>((ok) => {
      const child = spawn(bin, ["-v", "error", "-ss", at, "-i", video, "-frames:v", "1", "-y", file], { stdio: "ignore" })
      child.once("error", () => ok(false))
      child.once("close", (code) => ok(code === 0 && existsSync(file)))
    })
    if (!made) continue
    try {
      const data = readFileSync(file)
      if (data.length <= MAX_IMAGE_BYTES) out.push({ data, mime: "image/png" })
    } catch {
      // a missing frame is not a failed run
    }
  }
  return out
}

// Two recordings at once are plenty for a machine that also runs workers; a third waits by asking again.
let active = 0

export async function runBrowser(raw: Record<string, string>, dir: string, allowed: readonly string[], opts: BrowserOptions): Promise<BrowserResult> {
  if (active >= 2) return fail("two browser runs are already going; try again when one has finished")
  active++
  try {
    return await drive(raw, dir, allowed, opts)
  } finally {
    active--
  }
}

// The page as a worker drives it: one browser, one context, steps in order. opts.base is where artifacts go.
async function drive(raw: Record<string, string>, dir: string, allowed: readonly string[], opts: BrowserOptions): Promise<BrowserResult> {
  const target = lookTarget({ path: raw.path, url: raw.url }, dir, allowed)
  if (target.kind === "error") return fail(target.text)
  if (target.kind === "image") return fail("playwright drives a page, not an image; use look for an image.")
  let steps: BrowserStep[]
  try {
    steps = parseSteps(raw.steps)
  } catch (err) {
    return fail(message(err))
  }
  const chromium = opts.chromium === undefined ? (findChromium() ?? null) : opts.chromium
  if (!chromium) return fail("No browser is installed where the plugin runs (chromium, google-chrome or Playwright's chromium), so a page cannot be driven.")

  const width = clamp(Number(raw.width) || 1280, 320, 2560)
  const height = clamp(Number(raw.height) || 800, 240, 4000)
  const fullPage = !/^(false|no|0)$/i.test((raw.full ?? "").trim())
  // An empty field means "not given": the tool hands every field over as a string, "" included.
  const settleMs = raw.settle?.trim() ? clamp(Number(raw.settle) || 0, 0, 10_000) : 300
  const timeoutMs = clamp((raw.timeout?.trim() ? Number(raw.timeout) || DEFAULT_TIMEOUT_MS / 1000 : DEFAULT_TIMEOUT_MS / 1000) * 1000, 5000, MAX_TIMEOUT_MS)
  const video = truthy(raw.video)
  const mp4 = (raw.format ?? "").trim().toLowerCase() === "mp4"

  let ffmpeg: Ffmpeg = { ok: false }
  if (video) {
    ffmpeg = ensureFfmpeg(opts.env)
    if (!ffmpeg.ok) return fail(`video was asked for, but recording needs ffmpeg: ${ffmpeg.why ?? "not found"}. Run "npx playwright install ffmpeg" once, or install ffmpeg, then look again. A run without video still works.`)
  }

  let artifactDir: string
  try {
    artifactDir = artifactDirFor(raw.out, dir, opts.base, opts.label)
  } catch (err) {
    return fail(message(err))
  }

  const images: BrowserImage[] = []
  const artifacts: string[] = []
  const problems: string[] = [] // console errors and page exceptions
  const failed: string[] = [] // requests that never completed
  const results: string[] = [] // eval answers, in order
  let shots = 0
  let server: { origin: string; close(): Promise<void> } | undefined
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let recording: Video | undefined
  let videoFile: string | undefined
  let outcome = ""
  const started = Date.now()

  const push = (list: string[], line: string): void => {
    if (list.length < 20) list.push(line.slice(0, MAX_TEXT))
  }

  try {
    const { chromium: engine, devices } = await import("playwright-core").catch(() => {
      throw new Error("playwright-core is not installed where the plugin runs; install the plugin's dependencies (npm install)")
    })
    let startUrl: string
    let localOrigin: string | undefined
    if (target.kind === "page") {
      server = await serveDir(target.root, { fallback: true })
      localOrigin = server.origin
      startUrl = `${server.origin}${target.path}`
    } else {
      startUrl = target.url
      localOrigin = new URL(target.url).origin
    }

    const device = raw.device?.trim() ? (devices as Record<string, Record<string, unknown>>)[raw.device.trim()] : undefined
    if (raw.device?.trim() && !device) throw new Error(`unknown device "${raw.device}"; try "iPhone 13", "Pixel 7" or "iPad Pro 11"`)

    browser = await engine.launch({
      executablePath: chromium,
      headless: true,
      chromiumSandbox: true,
      args: [`--host-resolver-rules=${resolverRules(allowed)}`, "--disable-background-networking", "--hide-scrollbars", "--mute-audio"],
    })
    // A named device brings its own viewport, scale and user agent; explicit width/height win only without one.
    const screen = device?.viewport as { width: number; height: number } | undefined
    context = await browser.newContext({
      ...(device ?? {}),
      ...(device ? {} : { viewport: { width, height } }),
      deviceScaleFactor: 1, // a 3x phone screenshot is 9x the tokens of the same picture at 1x
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(video ? { recordVideo: { dir: artifactDir, size: screen ? { width: screen.width, height: screen.height } : { width, height } } } : {}),
    } as Parameters<Browser["newContext"]>[0])
    context.setDefaultTimeout(timeoutMs)
    context.setDefaultNavigationTimeout(timeoutMs)
    // The allow-list, at the one place every request passes: the served page, data/blob, and the job's granted hosts.
    // Chromium's resolver rules are the second line, not the first: they do not cover redirects or literal IPs.
    await context.route("**/*", (route) => {
      const request = route.request()
      const url = request.url()
      const ok = /^(about|data|blob):/.test(url) || navAllowed(url, localOrigin, allowed)
      return (ok ? route.continue() : route.abort("blockedbyclient")).catch(() => undefined)
    })
    // A WebSocket is not an HTTP request, so route() never sees it; without this a page could reach a daemon on
    // 127.0.0.1 that the resolver exclusions keep reachable. Ungranted sockets are closed, granted ones pass through.
    try {
      await context.routeWebSocket(/.*/, (ws) => {
        if (navAllowed(ws.url(), localOrigin, allowed)) ws.connectToServer()
        else void ws.close().catch(() => undefined)
      })
    } catch {
      // an older Playwright without WebSocket routing: the launch flags still confine DNS
    }
    const page = await context.newPage()
    recording = page.video() ?? undefined
    page.on("console", (m) => {
      if (m.type() === "error") push(problems, `console: ${m.text()}`)
    })
    page.on("pageerror", (err) => push(problems, `exception: ${err.message}`))
    page.on("requestfailed", (r) => push(failed, `${r.url()} ${r.failure()?.errorText ?? ""}`.trim()))
    page.on("dialog", (d) => void d.dismiss().catch(() => undefined))
    page.on("popup", (p) => void p.close().catch(() => undefined))

    // A page can be tens of thousands of pixels tall; `look` stops at 8000 and so does this, with a clip instead of a
    // picture the provider would reject.
    const snap = async (file: string): Promise<void> => {
      if (!fullPage) {
        await page.screenshot({ path: file })
        return
      }
      const size = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      })).catch(() => ({ width, height }))
      if (size.height > MAX_SHOT_HEIGHT) {
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: Math.min(size.width || width, MAX_SHOT_HEIGHT), height: MAX_SHOT_HEIGHT } })
        return
      }
      await page.screenshot({ path: file, fullPage: true })
    }
    const settle = async (): Promise<void> => {
      await page.evaluate("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true").catch(() => undefined)
      if (settleMs) await page.waitForTimeout(settleMs)
    }
    const go = async (url: string): Promise<void> => {
      if (!navAllowed(url, localOrigin, allowed)) throw new Error(`${url} is not a host this job may reach`)
      const r = await page.goto(url, { waitUntil: "load" })
      if (r && r.status() >= 400) throw new Error(`${url} answered ${r.status()}`)
      await settle()
    }
    const resolvePath = (where: string): string => {
      if (/^https?:\/\//i.test(where)) return where // go() checks the host list
      if (!localOrigin) throw new Error("this page was opened by URL; a goto needs a full URL")
      let u: URL
      try {
        u = new URL(where, `${localOrigin}/`)
      } catch {
        throw new Error(`"${where}" is no path`)
      }
      if (u.origin !== localOrigin) throw new Error(`${where} leaves the served directory`)
      return u.toString()
    }
    const save = (name: string, fallback: string): string => artifactFile(artifactDir, name, fallback)

    await go(startUrl)

    for (const [i, step] of steps.entries()) {
      const at = `step ${i + 1} (${step.action})`
      const sel = String(step.args[0] ?? "")
      const locator = () => page.locator(sel).first()
      try {
        switch (step.action) {
          case "goto": await go(resolvePath(step.args[0] as string)); break
          case "click": await locator().click(); break
          case "dblclick": await locator().dblclick(); break
          case "hover": await locator().hover(); break
          case "focus": await locator().focus(); break
          case "check": await locator().check(); break
          case "uncheck": await locator().uncheck(); break
          case "fill": await locator().fill(String(step.args[1])); break
          case "type": await locator().pressSequentially(String(step.args[1]), { delay: Number(step.args[2] ?? 0) }); break
          case "press":
            if (sel) await locator().press(String(step.args[1]))
            else await page.keyboard.press(String(step.args[1]))
            break
          case "select": await locator().selectOption(String(step.args[1])); break
          case "upload": {
            const file = confine(dir, String(step.args[1]))
            await locator().setInputFiles(file)
            break
          }
          case "waitFor": await locator().waitFor({ state: "visible" }); break
          case "waitHidden": await locator().waitFor({ state: "hidden" }); break
          case "waitText": {
            const [selector, wanted] = [String(step.args[0]), String(step.args[1])]
            await page.waitForFunction(([s, t]) => [...document.querySelectorAll(s!)].some((e) => (e.textContent ?? "").includes(t!)), [selector, wanted] as [string, string])
            break
          }
          case "sleep": await page.waitForTimeout(Number(step.args[0])); break
          case "idle": await page.waitForLoadState("networkidle", { timeout: Number(step.args[0]) || timeoutMs }); break
          case "scroll": await page.evaluate(([x, y]) => window.scrollTo(x!, y!), [Number(step.args[0]), Number(step.args[1])] as [number, number]); break
          case "wheel": await page.mouse.wheel(Number(step.args[0]), Number(step.args[1])); break
          case "scrollTo": await locator().scrollIntoViewIfNeeded(); break
          case "viewport": await page.setViewportSize({ width: clamp(Number(step.args[0]), 200, 3840), height: clamp(Number(step.args[1]), 200, 4000) }); break
          case "eval": {
            const value = await page.evaluate(String(step.args[0]))
            results.push(`eval ${i + 1}: ${JSON.stringify(value ?? null).slice(0, MAX_TEXT)}`)
            break
          }
          case "shot": {
            if (shots >= MAX_SHOTS) throw new Error(`a run takes at most ${MAX_SHOTS} screenshots`)
            const element = step.args.length > 1 ? String(step.args[0]) : undefined
            const name = String(step.args[step.args.length - 1] ?? "")
            const file = save(name, `shot-${shots + 1}.png`)
            if (element) await page.locator(element).first().screenshot({ path: file })
            else await snap(file)
            shots++
            artifacts.push(file)
            const data = readFileSync(file)
            if (data.length > MAX_IMAGE_BYTES) problems.push(`shot ${basename(file)} is ${data.length} bytes; not attached`)
            else if (images.length < MAX_IMAGES) images.push({ data, mime: "image/png" })
            break
          }
          case "pdf": {
            const file = save(String(step.args[0]), "page.pdf")
            await page.pdf({ path: file, format: "a4", printBackground: true })
            artifacts.push(file)
            break
          }
          case "back": await page.goBack({ waitUntil: "load" }); await settle(); break
          case "forward": await page.goForward({ waitUntil: "load" }); await settle(); break
          case "reload": await page.reload({ waitUntil: "load" }); await settle(); break
          default: throw new Error(`unknown action`)
        }
      } catch (err) {
        // A picture of the failure is worth more than the stack: the worker sees what the page showed.
        try {
          const file = save("failed.png", "failed.png")
          await snap(file)
          artifacts.push(file)
          const data = readFileSync(file)
          if (data.length <= MAX_IMAGE_BYTES && images.length < MAX_IMAGES) images.push({ data, mime: "image/png" })
        } catch {
          // no picture either, then
        }
        throw new Error(`${at} failed: ${message(err)}`)
      }
    }

    if (shots === 0) {
      const file = save("final.png", "final.png")
      await snap(file)
      artifacts.push(file)
      const data = readFileSync(file)
      if (data.length <= MAX_IMAGE_BYTES && images.length < MAX_IMAGES) images.push({ data, mime: "image/png" })
    }

    const title = await page.title().catch(() => "")
    outcome = [`done: ${steps.length} step${steps.length === 1 ? "" : "s"} in ${((Date.now() - started) / 1000).toFixed(1)} s`, `page: ${page.url()} — "${title.slice(0, 120)}"`].join("\n")
  } catch (err) {
    outcome = `failed: ${message(err)}`
  } finally {
    // Closing the context writes the recording; it survives a failed run too, which is often the interesting part.
    if (context) await context.close().catch(() => undefined)
    if (recording) videoFile = await recording.path().catch(() => undefined)
    if (browser) await browser.close().catch(() => undefined)
    if (server) await server.close()
  }

  // The video's own name is random; give the file a name the user can find again.
  if (videoFile && existsSync(videoFile)) {
    const wanted = join(artifactDir, `run${mp4 ? ".mp4" : ".webm"}`)
    try {
      if (mp4) {
        if (!(await convert(ffmpeg.bin, videoFile, wanted))) throw new Error("conversion failed")
        rmSync(videoFile, { force: true })
      } else {
        renameSync(videoFile, wanted)
      }
      videoFile = wanted
      artifacts.push(wanted)
    } catch {
      artifacts.push(videoFile)
      outcome += `\nthe recording is ${basename(videoFile)} (could not be renamed${mp4 ? " or converted to mp4" : ""})`
    }
  }

  if (videoFile && ffmpeg.bin && existsSync(videoFile)) {
    const frames = await keyframes(ffmpeg.bin, videoFile, artifactDir, Math.max(0, MAX_IMAGES - images.length))
    images.push(...frames)
  }

  const lines = [outcome]
  if (results.length) lines.push("results:", ...results.map((r) => `  ${r}`))
  if (problems.length) lines.push(`console (${problems.length}):`, ...problems.map((p) => `  ${p}`))
  if (failed.length) lines.push(`blocked or failed requests (${failed.length}):`, ...failed.map((f) => `  ${f}`))
  if (artifacts.length) {
    lines.push("files:", ...artifacts.map((f) => `  ${f} (${bytes(f)})`))
    const total = artifacts.reduce((n, f) => n + sizeOf(f), 0)
    if (total > MAX_ARTIFACT_BYTES) lines.push(`these files total ${Math.round(total / 1024 / 1024)} MB; keep a run's output under ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB`)
  }
  if (server) lines.push("only your directory and the hosts this job may reach loaded")
  if (images.length) lines.push(`${images.length} picture${images.length === 1 ? "" : "s"} follow${videoFile ? "; the recording's keyframes stand in for watching it" : ""}`)
  return { text: lines.join("\n"), images, artifacts }
}

// A file of the worker's own for an upload: inside its directory, real path, not a directory.
function confine(dir: string, path: string): string {
  const root = realpathSync(dir)
  const full = resolve(root, path)
  if (!within(root, full)) throw new Error(`${path} is outside your directory`)
  const real = realpathSync(full)
  if (!within(root, real)) throw new Error(`${path} resolves outside your directory`)
  if (!statSync(real).isFile()) throw new Error(`${path} is no file`)
  return real
}

async function convert(ffmpeg: string | undefined, from: string, to: string): Promise<boolean> {
  if (!ffmpeg) return false
  return await new Promise<boolean>((ok) => {
    const child = spawn(ffmpeg, ["-v", "error", "-y", "-i", from, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", to], { stdio: "ignore" })
    child.once("error", () => ok(false))
    child.once("close", (code) => ok(code === 0 && existsSync(to)))
  })
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function bytes(file: string): string {
  const n = sizeOf(file)
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}
