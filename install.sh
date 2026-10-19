#!/usr/bin/env bash
# Install micromanager into OpenCode (a symlink, so the repo stays the source), or remove it:
#   ./install.sh            link src/plugin.ts into ~/.config/opencode/plugins/micromanager.ts, and write the TUI
#                           package ~/.config/opencode/micromanager-tui/ (job progress in the TUI, src/tui.tsx) into
#                           the "plugins" of ~/.config/opencode/cli.json
#   ./install.sh --remove   remove both
#   ./install.sh --skills   link skills/<name> into ~/.config/opencode/skills/
# OpenCode loads plugins when it starts: restart the hub/server afterwards.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PLUGINS="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
LINK="$PLUGINS/micromanager.ts"

SKILLS="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills"
CLI="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/cli.json"
# The TUI package: opencode 2.0.18 wants a package directory exporting "./tui", and a relative import out of that
# directory does not resolve (live check: a package inside this repository importing ../src/tui.tsx never loaded),
# so the package is written here and imports the code by its absolute path. Its entry must be named tui.tsx: the same
# package with index.tsx was silently not loaded (live check, 2026-10-19).
TUI="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/micromanager-tui"

write_tui() {
  mkdir -p "$TUI"
  printf '%s\n' '{ "name": "micromanager-tui", "version": "0.1.0", "type": "module", "exports": { "./tui": "./tui.tsx" } }' >"$TUI/package.json"
  printf '%s\n' "// Written by $REPO/install.sh: the micromanager's TUI plugin lives in the repository." \
    "export { default } from \"$REPO/src/tui.tsx\"" >"$TUI/tui.tsx"
}

# Add (add) or remove (remove) the TUI package in cli.json's "plugins", keeping everything else in the file.
cli_plugin() {
  node -e '
    const fs = require("node:fs")
    const [file, entry, mode] = process.argv.slice(1)
    let config = {}
    try { config = JSON.parse(fs.readFileSync(file, "utf8")) } catch (err) {
      if (err.code !== "ENOENT") { console.error(`${file} is not plain JSON; add or remove "${entry}" in its "plugins" by hand`); process.exit(0) }
    }
    const plugins = (config.plugins ?? []).filter((p) => p !== entry)
    if (mode === "add") plugins.push(entry)
    config.plugins = plugins
    if (!plugins.length) delete config.plugins
    fs.mkdirSync(require("node:path").dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
    console.log(`${mode === "add" ? "added" : "removed"} ${entry} ${mode === "add" ? "to" : "from"} the plugins of ${file}`)
  ' "$CLI" "$TUI" "$1"
}

# --skills: link the repo's skills (skills/<name>/SKILL.md) into the user's OpenCode skills directory.
if [[ "${1:-}" == "--skills" ]]; then
  mkdir -p "$SKILLS"
  for dir in "$REPO"/skills/*/; do
    name="$(basename "$dir")"
    target="$SKILLS/$name"
    if [[ -e "$target" && ! -L "$target" ]]; then
      echo "$target exists and is not our link; not touching it" >&2
      continue
    fi
    ln -sfn "${dir%/}" "$target"
    echo "linked $target -> ${dir%/}"
  done
  exit 0
fi

if [[ "${1:-}" == "--remove" ]]; then
  [[ -L "$LINK" ]] && rm "$LINK" && echo "removed $LINK" || echo "not installed"
  cli_plugin remove
  rm -rf "$TUI"
  exit 0
fi

mkdir -p "$PLUGINS"
# The link's name before 2026-10-19: two links to the same plugin would load it twice.
OLD_LINK="$PLUGINS/jev-micromanager.ts"
if [[ -L "$OLD_LINK" && "$(readlink -f "$OLD_LINK")" == "$(readlink -f "$REPO/src/plugin.ts")" ]]; then
  rm "$OLD_LINK" && echo "removed the old link $OLD_LINK"
fi
if [[ -e "$LINK" && ! -L "$LINK" ]]; then
  echo "$LINK exists and is not our link; not touching it" >&2
  exit 1
fi
ln -sfn "$REPO/src/plugin.ts" "$LINK"
echo "linked $LINK -> $REPO/src/plugin.ts (restart the OpenCode server to load it)"
write_tui
cli_plugin add
echo "the TUI shows job progress from its next start (the sidebar toggles with <leader>b, or set \"session\": {\"sidebar\": \"auto\"} in cli.json; /tasks opens a task)"
