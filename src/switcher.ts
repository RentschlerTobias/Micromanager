// The agent switcher (src/tui.tsx, `/workers`; /agents is OpenCode's own agent picker): every recent session with its workers under it, as herdr shows its
// agents (the user, 2026-10-19). Plain data, so it is tested without a TUI.
//
// A worker belongs to its parent by OpenCode's parentID, or by the parent the plugin names in the session metadata
// (opencode 2.0.18 drops parentID on a plugin's session.create), or by the job whose task it worked on.

import { elapsed, shortModel } from "./progress.ts"
import type { Job } from "./state.ts"

// A session as the host lists it (client.session.list), only the fields used here.
export interface SessionFacts {
  readonly id: string
  readonly title?: string
  readonly parentID?: string
  readonly agent?: string
  readonly model?: { readonly id?: string; readonly providerID?: string } | string
  readonly cost?: number
  readonly outcome?: string
  readonly time?: { readonly created?: number; readonly updated?: number }
  readonly metadata?: Record<string, unknown>
}

export type Tag = "RUN" | "ASK" | "IDLE" | "DONE" | "FAIL"

export interface AgentRow {
  readonly id: string
  readonly depth: 0 | 1
  readonly tag: Tag
  readonly title: string
  readonly agent: string
  readonly model: string // the family's short name
  readonly elapsed: string // for a running worker
  readonly cost?: number // for a root: what its session cost
}

export interface Live {
  readonly active: ReadonlySet<string> // sessions executing right now
  readonly asking: ReadonlySet<string> // sessions waiting for a permission or an answer
}

// One session under a task in the sidebar (src/tui.tsx JobChecklist): the worker itself (depth 0) or a session it
// spawned (depth 1).
export interface TaskSessionRow {
  readonly id: string
  readonly depth: 0 | 1
  readonly tag: Tag // what it does now, or how it ended; only meaningful when known
  readonly title: string
  readonly agent: string
  readonly elapsed: string // for a running session
  readonly known: boolean // the host still lists it: a job file outlives a session that was deleted
}

export interface TaskSessions {
  readonly rows: readonly TaskSessionRow[]
  readonly hidden: number // sessions it spawned beyond the cap, shown as "+N more"
}

const RECENT_MS = 12 * 60 * 60_000
const MAX_ROOTS = 8
const MAX_DONE = 4 // finished workers shown per root, newest first, after the live ones
const MAX_CHILDREN = 8 // sessions one task's worker may unfold in the sidebar, then "+N more"

// The parent the plugin names in a session's metadata (the key before the rename too).
function namedParent(s: SessionFacts): string | undefined {
  const meta = (s.metadata?.micromanager ?? s.metadata?.jevMicromanager) as { parent?: unknown; helperOf?: unknown } | undefined
  const parent = meta?.parent ?? meta?.helperOf
  return typeof parent === "string" ? parent : undefined
}

export function parentOf(s: SessionFacts, taskOwners: ReadonlyMap<string, string>): string | undefined {
  return s.parentID || namedParent(s) || taskOwners.get(s.id)
}

const modelId = (m: SessionFacts["model"]) => (typeof m === "string" ? m : m?.id ? `${m.providerID ?? ""}/${m.id}` : undefined)

// The tag a session gets in the switcher: what it does right now, or how it ended (a worker, not a root: DONE/FAIL).
export function tagOf(s: SessionFacts, live: Live, worker: boolean): Tag {
  return live.asking.has(s.id) ? "ASK" : live.active.has(s.id) ? "RUN" : !worker ? "IDLE" : s.outcome === "failed" || s.outcome === "interrupted" ? "FAIL" : "DONE"
}

