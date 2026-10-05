#!/usr/bin/env bash
# Install jev-micromanager into OpenCode (a symlink, so the repo stays the source), or remove it:
#   ./install.sh            link src/plugin.ts into ~/.config/opencode/plugins/jev-micromanager.ts
#   ./install.sh --remove   remove the link
#   ./install.sh --skills   link skills/<name> into ~/.config/opencode/skills/
# OpenCode loads plugins when it starts: restart the hub/server afterwards.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PLUGINS="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
LINK="$PLUGINS/jev-micromanager.ts"

SKILLS="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills"

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
  exit 0
fi

mkdir -p "$PLUGINS"
if [[ -e "$LINK" && ! -L "$LINK" ]]; then
  echo "$LINK exists and is not our link; not touching it" >&2
  exit 1
fi
ln -sfn "$REPO/src/plugin.ts" "$LINK"
echo "linked $LINK -> $REPO/src/plugin.ts (restart the OpenCode server to load it)"
