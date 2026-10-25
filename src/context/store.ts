// The memory store: what lasts beyond a session, for every project and agent (the user, 2026-10-20 and 2026-10-23).
//
// Texts are the source of truth: one Markdown file per entry with YAML-ish frontmatter, in a git repository, readable
// and editable by hand (the lesson from openMemory). The SQLite index next to them (full-text search, embeddings) is
// derived and rebuilt whenever it falls behind, so a broken index or a changed embedding model loses nothing.
//
// Scopes: `user` (preferences and working style, everywhere), `global` (facts true across projects: tool pitfalls,
// provider quirks), `project` (one project). A pinned entry is core memory in Letta's sense: it is always in the
// prompt of its scope, within a budget per scope; the rest is the archive, found by search (src/context/search.ts).

import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type Scope = "user" | "global" | "project"

export interface Entry {
  readonly id: string
  readonly scope: Scope
  readonly project?: string // the project's slug, for scope "project"
  readonly text: string
  readonly pinned: boolean // core memory: always in the prompt of its scope
  readonly created: string
  readonly updated: string
  readonly source?: string // where it came from: a session, a worker's LEARNED line, the micromanager's tool
  readonly replaces?: string // the entry this one refined (kept in git history)
}

// Characters of pinned entries per scope; past it the oldest pinned entries are unpinned (they stay in the archive).
export const CORE_BUDGET: Record<Scope, number> = { user: 2000, global: 2000, project: 4000 }

export function memoryRoot(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "micromanager", "memory")
}

// A project's slug: its directory name and a short hash of its path, so two checkouts named alike stay apart.
export function projectSlug(dir: string): string {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"
  return `${name}-${createHash("sha256").update(dir).digest("hex").slice(0, 6)}`
}

const STOPWORDS = new Set("the a an and or of to in on at for with by from is are was be it this that as do does how what when where which who not no yes can will would should my your our der die das und oder ein eine ist sind zu im in am mit von für auf wie was wann wo nicht ja kann soll ich du wir es".split(" "))

const FIELDS = ["id", "scope", "project", "pinned", "created", "updated", "source", "replaces"] as const

export function renderEntry(e: Entry): string {
  const head = FIELDS.flatMap((k) => (e[k] === undefined ? [] : [`${k}: ${JSON.stringify(e[k])}`])).join("\n")
  return `---\n${head}\n---\n${e.text.trim()}\n`
}

export function parseEntry(text: string): Entry | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return undefined
  const meta: Record<string, unknown> = {}
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":")
    if (i < 0) continue
    try {
      meta[line.slice(0, i).trim()] = JSON.parse(line.slice(i + 1).trim())
    } catch {
      meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  if (typeof meta.id !== "string" || !["user", "global", "project"].includes(String(meta.scope))) return undefined
  return {
    id: meta.id,
    scope: meta.scope as Scope,
    ...(typeof meta.project === "string" ? { project: meta.project } : {}),
    text: m[2]!.trim(),
    pinned: meta.pinned === true,
    created: String(meta.created ?? ""),
    updated: String(meta.updated ?? meta.created ?? ""),
    ...(typeof meta.source === "string" ? { source: meta.source } : {}),
    ...(typeof meta.replaces === "string" ? { replaces: meta.replaces } : {}),
  }
}

export interface Vector {
  readonly model: string
  readonly values: Float32Array // unit length
}

export class MemoryStore {
  readonly root: string
  readonly #db: DatabaseSync
  readonly #git: boolean

