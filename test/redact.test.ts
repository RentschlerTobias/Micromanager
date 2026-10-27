import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { parseRedact } from "../src/config.ts"
import { redact } from "../src/jev.ts"
import {
  findPii, findSecrets, guardedValue, ibanValid, knownSecrets, luhn, mapStrings, plausibleEntity, prose, requestTexts, restoreScope, scanNames, scrub,
  useVault, Vault,
} from "../src/redact.ts"

const vault = (o: ConstructorParameters<typeof Vault>[0] = {}) => new Vault({ path: null, ...o })

test("secrets: token formats, private keys, URL passwords and assigned values; identifiers stay", () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"
  const found = (t: string) => findSecrets(t).map((f) => f.value)
  assert.deepEqual(found(`key:\n${pem}\n`), [pem])
  assert.deepEqual(found("github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789"), ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789"])
  assert.deepEqual(found("AIzaSyA1234567890abcdefghijklmnopqrstuv"), ["AIzaSyA1234567890abcdefghijklmnopqrstuv"])
  assert.deepEqual(found("sk_live_51Habcdefghijklmnop"), ["sk_live_51Habcdefghijklmnop"])
  assert.deepEqual(found("DATABASE_URL=postgres://app:hunter22x@db:5432/app"), ["hunter22x"])
  assert.deepEqual(found('password = "Tr0ub4dor&3x"'), ["Tr0ub4dor&3x"])
  for (const harmless of ["password = getPassword()", "token: config.token", "api_key=process.env.API_KEY", "password: changeme-please", "the token is ready"]) {
    assert.deepEqual(found(harmless), [], harmless)
  }
})

test("structured personal data: e-mail, phone, IBAN and card, each checked; examples and git remotes stay", () => {
  const kinds = (t: string) => findPii(t).map((f) => `${f.kind}:${f.value}`)
  assert.deepEqual(kinds("Write to anna.weber@firma.de"), ["email:anna.weber@firma.de"])
  assert.deepEqual(kinds("user@example.com, git@github.com:me/x.git, 123+me@users.noreply.github.com, a@b.invalid"), [])
  assert.deepEqual(kinds("Call +49 711 1234567 or 0711/1234567"), ["phone:+49 711 1234567", "phone:0711/1234567"])
  assert.deepEqual(kinds("version 1.2.3, port 8080, chmod 0644 file"), [])
  assert.ok(ibanValid("DE89 3704 0044 0532 0130 00"))
  assert.ok(!ibanValid("DE89 3704 0044 0532 0130 01"))
  assert.deepEqual(kinds("IBAN DE89 3704 0044 0532 0130 00."), ["iban:DE89 3704 0044 0532 0130 00"])
  assert.ok(luhn("4111 1111 1111 1111") && !luhn("4111 1111 1111 1112"))
  assert.deepEqual(kinds("card 4111-1111-1111-1111"), ["card:4111-1111-1111-1111"])
  assert.deepEqual(kinds("IBAN DE89 3704 0044 0532 0130 00 and +49 711 1234567"), ["iban:DE89 3704 0044 0532 0130 00", "phone:+49 711 1234567"])
  assert.deepEqual(kinds("card 4111-1111-1111-1112"), [])
  assert.deepEqual(kinds("card 3782 822463 10005"), ["card:3782 822463 10005"])
  assert.deepEqual(kinds("id 38800000000000003 and 4432000000000002"), [], "bare digit runs are ids, not cards")
})

test("the vault: one value, one placeholder, in every text; words only as whole words", () => {
  const v = vault()
  assert.equal(v.add("Anna Weber", "person"), "PERSON_1")
  assert.equal(v.add("Anna Weber", "person"), "PERSON_1")
  assert.equal(v.add("Anna", "person"), "PERSON_2")
  const out = v.redact("Anna Weber and Anna, not Annalena; mail anna@firma.de, key ghp_abcdefghijklmnopqrstuvwxyz12")
  assert.equal(out, "PERSON_1 and PERSON_2, not Annalena; mail email1@redacted.invalid, key SECRET_1")
  assert.equal(v.redact("again: Anna Weber"), "again: PERSON_1", "the same value keeps its placeholder")
  assert.equal(v.redact(out), out, "placeholders are left as they are")
})

