// The micromanager in OpenCode's terminal UI: a CLI plugin. opencode 2.0.18 loads it from cli.json "plugins" as a
// package directory whose package.json exports "./tui": tui/ in this repository (install.sh adds it).
//
// - Above the prompt: one line with the job's progress ("job-… · 7/19 ✔ · 3 ▶ · execute").
// - In the sidebar: the job's tasks as a todo list, with what each one does now.
// - /tasks: pick a task to open its worker session, or go back to the micromanager from a worker.
//
// The job file is the source (src/progress.ts): it holds every task and its sessions, also those of a planned job,
// whose workers are not children of the micromanager in OpenCode's eyes. Read every two seconds while shown.
// Keymap layers only work inside a rendered component (live spike: "Keymap.Provider is missing" from setup), so the
// command is registered from the "app" slot.

import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, onCleanup, Show } from "solid-js"

import { jobsFor, projectOf, summaryLine, taskChoices, todoLines, view, type JobView } from "./progress.ts"
import { listJobs } from "./store.ts"

const POLL_MS = 2_000

// The plugin context as this file uses it; the host's own types are not a dependency of this repository.
interface Context {
  theme: { text: { base: unknown; muted: unknown } }
  data: { session: { get(id: string): { location?: { directory?: string } } | undefined } }
  keymap: { layer(build: () => unknown): unknown }
  ui: {
    slot(slot: { append: string; render: (input: { sessionID: string }) => unknown }): unknown
    toast: { show(toast: { message: string; variant?: string }): void }
    router: { current(): { type: string; sessionID?: string } | undefined; navigate(to: { type: "session"; sessionID: string }): void }
    dialog: { select(input: { title: string; options: { title: string; value: string; description?: string; category?: string }[] }): Promise<string | undefined> }
  }
}

function read(context: Context, sessionID: string): JobView[] {
  const directory = context.data.session.get(sessionID)?.location?.directory
  if (!directory) return []
  try {
    return jobsFor(listJobs(projectOf(directory)), sessionID).map((job) => view(job))
  } catch {
    return [] // a job file being written right now: the next poll reads it
  }
}

// The session's jobs, kept fresh while the component that asked for them is on screen.
function useJobs(context: Context, sessionID: () => string) {
  const [jobs, setJobs] = createSignal<JobView[]>(read(context, sessionID()))
  const timer = setInterval(() => setJobs(read(context, sessionID())), POLL_MS)
  onCleanup(() => clearInterval(timer))
  return jobs
}

function Progress(props: { context: Context; sessionID: string }) {
  const jobs = useJobs(props.context, () => props.sessionID)
  return (
    <For each={jobs()}>
      {(job) => <text fg={props.context.theme.text.muted}>micromanager · {summaryLine(job)} · /tasks</text>}
    </For>
  )
}

function Todos(props: { context: Context; sessionID: string }) {
  const jobs = useJobs(props.context, () => props.sessionID)
  const { base, muted } = props.context.theme.text
  return (
    <For each={jobs()}>
      {(job) => (
        <box>
          <text fg={base}>Micromanager · {job.done}/{job.total} · {job.phase}</text>
          <For each={todoLines(job)}>
            {(line) => (
              <box>
                <text fg={line.muted ? muted : base}>{line.text}</text>
                <Show when={line.detail}>
                  <text fg={muted}>   {line.detail}</text>
                </Show>
              </box>
            )}
          </For>
        </box>
      )}
    </For>
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
    context.ui.slot({ append: "sidebar.content", render: (input) => <Todos context={context} sessionID={input.sessionID} /> })
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "micromanager.tasks",
              title: "Micromanager: open a task's session",
              group: "Micromanager",
              palette: true,
              slash: { name: "tasks" },
              run: () => openTask(context),
            },
          ],
        }))
        return null
      },
    })
  },
})