export function agentRows(sessions: readonly SessionFacts[], live: Live, jobs: readonly Job[], current?: string, now = Date.now()): AgentRow[] {
  // The sessions of every task of a job belong to the job's micromanager.
  const owners = new Map<string, string>()
  for (const job of jobs) {
    if (!job.facilitator) continue
    for (const task of job.tasks) for (const id of new Set([task.session, ...(task.sessions ?? [])])) if (id) owners.set(id, job.facilitator)
  }
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const children = new Map<string, SessionFacts[]>()
  const roots: SessionFacts[] = []
  for (const s of sessions) {
    const parent = parentOf(s, owners)
    if (parent && byId.has(parent)) children.set(parent, [...(children.get(parent) ?? []), s])
    else if (!parent) roots.push(s)
  }
  const busy = (id: string) => live.active.has(id) || live.asking.has(id)
  const updated = (s: SessionFacts) => s.time?.updated ?? s.time?.created ?? 0
  const lively = (s: SessionFacts) => busy(s.id) || (children.get(s.id) ?? []).some((c) => busy(c.id))
  const shown = roots
    .filter((s) => lively(s) || s.id === current || now - updated(s) < RECENT_MS)
    // the session on screen first, then the ones with something running, then the newest
    .sort((a, b) => Number(b.id === current) - Number(a.id === current) || Number(lively(b)) - Number(lively(a)) || updated(b) - updated(a))
    .slice(0, MAX_ROOTS)
  const tag = (s: SessionFacts, worker: boolean): Tag => tagOf(s, live, worker)
  const row = (s: SessionFacts, depth: 0 | 1): AgentRow => ({
    id: s.id,
    depth,
    tag: tag(s, depth === 1),
    title: s.title || s.id,
    agent: s.agent ?? "",
    model: shortModel(modelId(s.model)),
    elapsed: depth === 1 && busy(s.id) && s.time?.created ? elapsed(new Date(s.time.created).toISOString(), now) : "",
    ...(depth === 0 && s.cost ? { cost: s.cost } : {}),
  })
  return shown.flatMap((root) => {
    const kids = children.get(root.id) ?? []
    // the ones that wait for the user first, then the running ones by when they started
    const running = kids.filter((c) => busy(c.id)).sort((a, b) => Number(live.asking.has(b.id)) - Number(live.asking.has(a.id)) || (a.time?.created ?? 0) - (b.time?.created ?? 0))
    const ended = kids.filter((c) => !busy(c.id)).sort((a, b) => updated(b) - updated(a)).slice(0, MAX_DONE)
    return [row(root, 0), ...[...running, ...ended].map((c) => row(c, 1))]
  })
}

// The sessions of one task, for the sidebar: the task's own sessions in the order the job records them (oldest first),
// each followed by the sessions it spawned (opencode's parentID, or the parent the plugin names in the metadata). A
// session the host no longer lists stays visible but reads as unknown, because a click on it could only reach an error.
export function taskSessions(ids: readonly string[], sessions: readonly SessionFacts[], live: Live, now = Date.now()): TaskSessions {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const mine = new Set(ids)
  const children = new Map<string, SessionFacts[]>()
  for (const s of sessions) {
    const parent = parentOf(s, new Map())
    // A session the job recorded as one of the task's own is drawn above, not again as a child.
    if (parent && parent !== s.id && mine.has(parent) && !mine.has(s.id)) children.set(parent, [...(children.get(parent) ?? []), s])
  }
  const busy = (id: string) => live.active.has(id) || live.asking.has(id)
  const running = (s: SessionFacts) => (busy(s.id) && s.time?.created ? elapsed(new Date(s.time.created).toISOString(), now) : "")
  const row = (s: SessionFacts, depth: 0 | 1): TaskSessionRow => ({
    id: s.id,
    depth,
    tag: tagOf(s, live, true),
    title: s.title || s.id,
    agent: s.agent ?? "",
    elapsed: running(s),
    known: true,
  })
  const rows: TaskSessionRow[] = []
  let hidden = 0
  for (const id of ids) {
    const session = byId.get(id)
    rows.push(session ? row(session, 0) : { id, depth: 0, tag: "IDLE", title: id, agent: "", elapsed: "", known: false })
    // the ones that wait for the user first, then the running ones, then by when they started
    const kids = (children.get(id) ?? []).sort((a, b) =>
      Number(live.asking.has(b.id)) - Number(live.asking.has(a.id)) || Number(live.active.has(b.id)) - Number(live.active.has(a.id)) || (a.time?.created ?? 0) - (b.time?.created ?? 0))
    for (const kid of kids.slice(0, MAX_CHILDREN)) rows.push(row(kid, 1))
    hidden += Math.max(0, kids.length - MAX_CHILDREN)
  }
  return { rows, hidden }
}

// The panel's top line: "5 running · 1 asks".
export function agentSummary(rows: readonly AgentRow[]): string {
  const run = rows.filter((r) => r.tag === "RUN").length
  const ask = rows.filter((r) => r.tag === "ASK").length
  return [run ? `${run} running` : "", ask ? `${ask} ${ask === 1 ? "asks" : "ask"}` : ""].filter(Boolean).join(" · ") || "nothing running"
}
