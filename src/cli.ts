// Command line: npm run eval -- [--floor 0.8] [--backend typesafe] [--journal path]
//               npm run export-dataset -- [--target openjev|gliner|router] [--out file] [--journal path]
//               npm run bench-guards -- [--cases bench/guard_cases.json] [--url http://127.0.0.1:8781/v1/systemone] [--repeat]
//               npm run bench-n7 -- [--cases bench/followup_cases.json]
//               node src/cli.ts status [--project dir] [--all] [--watch]   (an ASCII board of the newest job, or of all)

import { writeFileSync } from "node:fs"

import { DEFAULT_BACKENDS, Decider, makeAskers } from "./backends.ts"
import { drift, formatDrift, formatN7, formatSweep, loadCases, loadN7, scoreCases, scoreN7, sweep } from "./bench.ts"
import { apiKey } from "./jev.ts"
import { glinerRows, openJevRows } from "./dataset.ts"
import { evaluate, formatReport } from "./eval.ts"
import { journalPath, readJournal } from "./journal.ts"
import { board } from "./board.ts"
import { listJobs } from "./store.ts"
import { outcomesPath, readOutcomes, routerRows } from "./outcomes.ts"

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv
  if (command === "status") {
    const project = flag(args, "project") ?? process.cwd()
    const draw = () => {
      const jobs = listJobs(project)
      const shown = args.includes("--all") ? jobs : jobs.slice(0, 1)
      const width = Math.max(80, (process.stdout.columns ?? 120) - 2)
      return shown.length ? shown.map((j) => board(j, width)).join("\n\n") : `no micromanager job in ${project}`
    }
    if (!args.includes("--watch")) {
      console.log(draw())
      return 0
    }
    for (;;) {
      process.stdout.write(`\x1b[2J\x1b[H${draw()}\n\n(redraws every 2 s; ctrl-c ends)\n`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  if (command === "bench-guards") {
    const config = { ...DEFAULT_BACKENDS, urls: { ...DEFAULT_BACKENDS.urls, gliner: flag(args, "url") ?? DEFAULT_BACKENDS.urls.gliner } }
    const decider = new Decider(config, makeAskers(config, undefined), () => {})
    const cases = loadCases(flag(args, "cases") ?? "bench/guard_cases.json")
    const rows = await scoreCases(decider, cases)
    console.log(formatSweep(sweep(rows)))
    if (args.includes("--repeat")) console.log(`\nrepeat run:\n${formatDrift(drift(rows, await scoreCases(decider, cases)))}`)
    return 0
  }
  if (command === "bench-n7") {
    // N7 runs on cloud Jev by default; the journal is not written, so bench runs never become training rows.
    const decider = new Decider(DEFAULT_BACKENDS, makeAskers(DEFAULT_BACKENDS, apiKey()), () => {})
    console.log(formatN7(await scoreN7(decider, loadN7(flag(args, "cases") ?? "bench/followup_cases.json"))))
    return 0
  }
  const entries = readJournal(flag(args, "journal") ?? journalPath())
  if (command === "eval") {
    const floor = Number(flag(args, "floor") ?? 0.8)
    console.log(formatReport(evaluate(entries, floor, flag(args, "backend")), floor))
    return 0
  }
  if (command === "export-dataset") {
    const targetName = flag(args, "target") ?? "openjev"
    if (targetName !== "openjev" && targetName !== "gliner" && targetName !== "router") {
      console.error(`unknown target ${targetName}: openjev, gliner or router`)
      return 2
    }
    // router: the outcome log (src/outcomes.ts), one row per task with a trial's attempts joined, not the journal.
    const rows = targetName === "router" ? routerRows(readOutcomes(flag(args, "outcomes") ?? outcomesPath())) : targetName === "gliner" ? glinerRows(entries) : openJevRows(entries)
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")
    const out = flag(args, "out")
    if (out) writeFileSync(out, text)
    else process.stdout.write(text)
    console.error(`${rows.length} ${targetName} rows${out ? ` -> ${out}` : ""}`)
    return 0
  }
  console.error("usage: cli.ts eval|export-dataset|bench-guards|bench-n7 [options]")
  return 2
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
