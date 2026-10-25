// The memory's tools, Letta-style: memory_search for the micromanager and the reading roles; memory_list, memory_get,
// memory_set and memory_replace for the micromanager only. Workers report LEARNED lines instead (src/roles.ts); every
// write goes through search and Jev (src/context/capture.ts), so a tool call cannot store a duplicate or quietly
// overwrite a fact.

import type { ToolContext, ToolDraft } from "../tools.ts"

export const MEMORY_IDS = { search: "memory_search", list: "memory_list", get: "memory_get", set: "memory_set", replace: "memory_replace" } as const
export type MemoryTool = keyof typeof MEMORY_IDS

export interface MemoryHandlers {
  search(query: string, ctx: ToolContext): Promise<string>
  list(ctx: ToolContext): Promise<string>
  get(id: string, ctx: ToolContext): Promise<string>
  set(text: string, scope: string, core: string, ctx: ToolContext): Promise<string>
  replace(id: string, text: string, ctx: ToolContext): Promise<string>
}

const DESCRIPTIONS: Record<MemoryTool, string> = {
  search: "Search the memory: lasting facts from earlier work on this project and others (commands, layout, conventions, pitfalls, the user's preferences). query: what you want to know, in a sentence. Answers with the best matches and their ids.",
  list: "List the memory entries this project sees: the user's, the ones true across projects, and this project's, core ones first (core entries are always in your prompt).",
  get: "Show one memory entry by its id, with where it came from.",
  set: "Remember a lasting fact: something later sessions need and cannot see quickly in the code, or a preference the user stated. text: the fact in one sentence. scope: user (the user's preference, everywhere), global (true across projects) or project. core: yes to keep it in every prompt (only for what matters in most sessions), else no. It is checked against the memory first: a duplicate is not stored, a contradiction is reported back so you can ask the user.",
  replace: "Correct a memory entry: id from memory_search or memory_list, text the new fact in one sentence. Use it when the user corrects a fact or a fact went out of date.",
}

const FIELDS: Record<MemoryTool, readonly string[]> = { search: ["query"], list: [], get: ["id"], set: ["text", "scope", "core"], replace: ["id", "text"] }

export function installMemoryTools(draft: ToolDraft, handlers: MemoryHandlers, allowed: (tool: MemoryTool, ctx: ToolContext) => boolean): void {
  const read = draft.get("read")
  const str = read?.input?.fields?.path
  if (!read?.input?.mapFields || !str) throw new Error("the built-in read tool has no input schema to build from")
  for (const tool of Object.keys(MEMORY_IDS) as MemoryTool[]) {
    const fields = FIELDS[tool]
    draft.add({
      id: MEMORY_IDS[tool],
      name: MEMORY_IDS[tool],
      description: DESCRIPTIONS[tool],
      input: read.input.mapFields(() => Object.fromEntries((fields.length ? fields : ["note"]).map((f) => [f, str]))),
      execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!allowed(tool, ctx ?? {})) return { content: tool === "search" ? "Only the micromanager and the reading agents may search the memory." : "Only the micromanager may change the memory; report a lasting fact as a LEARNED line instead." }
        const v = (k: string) => String(args?.[k] ?? "").trim()
        try {
          const content =
            tool === "search" ? await handlers.search(v("query"), ctx) :
            tool === "list" ? await handlers.list(ctx) :
            tool === "get" ? await handlers.get(v("id"), ctx) :
            tool === "set" ? await handlers.set(v("text"), v("scope"), v("core"), ctx) :
            await handlers.replace(v("id"), v("text"), ctx)
          return { content }
        } catch (err) {
          return { content: `failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    })
  }
}
