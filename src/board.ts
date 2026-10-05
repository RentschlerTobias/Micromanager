// An ASCII board of a job (the user: "there is no overview of what is going on"): one line per task with its state,
// role, model and current stage, the job's usage, what waits for the user, and what was found but not done. Used by
// job_status and by `node src/cli.ts status` in a terminal (with --watch it redraws).

import type { Job, Task } from "./state.ts"

const ICON: Record<Task["status"], string> = {
  pending: "·",
  ready: "○",
  planned: "▷",
  running: "▶",
  gating: "▶",
  reviewing: "▶",
  fixing: "▶",
  escalated: "✖",
  passed: "✔",
  merged: "✔",
  blocked: "⏸",
  cancelled: "⊘",
}

const short = (model?: string) => (model ? model.slice(model.indexOf("/") + 1).replace(/-flash$|-v[\d.]+/g, "") : "-")
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const k = (n?: number) => (n === undefined ? "0" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

function since(iso?: string, now = Date.now()): string {
  if (!iso) return ""
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${(s / 3600).toFixed(1)}h`
}

// What a task does right now, or why it stopped.
function detail(task: Task, now: number): string {
  const last = task.stages.at(-1)
  if (task.status === "blocked") return `waits: ${task.summary ?? ""}`
  if (task.status === "escalated") return `given up: ${task.escalation?.detail ?? ""}`
  if (["running", "gating", "reviewing", "fixing"].includes(task.status)) {
    const stage = task.status === "running" ? (last?.stage === "classify" ? "working" : last?.stage ?? "working") : task.status
    return `${stage}${task.attempts ? ` · fix ${task.attempts}` : ""}${last ? ` · ${since(last.at, now)}` : ""}`
  }
  if (task.status === "pending" && task.dependsOn.length) return `after ${task.dependsOn.join(", ")}`
  return ""
}

export function board(job: Job, width = 110, now = Date.now()): string {
  const done = job.tasks.filter((t) => t.status === "merged" || t.status === "passed").length
  const head = [
    `┌─ jev-micromanager · ${job.id} · ${job.rolling ? "session tasks" : "planned job"} · ${job.phase}${job.resumePhase ? ` (from ${job.resumePhase})` : ""}`,
    `│  branch ${job.integrationBranch ?? "-"} · ${done}/${job.tasks.length} done · tokens ${k(job.counters.tokens)} · requests ${job.counters.requests ?? 0}${job.counters.cost ? ` · $${job.counters.cost.toFixed(2)}` : ""}`,
    `├${"─".repeat(Math.min(width, 100))}`,
  ]
  const rows = job.tasks.map((t) => {
    const left = `│ ${ICON[t.status]} ${pad(t.id, 6)} ${pad(t.status, 9)} ${pad(t.role, 8)} ${pad(short(t.model), 12)} ${pad(t.session ?? "-", 31)} `
    const rest = `${t.title}${detail(t, now) ? `  ← ${detail(t, now)}` : ""}`
    return `${left}${pad(rest, Math.max(20, width - left.length))}`
  })
  const open = `│   open a task's session: opencode -s <session>  (in another terminal; it shows what the worker does)`
  const later = (job.later ?? []).map((l) => `│   later: ${pad(`${l.what} (${l.from}, ${l.reason.replace(/_/g, " ")})`, width - 12)}`)
  const lessons = job.lessons.slice(-3).map((l) => `│   note: ${pad(l, width - 11)}`)
  return [...head, ...rows, `├${"─".repeat(Math.min(width, 100))}`, open, ...later, ...lessons, `└${"─".repeat(Math.min(width, 100))}`].join("\n")
}
