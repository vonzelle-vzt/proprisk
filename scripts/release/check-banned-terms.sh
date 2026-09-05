#!/usr/bin/env bash
# Fails if any tracked file matches a banned pattern. Patterns come from two files:
#   scripts/release/banned-terms.public   generic infrastructure/secret shapes (tracked)
#   scripts/release/banned-terms.private  maintainer-specific names (gitignored, optional)
# The private list exists so the words we refuse to publish are not themselves
# published by the script that enforces it. Runs in CI and before every export.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
load() { grep -vE '^\s*(#|$)' "$1" | paste -sd '|' -; }
PATTERN=$(load scripts/release/banned-terms.public)
if [ -f scripts/release/banned-terms.private ]; then
  PATTERN="$PATTERN|$(load scripts/release/banned-terms.private)"
  echo "banned-terms: using public + private pattern lists"
else
  echo "banned-terms: using public pattern list only"
fi
hits=$(git ls-files -z | grep -zvE '^scripts/release/banned-terms\.public$|package-lock\.json$' \
  | xargs -0 grep -InE -i "$PATTERN" 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "banned terms found:"; echo "$hits"; echo
  echo "count: $(printf '%s\n' "$hits" | wc -l | tr -d ' ')"; exit 1
fi
echo "banned-terms: clean"
