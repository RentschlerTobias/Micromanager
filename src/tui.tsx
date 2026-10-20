// The micromanager in OpenCode's terminal UI: a CLI plugin. opencode 2.0.18 loads it from cli.json "plugins" as a
// package directory whose package.json exports "./tui" (install.sh writes one that imports this file).
//
// - Above the prompt: one line with the job's progress ("job-… · 7/19 ✔ · 3 ▶ · execute").
// - In the sidebar: the job as a checklist, grouped by what needs attention (src/progress.ts sidebarGroups).
// - /workers: a session panel with every recent session and its workers, as herdr shows agents (src/switcher.ts).
// - /tasks: pick a task to open its worker session, or go back to the micromanager from a worker.
// - In the sidebar, below the checklist, and /pools: the models each worker role may run on, picked in a popup like
//   /model (src/pools.ts). The picks go to a file the server reads at each delegation (src/config.ts loadPicks).
//
// The job file is the source of the checklist: it holds every task and its sessions, also those of a planned job,
// whose workers are not children of the micromanager in OpenCode's eyes. Keymap layers only work inside a rendered
// component (live spike: "Keymap.Provider is missing" from setup), so the commands are registered from the "app" slot.

import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, onCleanup, Show } from "solid-js"

import { loadPicks, loadSettings, savePicks } from "./config.ts"
import { agentOptions, modelOptions, poolRows, RESET, shortNames, toggle, updatePicks, VISION, type CatalogModel, type PoolRow } from "./pools.ts"
import { BOX, foldedLine, jobsFor, projectOf, resolver, sessionJobs, sidebarCounts, sidebarGroups, summaryLine, taskChoices, view, type JobView, type Mark, type SidebarGroup } from "./progress.ts"
import { listJobs } from "./store.ts"
import { agentRows, agentSummary, type AgentRow, type SessionFacts, type Tag } from "./switcher.ts"
import type { Job } from "./state.ts"
import { seedFromJournal } from "./usage.ts"

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
    model: { list(input: Record<string, unknown>): Promise<unknown> }
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
    // opencode 2.0.18 passes a plugin's select only title, placeholder, options and current: no actions, no search.
    dialog: { select(input: { title: string; placeholder?: string; current?: string; options: { title: string; value: string; description?: string; category?: string }[] }): Promise<string | undefined> }
    panel: { open(name: string): void }
    // Read only: a plugin cannot set the session's model (the TUI sends its own pick with every prompt), /model does.
    model: { current(): { providerID: string; modelID: string } | undefined }
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
    dropped: t.text.muted,
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
  const jobs = jobsOf(context, sessionID)
  const resolve = resolver(jobs) // a task done over in another job of the session
  return jobsFor(jobs, sessionID).map((job) => view(job, Date.now(), resolve))
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

// Groups folded at first: DONE and DROPPED always, FAILED only once it is empty (then it is not shown anyway).
const FOLDED_AT_FIRST: readonly SidebarGroup["key"][] = ["done", "dropped"]

