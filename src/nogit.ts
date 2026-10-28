// A project folder that is no git repository (the user, 2026-10-20: the micromanager could not work there at all).
// Workers normally get a git worktree each, so they run in parallel and a change is checked and merged on its own;
// OpenCode's own worktrees are git worktrees too. So the user is asked, with a form: create a repository, or let the
// workers change the folder directly, one task after another, checks only (src/native.ts, isolation "none").
//
// Whether it is a repository is a fact the code checks. What to recommend is judgement (Jev, src/plugin.ts): a code
// project wants git, a config folder or notes may not. What the first commit must leave out is decided here, by rules
// that do not guess: secrets, dependency and build folders, and files too large for a repository.

import { lstatSync, readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { exec as defaultExec, type Exec } from "./integration.ts"

export type GitState = "repo" | "no-repo" | "no-commit"

export async function gitState(project: string, run: Exec = defaultExec): Promise<GitState> {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: project }).catch(() => undefined)
  if (!inside || inside.code !== 0 || inside.stdout.trim() !== "true") return "no-repo"
  const head = await run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: project }).catch(() => undefined)
  return head && head.code === 0 ? "repo" : "no-commit"
}

// Folders that are installed or built, never written by hand.
const GENERATED = new Set(["node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".cache", ".next", ".pytest_cache", ".mypy_cache", ".tox", ".gradle"])
// Names that hold secrets: keys, certificates, environment files, credentials.
const SECRET = [/^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|kdbx|keystore|jks)$/i, /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i, /^(credentials|secrets?)(\..+)?$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i]
// The plugin's own state and anything above this size stay out.
const OWN = new Set([".micromanager", ".jev-micromanager", ".git"])
export const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_ENTRIES = 20_000 // a folder this large is surveyed only so far

export interface Survey {
  readonly files: number
  readonly bytes: number
  readonly excluded: readonly string[] // project-relative, a folder with a trailing "/"
  readonly top: readonly string[] // the top-level names, for the recommendation
  readonly extensions: Readonly<Record<string, number>> // file count per extension, for the recommendation
}

export function surveyFolder(project: string): Survey {
  let files = 0
  let bytes = 0
  let seen = 0
  const excluded: string[] = []
  const extensions: Record<string, number> = {}
  const walk = (dir: string, rel: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) return
      const path = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      let st
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (OWN.has(name)) continue
        if (GENERATED.has(name)) { excluded.push(`${relPath}/`); continue }
        walk(path, relPath)
        continue
      }
      if (SECRET.some((re) => re.test(name)) || st.size > MAX_FILE_BYTES) { excluded.push(relPath); continue }
      files++
      bytes += st.size
      const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "(none)"
      extensions[ext] = (extensions[ext] ?? 0) + 1
    }
  }
  walk(project, "")
  let top: string[] = []
  try {
    top = readdirSync(project).filter((n) => !OWN.has(n)).slice(0, 40)
  } catch {
    // an unreadable folder: nothing to show
  }
  return { files, bytes, excluded, top, extensions }
}

export function humanSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(0)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

// git init, a .gitignore with what stays out (kept and extended when there is one), and a first commit of the rest.
export async function initRepo(project: string, excluded: readonly string[], run: Exec = defaultExec): Promise<{ ok: boolean; text: string }> {
  const state = await gitState(project, run)
  if (state === "no-repo") {
    const init = await run("git", ["init", "-q"], { cwd: project })
    if (init.code !== 0) return { ok: false, text: `git init failed: ${init.stderr.trim()}` }
  }
  const ignore = join(project, ".gitignore")
  const had = existsSync(ignore) ? readFileSync(ignore, "utf8") : ""
  const lines = had.split("\n").map((l) => l.trim())
  // The plugin's state stays out, except its backlog and contracts, which are the user's to commit (design.md §25).
  const own = [...OWN].filter((n) => n !== ".git").flatMap((n) => [`${n}/*`, `!${n}/backlog/`, `!${n}/contracts/`])
  const add = own.concat(excluded.map((p) => `/${p}`)).filter((p) => !lines.includes(p))
  if (add.length) writeFileSync(ignore, `${had}${had && !had.endsWith("\n") ? "\n" : ""}${had ? "\n" : ""}# left out of the first commit by micromanager\n${add.join("\n")}\n`)
  const staged = await run("git", ["add", "-A"], { cwd: project })
  if (staged.code !== 0) return { ok: false, text: `git add failed: ${staged.stderr.trim()}` }
  // The user's own identity, as git resolves it: without one the commit fails and they see git's own message.
  const commit = await run("git", ["commit", "-qm", "Initial commit", "--allow-empty"], { cwd: project })
  if (commit.code !== 0) return { ok: false, text: `git commit failed: ${commit.stderr.trim()}` }
  return { ok: true, text: `Created a git repository in ${project} with a first commit${excluded.length ? `; left out (in .gitignore): ${excluded.join(", ")}` : ""}.` }
}
