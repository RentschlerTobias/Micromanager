// The planning session (design.md §6): a design tree owned by code, worked one question per turn.
//
// The facilitator (the dictator, on the user's session model) drafts the tree and asks; code validates the tree,
// keeps the frontier, applies the user's shortcuts and answers, and tells the facilitator what to do next. There
// are no suggested answers: options or explanations come only when the user is stuck or asks for them.

export type Impact = "low" | "medium" | "high"
export type NodeKind = "decision" | "fact" | "assumption"
export type NodeStatus = "open" | "settled" | "assumed" | "out_of_scope" | "researching"
export type Depth = "light" | "normal" | "frequent"

export interface DesignNode {
  readonly id: string
  readonly question: string
  readonly kind: NodeKind
  readonly dependsOn: readonly string[]
  readonly impact: Impact
  status: NodeStatus
  answer?: string
  origin?: "user" | "proposed_and_confirmed" | "fact" | "assumed"
  settledAt?: number // the turn
}

export interface DesignTree {
  nodes: DesignNode[]
  current?: string // the question asked last
  depth: Depth
  asked: number
  turn: number
}

const IMPACT_RANK: Record<Impact, number> = { low: 0, medium: 1, high: 2 }
const CAP: Record<Depth, number> = { light: 5, normal: 12, frequent: Infinity }
const MAX_NODES = 25
const ID = /^[A-Za-z][\w.-]{0,15}$/

export type ParsedTree = { tree: DesignTree; errors?: undefined } | { tree?: undefined; errors: string[] }

// The facilitator's draft: [{ id, question, kind, dependsOn, impact }], or { nodes: [...] }.
export function parseTree(raw: unknown, depth: Depth = "normal"): ParsedTree {
  const list = Array.isArray(raw) ? raw : (raw as { nodes?: unknown })?.nodes
  if (!Array.isArray(list) || list.length === 0) return { errors: ["the tree needs a non-empty list of questions"] }
  if (list.length > MAX_NODES) return { errors: [`at most ${MAX_NODES} questions, got ${list.length}`] }
  const errors: string[] = []
  const nodes: DesignNode[] = []
  for (const [i, item] of list.entries()) {
    const n = item as Record<string, unknown>
    const where = `question ${i + 1}${typeof n.id === "string" ? ` (${n.id})` : ""}`
    const deps = n.dependsOn ?? []
    if (typeof n.id !== "string" || !ID.test(n.id)) errors.push(`${where}: needs a short id`)
    if (typeof n.question !== "string" || n.question.trim().length < 5) errors.push(`${where}: needs the question text`)
    if (!["decision", "fact", "assumption"].includes(String(n.kind ?? "decision"))) errors.push(`${where}: kind must be decision, fact or assumption`)
    if (!["low", "medium", "high"].includes(String(n.impact))) errors.push(`${where}: impact must be low, medium or high`)
    if (!Array.isArray(deps) || !deps.every((d) => typeof d === "string")) errors.push(`${where}: dependsOn must be a list of ids`)
    if (errors.length) continue
    nodes.push({
      id: n.id as string,
      question: (n.question as string).trim(),
      kind: (n.kind ?? "decision") as NodeKind,
      dependsOn: deps as string[],
      impact: n.impact as Impact,
      status: "open",
    })
  }
  const ids = new Set<string>()
  for (const n of nodes) {
    if (ids.has(n.id)) errors.push(`${n.id}: duplicate id`)
    ids.add(n.id)
  }
  for (const n of nodes) for (const d of n.dependsOn) if (!ids.has(d)) errors.push(`${n.id}: depends on unknown ${d}`)
  if (hasCycle(nodes)) errors.push("the questions depend on each other in a cycle")
  return errors.length ? { errors } : { tree: { nodes, depth, asked: 0, turn: 0 } }
}

function hasCycle(nodes: readonly DesignNode[]): boolean {
  const deps = new Map(nodes.map((n) => [n.id, n.dependsOn]))
  const state = new Map<string, number>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false
    if (state.get(id) === 1) return true
    state.set(id, 1)
    const found = (deps.get(id) ?? []).some(visit)
    state.set(id, 2)
    return found
  }
  return nodes.some((n) => visit(n.id))
}

// Adds nodes the facilitator found later (a new branch); same rules as the draft.
export function addNodes(tree: DesignTree, raw: unknown): string[] {
  const merged = parseTree([...tree.nodes.map((n) => ({ ...n })), ...(Array.isArray(raw) ? raw : [])], tree.depth)
  if (merged.errors) return merged.errors
  const known = new Map(tree.nodes.map((n) => [n.id, n]))
  tree.nodes = merged.tree.nodes.map((n) => known.get(n.id) ?? n)
  return []
}

const RESOLVED = new Set<NodeStatus>(["settled", "assumed", "out_of_scope"])

