#!/usr/bin/env bash
# Snapshot the sanitized working tree onto a single-commit orphan branch for the
# public repository. Nothing here pushes: the script prints the push command and
# stops, so a human reviews the gate output first.
#
# Usage: scripts/release/export-public.sh [branch-name]   (default: public-release)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
BRANCH="${1:-public-release}"
START_BRANCH=$(git branch --show-current)

echo "== 1/5 clean tree?"
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree has uncommitted changes — commit or stash first" >&2; exit 1
fi

echo "== 2/5 banned terms (public + private lists)"
test -f scripts/release/banned-terms.private || { echo "refusing: scripts/release/banned-terms.private is missing — the export gate needs the maintainer list" >&2; exit 1; }
bash scripts/release/check-banned-terms.sh

echo "== 3/5 secret scan"
if command -v gitleaks >/dev/null 2>&1; then
  # Scan exactly what would ship (tracked files), not the working tree — the
  # working tree legitimately holds .env.local and .next/ build output.
  SCAN=$(mktemp -d); git archive HEAD | tar -x -C "$SCAN"
  gitleaks dir "$SCAN" --redact --config .gitleaks.toml --exit-code 1
  rm -rf "$SCAN"
else
  echo "gitleaks not installed — install it (brew install gitleaks) and re-run; refusing to export unscanned" >&2; exit 1
fi

echo "== 4/5 tracked files that must never ship"
if git ls-files | grep -E '(^|/)\.env($|\.)|\.pem$|\.claude/|\.cursor/|dna-strands/|\.mcp\.json$|orca\.yaml$|\.vzt' | grep -v '\.env\.local\.example$'; then
  echo "refusing: the files above are tracked" >&2; exit 1
fi
echo "none"

echo "== 5/5 build orphan branch $BRANCH"
SRC=$(git rev-parse HEAD)
git branch -D "$BRANCH" 2>/dev/null || true
git checkout --orphan "$BRANCH"
git rm -r --cached -q .
git add -A
git -c user.name="vonzelle-vzt" -c user.email="243221517+vonzelle-vzt@users.noreply.github.com" commit -q -m "feat: PropRisk initial public release

Open-source risk desk for prop trading firms: versioned rule packs, hard
multi-tenant isolation, evidence-backed breach decisions, PDF/CSV violation
reports. Exported from private source revision ${SRC:0:12}." 
echo
echo "orphan branch '$BRANCH' ready: $(git rev-list --count HEAD) commit, $(git ls-files | wc -l | tr -d ' ') files"
echo "review:  git checkout $BRANCH && git ls-files | less"
echo "publish: git remote add proprisk git@github.com:vonzelle-vzt/proprisk.git && git push proprisk $BRANCH:main"
git checkout -q "$START_BRANCH"
