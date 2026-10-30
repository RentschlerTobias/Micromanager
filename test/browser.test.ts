import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ensureFfmpeg, MAX_STEPS, parseSteps, runBrowser } from "../src/browser.ts"
import { findChromium, serveDir } from "../src/look.ts"
import { installBrowserTool, type ToolDraft } from "../src/tools.ts"

const chromium = findChromium() ?? null

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), "playwright-"))
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>Demo</title>
<input id="name"><button id="go" onclick="document.getElementById('out').textContent='hi '+document.getElementById('name').value">Go</button>
<output id="out"></output><div style="height:1200px"></div>`)
  return dir
}

test("steps are a list of known verbs with checked arguments", () => {
  const steps = parseSteps(
    '[{"fill":["#name","Ada"]},{"click":"#go"},{"waitText":["#out","hi Ada"]},{"eval":"document.title"},{"shot":"after.png"},{"sleep":100},{"goto":"/next"},{"viewport":[390,844]}]',
  )
  assert.deepEqual(steps.map((s) => s.action), ["fill", "click", "waitText", "eval", "shot", "sleep", "goto", "viewport"])
  assert.deepEqual(steps[0]!.args, ["#name", "Ada"])
  assert.deepEqual(steps[5]!.args, [100])
  assert.deepEqual(parseSteps(""), [])
  assert.equal(parseSteps(undefined).length, 0)
})

test("a bad step is refused with the action and the shape it wanted", () => {
  assert.throws(() => parseSteps("not json"), /steps is not JSON/)
  assert.throws(() => parseSteps("{}"), /JSON array/)
  assert.throws(() => parseSteps('[{"jump":"#x"}]'), /unknown action "jump"/)
  assert.throws(() => parseSteps('[{"click":"#a","fill":["#b","c"]}]'), /one action per step/)
  assert.throws(() => parseSteps('[{"fill":"#name"}]'), /fill takes \[selector, …\]/)
  assert.throws(() => parseSteps('[{"click":""}]'), /click takes a non-empty string/)
  assert.throws(() => parseSteps(`[${Array.from({ length: MAX_STEPS + 1 }, () => '{"back":true}').join(",")}]`), /limited to/)
})

test("a page is driven without a browser only in tests: no browser means a sentence, not a crash", async () => {
  const dir = site()
  const r = await runBrowser({ path: "index.html", steps: "" }, dir, [], { base: dir, chromium: null })
  assert.match(r.text, /No browser is installed/)
  assert.equal(r.images.length, 0)
})

test("an artifact directory outside the worker's own directory is refused", async () => {
  const dir = site()
  const r = await runBrowser({ path: "index.html", steps: "", out: "../elsewhere" }, dir, [], { base: dir, chromium })
  assert.match(r.text, /outside your directory/)
  assert.equal(existsSync(join(dir, "..", "elsewhere")), false)
})

test("a run clicks, fills, reads the page back and returns the picture and the files", async (t) => {
  if (!chromium) return t.skip("no Chromium here")
  const dir = site()
  const media = mkdtempSync(join(tmpdir(), "playwright-media-"))
  const r = await runBrowser(
    {
      path: "index.html",
      steps: '[{"fill":["#name","Ada"]},{"click":"#go"},{"waitText":["#out","hi Ada"]},{"eval":"document.getElementById(\'out\').textContent"},{"shot":"after.png"}]',
      width: "800",
      height: "600",
      full: "true",
    },
    dir,
    [],
    { base: media, chromium },
  )
  assert.match(r.text, /^done: 5 steps/)
  assert.match(r.text, /eval 4: "hi Ada"/)
  assert.equal(r.images.length, 1)
  assert.equal(r.images[0]!.data.subarray(1, 4).toString(), "PNG")
  assert.equal(r.artifacts.length, 1)
  assert.ok(existsSync(r.artifacts[0]!))
  assert.ok(r.artifacts[0]!.startsWith(media))
})

test("a step cannot navigate to a host the job was not granted", async (t) => {
  if (!chromium) return t.skip("no Chromium here")
  const dir = site()
  const r = await runBrowser({ path: "index.html", steps: '[{"goto":"https://evil.test/"}]' }, dir, [], { base: mkdtempSync(join(tmpdir(), "playwright-media-")), chromium })
  assert.match(r.text, /failed: step 1 \(goto\) failed: https:\/\/evil\.test\/ is not a host this job may reach/)
})

test("a run with video writes a recording and hands back keyframes", async (t) => {
  if (!chromium) return t.skip("no Chromium here")
  if (!ensureFfmpeg().ok) return t.skip("no ffmpeg for the recording")
  const dir = site()
  const media = mkdtempSync(join(tmpdir(), "playwright-media-"))
  const r = await runBrowser(
    { path: "index.html", steps: '[{"fill":["#name","Ada"]},{"click":"#go"},{"sleep":900}]', video: "true", width: "640", height: "480" },
    dir,
    [],
    { base: media, chromium },
  )
  const video = r.artifacts.find((f) => f.endsWith(".webm") || f.endsWith(".mp4"))
  assert.ok(video, `a recording among ${r.artifacts.join(", ")}: ${r.text}`)
  assert.ok(statSync(video!).size > 0)
  assert.ok(r.images.length >= 2, "the final view and at least one keyframe")
})

test("the static server answers a client route with index.html, but a missing asset with 404", async () => {
  const dir = site()
  mkdirSync(join(dir, "dist"), { recursive: true })
  writeFileSync(join(dir, "dist", "index.html"), "<h1>app</h1>")
  const s = await serveDir(join(dir, "dist"), { fallback: true })
  try {
    const status = (p: string) => new Promise<number>((ok) => request(`${s.origin}${p}`, (r) => ok(r.statusCode ?? 0)).end())
    assert.equal(await status("/dashboard"), 200)
    assert.equal(await status("/assets/missing.js"), 404)
  } finally {
    await s.close()
  }
})

test("the playwright tool is built from the read schema, refuses other sessions and hands pictures back", async () => {
  const added: Record<string, unknown>[] = []
  const str = { kind: "string" }
  const draft = {
    get: (id: string) => (id === "read" ? { input: { fields: { path: str }, mapFields: (f: () => unknown) => f() } } : undefined),
    add: (tool: Record<string, unknown>) => added.push(tool),
  } as unknown as ToolDraft
  installBrowserTool(draft, async () => ({ text: "ran", images: [{ data: Buffer.from("png"), mime: "image/png" }], artifacts: [] }), (id) => id === "ses_designer")
  const tool = added[0] as { id: string; input: Record<string, unknown>; execute: (a: Record<string, unknown>, c: { sessionID: string }) => Promise<{ content: unknown }> }
  assert.equal(tool.id, "playwright")
  assert.deepEqual(Object.keys(tool.input).sort(), ["device", "format", "full", "height", "out", "path", "settle", "steps", "timeout", "url", "video", "width"])
  assert.deepEqual(await tool.execute({}, { sessionID: "ses_writer" }), { content: "Only a designer of the micromanager may use this tool." })
  const out = await tool.execute({ steps: "[]" }, { sessionID: "ses_designer" }) as { content: { type: string; uri?: string }[] }
  assert.equal(out.content[0]?.type, "text")
  assert.equal(out.content[1]?.type, "file")
  assert.match(out.content[1]?.uri ?? "", /^data:image\/png;base64,/)
})