// Low-impact open decisions are not asked: they become assumptions, shown at the checkpoint. Open facts wait
// for agents, never for the user.
export function assumeLowImpact(tree: DesignTree): DesignNode[] {
  const assumed = tree.nodes.filter((n) => n.status === "open" && n.kind !== "fact" && n.impact === "low")
  for (const n of assumed) {
    n.status = "assumed"
    n.origin = "assumed"
  }
  return assumed
}

// Open decisions whose prerequisites are all resolved: the questions that can be asked now without guessing.
export function frontier(tree: DesignTree): DesignNode[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]))
  return tree.nodes.filter((n) =>
    n.status === "open" && n.kind === "decision" && n.dependsOn.every((d) => RESOLVED.has(byId.get(d)?.status ?? "open")),
  )
}

export function openFacts(tree: DesignTree): DesignNode[] {
  return tree.nodes.filter((n) => n.kind === "fact" && (n.status === "open" || n.status === "researching"))
}

// The rules' pick: highest impact, then the one most other questions wait on, then the draft's order.
export function ruleNext(tree: DesignTree): DesignNode | undefined {
  const waiting = (id: string) => tree.nodes.filter((n) => n.status === "open" && n.dependsOn.includes(id)).length
  return [...frontier(tree)].sort((a, b) => IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] || waiting(b.id) - waiting(a.id))[0]
}

export function capReached(tree: DesignTree): boolean {
  return tree.asked >= CAP[tree.depth]
}

export function settle(tree: DesignTree, id: string, answer: string, origin: DesignNode["origin"] = "user"): void {
  const n = tree.nodes.find((x) => x.id === id)
  if (!n) return
  n.status = "settled"
  n.answer = answer
  n.origin = origin
  n.settledAt = tree.turn
}

// --- the user's turn ------------------------------------------------------------------------------------

export type Shortcut =
  | { kind: "stop" }
  | { kind: "skip" } // "decide it yourself": the current question becomes an assumption
  | { kind: "wait_what" } // re-pitch the current question with the missing context
  | { kind: "back"; id: string } // reopen a settled question
  | { kind: "depth"; depth: Depth }
  | { kind: "confirm" }
  | { kind: "discuss" }

export function matchSessionShortcut(text: string): Shortcut | undefined {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "")
  if (["stop", "enough", "that's enough"].includes(t)) return { kind: "stop" }
  if (["skip", "decide it yourself", "you decide"].includes(t)) return { kind: "skip" }
  if (["wait what", "i don't get it", "i do not get it", "what do you mean"].includes(t)) return { kind: "wait_what" }
  if (["light", "normal", "frequent"].includes(t)) return { kind: "depth", depth: t as Depth }
  if (["confirm", "confirmed", "looks good", "go"].includes(t)) return { kind: "confirm" }
  if (t === "discuss") return { kind: "discuss" }
  const back = t.match(/^(?:go )?back to ([a-z][\w.-]*)$/)
  if (back) return { kind: "back", id: back[1]! }
  return undefined
}

// What the facilitator does this turn, as code decided it. The plugin turns this into a system block.
export type Step =
  | { kind: "ask"; node: DesignNode; reason: string }
  | { kind: "explain"; node: DesignNode } // the user is stuck or asked: options with trade-offs, then hand back
  | { kind: "repitch"; node: DesignNode }
  | { kind: "contradiction"; node: DesignNode; earlier: DesignNode[] }
  | { kind: "add_branches"; node: DesignNode }
  | { kind: "checkpoint" }
  | { kind: "facts_pending"; facts: DesignNode[] }
  | { kind: "stopped" }

export interface AnswerReading {
  readonly settles?: boolean
  readonly newBranches?: boolean
  readonly stuck?: boolean
  readonly asksOptions?: boolean
  readonly contradicts?: boolean
  readonly outOfScope?: boolean
}

// One user turn while a question is open. Without a reading (no decision model), an answer counts as settling.
export function applyAnswer(tree: DesignTree, text: string, reading: AnswerReading = { settles: true }): Step | undefined {
  tree.turn++
  const node = tree.nodes.find((n) => n.id === tree.current)
  if (!node) return undefined
  // A clear decision wins: help is offered only when the answer does not decide the question (live test: a firm
  // answer also scored 0.71 on "asks for options").
  if ((reading.stuck || reading.asksOptions) && !reading.settles) return { kind: "explain", node }
  if (reading.outOfScope) {
    node.status = "out_of_scope"
    node.answer = text
    return undefined
  }
  if (reading.contradicts) {
    const earlier = tree.nodes.filter((n) => n.status === "settled" && n.origin === "user")
    if (earlier.length) return { kind: "contradiction", node, earlier }
  }
  if (reading.settles === false) return { kind: "repitch", node }
  settle(tree, node.id, text)
  if (reading.newBranches) return { kind: "add_branches", node }
  return undefined
}

