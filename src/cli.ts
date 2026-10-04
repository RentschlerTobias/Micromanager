// Command line for the journal: npm run eval -- [--floor 0.8] [--backend typesafe] [--journal path]
//                                npm run export-dataset -- [--target openjev|gliner] [--out file] [--journal path]

import { writeFileSync } from "node:fs"

import { glinerRows, openJevRows } from "./dataset.ts"
import { evaluate, formatReport } from "./eval.ts"
import { journalPath, readJournal } from "./journal.ts"

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

export function main(argv: readonly string[]): number {
  const [command, ...args] = argv
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
  console.error("usage: cli.ts eval|export-dataset [options]")
  return 2
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