test("the vault leaves allowed values and too-short ones alone, and comes back from its file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-"))
  const path = join(dir, "vault.json")
  const a = new Vault({ path, allow: ["tobi@home.de"] })
  assert.equal(a.redact("from tobi@home.de to x@firma.de"), "from tobi@home.de to email1@redacted.invalid")
  assert.equal(a.add("ab", "person"), undefined)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const b = new Vault({ path })
  assert.equal(b.redact("x@firma.de"), "email1@redacted.invalid")
  assert.equal(b.add("y@firma.de", "email"), "email2@redacted.invalid", "the counter goes on")
  assert.doesNotMatch(readFileSync(path, "utf8"), /"tobi@home\.de"/)
})

test("restore: files get every value back, other tools all but secrets, the web nothing", () => {
  const v = vault()
  v.add("Anna Weber", "person")
  v.add("s3cr3t-Val-9876", "secret")
  const text = "PERSON_1 uses SECRET_1; PERSON_9 is unknown"
  assert.equal(v.restore(text, restoreScope("write")), "Anna Weber uses s3cr3t-Val-9876; PERSON_9 is unknown")
  assert.equal(v.restore(text, restoreScope("shell")), "Anna Weber uses SECRET_1; PERSON_9 is unknown")
  assert.equal(restoreScope("webfetch"), undefined)
  const input = { filePath: "a.txt", edits: [{ oldString: "Hi PERSON_1", newString: "Bye PERSON_1" }] }
  mapStrings(input, (s) => v.restore(s, restoreScope("edit")))
  assert.deepEqual(input.edits[0], { oldString: "Hi Anna Weber", newString: "Bye Anna Weber" })
  // A frozen input with nothing to restore is not written to, and one with a placeholder does not fail the call.
  const question = Object.freeze({ questions: Object.freeze([Object.freeze({ header: "Start job", question: "Start?" })]) })
  assert.doesNotThrow(() => mapStrings(question, (s) => v.restore(s, restoreScope("question"))))
  assert.doesNotThrow(() => mapStrings(Object.freeze({ text: "PERSON_1" }), (s) => v.restore(s)))
})

test("a request is redacted in its text, calls and results, never in ids, types or images", () => {
  const v = vault()
  const messages = [
    { role: "user", content: "Mail anna@firma.de" },
    { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { filePath: ".env" } }] },
    { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz12" } }] },
    { role: "user", content: [{ type: "image", mediaType: "image/png", data: "AKIAABCDEFGHIJKLMNOP" }] },
  ]
  mapStrings(messages, (s) => v.redact(s))
  assert.equal(messages[0]!.content, "Mail email1@redacted.invalid")
  assert.match(JSON.stringify(messages[2]), /TOKEN=SECRET_1/)
  assert.match(JSON.stringify(messages[3]), /AKIAABCDEFGHIJKLMNOP/, "binary payloads are not touched")
  assert.match(JSON.stringify(messages[1]), /"id":"c1"/)
  assert.ok(requestTexts(messages, [{ text: "sys" }]).includes("sys"))
})

