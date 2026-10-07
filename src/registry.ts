// The model registry and the router over it (design.md §19): which models exist, where they run, what they can
// do, and which one a task gets. Local when capable; cloud for hard tasks, long contexts, or busy hardware.

import { MODELS, family, roleById } from "./roles.ts"

export type Location = "local" | "cloud"
export type Device = "cuda" | "igpu" | "npu" | "cloud"
export type Tier = "quick" | "agent" | "deep"

export interface ModelEntry {
  readonly id: string // "provider/model", as OpenCode names it
  readonly location: Location
  readonly device: Device
  readonly censored: boolean
  readonly family: string
  readonly tier: Tier
  readonly vision: boolean
  readonly ctx: number
  readonly tokPerSec?: number
  readonly resident?: boolean // always loaded (the iGPU model)
  readonly swapGroup?: string // models that share one GPU through llama-swap
  readonly disabled?: boolean // known but not routed to
  readonly note?: string
}

const TIER_RANK: Record<Tier, number> = { quick: 0, agent: 1, deep: 2 }

// Cloud models (OpenCode Go) and the local fleet of ~/Models/bench/ROSTER.md (2026-10-04). Local models run with
// a 16k context. The NPU is reserved for Whisper plus one small quick model (Phase A).
export const DEFAULT_REGISTRY: readonly ModelEntry[] = [
  { id: MODELS.space, location: "cloud", device: "cloud", censored: true, family: "space", tier: "agent", vision: true, ctx: 200000, note: "free and strong on code; leads every role's chain since 2026-10-07" },
  { id: MODELS.glm, location: "cloud", device: "cloud", censored: true, family: "glm", tier: "agent", vision: false, ctx: 128000 },
  { id: MODELS.qwen, location: "cloud", device: "cloud", censored: true, family: "qwen", tier: "agent", vision: true, ctx: 128000 },
  { id: MODELS.deepseek, location: "cloud", device: "cloud", censored: true, family: "deepseek", tier: "agent", vision: false, ctx: 128000 },
  { id: "llamaswap/oss-u", location: "local", device: "cuda", censored: false, family: "gpt-oss", tier: "deep", vision: false, ctx: 16384, tokPerSec: 53, swapGroup: "cuda0" },
  { id: "llamaswap/ornith-u", location: "local", device: "cuda", censored: false, family: "ornith", tier: "agent", vision: true, ctx: 16384, tokPerSec: 40, swapGroup: "cuda0" },
  { id: "llamaswap/ornith-u-s", location: "local", device: "cuda", censored: false, family: "ornith", tier: "agent", vision: true, ctx: 16384, tokPerSec: 45, swapGroup: "cuda0" },
  { id: "llamaswap/ornith", location: "local", device: "cuda", censored: true, family: "ornith", tier: "agent", vision: true, ctx: 16384, tokPerSec: 35, swapGroup: "cuda0" },
  { id: "llamaswap/mimo", location: "local", device: "cuda", censored: true, family: "mimo", tier: "agent", vision: true, ctx: 16384, tokPerSec: 39, swapGroup: "cuda0" },
  { id: "llamaigpu/qwen3.8-u", location: "local", device: "igpu", censored: false, family: "qwen", tier: "agent", vision: true, ctx: 16384, tokPerSec: 6.5, resident: true },
  { id: "flmnpu/qwen3:4b", location: "local", device: "npu", censored: true, family: "qwen", tier: "quick", vision: false, ctx: 16384, tokPerSec: 19, note: "quick tier only; skipped a required tool in Phase A" },
  { id: "flmnpu/qwen3vl-it:4b", location: "local", device: "npu", censored: true, family: "qwen", tier: "quick", vision: true, ctx: 16384, tokPerSec: 19 },
  { id: "flmnpu/gpt-oss:20b", location: "local", device: "npu", censored: true, family: "gpt-oss", tier: "deep", vision: false, ctx: 16384, disabled: true, note: "the NPU stays free for Whisper" },
]

