// Who makes a decision: the decision model, the user, a preset or the rules (design.md §22).
//
// A policy is set per decision key ("N6.pipeline", "G0.locality", …) or per node ("N6" covers all its keys), on
// five levels; the most specific level wins. Guards and hard rules are never switched off by a config-level
// preset: only a single decision may override a guard, explicitly.

export type Policy =
  | { readonly kind: "auto" } // the decision model decides; below its floor, rules or the user
  | { readonly kind: "ask" } // always the user
  | { readonly kind: "fixed"; readonly value: string } // the user's preset: the node is skipped
  | { readonly kind: "rule" } // the rules fallback only

export const LEVELS = ["decision", "task", "job", "project", "global"] as const
export type Level = (typeof LEVELS)[number]
export type PolicySet = Readonly<Record<string, string>> // key -> "auto" | "ask" | "rule" | "fixed:<value>"
export type Policies = Partial<Record<Level, PolicySet>>

export interface Resolved {
  readonly policy: Policy
  readonly level?: Level // undefined: nobody set one, the default applies
  readonly key?: string // the key that matched: the full key or its node
}

// Guard nodes: a preset above the single decision is ignored for them.
const GUARDED = new Set(["G0", "G"])

export function parsePolicy(text: string): Policy | undefined {
  const t = text.trim()
  if (t === "auto" || t === "ask" || t === "rule") return { kind: t }
  if (t.startsWith("fixed:") && t.length > "fixed:".length) return { kind: "fixed", value: t.slice("fixed:".length) }
  return undefined
}

export function resolvePolicy(key: string, policies: Policies): Resolved {
  const node = key.split(".")[0] ?? key
  const guarded = GUARDED.has(node)
  for (const level of LEVELS) {
    if (guarded && level !== "decision") continue
    const set = policies[level]
    if (!set) continue
    for (const candidate of [key, node]) {
      const raw = set[candidate]
      if (raw === undefined) continue
      const policy = parsePolicy(raw)
      if (policy) return { policy, level, key: candidate }
    }
  }
  return { policy: { kind: "auto" } }
}

export function validatePolicies(set: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(set).flatMap(([key, value]) =>
    typeof value === "string" && parsePolicy(value) && /^[A-Z][A-Za-z0-9]*(\.[a-z_]+)?$/.test(key)
      ? []
      : [`decisions.${key}: expected a key like "N6.pipeline" and "auto", "ask", "rule" or "fixed:<value>"`],
  )
}

// Chat shortcuts that set policies, matched on exact phrases before any model (design.md §22).
export interface Pin {
  readonly level: "job" | "task"
  readonly taskId?: string
  readonly key: string
  readonly value: string
}

const SHORTCUTS: readonly { readonly re: RegExp; readonly pin: (m: RegExpMatchArray) => Pin }[] = [
  { re: /^(always|only) local$/i, pin: () => ({ level: "job", key: "G0.locality", value: "fixed:local" }) },
  { re: /^no planning session$/i, pin: () => ({ level: "job", key: "N2.clarity", value: "fixed:clear" }) },
  { re: /^pipeline (P\d)$/i, pin: (m) => ({ level: "job", key: "N6.pipeline", value: `fixed:${m[1]!.toUpperCase()}` }) },
  { re: /^ask me (about|before) everything$/i, pin: () => ({ level: "job", key: "N5", value: "ask" }) },
  { re: /^([A-Za-z][\w.-]*) use ([\w./:-]+)$/, pin: (m) => ({ level: "task", taskId: m[1], key: "N5.model", value: `fixed:${m[2]}` }) },
  { re: /^skip review for ([A-Za-z][\w.-]*)$/i, pin: (m) => ({ level: "task", taskId: m[1], key: "N6.review", value: "fixed:skip" }) },
]

export function matchShortcut(text: string): Pin | undefined {
  const t = text.trim().replace(/[.!]+$/, "")
  for (const s of SHORTCUTS) {
    const m = t.match(s.re)
    if (m) return s.pin(m)
  }
  return undefined
}
