// The micromanager in OpenCode's terminal UI: a CLI plugin. opencode 2.0.18 loads it from cli.json "plugins" as a
// package directory whose package.json exports "./tui" (install.sh writes one that imports this file).
//
// - Above the prompt: one line with the job's progress ("job-… · 7/19 ✔ · 3 ▶ · execute").
// - In the sidebar: the job as a checklist, grouped by what needs attention (src/progress.ts sidebarGroups).
// - /workers: a session panel with every recent session and its workers, as herdr shows agents (src/switcher.ts).
// - /tasks: pick a task to open its worker session, or go back to the micromanager from a worker.
//
// The job file is the source of the checklist: it holds every task and its sessions, also those of a planned job,
// whose workers are not children of the micromanager in OpenCode's eyes. Keymap layers only work inside a rendered
// component (live spike: "Keymap.Provider is missing" from setup), so the commands are registered from the "app" slot.

import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, onCleanup, Show } from "solid-js"

import { BOX, jobsFor, projectOf, sidebarCounts, sidebarGroups, summaryLine, taskChoices, view, type JobView, type Mark } from "./progress.ts"
import { listJobs } from "./store.ts"
import { agentRows, agentSummary, type AgentRow, type SessionFacts, type Tag } from "./switcher.ts"
import type { Job } from "./state.ts"

const POLL_MS = 2_000
const PANEL = "micromanager.agents"

type Color = unknown

// The plugin context as this file uses it; the host's own types are not a dependency of this repository.
interface Context {
  theme: { text: { base: Color; muted: Color; action?: { primary?: { base?: Color } } }; diff?: { text?: { added?: Color; removed?: Color } }; hue?: Record<string, Record<string, Color>> }
  data: {
    session: { get(id: string): { location?: { directory?: string } } | undefined }
  }
  client: {
    session: {
      list(input: Record<string, unknown>): Promise<unknown>
      active(input: Record<string, unknown>): Promise<unknown>
      interrupt(input: { sessionID: string }): Promise<unknown>
    }
    permission: {
      list(input: { sessionID: string }): Promise<unknown>
      reply(input: { sessionID: string; requestID: string; decision: "once" | "reject" }): Promise<unknown>
    }
    form?: { list(input: Record<string, unknown>): Promise<unknown> }
  }
  keymap: { layer(build: () => unknown): unknown }
  ui: {
    slot(slot: { append?: string; prepend?: string; render: (input: any) => unknown }): unknown
    toast: { show(toast: { message: string; variant?: string }): void }
    router: { current(): { type: string; sessionID?: string } | undefined; navigate(to: { type: "session"; sessionID: string }): void }
    dialog: { select(input: { title: string; options: { title: string; value: string; description?: string; category?: string }[] }): Promise<string | undefined> }
    panel: { open(name: string): void }
  }
}

// What a host answer holds: the hub wraps lists as { data }.
const items = (answer: unknown): unknown[] => {
  const d = (answer as { data?: unknown })?.data ?? answer
  return Array.isArray(d) ? d : []
}
const ids = (answer: unknown): string[] => {
  const d = (answer as { data?: unknown })?.data ?? answer
  if (Array.isArray(d)) return d.map((x) => (typeof x === "string" ? x : String((x as { id?: unknown; sessionID?: unknown }).sessionID ?? (x as { id?: unknown }).id)))
  return d && typeof d === "object" ? Object.keys(d) : []
}

// The colors of the checklist marks, from the theme, so light and dark both work.
function palette(context: Context) {
  const t = context.theme
  const mark: Record<Mark, Color> = {
    done: t.diff?.text?.added ?? t.text.base,
    failed: t.diff?.text?.removed ?? t.text.base,
    running: t.text.action?.primary?.base ?? t.text.base,
    waiting: t.hue?.orange?.["500"] ?? t.text.base,
    open: t.text.muted,
  }
  const tag: Record<Tag, Color> = { RUN: mark.running, ASK: mark.waiting, IDLE: t.text.muted, DONE: mark.done, FAIL: mark.failed }
  return { base: t.text.base, muted: t.text.muted, mark, tag }
}

const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)

function jobsOf(context: Context, sessionID: string): Job[] {
  const directory = context.data.session.get(sessionID)?.location?.directory
  if (!directory) return []
  try {
    return listJobs(projectOf(directory))
  } catch {
    return [] // a job file being written right now: the next poll reads it
  }
}

function read(context: Context, sessionID: string): JobView[] {
  return jobsFor(jobsOf(context, sessionID), sessionID).map((job) => view(job))
}

// The session's jobs, kept fresh while the component that asked for them is on screen.
function useJobs(context: Context, sessionID: () => string) {
  const [jobs, setJobs] = createSignal<JobView[]>(read(context, sessionID()))
  const timer = setInterval(() => setJobs(read(context, sessionID())), POLL_MS)
  onCleanup(() => clearInterval(timer))
  return jobs
}

