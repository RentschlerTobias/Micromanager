// The ledger of a session's context: every tool call in the messages the context hook gets, with what the rules and
// the epoch policy need to know about it (src/context/rules.ts, src/context/policy.ts).
//
// The context hook's messages (opencode 2.0.18, spike 2026-10-25): an assistant message holds `tool-call` parts
// ({ id, name, input }), the following `tool` message holds the `tool-result` parts ({ id, name, result }). Between
// two steps of a session the earlier messages are byte-identical, so a call id names the same call in every turn.

export interface Part {
  type?: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  result?: { type?: string; value?: unknown }
}

export interface Message {
  role?: string
  content?: Part[] | string
}

export interface Item {
  readonly id: string // the tool call id
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly key: string // tool + input, for spotting identical calls
  readonly turn: number // index of the assistant message that made the call
  readonly message: number // index of the message that holds the result
  readonly size: number // characters of the result
  readonly inputSize: number // characters of the input
  readonly error: boolean
  readonly path?: string // the file a file tool works on
  readonly range?: { readonly from: number; readonly to: number } // lines a read covered; absent: the whole file
}

export interface Ledger {
  readonly items: readonly Item[]
  readonly turns: number // assistant messages so far
  readonly chars: number // characters of all messages, for the token estimate
  readonly offsets: readonly number[] // characters before each message
}

export const resultText = (p: Part): string =>
  typeof p.result?.value === "string" ? p.result.value : p.result?.value === undefined ? "" : JSON.stringify(p.result.value)

const textOf = (m: Message): string =>
  typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? (p.input !== undefined ? JSON.stringify(p.input) : "") + resultText(p)).join("")

const FILE_TOOLS = new Set(["read", "write", "edit", "patch", "apply_patch", "multiedit"])

function rangeOf(input: Record<string, unknown>): Item["range"] {
  const offset = Number(input.offset ?? 0)
  const limit = input.limit === undefined ? undefined : Number(input.limit)
  if (!offset && limit === undefined) return undefined
  return { from: offset || 1, to: limit === undefined ? Number.MAX_SAFE_INTEGER : (offset || 1) + limit - 1 }
}

export function ledger(messages: readonly Message[]): Ledger {
  const calls = new Map<string, { tool: string; input: Record<string, unknown>; turn: number }>()
  const items: Item[] = []
  let turns = 0
  let chars = 0
  const offsets: number[] = []
  messages.forEach((m, index) => {
    offsets.push(chars)
    chars += textOf(m).length
    if (!Array.isArray(m.content)) return
    if (m.role === "assistant") {
      for (const p of m.content) {
        if (p.type === "tool-call" && p.id) calls.set(p.id, { tool: p.name ?? "tool", input: (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>, turn: turns })
      }
      turns++
    }
    if (m.role !== "tool") return
    for (const p of m.content) {
      if (p.type !== "tool-result" || !p.id) continue
      const call = calls.get(p.id)
      const tool = call?.tool ?? p.name ?? "tool"
      const input = call?.input ?? {}
      const path = FILE_TOOLS.has(tool) && typeof (input.path ?? input.filePath) === "string" ? String(input.path ?? input.filePath) : undefined
      items.push({
        id: p.id,
        tool,
        input,
        key: `${tool} ${JSON.stringify(input)}`,
        turn: call?.turn ?? Math.max(0, turns - 1),
        message: index,
        size: resultText(p).length,
        inputSize: JSON.stringify(input).length,
        error: /error/i.test(p.result?.type ?? ""),
        ...(path ? { path } : {}),
        ...(tool === "read" ? { range: rangeOf(input) } : {}),
      })
    }
  })
  return { items, turns, chars, offsets }
}

// Whether read range `a` is covered by read range `b` (absent: the whole file).
export function covers(b: Item["range"], a: Item["range"]): boolean {
  if (!b) return true
  if (!a) return false
  return b.from <= a.from && b.to >= a.to
}