export function applyShortcut(tree: DesignTree, s: Shortcut): Step | undefined {
  const node = tree.nodes.find((n) => n.id === tree.current)
  switch (s.kind) {
    case "stop":
      return { kind: "stopped" }
    case "skip":
      if (node) {
        node.status = "assumed"
        node.origin = "assumed"
      }
      return undefined
    case "wait_what":
      return node ? { kind: "repitch", node } : undefined
    case "back": {
      const target = tree.nodes.find((n) => n.id.toLowerCase() === s.id.toLowerCase())
      if (target) {
        target.status = "open"
        target.answer = undefined
        target.origin = undefined
        return { kind: "ask", node: target, reason: "the user reopened it" }
      }
      return undefined
    }
    case "depth":
      tree.depth = s.depth
      return undefined
    default:
      return undefined // confirm and discuss belong to the checkpoint
  }
}

// After a turn: the next question, the checkpoint, or waiting for facts.
export function nextStep(tree: DesignTree, pick?: string): Step {
  assumeLowImpact(tree)
  const options = frontier(tree)
  if (options.length === 0 || capReached(tree)) {
    const facts = openFacts(tree)
    if (options.length === 0 && facts.length > 0 && tree.nodes.some((n) => n.status === "open" && n.kind === "decision")) {
      return { kind: "facts_pending", facts }
    }
    return { kind: "checkpoint" }
  }
  const chosen = options.find((n) => n.id === pick) ?? ruleNext(tree)!
  tree.current = chosen.id
  tree.asked++
  return { kind: "ask", node: chosen, reason: pick === chosen.id ? "the decision model picked it" : "highest impact first" }
}

// --- what the facilitator is told -------------------------------------------------------------------------

const RULES = `Rules of the planning session: ask exactly one question, in plain words, with one to three sentences of
context. Give no options, no examples of possible answers and no recommendation. Do not answer the question yourself. If a term may be new to the
user, add a short "Concept:" or "Why this matters:" line. Then stop and wait for the user's answer.`

export function instruction(step: Step, job: string, tree: DesignTree): string {
  const decided = tree.nodes.filter((n) => n.status === "settled" && n.origin === "user")
  const settledLine = decided.length ? `\nDecided so far: ${decided.map((n) => `${n.id} ${n.answer}`).join(" | ")}` : ""
  switch (step.kind) {
    case "ask":
      return `[planning session ${job}] Ask the user question ${step.node.id} now: "${step.node.question}"\n${RULES}${settledLine}`
    case "repitch":
      return `[planning session ${job}] The user did not follow question ${step.node.id} ("${step.node.question}"). Ask it again with the context they were missing, in simpler words, still without options or a recommendation.${settledLine}`
    case "explain":
      return `[planning session ${job}] The user is stuck on ${step.node.id} ("${step.node.question}") or asked for help. Now, and only now: explain the concept briefly or show two or three approaches with their trade-offs, without picking one. Then hand the decision back: ask which they would take, and why.${settledLine}`
    case "contradiction":
      return `[planning session ${job}] The user's answer to ${step.node.id} may contradict an earlier decision (${step.earlier.map((n) => `${n.id}: ${n.answer}`).join("; ")}). Name both statements and ask which one holds. No recommendation.`
    case "add_branches":
      return `[planning session ${job}] The answer to ${step.node.id} raised new decisions. Call dictator_questions with job "${job}" and only the new questions (same format: id, question, kind, dependsOn, impact). Do not ask the user anything in this turn.`
    case "facts_pending":
      return `[planning session ${job}] The remaining decisions wait for facts the agents must find: ${step.facts.map((n) => `${n.id} "${n.question}"`).join("; ")}. Tell the user briefly that these are being looked up; never ask the user for facts.`
    case "checkpoint":
      return `[planning session ${job}] Design checkpoint. Show the user, apart from each other: (1) their decisions: ${decided.map((n) => `${n.id} ${n.question} -> ${n.answer}`).join("; ") || "none"}; (2) what was assumed without asking (mark these as proposals): ${tree.nodes.filter((n) => n.status === "assumed").map((n) => `${n.id} ${n.question}`).join("; ") || "nothing"}. Then ask them to answer "confirm" to plan with this, or "discuss" to change something.`
    case "stopped":
      return `[planning session ${job}] The user stopped the planning session. Confirm briefly that the job is paused; dictator_plan with the job id continues it later.`
  }
}

// The settled tree as the planner gets it: decisions and assumptions, one per line.
export function decisionsText(tree: DesignTree): string[] {
  return tree.nodes
    .filter((n) => n.status === "settled" || n.status === "assumed")
    .map((n) => `${n.question} -> ${n.status === "assumed" ? "assumed: the planner decides, and says what it chose" : n.answer}`)
}