  constructor(root = memoryRoot(), o: { git?: boolean } = {}) {
    this.root = root
    this.#git = o.git ?? true
    mkdirSync(join(root, "entries"), { recursive: true })
    if (!existsSync(join(root, ".gitignore"))) writeFileSync(join(root, ".gitignore"), "index.db*\n")
    this.#db = new DatabaseSync(join(root, "index.db"))
    this.#db.exec(`
      create table if not exists entries (id text primary key, scope text, project text, pinned integer, text text, updated text, recalled integer default 0);
      create virtual table if not exists fts using fts5(id unindexed, text);
      create table if not exists vectors (id text primary key, model text, vec blob);
    `)
    this.#sync()
  }

  // Brings the index level with the files: new or edited files are (re)indexed, removed ones dropped.
  #sync(): void {
    const files = new Map<string, Entry>()
    for (const f of readdirSync(join(this.root, "entries"))) {
      if (!f.endsWith(".md")) continue
      const e = parseEntry(readFileSync(join(this.root, "entries", f), "utf8"))
      if (e) files.set(e.id, e)
    }
    const indexed = new Map((this.#db.prepare("select id, updated, text from entries").all() as { id: string; updated: string; text: string }[]).map((r) => [r.id, r]))
    for (const [id, e] of files) {
      const r = indexed.get(id)
      if (!r || r.updated !== e.updated || r.text !== e.text) this.#index(e)
    }
    for (const id of indexed.keys()) if (!files.has(id)) this.#unindex(id)
  }

  #index(e: Entry): void {
    const recalled = (this.#db.prepare("select recalled from entries where id = ?").get(e.id) as { recalled?: number } | undefined)?.recalled ?? 0
    this.#db.prepare("insert or replace into entries (id, scope, project, pinned, text, updated, recalled) values (?, ?, ?, ?, ?, ?, ?)").run(e.id, e.scope, e.project ?? null, e.pinned ? 1 : 0, e.text, e.updated, recalled)
    this.#db.prepare("delete from fts where id = ?").run(e.id)
    this.#db.prepare("insert into fts (id, text) values (?, ?)").run(e.id, e.text)
    const v = this.#db.prepare("select id from vectors where id = ?").get(e.id)
    if (v) this.#db.prepare("delete from vectors where id = ?").run(e.id) // its text changed: embed again
  }

  #unindex(id: string): void {
    for (const t of ["entries", "fts", "vectors"]) this.#db.prepare(`delete from ${t} where id = ?`).run(id)
  }

  #commit(message: string): void {
    if (!this.#git) return
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "micromanager", GIT_AUTHOR_EMAIL: "micromanager@localhost", GIT_COMMITTER_NAME: "micromanager", GIT_COMMITTER_EMAIL: "micromanager@localhost" }
      if (!existsSync(join(this.root, ".git"))) execFileSync("git", ["init", "-q"], { cwd: this.root, env, stdio: "ignore" })
      execFileSync("git", ["add", "-A"], { cwd: this.root, env, stdio: "ignore" })
      execFileSync("git", ["commit", "-q", "-m", message], { cwd: this.root, env, stdio: "ignore" })
    } catch {
      // nothing to commit, or no git: the files are still written
    }
  }

  #write(e: Entry): void {
    const file = join(this.root, "entries", `${e.id}.md`)
    writeFileSync(`${file}.tmp`, renderEntry(e))
    renameSync(`${file}.tmp`, file)
    this.#index(e)
  }

  get(id: string): Entry | undefined {
    const file = join(this.root, "entries", `${id}.md`)
    return existsSync(file) ? parseEntry(readFileSync(file, "utf8")) : undefined
  }

  // Entries visible to a project: the user's, the global ones and that project's.
  list(o: { project?: string; pinned?: boolean } = {}): Entry[] {
    const rows = this.#db.prepare("select id from entries where (scope != 'project' or project = ?) order by updated").all(o.project ?? "") as { id: string }[]
    return rows.map((r) => this.get(r.id)).filter((e): e is Entry => Boolean(e) && (o.pinned === undefined || e!.pinned === o.pinned))
  }

  add(e: Omit<Entry, "id" | "created" | "updated"> & { id?: string }, message = "add"): Entry {
    const now = new Date().toISOString()
    const entry: Entry = { ...e, id: e.id ?? randomUUID().slice(0, 8), created: now, updated: now }
    this.#write(entry)
    if (entry.pinned) this.#fitCore(entry.scope, entry.project)
    this.#commit(`${message}: ${entry.text.slice(0, 60)}`)
    return entry
  }

  update(id: string, patch: Partial<Pick<Entry, "text" | "pinned" | "scope" | "project">>, message = "update"): Entry | undefined {
    const old = this.get(id)
    if (!old) return undefined
    const entry: Entry = { ...old, ...patch, updated: new Date().toISOString() }
    this.#write(entry)
    if (entry.pinned) this.#fitCore(entry.scope, entry.project)
    this.#commit(`${message}: ${entry.text.slice(0, 60)}`)
    return entry
  }

  remove(id: string, message = "remove"): boolean {
    const file = join(this.root, "entries", `${id}.md`)
    if (!existsSync(file)) return false
    renameSync(file, `${file}.removed`)
    this.#unindex(id)
    this.#commit(`${message}: ${id}`)
    return true
  }

  // Keeps a scope's pinned entries within its budget: the oldest are unpinned and stay searchable.
  #fitCore(scope: Scope, project?: string): void {
    const pinned = this.list({ ...(project ? { project } : {}), pinned: true }).filter((e) => e.scope === scope && (scope !== "project" || e.project === project))
    let size = pinned.reduce((n, e) => n + e.text.length, 0)
    for (const e of pinned) {
      if (size <= CORE_BUDGET[scope]) break
      this.#write({ ...e, pinned: false, updated: new Date().toISOString() })
      size -= e.text.length
    }
  }

  // Full-text matches (BM25), best first. Function words are left out: "the" matched every entry.
  keyword(query: string, project: string | undefined, limit = 30): { id: string; rank: number }[] {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])].filter((w) => !STOPWORDS.has(w)).slice(0, 24)
    if (!words.length) return []
    const match = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ")
    try {
      const rows = this.#db.prepare(`select fts.id as id from fts join entries on entries.id = fts.id where fts match ? and (entries.scope != 'project' or entries.project = ?) order by bm25(fts) limit ?`).all(match, project ?? "", limit) as { id: string }[]
      return rows.map((r, i) => ({ id: r.id, rank: i + 1 }))
    } catch {
      return []
    }
  }

  setVector(id: string, v: Vector): void {
    this.#db.prepare("insert or replace into vectors (id, model, vec) values (?, ?, ?)").run(id, v.model, new Uint8Array(v.values.buffer, v.values.byteOffset, v.values.byteLength))
  }

  // Vectors of the entries a project sees, made with the given model.
  vectors(model: string, project: string | undefined): { id: string; values: Float32Array }[] {
    const rows = this.#db.prepare("select vectors.id as id, vec from vectors join entries on entries.id = vectors.id where model = ? and (entries.scope != 'project' or entries.project = ?)").all(model, project ?? "") as { id: string; vec: Uint8Array }[]
    return rows.map((r) => ({ id: r.id, values: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) }))
  }

  // Entries without a vector from this model (new, edited, or embedded while the service was down).
  missingVectors(model: string, limit = 64): Entry[] {
    const rows = this.#db.prepare("select entries.id as id from entries left join vectors on vectors.id = entries.id and vectors.model = ? where vectors.id is null limit ?").all(model, limit) as { id: string }[]
    return rows.map((r) => this.get(r.id)).filter((e): e is Entry => Boolean(e))
  }

  recalledCount(id: string): number {
    return (this.#db.prepare("select recalled from entries where id = ?").get(id) as { recalled?: number } | undefined)?.recalled ?? 0
  }

  markRecalled(ids: readonly string[]): void {
    for (const id of ids) this.#db.prepare("update entries set recalled = recalled + 1 where id = ?").run(id)
  }

  close(): void {
    this.#db.close()
  }
}
