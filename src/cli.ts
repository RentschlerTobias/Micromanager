// Command line: npm run eval -- [--floor 0.8] [--backend typesafe] [--journal path]
//               npm run export-dataset -- [--target openjev|gliner] [--out file] [--journal path]
//               npm run bench-guards -- [--cases bench/guard_cases.json] [--url http://127.0.0.1:8781/v1/systemone]

import { writeFileSync } from "node:fs"

import { DEFAULT_BACKENDS, Decider, makeAskers } from "./backends.ts"
import { formatSweep, loadCases, scoreCases, sweep } from "./bench.ts"
import { glinerRows, openJevRows } from "./dataset.ts"
import { evaluate, formatReport } from "./eval.ts"
import { journalPath, readJournal } from "./journal.ts"

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv
  if (command === "bench-guards") {
    const config = { ...DEFAULT_BACKENDS, urls: { ...DEFAULT_BACKENDS.urls, gliner: flag(args, "url") ?? DEFAULT_BACKENDS.urls.gliner } }
    const rows = await scoreCases(new Decider(config, makeAskers(config, undefined), () => {}), loadCases(flag(args, "cases") ?? "bench/guard_cases.json"))
    console.log(formatSweep(sweep(rows)))
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
    if (targetName !== "openjev" && targetName !== "gliner") {
      console.error(`unknown target ${targetName}: openjev or gliner`)
      return 2
    }
    const rows = targetName === "gliner" ? glinerRows(entries) : openJevRows(entries)
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")
    const out = flag(args, "out")
    if (out) writeFileSync(out, text)
    else process.stdout.write(text)
    console.error(`${rows.length} ${targetName} rows${out ? ` -> ${out}` : ""}`)
    return 0
  }
  console.error("usage: cli.ts eval|export-dataset|bench-guards [options]")
  return 2
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
