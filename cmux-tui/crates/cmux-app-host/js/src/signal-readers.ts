// Named readers for signal sources whose read is more than one op call (schema/v2/signals.json
// `read.reader`). A reader calls only the ops its entry lists; the host checks every call.

import { CmuxError } from "./cmux.ts"

export type Caller = <T = unknown>(op: string, params: unknown) => Promise<T>
export type Reader = (params: Record<string, any>, call: Caller) => Promise<unknown>

type Role = "author" | "review-requested" | "assignee"
interface Pull {
  id: number
  number: number
  title: string
  url: string
  repo: string
  draft: boolean
  state: "open" | "merged" | "closed"
  roles: Role[]
  author: string
  updatedAt: string
}

const repoOf = (url: string) => String(url ?? "").replace("https://api.github.com/repos/", "")
const codeOf = (e: unknown) => (e instanceof CmuxError ? e.code : "operation.failed")

/**
 * `github.pulls`: one search per role through the integration gateway, else (when the gateway refuses
 * and a login is set) the public search API. The route is chosen once per read: the first search that
 * the gateway refuses moves every search of that read to the fallback.
 */
async function githubPulls(params: Record<string, any>, call: Caller): Promise<Pull[]> {
  const roles: Role[] = Array.isArray(params.roles) && params.roles.length ? params.roles : ["author", "review-requested"]
  const merged = params.include === "open-and-merged"
  const limit = typeof params.limit === "number" ? params.limit : 30
  const login = typeof params.login === "string" ? params.login.trim() : ""
  const since = typeof params.updatedWithinHours === "number" ? new Date(Date.now() - params.updatedWithinHours * 3_600_000).toISOString().slice(0, 19) + "Z" : ""
  const query = (role: Role, who: string) => `is:pr ${merged ? "" : "is:open "}${role}:${who}${since ? ` updated:>=${since}` : ""}`
  let viaGateway = true
  let gatewayError: unknown = null
  const search = async (role: Role): Promise<Array<Record<string, any>>> => {
    if (viaGateway) {
      try {
        const r = await call<{ items?: Array<Record<string, any>> }>("integration.request", { provider: "github", method: "GET", path: `/search/issues?q=${encodeURIComponent(query(role, "@me"))}&per_page=${limit}` })
        return r?.items ?? []
      } catch (e) {
        viaGateway = false
        gatewayError = e
      }
    }
    if (!login) {
      // A transient gateway error (retryable) is itself the answer; a refusal means no usable connection.
      if (gatewayError instanceof CmuxError && gatewayError.retryable) throw gatewayError
      const code = codeOf(gatewayError)
      throw new CmuxError(
        code === "scope.missing" ? "scope.missing" : "integration.unavailable",
        "Connect GitHub, or set a GitHub login for the public search.",
        { signal: "github.pulls", gateway: code },
        code !== "scope.missing"
      )
    }
    const r = await call<{ status: number; body?: string }>("net.fetch", {
      url: `https://api.github.com/search/issues?q=${encodeURIComponent(query(role, login))}&per_page=${limit}`,
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      body: null
    })
    if (r.status < 200 || r.status >= 300) throw new CmuxError("upstream.failed", `GitHub answered ${r.status}`, { status: r.status }, r.status === 403 || r.status === 429 || r.status >= 500)
    return (JSON.parse(r.body || "{}") as { items?: Array<Record<string, any>> }).items ?? []
  }
  const byId = new Map<number, Pull>()
  // Sequential on purpose: the first refusal picks the route for the rest of the read.
  for (const role of roles) {
    for (const i of await search(role)) {
      const state = i.pull_request?.merged_at ? "merged" : i.state === "closed" ? "closed" : "open"
      if (state === "closed") continue
      const known = byId.get(i.id)
      if (known) {
        if (!known.roles.includes(role)) known.roles.push(role)
        continue
      }
      byId.set(i.id, { id: i.id, number: i.number, title: String(i.title ?? ""), url: String(i.html_url ?? ""), repo: repoOf(i.repository_url), draft: !!i.draft, state, roles: [role], author: String(i.user?.login ?? ""), updatedAt: String(i.updated_at ?? "") })
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

interface UsageWindow {
  id: string
  usedPercent: number
  resetsAtMs: number | null
}
interface ProviderUsage {
  provider: string
  chats: number
  working: number
  tokens24h: number | null
  costUsd24h: number | null
  calls24h: number | null
  limits: { plan: string | null; windows: UsageWindow[]; chat: string; reportedAtMs: number | null } | null
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b)
const ms = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/**
 * `usage.meter`: `chat.list` folded per provider (the chat's agent family, else its harness): the
 * listed chats' tokens, list-price dollars and model calls of the last 24 hours, and the plan
 * limits the newest reporting chat of that provider carries (its account's 5-hour and weekly
 * windows). Only what acpmux recorded from the harnesses; nothing here reads a credential.
 */
async function usageMeter(_params: Record<string, any>, call: Caller) {
  const rows = (await call<Array<Record<string, any>>>("chat.list", {})) ?? []
  const by = new Map<string, ProviderUsage>()
  for (const r of rows) {
    const provider = String(r.family || r.harness || "other")
    let p = by.get(provider)
    if (!p) by.set(provider, (p = { provider, chats: 0, working: 0, tokens24h: null, costUsd24h: null, calls24h: null, limits: null }))
    p.chats++
    if (r.state === "working") p.working++
    p.tokens24h = add(p.tokens24h, num(r.usage?.tokens_24h))
    p.costUsd24h = add(p.costUsd24h, num(r.usage?.cost_usd_24h))
    p.calls24h = add(p.calls24h, num(r.usage?.calls_24h))
    const windows: UsageWindow[] = (Array.isArray(r.limits?.windows) ? r.limits.windows : [])
      .filter((w: any) => typeof w?.id === "string" && num(w.used_percent) !== null)
      .map((w: any) => ({ id: w.id, usedPercent: num(w.used_percent)!, resetsAtMs: num(w.resets_at) === null ? null : num(w.resets_at)! * 1000 }))
    const at = ms(r.updated_ms)
    if (windows.length && (!p.limits || (at ?? 0) > (p.limits.reportedAtMs ?? 0))) {
      p.limits = { plan: typeof r.limits?.plan === "string" ? r.limits.plan : null, windows, chat: String(r.id), reportedAtMs: at }
    }
  }
  const providers = [...by.values()].sort((a, b) => (b.tokens24h ?? -1) - (a.tokens24h ?? -1) || a.provider.localeCompare(b.provider))
  const totals = providers.reduce(
    (t, p) => ({ chats: t.chats + p.chats, working: t.working + p.working, tokens24h: add(t.tokens24h, p.tokens24h), costUsd24h: add(t.costUsd24h, p.costUsd24h), calls24h: add(t.calls24h, p.calls24h) }),
    { chats: 0, working: 0, tokens24h: null as number | null, costUsd24h: null as number | null, calls24h: null as number | null }
  )
  return { providers, totals }
}

export const READERS: Record<string, Reader> = { "github.pulls": githubPulls, "usage.meter": usageMeter }
