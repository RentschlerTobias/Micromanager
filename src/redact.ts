// Private data never reaches a cloud model: secrets, structured personal data (e-mail, phone, IBAN, card) and, when the
// user turns it on, names and addresses found by the local GLiNER server are swapped for stable placeholders
// (PERSON_1, SECRET_2, email3@redacted.invalid) in every request the context hook sends, and swapped back in the
// arguments of the tools a model calls.
//
// The vault holds value -> placeholder for all sessions and is kept on disk under the plugin's state directory, which
// the sandbox keeps from every worker. One value always gets the same placeholder, so a model can still reason about
// it ("PERSON_1 sent the invoice") and the prompt's prefix stays the same bytes between epochs (src/context/manager.ts).
// Only the outgoing request is changed: OpenCode's database and the TUI keep the real text.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { looksSecret } from "./sandbox.ts"

export type Kind = "secret" | "email" | "phone" | "iban" | "card" | "person" | "address"

export interface Finding {
  readonly value: string
  readonly kind: Kind
  readonly rule: string // which detector found it, for the journal
}

// ---------------------------------------------------------------------------------------------------------------------
// Detectors

// Token formats with a fixed prefix: no false alarm worth the name, so they count wherever they appear.
const TOKENS: readonly { rule: string; re: RegExp }[] = [
  { rule: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { rule: "sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g }, // OpenAI, Anthropic (sk-ant-), DeepSeek, …
  { rule: "stripe", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { rule: "github", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { rule: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { rule: "gitlab", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { rule: "slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { rule: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { rule: "aws", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "google", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "huggingface", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { rule: "npm", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { rule: "pypi", re: /\bpypi-AgE[A-Za-z0-9_-]{50,}/g },
  { rule: "sendgrid", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
]

// The password of a URL with credentials (postgres://app:hunter22@db/x): only the password is secret.
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi

// A value assigned to a name that says it is secret: password = "…", api_key: …, TOKEN=….
const ASSIGNED = /\b(?:password|passwd|pwd|secret|client[_-]?secret|token|auth[_-]?token|access[_-]?token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi

// Shannon entropy in bits per character.
export function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

// A value that reads like a secret rather than an identifier, an expression or a word.
export function secretShaped(v: string): boolean {
  if (v.length < 8 || /[(){}$<>[\]]/.test(v) || isPlaceholder(v)) return false
  if (/^[A-Za-z_.-]+$/.test(v)) return false // config.token, getPassword, changeme-please: names, not values
  return entropy(v) >= 3
}

export function findSecrets(text: string): Finding[] {
  const out: Finding[] = []
  for (const { rule, re } of TOKENS) for (const m of text.matchAll(re)) out.push({ value: m[0], kind: "secret", rule })
  for (const m of text.matchAll(URL_CREDENTIALS)) if (m[1] && !isPlaceholder(m[1])) out.push({ value: m[1], kind: "secret", rule: "url-credentials" })
  for (const m of text.matchAll(ASSIGNED)) if (m[1] && secretShaped(m[1])) out.push({ value: m[1], kind: "secret", rule: "assigned" })
  return out
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g
const SAFE_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost|local|users\.noreply\.github\.com)$/i
const SAFE_LOCAL = /^(?:git|noreply|no-reply)$/i
const PHONE_INTL = /(?<![\w+])\+\d{1,3}[ /-]?(?:\(0\)[ /-]?)?\d{2,5}(?:[ /-]?\d{2,}){1,4}(?![\w])/g
const PHONE_NATIONAL = /(?<![\w./-])0\d{2,5}[ /-]\d{3,}(?:[ -]\d{2,})*(?![\w./-])/g
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g
const CARD = /(?<![\d-])[3456]\d{3}(?:[ -]?\d{2,4}){2,4}(?![\d-])/g

const digits = (s: string): string => s.replace(/\D/g, "")

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/ /g, "")
  if (s.length < 15 || s.length > 34) return false
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let rest = 0
  for (const ch of moved) rest = (rest * 10 + Number(ch)) % 97
  return rest === 1
}

export function luhn(raw: string): boolean {
  const d = digits(raw)
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2
    sum += n
  }
  return sum % 10 === 0
}

export function findPii(text: string): Finding[] {
  const out: Finding[] = []
  // IBAN and card first, each checked by its checksum: a phone pattern inside one of them is no phone number.
  const taken: [number, number][] = []
  const free = (at: number, len: number) => !taken.some(([a, b]) => at < b && at + len > a)
  for (const m of text.matchAll(IBAN)) {
    if (ibanValid(m[0])) {
      out.push({ value: m[0], kind: "iban", rule: "iban" })
      taken.push([m.index, m.index + m[0].length])
    }
  }
  for (const m of text.matchAll(CARD)) {
    if (free(m.index, m[0].length) && luhn(m[0])) {
      out.push({ value: m[0], kind: "card", rule: "card" })
      taken.push([m.index, m.index + m[0].length])
    }
  }
  for (const m of text.matchAll(EMAIL)) {
    const [local, domain] = [m[0].slice(0, m[0].indexOf("@")), m[0].slice(m[0].indexOf("@") + 1)]
    if (!SAFE_DOMAIN.test(domain) && !SAFE_LOCAL.test(local)) out.push({ value: m[0], kind: "email", rule: "email" })
  }
  for (const re of [PHONE_INTL, PHONE_NATIONAL]) {
    for (const m of text.matchAll(re)) {
      const n = digits(m[0]).length
      if (n >= 8 && n <= 15 && free(m.index, m[0].length)) out.push({ value: m[0].trim(), kind: "phone", rule: "phone" })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Placeholders

const PREFIX: Record<Kind, string> = { secret: "SECRET", email: "email", phone: "PHONE", iban: "IBAN", card: "CARD", person: "PERSON", address: "ADDRESS" }
const PLACEHOLDER = /\b(?:(SECRET|PHONE|IBAN|CARD|PERSON|ADDRESS)_(\d+)|email(\d+)@redacted\.invalid)\b/g

export function isPlaceholder(s: string): boolean {
  return new RegExp(`^(?:${PLACEHOLDER.source})$`).test(s)
}

function placeholder(kind: Kind, n: number): string {
  return kind === "email" ? `email${n}@redacted.invalid` : `${PREFIX[kind]}_${n}`
}

// The note every redacting request carries in its system prompt: constant, so it never moves the prompt's prefix.
export const PLACEHOLDER_NOTE =
  "[micromanager] Placeholders such as SECRET_1, PERSON_2, ADDRESS_3, PHONE_4, IBAN_5, CARD_6 or email7@redacted.invalid stand for private data the plugin keeps on this machine. Use them exactly as written: in files you write and commands you run the plugin puts the real value back (a SECRET_n only in files). Never guess, invent or ask for the real value."

// ---------------------------------------------------------------------------------------------------------------------
// The vault

interface Entry {
  readonly value: string
  readonly kind: Kind
  readonly placeholder: string
}

export interface VaultOptions {
  readonly path?: string | null // null: memory only (tests)
  readonly allow?: readonly string[] // values never replaced (the user's own name, say)
  readonly secrets?: boolean
  readonly pii?: boolean
  readonly journal?: (entry: Record<string, unknown>) => void
}

export function vaultPath(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "micromanager", "vault.json")
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
const WORDY = new Set<Kind>(["person", "address", "email", "phone"])

export class Vault {
  readonly #byValue = new Map<string, Entry>()
  readonly #byPlaceholder = new Map<string, Entry>()
  readonly #counters: Record<Kind, number> = { secret: 0, email: 0, phone: 0, iban: 0, card: 0, person: 0, address: 0 }
  readonly #allow: Set<string>
  readonly #path: string | null
  readonly #secrets: boolean
  readonly #pii: boolean
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #scanned = new Set<string>() // hashes of texts the name detector has seen
  #matcher: RegExp | undefined
  #cache = new Map<string, string>()
  version = 0

  constructor(o: VaultOptions = {}) {
    this.#path = o.path === undefined ? vaultPath() : o.path
    this.#allow = new Set((o.allow ?? []).map((a) => a.trim()).filter(Boolean))
    this.#secrets = o.secrets ?? true
    this.#pii = o.pii ?? true
    this.#journal = o.journal ?? (() => {})
    if (this.#path && existsSync(this.#path)) {
      try {
        const saved = JSON.parse(readFileSync(this.#path, "utf8")) as { entries?: Entry[]; scanned?: string[] }
        for (const e of saved.entries ?? []) this.#remember(e)
        for (const h of saved.scanned ?? []) this.#scanned.add(h)
      } catch {
        // a broken file starts a new vault: placeholders change once, the real values are still in OpenCode's database
      }
    }
  }

  get size(): number {
    return this.#byValue.size
  }

  #remember(e: Entry): void {
    this.#byValue.set(e.value, e)
    this.#byPlaceholder.set(e.placeholder, e)
    const n = Number(e.placeholder.match(/\d+/)?.[0] ?? 0)
    if (n > this.#counters[e.kind]) this.#counters[e.kind] = n
  }

  #save(): void {
    if (!this.#path) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const scanned = [...this.#scanned].slice(-20_000)
      writeFileSync(this.#path, JSON.stringify({ entries: [...this.#byValue.values()], scanned }), { mode: 0o600 })
      chmodSync(this.#path, 0o600)
    } catch {
      // losing the file costs new placeholders after a restart, never a leak: the values are found again
    }
  }

  // The placeholder for a value, made on first sight. Undefined for a value that is allowed, too short or a placeholder.
  add(value: string, kind: Kind, rule: string = kind): string | undefined {
    const v = value.trim()
    if (v.length < (kind === "secret" ? 8 : 3) || this.#allow.has(v) || isPlaceholder(v)) return undefined
    const known = this.#byValue.get(v)
    if (known) return known.placeholder
    const e: Entry = { value: v, kind, placeholder: placeholder(kind, ++this.#counters[kind]) }
    this.#remember(e)
    this.#matcher = undefined
    this.#cache.clear()
    this.version++
    this.#save()
    this.#journal({ kind: "redact.new", type: kind, rule, placeholder: e.placeholder, length: v.length })
    return e.placeholder
  }

  // Whether the name detector has seen this text; marks it seen.
  seen(text: string): boolean {
    const h = createHash("sha1").update(text).digest("hex")
    if (this.#scanned.has(h)) return true
    this.#scanned.add(h)
    return false
  }

  saveScanned(): void {
    this.#save()
  }

  #regex(): RegExp | undefined {
    if (this.#matcher || !this.#byValue.size) return this.#matcher
    const values = [...this.#byValue.values()].sort((a, b) => b.value.length - a.value.length)
    // Words only as whole words (Anna in Annalena is not Anna); secrets wherever they occur, they have no edges.
    const parts = values.map((e) => (WORDY.has(e.kind) ? `(?<![\\p{L}\\p{N}_])${escape(e.value)}(?![\\p{L}\\p{N}_])` : escape(e.value)))
    this.#matcher = new RegExp(parts.join("|"), "gu")
    return this.#matcher
  }

  // The text as a cloud model may see it: what the detectors find is added, then every known value is replaced.
  redact(text: string): string {
    if (!text) return text
    const hit = this.#cache.get(text)
    if (hit !== undefined) return hit
    const found = [...(this.#secrets ? findSecrets(text) : []), ...(this.#pii ? findPii(text) : [])]
    for (const f of found) this.add(f.value, f.kind, f.rule)
    const re = this.#regex()
    const out = re ? text.replace(re, (m) => this.#byValue.get(m)?.placeholder ?? m) : text
    if (this.#cache.size > 5000) this.#cache.clear()
    this.#cache.set(text, out)
    return out
  }

  // The real values back, for the kinds `allow` lets through; a placeholder the vault does not know stays as it is.
  restore(text: string, allow: (kind: Kind) => boolean = () => true): string {
    if (!text || !this.#byPlaceholder.size) return text
    return text.replace(PLACEHOLDER, (m) => {
      const e = this.#byPlaceholder.get(m)
      return e && allow(e.kind) ? e.value : m
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Walking a request and a tool call

// Keys whose strings are never text a model reads as words: ids, types, and binary payloads (an image's base64 could
// match a token pattern and come back broken).
const SKIP = new Set(["type", "id", "name", "role", "toolCallId", "toolName", "mediaType", "mimeType", "data", "image", "providerOptions", "providerMetadata"])

// Applies fn to every string in value, in place where it can; returns the new value for a top-level string. Only a
// string that changes is written back: a tool's input can be frozen (live run, 2026-10-27: writing every field back
// made every question form fail with "Attempted to assign to readonly property"), and one that cannot be written is
// left as it is rather than failing the call.
export function mapStrings(value: unknown, fn: (s: string) => string, key?: string): unknown {
  if (typeof value === "string") return key && SKIP.has(key) ? value : fn(value)
  const put = (o: Record<string | number, unknown>, k: string | number, next: unknown) => {
    if (next === o[k]) return
    try {
      o[k] = next
    } catch {
      // frozen: kept as it is
    }
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) put(value as unknown as Record<number, unknown>, i, mapStrings(value[i], fn))
    return value
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>
    for (const k of Object.keys(o)) if (!SKIP.has(k)) put(o, k, mapStrings(o[k], fn, k))
    return value
  }
  return value
}

// Every string of a request's messages and system prompt, the way the walk above sees them: what the name detector reads.
export function requestTexts(messages: unknown, system: readonly { text?: string }[] | undefined): string[] {
  const out: string[] = []
  const take = (s: string) => {
    out.push(s)
    return s
  }
  mapStrings(messages ?? [], take) // take returns each string unchanged, so the walk changes nothing
  for (const p of system ?? []) if (typeof p.text === "string") out.push(p.text)
  return out
}

const FILE_TOOLS = new Set(["write", "edit", "patch", "apply_patch", "multiedit"])
const WEB_TOOLS = /web|fetch|search_web|research/i

// Which placeholders a tool call gets back as real values: files get all of them, so a file keeps its key; the web
// gets none, so a name never leaves in a URL; anything else gets everything but secrets, which a command could send
// away without the model ever seeing them.
export function restoreScope(tool: string): ((kind: Kind) => boolean) | undefined {
  if (WEB_TOOLS.test(tool)) return undefined
  if (FILE_TOOLS.has(tool)) return () => true
  return (kind) => kind !== "secret"
}

// ---------------------------------------------------------------------------------------------------------------------
// Known secrets: values that are secret wherever they appear, whatever their format

function envFileValues(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let v = m[2]!
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, "")
    if (v) out.push({ name: m[1]!, value: v })
  }
  return out
}

// A variable's value worth guarding: its name says secret, or it has the shape of one (long, random). Paths, plain
// words and URLs without credentials stay out, or every "/home/…" in a context would turn into a placeholder.
export function guardedValue(name: string, value: string): boolean {
  if (value.length < 8 || /^[/~.]/.test(value) || /^[a-z][\w+.-]*:\/\/(?![^/\s:@]+:[^/\s@]+@)/i.test(value)) return false
  if (looksSecret(name)) return secretShaped(value) || (value.length >= 12 && !/^[a-z]+$/.test(value))
  return value.length >= 20 && secretShaped(value) && entropy(value) >= 3.5
}

export function knownSecrets(env: NodeJS.ProcessEnv, projectDir?: string, extra: readonly string[] = []): string[] {
  const values = new Set<string>(extra.filter(Boolean))
  for (const [name, value] of Object.entries(env)) if (value && guardedValue(name, value)) values.add(value)
  if (projectDir) {
    let names: string[] = []
    try {
      names = readdirSync(projectDir).filter((f) => /^\.env(\..+)?$/.test(f) && !/\.(example|sample|template|dist)$/.test(f))
    } catch {
      // no directory: no files
    }
    for (const f of names) {
      try {
        for (const { name, value } of envFileValues(readFileSync(join(projectDir, f), "utf8"))) if (guardedValue(name, value)) values.add(value)
      } catch {
        // unreadable: skipped
      }
    }
  }
  return [...values]
}

// ---------------------------------------------------------------------------------------------------------------------
// Names and addresses: the local GLiNER server's entity endpoint (decider/, POST /v1/entities)

export interface NameSettings {
  readonly url: string
  readonly labels: Readonly<Record<string, Kind>> // GLiNER label -> kind
  readonly threshold: number
  readonly timeoutMs?: number
}

export const DEFAULT_LABELS: Readonly<Record<string, Kind>> = { "person name": "person", "street address": "address" }

const CODE_LINE = /(?:[;{}(]\s*$|^\s*(?:import|from|export|def|class|function|const|let|var|return|if|for|while|#include|package|fn|pub|use)\b|=>)/

// What of a text the name detector reads. Code is mostly identifiers, where a model sees names that are none (class
// Jordan, paris_timeout); its comments and string literals are where people's names and addresses live.
export function prose(text: string): string {
  const lines = text.split("\n").map((l) => l.replace(/^\s*\d+[|:\t]\s?/, ""))
  const code = lines.filter((l) => CODE_LINE.test(l)).length
  if (lines.length < 4 || code / lines.length < 0.3) return text
  const kept: string[] = []
  for (const l of lines) {
    const comment = l.match(/(?:\/\/|#|--|\/\*|^\s*\*|<!--)\s?(.*)$/)
    if (comment?.[1]?.trim()) kept.push(comment[1])
    for (const s of l.matchAll(/"((?:[^"\\]|\\.){3,})"|'((?:[^'\\]|\\.){3,})'|`([^`]{3,})`/g)) kept.push(s[1] ?? s[2] ?? s[3] ?? "")
  }
  return kept.join("\n")
}

// A span GLiNER called a person or an address that is worth a placeholder: not an identifier, not a placeholder.
export function plausibleEntity(value: string, kind: Kind): boolean {
  const v = value.trim()
  if (v.length < 3 || isPlaceholder(v) || /[_/\\=<>{}()[\]`]/.test(v)) return false
  if (kind === "person") return /\p{Lu}/u.test(v) && !/^\p{Lu}+$/u.test(v.replace(/\s/g, "")) && !/[a-z][A-Z]/.test(v)
  return true
}

interface EntitySpan {
  readonly label?: string
  readonly text?: string
  readonly score?: number
}

// Asks the GLiNER server for the names and addresses in texts it has not seen; adds them to the vault. Throws when the
// server cannot be reached, so the caller can say so; what was found before that stays found.
export async function scanNames(vault: Vault, texts: readonly string[], s: NameSettings, fetcher: typeof fetch = fetch): Promise<number> {
  const fresh: string[] = []
  for (const t of texts) {
    if (t.length < 3) continue
    const p = prose(t).slice(0, 200_000)
    if (p.trim().length >= 3 && !vault.seen(p)) fresh.push(p)
  }
  if (!fresh.length) return 0
  const res = await fetcher(s.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: fresh, labels: Object.keys(s.labels), threshold: s.threshold }),
    signal: AbortSignal.timeout(s.timeoutMs ?? 30_000),
  })
  if (!res.ok) throw new Error(`entities: HTTP ${res.status}`)
  const body = (await res.json()) as { entities?: EntitySpan[][] }
  let added = 0
  for (const spans of body.entities ?? []) {
    for (const span of spans ?? []) {
      const kind = span.label ? s.labels[span.label] : undefined
      if (!kind || !span.text || !plausibleEntity(span.text, kind)) continue
      if (vault.add(span.text, kind, "gliner")) added++
    }
  }
  vault.saveScanned()
  return added
}

// ---------------------------------------------------------------------------------------------------------------------
// The process-wide vault, for callers that only have text (src/jev.ts)

let active: Vault | undefined

export function useVault(v: Vault | undefined): void {
  active = v
}

// With a vault: placeholders. Without one (redaction off, tests): token formats masked as <secret>, as before.
export function scrub(text: string): string {
  if (active) return active.redact(text)
  let out = text
  for (const f of findSecrets(text)) out = out.split(f.value).join("<secret>")
  return out
}

// The user's own name and e-mail from git: values the vault leaves alone.
export function gitAuthor(): string[] {
  const out: string[] = []
  for (const key of ["user.name", "user.email"]) {
    try {
      const v = execFileSync("git", ["config", "--global", key], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim()
      if (v) out.push(v)
    } catch {
      // not set
    }
  }
  return out
}
