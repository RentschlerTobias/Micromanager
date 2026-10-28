import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"
import { test } from "node:test"

import { findChromium, hostAllowed, look, lookTarget, missingVisualEvidence, resolverRules, serveDir } from "../src/look.ts"

test("a visual writer cannot finish without a successful picture", () => {
  assert.equal(missingVisualEvidence("visual", false), true)
  assert.equal(missingVisualEvidence("visual", true), false)
  assert.equal(missingVisualEvidence("code", false), false)
})

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), "look-"))
  mkdirSync(join(dir, "dist", "assets"), { recursive: true })
  writeFileSync(join(dir, "dist", "index.html"), '<!doctype html><link rel="stylesheet" href="/assets/app.css"><h1>Hi</h1><div style="height:1500px"></div>')
  writeFileSync(join(dir, "dist", "assets", "app.css"), "h1{color:rgb(0,128,0)}")
  writeFileSync(join(dir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>')
  writeFileSync(join(dir, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"))
  writeFileSync(join(dir, ".env"), "TOKEN=x\n")
  writeFileSync(join(dir, "notes.txt"), "hello")
  writeFileSync(join(dir, "a#b.html"), "<h1>hash</h1>")
  return dir
}

test("a look names a page, an svg, an image or a directory inside the worker's directory, or a URL on an allowed host", () => {
  const dir = site()
  assert.deepEqual(lookTarget({ path: "dist" }, dir, []), { kind: "page", root: join(dir, "dist"), path: "/", label: "dist/" })
  assert.deepEqual(lookTarget({ path: "logo.svg" }, dir, []), { kind: "page", root: dir, path: "/logo.svg", label: "logo.svg" })
  assert.deepEqual(lookTarget({ path: "a#b.html" }, dir, []), { kind: "page", root: dir, path: "/a%23b.html", label: "a#b.html" })
  assert.deepEqual(lookTarget({ path: "./shot.png" }, dir, []), { kind: "image", file: join(dir, "shot.png"), mime: "image/png" })
  assert.match((lookTarget({ path: "../etc/passwd" }, dir, []) as { text: string }).text, /outside your directory/)
  assert.match((lookTarget({ path: ".env" }, dir, []) as { text: string }).text, /not shown/)
  assert.match((lookTarget({ path: "notes.txt" }, dir, []) as { text: string }).text, /no page or image/)
  assert.match((lookTarget({ path: "missing.html" }, dir, []) as { text: string }).text, /does not exist\. Build the page first/)
  const outside = mkdtempSync(join(tmpdir(), "look-outside-"))
  writeFileSync(join(outside, "secret.html"), "<h1>secret</h1>")
  symlinkSync(join(outside, "secret.html"), join(dir, "leak.html"))
  assert.match((lookTarget({ path: "leak.html" }, dir, []) as { text: string }).text, /resolves outside your directory/)
  assert.match((lookTarget({}, dir, []) as { text: string }).text, /Name a path/)
  assert.deepEqual(lookTarget({ url: "https://docs.example.com/x" }, dir, ["*.example.com"]), { kind: "url", url: "https://docs.example.com/x" })
  assert.match((lookTarget({ url: "https://evil.test/" }, dir, ["*.example.com"]) as { text: string }).text, /not a host this job may reach/)
  assert.match((lookTarget({ url: "file:///etc/passwd" }, dir, []) as { text: string }).text, /Only http and https/)
})

test("hosts: exact or a wildcard's subdomains; the resolver knows nothing else", () => {
  assert.ok(hostAllowed("api.example.com", ["api.example.com"]))
  assert.ok(hostAllowed("a.b.example.com", ["*.example.com"]))
  assert.ok(!hostAllowed("example.com", ["*.example.com"]))
  assert.ok(!hostAllowed("example.com.evil.test", ["example.com"]))
  assert.ok(hostAllowed("api.example.com:8443", ["api.example.com"]))
  assert.ok(hostAllowed("api.example.com:8443", ["api.example.com:8443"]))
  assert.ok(!hostAllowed("api.example.com:9443", ["api.example.com:8443"]))
  assert.equal(resolverRules(["api.example.com:8443"]), "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE api.example.com")
})

test("the static server hands out the directory, never its environment files or anything above it", async () => {
  const dir = site()
  const s = await serveDir(dir)
  try {
    const get = async (p: string) => (await fetch(`${s.origin}${p}`)).status
    assert.equal(await get("/dist/"), 200)
    assert.equal(await get("/dist/assets/app.css"), 200)
    assert.equal(await get("/.env"), 403)
    const outside = mkdtempSync(join(tmpdir(), "look-outside-"))
    writeFileSync(join(outside, "secret.css"), "body{display:none}")
    symlinkSync(outside, join(dir, "dist", "leak"))
    assert.equal(await get("/dist/leak/secret.css"), 403)
    // A raw request, which no client normalises: the path still resolves inside the directory.
    writeFileSync(join(dir, "..", `${dir.split("/").pop()}-secret`), "s")
    const raw = await new Promise<number>((ok) => request(`${s.origin}/../${dir.split("/").pop()}-secret`, (r) => ok(r.statusCode ?? 0)).end())
    assert.notEqual(raw, 200)
    assert.equal(await get("/nope.html"), 404)
  } finally {
    await s.close()
  }
})

test("an image comes back as it is, without a browser; a page as a picture when a browser is here", async (t) => {
  const dir = site()
  const img = await look({ path: "shot.png" }, dir, [], null)
  assert.equal(img.image?.mime, "image/png")
  assert.match((await look({ path: "dist" }, dir, [], null)).text, /No browser is installed/)
  const chromium = findChromium()
  if (!chromium) return t.skip("no Chromium here")
  const page = await look({ path: "dist", width: "800" }, dir, [], chromium)
  assert.equal(page.image?.mime, "image/png")
  assert.equal(page.image!.data.subarray(1, 4).toString(), "PNG")
  const height = page.image!.data.readUInt32BE(20)
  assert.equal(page.image!.data.readUInt32BE(16), 800)
  assert.ok(height > 1500, `the whole page, ${height} px`)
  const first = await look({ path: "dist", width: "800", height: "600", full: "false" }, dir, [], chromium)
  assert.equal(first.image!.data.readUInt32BE(20), 600)
})