// One job as a checklist: its header, the counts, and the groups; DONE, FAILED and DROPPED fold on a click.
function JobChecklist(props: { context: Context; job: JobView; waiting: Map<string, string> }) {
  const colors = palette(props.context)
  const [folded, setFolded] = createSignal(new Set<string>(FOLDED_AT_FIRST))
  const toggle = (key: string) => setFolded((was) => { const next = new Set(was); next.has(key) ? next.delete(key) : next.add(key); return next })
  const groups = () => sidebarGroups(props.job, props.waiting)
  const foldable = (key: string) => key === "done" || key === "failed" || key === "dropped"
  return (
    <box>
      <box flexDirection="row">
        <text fg={colors.base}>{cut(props.job.title, 26)}</text>
        <box flexGrow={1} />
        <text fg={colors.muted}>{props.job.phase}</text>
      </box>
      <box flexDirection="row">
        <For each={sidebarCounts(groups())}>{(c) => <text fg={colors.mark[c.mark]}>{c.text} </text>}</For>
        <box flexGrow={1} />
        <text fg={colors.muted}>/{props.job.total}</text>
      </box>
      <For each={groups()}>
        {(group) => {
          const shut = () => foldable(group.key) && folded().has(group.key)
          const count = () => foldable(group.key) ? `${group.count} ${shut() ? "▸" : "▾"}`
            : group.lines.length < group.count ? `${group.lines.length} of ${group.count}` : String(group.count)
          return (
            <box paddingTop={1}>
              <box flexDirection="row" onMouseUp={() => foldable(group.key) && toggle(group.key)}>
                <text fg={colors.base}>{group.name}</text>
                <box flexGrow={1} />
                <text fg={colors.muted}>{count()}</text>
              </box>
              <For each={shut() ? [] : group.lines}>
                {(line) => (
                  <box flexDirection="row">
                    <text fg={colors.mark[line.mark]}>{BOX[line.mark]} </text>
                    <text fg={line.mark === "open" || line.mark === "done" || line.mark === "dropped" ? colors.muted : colors.base}>{cut(`${line.id} ${line.title}`, line.detail ? 24 : 32)}</text>
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
}

// The session's checklist: its newest job in full, older open jobs as one folded line each (the user, 2026-10-20: two
// jobs of one session showed two FAILED groups).
function Checklist(props: { context: Context; sessionID: string }) {
  const jobs = useJobs(props.context, () => props.sessionID)
  const [waiting, setWaiting] = createSignal(new Map<string, string>())
  const [opened, setOpened] = createSignal(new Set<string>())
  const colors = palette(props.context)
  const poll = async () => {
    const running = jobs().flatMap((j) => j.rows.filter((r) => ["running", "gating", "fixing", "reviewing"].includes(r.status) && r.session).map((r) => r.session!))
    const found = running.length ? await pending(props.context, running) : new Map()
    setWaiting(new Map([...found].map(([id, p]) => [id, p.what])))
  }
  void poll()
  const timer = setInterval(() => void poll(), POLL_MS * 2)
  onCleanup(() => clearInterval(timer))
  const split = () => sessionJobs(jobs())
  const flip = (id: string) => setOpened((was) => { const next = new Set(was); next.has(id) ? next.delete(id) : next.add(id); return next })
  return (
    <box>
      <Show when={split().main}>{(main) => <JobChecklist context={props.context} job={main()} waiting={waiting()} />}</Show>
      <For each={split().others}>
        {(job) => (
          <box paddingTop={1}>
            <box flexDirection="row" onMouseUp={() => flip(job.id)}>
              <text fg={job.phase === "ask_user" ? colors.mark.waiting : colors.muted}>{foldedLine(job)}</text>
              <box flexGrow={1} />
              <text fg={colors.muted}>{opened().has(job.id) ? "▾" : "▸"}</text>
            </box>
            <Show when={opened().has(job.id)}>
              <JobChecklist context={props.context} job={job} waiting={waiting()} />
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}

// The session's model, which is the micromanager's when it runs in this session.
function sessionModel(context: Context): string | undefined {
  const m = context.ui.model.current()
  return m ? `${m.providerID}/${m.modelID}` : undefined
}

function rows(): PoolRow[] {
  return poolRows(loadSettings().routing, loadPicks())
}

// The MODELS section: folded to one line, unfolded a line per role with its pool; a click on a role opens its popup.
function Pools(props: { context: Context }) {
  const context = props.context
  const colors = palette(context)
  const [open, setOpen] = createSignal(false)
  const [pools, setPools] = createSignal<PoolRow[]>(rows())
  const [model, setModel] = createSignal(sessionModel(context))
  const timer = setInterval(() => { setPools(rows()); setModel(sessionModel(context)) }, POLL_MS)
  onCleanup(() => clearInterval(timer))
  const line = (name: string, models: string, mark: string, onClick: () => void) => (
    <box flexDirection="row" onMouseUp={onClick}>
      <text fg={colors.base}>{name.padEnd(13)}</text>
      <text fg={colors.muted}>{cut(models, 20)}</text>
      <box flexGrow={1} />
      <text fg={colors.mark.running}>{mark}</text>
    </box>
  )
  return (
    <box paddingTop={1}>
      <box flexDirection="row" onMouseUp={() => setOpen(!open())}>
        <text fg={colors.base}>MODELS</text>
        <box flexGrow={1} />
        <text fg={colors.muted}>{open() ? "/pools ▾" : "/pools ▸"}</text>
      </box>
      <Show when={open()}>
        {line("micromanager", model()?.split("/").pop() ?? "", "", () => context.ui.toast.show({ message: "The micromanager runs on this session's model: change it with /model." }))}
        <For each={pools()}>{(row) => line(row.agent, shortNames(row.models).join(" "), row.own ? "✎" : "", () => void pickModels(context, row.key))}</For>
      </Show>
    </box>
  )
}

// The popup: step 1 picks the agent, step 2 its models. A plugin's select has no keys of its own, so ↵ checks or
// unchecks a model and the popup opens again on it; esc ends. Every change is saved at once.
async function pickModels(context: Context, key?: PoolRow["key"]): Promise<void> {
  if (!key) {
    const chosen = await context.ui.dialog.select({ title: "Micromanager: models per agent", placeholder: "agent", options: agentOptions(rows(), sessionModel(context)) })
    if (chosen === "micromanager") return context.ui.toast.show({ message: "The micromanager runs on this session's model: change it with /model." })
    if (!chosen) return
    key = chosen as PoolRow["key"]
  }
  const catalog = items(await context.client.model.list({}).catch(() => undefined)) as CatalogModel[]
  const settings = loadSettings()
  const weekly = new Map<string, number>()
  for (const pick of seedFromJournal()) weekly.set(pick.model, (weekly.get(pick.model) ?? 0) + 1)
  const budget = (model: string) => settings.registry.find((m) => m.id === model)?.budget
  let current: string | undefined
  for (;;) {
    const row = poolRows(settings.routing, loadPicks()).find((r) => r.key === key)
    if (!row) return
    const title = key === VISION ? "vision · ↵ picks the image model" : `${row.agent} · ↵ check · esc done`
    const chosen = await context.ui.dialog.select({ title, placeholder: "model", current, options: modelOptions(catalog, row, (m) => weekly.get(m) ?? 0, budget) })
    if (!chosen) return
    current = chosen
    const models = chosen === RESET ? RESET : toggle(row, chosen)
    if (!models) {
      context.ui.toast.show({ message: `${row.agent} needs at least one model.` })
      continue
    }
    savePicks(updatePicks(loadPicks(), settings.routing, key, models))
    if (key === VISION || chosen === RESET) {
      context.ui.toast.show({ message: `${row.agent}: ${shortNames(poolRows(settings.routing, loadPicks()).find((r) => r.key === key)!.models).join(" ")}`, variant: "success" })
      return
    }
  }
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
    context.ui.slot({
      prepend: "sidebar.content",
      render: (input) => (
        <box>
          <Checklist context={context} sessionID={input.sessionID} />
          <Pools context={context} />
        </box>
      ),
    })
    context.ui.slot({ append: "session.panel", render: (panel) => (panel.name === PANEL ? <Agents context={context} panel={panel} /> : null) })
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            { id: "micromanager.tasks", title: "Micromanager: open a task's session", group: "Micromanager", palette: true, slash: { name: "tasks" }, run: () => openTask(context) },
            { id: "micromanager.agents", title: "Micromanager: agents", group: "Micromanager", palette: true, slash: { name: "workers" }, run: () => context.ui.panel.open(PANEL) },
            { id: "micromanager.pools", title: "Micromanager: models per agent", group: "Micromanager", palette: true, slash: { name: "pools" }, run: () => pickModels(context) },
          ],
        }))
        return null
      },
    })
  },
})
