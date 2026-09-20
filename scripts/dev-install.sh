#!/usr/bin/env bash
# Copies the plugin into the user plugin directory for local development and
# asks the running shell to rescan. Not needed for normal use: end users install
# with `omarchy plugin add <git-url>`.
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
id="$(jq -r .id "$src/manifest.json")"
dest="$HOME/.config/omarchy/plugins/$id"
mkdir -p "$dest/lib"
cp "$src"/manifest.json "$src"/*.qml "$dest"/
cp "$src"/lib/*.js "$dest"/lib/
omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
echo "installed $id -> $dest"
