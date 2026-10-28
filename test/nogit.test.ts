import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { gitForm, readForm } from "../src/forms.ts"
import { gitState, initRepo, MAX_FILE_BYTES, surveyFolder } from "../src/nogit.ts"

const folder = () => mkdtempSync(join(tmpdir(), "mm-nogit-"))
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args]).toString().trim()

test("a folder is a repository, one without a commit, or none", async () => {
  const dir = folder()
  assert.equal(await gitState(dir), "no-repo")
  git(dir, "init", "-q")
  assert.equal(await gitState(dir), "no-commit")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x")
  assert.equal(await gitState(dir), "repo")
})

test("the survey leaves secrets, generated folders and huge files out of the first commit, and init commits the rest", async () => {
  const dir = folder()
  writeFileSync(join(dir, "main.py"), "print('hi')\n")
  writeFileSync(join(dir, ".env"), "TOKEN=x\n")
  writeFileSync(join(dir, "server.key"), "k\n")
  mkdirSync(join(dir, "node_modules", "a"), { recursive: true })
  writeFileSync(join(dir, "node_modules", "a", "i.js"), "x\n")
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "util.py"), "x = 1\n")
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1))
  const survey = surveyFolder(dir)
  assert.deepEqual([...survey.excluded].sort(), [".env", "big.bin", "node_modules/", "server.key"])
  assert.equal(survey.files, 2)
  assert.equal(survey.extensions.py, 2)

  const r = await initRepo(dir, survey.excluded)
  assert.ok(r.ok, r.text)
  assert.equal(await gitState(dir), "repo")
  assert.deepEqual(git(dir, "ls-files").split("\n").sort(), [".gitignore", "main.py", "src/util.py"])
  const ignore = readFileSync(join(dir, ".gitignore"), "utf8")
  assert.match(ignore, /^\.micromanager\/\*$/m)
  assert.match(ignore, /^!\.micromanager\/backlog\/$/m)
  assert.match(ignore, /^\/\.env$/m)
})

test("initRepo's first commit carries the user's identity and the plain subject", async () => {
  const dir = folder()
  const config = join(folder(), "gitconfig")
  writeFileSync(config, "[user]\n\tname = N\n\temail = n@n\n")
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const
  const saved = keys.map((key) => [key, process.env[key]] as const)
  process.env.GIT_CONFIG_GLOBAL = config
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  for (const key of keys.slice(2)) delete process.env[key]
  try {
    writeFileSync(join(dir, "main.py"), "print('hi')\n")
    const r = await initRepo(dir, surveyFolder(dir).excluded)
    assert.ok(r.ok, r.text)
    assert.equal(git(dir, "log", "-1", "--format=%an <%ae>"), "N <n@n>")
    assert.equal(git(dir, "log", "-1", "--format=%s"), "Initial commit")
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("the no-git form puts the recommended way first and reads the answer", () => {
  const form = gitForm("/home/u/notes", 12, "40 KB", "none", [".env"])
  assert.match(form[0]!.options[0]!.label, /^Without isolation \(Recommended\)$/)
  assert.match(form[0]!.options[1]!.description, /left out: \.env/)
  assert.deepEqual(readForm(form, [["Without isolation (Recommended)"]]), { kind: "git", decision: "none" })
  assert.deepEqual(readForm(form, [["Create a git repository"]]), { kind: "git", decision: "init" })
})
