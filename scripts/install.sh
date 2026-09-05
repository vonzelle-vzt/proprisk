#!/usr/bin/env bash
# PropRisk one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/vonzelle-vzt/proprisk/main/scripts/install.sh | bash
#
# Clones the repo into ./proprisk (or the directory named by $1) and hands
# off to scripts/setup.sh with any remaining arguments. Refuses to run if the
# target directory already exists and is non-empty.
#
# Usage:
#   install.sh [target-dir] [-- setup.sh args...]
#   curl -fsSL .../install.sh | bash -s -- myproprisk --live
#
# Anything after the optional target directory is passed straight through to
# scripts/setup.sh (e.g. --live, --db-url <url>, --skip-install, --yes).
set -euo pipefail

REPO_URL="https://github.com/vonzelle-vzt/proprisk.git"
TARGET_DIR="proprisk"

if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then
  # First arg doesn't start with "--", treat it as the target directory.
  TARGET_DIR="$1"
  shift
fi

echo "== PropRisk installer =="

if ! command -v git >/dev/null 2>&1; then
  echo "install.sh: git is not installed. Install it (e.g. 'xcode-select --install' on macOS, or your distro's git package) and re-run." >&2
  exit 1
fi

if [ -e "$TARGET_DIR" ]; then
  if [ -d "$TARGET_DIR" ] && [ -z "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
    : # empty directory, fine to clone into
  else
    echo "install.sh: '$TARGET_DIR' already exists and is not empty. Remove it, or pass a different target directory: install.sh <dir>." >&2
    exit 1
  fi
fi

echo "Cloning $REPO_URL into $TARGET_DIR ..."
git clone "$REPO_URL" "$TARGET_DIR"

SETUP_SCRIPT="$TARGET_DIR/scripts/setup.sh"
if [ ! -f "$SETUP_SCRIPT" ]; then
  echo "install.sh: clone succeeded but $SETUP_SCRIPT is missing — is the branch up to date?" >&2
  exit 1
fi

echo "Running setup ..."
bash "$SETUP_SCRIPT" "$@"