// Entries from the config replace or add models by id.
export function mergeRegistry(base: readonly ModelEntry[], extra: readonly Partial<ModelEntry>[]): ModelEntry[] {
  const out = new Map(base.map((m) => [m.id, m]))
  for (const e of extra) {
    if (!e.id) continue
    const known = out.get(e.id)
    out.set(e.id, { ...(known ?? defaultsFor(e.id)), ...e } as ModelEntry)
  }
  return [...out.values()]
}

// A model the registry does not know: cautious defaults (local, censored, agent tier, small context).
function defaultsFor(id: string): ModelEntry {
  const cloud = id.startsWith("opencode-go/") || id.startsWith("opencode/")
  return { id, location: cloud ? "cloud" : "local", device: cloud ? "cloud" : "cuda", censored: true, family: family(id), tier: "agent", vision: false, ctx: cloud ? 128000 : 16384 }
}

// --- availability -----------------------------------------------------------------------------------------

export interface Availability {
  readonly reachable: boolean
  readonly loaded?: boolean // llama-swap: the model is in memory, no swap needed
  readonly busy?: boolean // llama-vulkan: every slot is processing
}

export interface Endpoints {
  readonly llamaswap?: string // http://127.0.0.1:8000
  readonly llamaigpu?: string // http://127.0.0.1:8092
  readonly flmnpu?: string // http://127.0.0.1:52625
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  llamaswap: "http://127.0.0.1:8000",
  llamaigpu: "http://127.0.0.1:8092",
  flmnpu: "http://127.0.0.1:52625",
}