test("known secrets: variables and .env files by name and shape; paths, words and examples stay out", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-"))
  writeFileSync(join(dir, ".env"), 'DB_PASSWORD="pa55-Word-x9"\nPORT=3000\nexport SESSION_SECRET=abcdefghijklmnop1234\n')
  writeFileSync(join(dir, ".env.example"), "DB_PASSWORD=example-only-123\n")
  const env = { HOME: "/home/x", MY_API_KEY: "q8Zk2LmN4pR7sT1v", AUTH_MODE: "password", LONG_RANDOM: "9f8e7d6c5b4a39281706f5e4d3c2b1a0ff" }
  const values = knownSecrets(env, dir)
  assert.deepEqual(values.sort(), ["9f8e7d6c5b4a39281706f5e4d3c2b1a0ff", "abcdefghijklmnop1234", "pa55-Word-x9", "q8Zk2LmN4pR7sT1v"].sort())
  assert.ok(!guardedValue("CALLBACK_URL", "https://example.com/cb"))
  assert.ok(!guardedValue("CLAUDE_CODE_SESSION_ID", "23d5d6cc-e883-4350-b37c-ae130ea22f1f"), "an id is no secret, even under a session name")
  assert.ok(!guardedValue("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"))
  assert.ok(guardedValue("SESSION_SECRET", "abcdefghijklmnop1234"))
  assert.ok(guardedValue("DATABASE_URL", "postgres://u:pw123456@h/db"))
})

test("names: code is read for its comments and strings; the detector's spans become placeholders once", async () => {
  const code = ["import x from 'y'", "// Maintainer: Anna Weber", "const greeting = \"Hello Jordan Smith\"", "function f() {", "  return paris_timeout;", "}"].join("\n")
  assert.equal(prose(code), ["Maintainer: Anna Weber", "Hello Jordan Smith"].join("\n"))
  assert.equal(prose("Dear Anna,\nthanks."), "Dear Anna,\nthanks.")
  assert.ok(plausibleEntity("Anna Weber", "person") && !plausibleEntity("parisTimeout", "person") && !plausibleEntity("HTTP", "person") && !plausibleEntity("PERSON_1", "person"))

  const v = vault()
  const bodies: unknown[] = []
  const fetcher = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { texts: string[] }
    bodies.push(body)
    return new Response(JSON.stringify({ entities: body.texts.map((t) => (t.includes("Anna Weber") ? [{ label: "person name", text: "Anna Weber", score: 0.9 }, { label: "street address", text: "Lindenstraße 12", score: 0.8 }, { label: "person name", text: "fooBar", score: 0.9 }] : [])) }))
  }) as unknown as typeof fetch
  const s = { url: "http://x/v1/entities", labels: { "person name": "person", "street address": "address" } as const, threshold: 0.5 }
  const text = "Invoice to Anna Weber, Lindenstraße 12."
  assert.equal(await scanNames(v, [text], s, fetcher), 2)
  assert.equal(v.redact(text), "Invoice to PERSON_1, ADDRESS_1.")
  assert.equal(await scanNames(v, [text], s, fetcher), 0)
  assert.equal(bodies.length, 1, "a text the detector has seen is not sent again")
  const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch
  await assert.rejects(scanNames(v, ["new text here"], s, down), /503/)
})

test("scrub: the active vault's placeholders, or masked tokens without one", () => {
  assert.equal(scrub("ghp_abcdefghijklmnopqrstuvwxyz12"), "<secret>")
  const v = vault()
  useVault(v)
  try {
    assert.equal(redact("token ghp_abcdefghijklmnopqrstuvwxyz12 for anna@firma.de"), "token SECRET_1 for email1@redacted.invalid")
  } finally {
    useVault(undefined)
  }
})

test("settings: secrets and structured data on, names off by default; every switch checked", () => {
  assert.deepEqual(parseRedact("{}"), { secrets: true, pii: true, names: false, threshold: 0.5, allow: [] })
  assert.deepEqual(parseRedact('{ "redact": false }'), { secrets: false, pii: false, names: false, threshold: 0.5, allow: [] })
  assert.deepEqual(parseRedact('{ "redact": { "names": true, "threshold": 0.35, "allow": ["ACME GmbH"] } }'), { secrets: true, pii: true, names: true, threshold: 0.35, allow: ["ACME GmbH"] })
  for (const bad of ['{ "redact": "yes" }', '{ "redact": { "names": 1 } }', '{ "redact": { "threshold": 1.5 } }', '{ "redact": { "allow": "x" } }']) assert.throws(() => parseRedact(bad), /redact must be/)
})