// What the given sessions wait for: a pending permission (its action and request id) or an open question.
async function pending(context: Context, sessions: readonly string[]): Promise<Map<string, { what: string; requestID?: string }>> {
  const out = new Map<string, { what: string; requestID?: string }>()
  await Promise.all(sessions.map(async (sessionID) => {
    const first = items(await context.client.permission.list({ sessionID }).catch(() => undefined))[0] as { id?: string; action?: string } | undefined
    if (first?.id) out.set(sessionID, { what: first.action ?? "permission", requestID: first.id })
  }))
  for (const form of items(await context.client.form?.list({}).catch(() => undefined))) {
    const sessionID = (form as { sessionID?: string }).sessionID
    if (sessionID && sessions.includes(sessionID) && !out.has(sessionID)) out.set(sessionID, { what: "a question" })
  }
  return out
}

function Progress(props: { context: Context; sessionID: string }) {
  const jobs = useJobs(props.context, () => props.sessionID)
  return (
    <For each={jobs().filter((j) => j.total > 0)}>
      {(job) => <text fg={props.context.theme.text.muted}>micromanager · {summaryLine(job)} · /tasks · /workers</text>}
    </For>
  )
}

function Checklist(props: { context: Context; sessionID: string }) {
  const jobs = useJobs(props.context, () => props.sessionID)
  const [waiting, setWaiting] = createSignal(new Map<string, string>())
  const [showDone, setShowDone] = createSignal(false)
  const colors = palette(props.context)
  const poll = async () => {
    const running = jobs().flatMap((j) => j.rows.filter((r) => ["running", "gating", "fixing", "reviewing"].includes(r.status) && r.session).map((r) => r.session!))
    const found = running.length ? await pending(props.context, running) : new Map()
    setWaiting(new Map([...found].map(([id, p]) => [id, p.what])))
  }
  void poll()
  const timer = setInterval(() => void poll(), POLL_MS * 2)
  onCleanup(() => clearInterval(timer))
  return (
    <For each={jobs().filter((j) => j.total > 0)}>
      {(job) => {
        const groups = () => sidebarGroups(job, waiting())
        return (
          <box>
            <box flexDirection="row">
              <text fg={colors.base}>{cut(job.title, 26)}</text>
              <box flexGrow={1} />
              <text fg={colors.muted}>{job.phase}</text>
            </box>
            <box flexDirection="row">
              <For each={sidebarCounts(groups())}>{(c) => <text fg={colors.mark[c.mark]}>{c.text} </text>}</For>
              <box flexGrow={1} />
              <text fg={colors.muted}>/{job.total}</text>
            </box>
            <For each={groups()}>
              {(group) => {
                const folded = () => group.key === "done" && !showDone()
                const count = group.key === "done" ? `${group.count} ${showDone() ? "▾" : "▸"}`
                  : group.lines.length < group.count ? `${group.lines.length} of ${group.count}` : String(group.count)
                return (
                  <box paddingTop={1}>
                    <box flexDirection="row" onMouseUp={() => group.key === "done" && setShowDone(!showDone())}>
                      <text fg={colors.base}>{group.name}</text>
                      <box flexGrow={1} />
                      <text fg={colors.muted}>{count}</text>
                    </box>
                    <For each={folded() ? [] : group.lines}>
                      {(line) => (
                        <box flexDirection="row">
                          <text fg={colors.mark[line.mark]}>{BOX[line.mark]} </text>
                          <text fg={line.mark === "open" || line.mark === "done" ? colors.muted : colors.base}>{cut(`${line.id} ${line.title}`, line.detail ? 24 : 32)}</text>
                          <box flexGrow={1} />
                          <Show when={line.detail}>
                            <text fg={colors.muted}>{line.detail}</text>
                          </Show>
                        </box>
                      )}
                    </For>
                  </box>
                )
              }}
            </For>
          </box>
        )
      }}
    </For>
  )
}