async function getJson(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

// Reads what the local servers report (Phase A, A8): llama-swap's loaded status, llama-vulkan's slots, FLM's
// model list. Cloud models count as reachable; their limits are the budget's job.
export async function probe(
  registry: readonly ModelEntry[],
  endpoints: Endpoints = DEFAULT_ENDPOINTS,
  fetcher: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>()
  const name = (id: string) => id.slice(id.indexOf("/") + 1)
  const [swap, igpuHealth, igpuSlots, npu] = await Promise.all([
    endpoints.llamaswap ? getJson(fetcher, `${endpoints.llamaswap}/v1/models`, timeoutMs).catch(() => undefined) : undefined,
    endpoints.llamaigpu ? getJson(fetcher, `${endpoints.llamaigpu}/health`, timeoutMs).catch(() => undefined) : undefined,
    endpoints.llamaigpu ? getJson(fetcher, `${endpoints.llamaigpu}/slots`, timeoutMs).catch(() => undefined) : undefined,
    endpoints.flmnpu ? getJson(fetcher, `${endpoints.flmnpu}/v1/models`, timeoutMs).catch(() => undefined) : undefined,
  ])
  const swapModels = new Map(((swap as { data?: { id: string; status?: { value?: string } }[] } | undefined)?.data ?? []).map((m) => [m.id, m.status?.value]))
  const slots = Array.isArray(igpuSlots) ? (igpuSlots as { is_processing?: boolean }[]) : []
  const npuIds = new Set(((npu as { data?: { id: string }[] } | undefined)?.data ?? []).map((m) => m.id))
  for (const m of registry) {
    if (m.location === "cloud") out.set(m.id, { reachable: true })
    else if (m.id.startsWith("llamaswap/")) {
      const status = swapModels.get(name(m.id))
      out.set(m.id, { reachable: status !== undefined, loaded: status === "loaded" })
    } else if (m.id.startsWith("llamaigpu/")) {
      const ok = (igpuHealth as { status?: string } | undefined)?.status === "ok"
      out.set(m.id, { reachable: ok, loaded: ok, busy: slots.length > 0 && slots.every((s) => s.is_processing) })
    } else if (m.id.startsWith("flmnpu/")) {
      out.set(m.id, { reachable: npuIds.has(name(m.id)) })
    } else out.set(m.id, { reachable: false })
  }
  return out
}

// --- routing ------------------------------------------------------------------------------------------------

export interface RouteNeeds {
  readonly role: string
  readonly difficulty?: number // 0..1; picks the tier
  readonly vision?: boolean
  readonly ctx?: number // tokens the task needs in context
  readonly sensitive?: boolean // must not leave the machine
  readonly refusalLikely?: boolean // a censored model would refuse: local and uncensored only
  readonly avoidFamilies?: readonly string[] // a reviewer never checks its own family's work
  readonly preferCloud?: boolean // e.g. the user pinned the cloud
  readonly loadedModel?: string // the model already loaded on cuda0 (batching avoids swaps)
}

export interface Route {
  readonly model?: string
  readonly reason: string
  readonly ranked: readonly string[]
}

export function tierFor(difficulty = 0.5): Tier {
  return difficulty <= 0.33 ? "quick" : difficulty <= 0.66 ? "agent" : "deep"
}

// Roles that do agentic work never go to the NPU's quick model.
const QUICK_ROLES = new Set(["explore", "write"])

export function route(registry: readonly ModelEntry[], needs: RouteNeeds, availability?: Map<string, Availability>): Route {
  const tier = tierFor(needs.difficulty)
  const avail = (id: string) => availability?.get(id) ?? { reachable: true }
  const local = needs.sensitive || needs.refusalLikely
  const candidates = registry.filter((m) =>
    !m.disabled &&
    avail(m.id).reachable &&
    (!needs.vision || m.vision) &&
    m.ctx >= (needs.ctx ?? 0) &&
    (!local || m.location === "local") &&
    (!needs.refusalLikely || !m.censored) &&
    (m.device !== "npu" || (tier === "quick" && QUICK_ROLES.has(needs.role))) &&
    !(needs.avoidFamilies ?? []).includes(m.family),
  )
  if (candidates.length === 0) {
    const why = [needs.refusalLikely && "uncensored", local && "local", needs.vision && "vision", needs.ctx && `ctx ≥ ${needs.ctx}`].filter(Boolean).join(", ")
    return { reason: `no reachable model fits (${why || "any"})`, ranked: [] }
  }
  // Local when capable: a local model covers the tier, and nothing pins the cloud.
  const localCovers = candidates.some((m) => m.location === "local" && TIER_RANK[m.tier] >= TIER_RANK[tier] && !avail(m.id).busy)
  const wantLocal = local || (localCovers && !needs.preferCloud)
  // The role matrix's models in their order (src/roles.ts) break ties, so roles spread over the families instead of
  // all landing on the alphabetically first one (live test: deepseek got every role).
  const preferred = roleById(needs.role)?.models ?? []
  const rank = (id: string) => (preferred.includes(id) ? preferred.indexOf(id) : preferred.length)
  const score = (m: ModelEntry): number[] => {
    const a = avail(m.id)
    return [
      m.location === (wantLocal ? "local" : "cloud") ? 0 : 1,
      TIER_RANK[m.tier] >= TIER_RANK[tier] ? 0 : 1, // covers the tier
      a.busy ? 1 : 0,
      m.resident || a.loaded || m.id === needs.loadedModel || m.location === "cloud" ? 0 : 1, // no swap
      Math.abs(TIER_RANK[m.tier] - TIER_RANK[tier]), // no bigger than needed
      -(m.tokPerSec ?? 0),
      rank(m.id),
    ]
  }
  const ranked = [...candidates].sort((a, b) => {
    const x = score(a), y = score(b)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
    return a.id.localeCompare(b.id)
  })
  const best = ranked[0]!
  const reason = [
    best.location,
    `${tier} task`,
    needs.refusalLikely ? "uncensored" : needs.sensitive ? "sensitive" : undefined,
    avail(best.id).loaded || best.resident ? "already loaded" : best.location === "local" ? "needs a swap" : undefined,
  ].filter(Boolean).join(", ")
  return { model: best.id, reason, ranked: ranked.map((m) => m.id) }
}
