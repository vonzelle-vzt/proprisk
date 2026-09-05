#!/usr/bin/env bash
# Push a filled-in client env file to the linked Vercel project.
#
# Usage:
#   cd risk-management
#   vercel link                                  # link to the CLIENT's Vercel project first!
#   bash scripts/provision/push-env.sh client.env [environment]
#
# client.env: KEY=value lines (copy .env.local.example and fill it in).
# environment: production (default) | preview | development
#
# Blank values are skipped. CRON_SECRET is auto-generated when the line is
# blank or missing. Values are piped via stdin — nothing lands in shell history.

set -euo pipefail

ENV_FILE="${1:?usage: push-env.sh client.env [environment]}"
TARGET="${2:-production}"

has_cron_secret=false

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in \#*|"") continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  if [ "$key" = "CRON_SECRET" ] && [ -z "$value" ]; then
    value="$(openssl rand -hex 32)"
    echo "generated CRON_SECRET"
  fi
  [ -z "$value" ] && { echo "skip  $key (blank)"; continue; }
  [ "$key" = "CRON_SECRET" ] && has_cron_secret=true
  # Remove existing var first so re-runs update instead of erroring
  vercel env rm "$key" "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$key" "$TARGET" >/dev/null
  echo "set   $key ($TARGET)"
done < "$ENV_FILE"

if [ "$has_cron_secret" = false ]; then
  secret="$(openssl rand -hex 32)"
  vercel env rm CRON_SECRET "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$secret" | vercel env add CRON_SECRET "$TARGET" >/dev/null
  echo "set   CRON_SECRET (auto-generated)"
fi

echo "Done. Redeploy for the changes to take effect."