// The agent switcher: every recent session with its workers, live; keys move, open, stop and answer.
function Agents(props: { context: Context; panel: { sessionID: string; focused?: boolean; close(): void } }) {
  const context = props.context
  const colors = palette(context)
  const [rows, setRows] = createSignal<AgentRow[]>([])
  const [asks, setAsks] = createSignal(new Map<string, { what: string; requestID?: string }>())
  const [at, setAt] = createSignal(0)
  const refresh = async () => {
    const sessions = items(await context.client.session.list({ limit: 200 }).catch(() => undefined)) as SessionFacts[]
    const active = new Set(ids(await context.client.session.active({}).catch(() => undefined)))
    const jobs = jobsOf(context, props.panel.sessionID)
    const found = await pending(context, [...active])
    setAsks(found)
    setRows(agentRows(sessions, { active, asking: new Set(found.keys()) }, jobs, props.panel.sessionID))
    if (at() >= rows().length) setAt(Math.max(0, rows().length - 1))
  }
  void refresh()
  const timer = setInterval(() => void refresh(), POLL_MS * 1.5)
  onCleanup(() => clearInterval(timer))
  const chosen = () => rows()[at()]
  const answer = async (decision: "once" | "reject") => {
    const row = chosen()
    const ask = row && asks().get(row.id)
    if (!row || !ask?.requestID) return context.ui.toast.show({ message: "Nothing to answer there." })
    await context.client.permission.reply({ sessionID: row.id, requestID: ask.requestID, decision })
      .then(() => context.ui.toast.show({ message: `${decision === "once" ? "Allowed" : "Refused"}: ${ask.what}`, variant: "success" }))
      .catch((err: unknown) => context.ui.toast.show({ message: `Could not answer: ${String(err)}`, variant: "error" }))
    void refresh()
  }
  const on = () => props.panel.focused !== false
  context.keymap.layer(() => ({
    commands: [
      { id: "micromanager.agents.up", bind: "up,k", enabled: on, run: () => setAt(Math.max(0, at() - 1)) },
      { id: "micromanager.agents.down", bind: "down,j", enabled: on, run: () => setAt(Math.min(rows().length - 1, at() + 1)) },
      { id: "micromanager.agents.open", bind: "return", enabled: on, run: () => { const r = chosen(); if (r) { props.panel.close(); context.ui.router.navigate({ type: "session", sessionID: r.id }) } } },
      { id: "micromanager.agents.stop", bind: "x", enabled: on, run: () => { const r = chosen(); if (r) void context.client.session.interrupt({ sessionID: r.id }).then(() => context.ui.toast.show({ message: `Stopped ${cut(r.title, 40)}` })).catch(() => undefined) } },
      { id: "micromanager.agents.yes", bind: "y", enabled: on, run: () => void answer("once") },
      { id: "micromanager.agents.no", bind: "n", enabled: on, run: () => void answer("reject") },
      { id: "micromanager.agents.close", bind: "escape", enabled: on, run: () => props.panel.close() },
    ],
  }))
  return (
    <box paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={colors.base}>Agents</text>
        <box flexGrow={1} />
        <text fg={colors.muted}>{agentSummary(rows())}</text>
      </box>
      <For each={rows()}>
        {(row, i) => (
          <box flexDirection="row" paddingTop={row.depth === 0 && i() > 0 ? 1 : 0} onMouseUp={() => setAt(i())}>
            <text fg={i() === at() ? colors.mark.running : colors.muted}>{i() === at() ? "› " : "  "}</text>
            <text fg={colors.tag[row.tag]}>{row.depth ? "  " : ""}{row.tag.padEnd(4)} </text>
            <text fg={row.depth ? colors.base : colors.base}>{cut(row.title, row.depth ? 38 : 44)}</text>
            <box flexGrow={1} />
            <text fg={colors.muted}>
              {[row.agent, row.model, row.elapsed, asks().get(row.id)?.what ?? "", row.cost ? `$${row.cost.toFixed(2)}` : ""].filter(Boolean).join("  ")}
            </text>
          </box>
        )}
      </For>
      <box paddingTop={1}>
        <text fg={colors.muted}>↑↓ move  ↵ open  x stop  y/n answer  esc close</text>
      </box>
    </box>
  )
}

async function openTask(context: Context): Promise<void> {
  const sessionID = context.ui.router.current()?.sessionID
  const options = sessionID ? taskChoices(read(context, sessionID), sessionID) : []
  if (!sessionID || !options.length) return context.ui.toast.show({ message: "No micromanager job in this session." })
  const chosen = await context.ui.dialog.select({ title: "Micromanager tasks", options })
  if (chosen) context.ui.router.navigate({ type: "session", sessionID: chosen })
  else if (chosen === "") context.ui.toast.show({ message: "That task has no session yet." })
}

export default Plugin.define({
  id: "micromanager.tui",
  setup(raw: unknown) {
    const context = raw as Context
    context.ui.slot({ append: "session.composer.top", render: (input) => <Progress context={context} sessionID={input.sessionID} /> })
    // prepend: at the top of the sidebar, above OpenCode's own context and MCP sections (appended, it was below the fold)
    context.ui.slot({ prepend: "sidebar.content", render: (input) => <Checklist context={context} sessionID={input.sessionID} /> })
    context.ui.slot({ append: "session.panel", render: (panel) => (panel.name === PANEL ? <Agents context={context} panel={panel} /> : null) })
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            { id: "micromanager.tasks", title: "Micromanager: open a task's session", group: "Micromanager", palette: true, slash: { name: "tasks" }, run: () => openTask(context) },
            { id: "micromanager.agents", title: "Micromanager: agents", group: "Micromanager", palette: true, slash: { name: "workers" }, run: () => context.ui.panel.open(PANEL) },
          ],
        }))
        return null
      },
    })
  },
})
