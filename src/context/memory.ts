// The memory as the plugin uses it: the store, the embedder and Jev behind one object, opened lazily. A memory that
// cannot open (no SQLite, an unwritable directory) turns itself off and says why; the plugin works on without it.

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Decider } from "../backends.ts"
import { readMemory } from "../memory.ts"
import { capture, type Candidate, type Verdict } from "./capture.ts"
import { Embedder, type EmbedOptions } from "./embed.ts"
import { coreBlock, recall, recallBlock, type Recalled } from "./recall.ts"
import { search, type SearchResult } from "./search.ts"
import { MemoryStore, projectSlug, type Entry } from "./store.ts"

export interface MemoryOptions {
  readonly root?: string
  readonly embed?: Partial<EmbedOptions> | false // false: keywords only
  readonly git?: boolean
}

export class Memory {
  readonly #o: MemoryOptions
  readonly #decider: Decider | undefined
  readonly #journal: (e: Record<string, unknown>) => void
  #store: MemoryStore | undefined
  #embedder: Embedder | undefined
  #off: string | undefined

  constructor(decider: Decider | undefined, journal: (e: Record<string, unknown>) => void, o: MemoryOptions = {}) {
    this.#decider = decider
    this.#journal = journal
    this.#o = o
  }

  get off(): string | undefined {
    return this.#off
  }

  get embedder(): Embedder | undefined {
    return this.#embedder
  }

  store(): MemoryStore | undefined {
    if (this.#store || this.#off) return this.#store
    try {
      this.#store = new MemoryStore(this.#o.root, { git: this.#o.git ?? true })
      this.#embedder = this.#o.embed === false ? undefined : new Embedder(this.#o.embed ?? {})
    } catch (err) {
      this.#off = String(err)
      this.#journal({ kind: "memory.off", reason: this.#off })
    }
    return this.#store
  }

  slug(dir: string | undefined): string | undefined {
    return dir ? projectSlug(dir) : undefined
  }

  // Moves the old per-project block (.opencode/memory/jev-project.md, src/memory.ts) into the store, once.
  migrate(projectDir: string | undefined): number {
    const s = this.store()
    if (!s || !projectDir) return 0
    const slug = projectSlug(projectDir)
    const marker = join(s.root, `.migrated-${slug}`)
    if (existsSync(marker)) return 0
    const lines = readMemory(projectDir)
    for (const text of lines) s.add({ scope: "project", project: slug, text, pinned: true, source: "jev-project.md" }, "migrate")
    writeFileSync(marker, `${lines.length} entries from ${join(projectDir, ".opencode", "memory", "jev-project.md")}\n`)
    return lines.length
  }

  core(projectDir: string | undefined): string {
    const s = this.store()
    if (!s) return ""
    const slug = this.slug(projectDir)
    return coreBlock(s.list({ ...(slug ? { project: slug } : {}), pinned: true }))
  }

  async recall(task: string, o: { projectDir?: string; role?: string; exclude?: ReadonlySet<string>; session?: string }): Promise<Recalled | undefined> {
    const s = this.store()
    if (!s) return undefined
    const slug = this.slug(o.projectDir)
    return await recall(s, this.#embedder, this.#decider, task, { ...(slug ? { project: slug } : {}), ...(o.role ? { role: o.role } : {}), ...(o.exclude ? { exclude: o.exclude } : {}), ...(o.session ? { session: o.session } : {}), journal: this.#journal })
  }

  async recallText(task: string, o: { projectDir?: string; role?: string; exclude?: ReadonlySet<string>; session?: string }): Promise<{ text: string; ids: string[] }> {
    const r = await this.recall(task, o).catch(() => undefined)
    return r ? { text: recallBlock(r), ids: r.picked.map((h) => h.entry.id) } : { text: "", ids: [] }
  }

  async capture(c: Candidate, projectDir: string | undefined): Promise<Verdict | undefined> {
    const s = this.store()
    if (!s) return undefined
    const slug = this.slug(projectDir)
    return await capture(s, this.#embedder, this.#decider, c, { ...(slug ? { project: slug } : {}), journal: this.#journal })
  }

  async search(query: string, projectDir: string | undefined, limit = 8): Promise<SearchResult | undefined> {
    const s = this.store()
    if (!s) return undefined
    const slug = this.slug(projectDir)
    return await search(s, this.#embedder, query, { ...(slug ? { project: slug } : {}), task: "recall", limit })
  }

  list(projectDir: string | undefined): Entry[] {
    const slug = this.slug(projectDir)
    return this.store()?.list(slug ? { project: slug } : {}) ?? []
  }
}

export const describe = (e: Entry) => `${e.id} [${e.scope}${e.pinned ? ", core" : ""}] ${e.text}`

// The status line the TUI and job_status show: entries, core size, whether vectors are on.
export function memoryStatus(m: Memory, projectDir: string | undefined): string {
  if (m.off) return `memory off: ${m.off.slice(0, 80)}`
  const all = m.list(projectDir)
  const core = all.filter((e) => e.pinned)
  return `memory ${all.length} entries · core ${core.reduce((n, e) => n + e.text.length, 0)} chars · ${m.embedder ? (m.embedder.available ? "vectors" : "keywords (embedding down)") : "keywords"}`
}

