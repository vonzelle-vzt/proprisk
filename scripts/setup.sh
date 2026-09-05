#!/usr/bin/env bash
# PropRisk local setup.
#
# Gets a clone from nothing to a running demo (or a live-mode-ready checkout)
# in one command. Safe to re-run: it never overwrites an existing .env.local
# and only fills in blank values.
#
# Usage:
#   scripts/setup.sh [--demo|--live] [--db-url <postgres-url>] [--skip-install] [--yes]
#
#   --demo          Mock-data mode, no database needed (default).
#   --live          Real Supabase project. Generates secrets into .env.local
#                    and (with --db-url) applies migrations.
#   --db-url URL    A postgres connection string. With --live, applies every
#                    file in risk-management/supabase/migrations/*.sql, in
#                    sorted order, with psql -v ON_ERROR_STOP=1. Ignored
#                    without --live.
#   --skip-install  Skip `npm ci` / `npm install` (useful for CI or re-runs).
#   --yes           Non-interactive; assume yes to any prompt (none today,
#                    reserved for future use).
#
# Requires: bash 3.2+ (macOS default) or Linux bash, Node >=20, npm. `--live`
# with `--db-url` also requires psql. Generating live secrets requires openssl.
set -euo pipefail

MODE="demo"
DB_URL=""
SKIP_INSTALL=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --demo) MODE="demo"; shift ;;
    --live) MODE="live"; shift ;;
    --db-url) DB_URL="${2:-}"; shift 2 ;;
    --db-url=*) DB_URL="${1#*=}"; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "setup.sh: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve repo root regardless of where this script is invoked from.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/risk-management"
ENV_EXAMPLE="$APP_DIR/.env.local.example"
ENV_FILE="$APP_DIR/.env.local"

if [ ! -d "$APP_DIR" ]; then
  echo "setup.sh: expected to find risk-management/ under $REPO_ROOT — is this a full clone?" >&2
  exit 1
fi

echo "== PropRisk setup ($MODE mode) =="
echo "Repo root: $REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Node / npm version check
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "setup.sh: node is not installed. Install Node 20+ from https://nodejs.org/ (or via nvm: 'nvm install 20')." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  echo "setup.sh: Node $(node -v) found, but PropRisk requires Node >=20. Install Node 20+ (e.g. 'nvm install 20 && nvm use 20')." >&2
  exit 1
fi
echo "Node $(node -v) OK"

if ! command -v npm >/dev/null 2>&1; then
  echo "setup.sh: npm is not installed (it normally ships with Node). Reinstall Node from https://nodejs.org/." >&2
  exit 1
fi
echo "npm $(npm -v) OK"

# ---------------------------------------------------------------------------
# 2. Install dependencies
# ---------------------------------------------------------------------------
if [ "$SKIP_INSTALL" -eq 1 ]; then
  echo "Skipping npm install (--skip-install)."
else
  echo "Installing dependencies in risk-management/ ..."
  if [ -f "$APP_DIR/package-lock.json" ]; then
    (cd "$APP_DIR" && npm ci) || (cd "$APP_DIR" && npm install)
  else
    (cd "$APP_DIR" && npm install)
  fi
fi

# ---------------------------------------------------------------------------
# 3. .env.local — copy once, never overwrite
# ---------------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  echo ".env.local already exists — leaving it untouched."
else
  if [ ! -f "$ENV_EXAMPLE" ]; then
    echo "setup.sh: $ENV_EXAMPLE not found." >&2
    exit 1
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "Created risk-management/.env.local from .env.local.example."
fi

# Portable in-place sed (macOS bash 3.2 ships BSD sed which requires -i '').
sed_inplace() {
  # $1 = expression, $2 = file
  if sed --version >/dev/null 2>&1; then
    sed -i "$1" "$2"          # GNU sed
  else
    sed -i '' "$1" "$2"       # BSD sed (macOS)
  fi
}

set_env_var() {
  # set_env_var KEY VALUE — sets KEY=VALUE in $ENV_FILE only if KEY is
  # currently unset or blank. Appends the line if the key is missing entirely.
  key="$1"
  value="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    current="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d'=' -f2-)"
    if [ -z "$current" ]; then
      sed_inplace "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    fi
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

force_env_var() {
  # Always sets KEY=VALUE, overwriting any existing value.
  key="$1"
  value="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed_inplace "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

MANUAL_FILL=""

if [ "$MODE" = "demo" ]; then
  force_env_var "NEXT_PUBLIC_DEMO_MODE" "true"
  echo "Demo mode: NEXT_PUBLIC_DEMO_MODE=true (mock data, no database, auth bypassed)."
else
  force_env_var "NEXT_PUBLIC_DEMO_MODE" "false"

  if ! command -v openssl >/dev/null 2>&1; then
    echo "setup.sh: --live mode generates secrets with openssl, which was not found on PATH." >&2
    exit 1
  fi

  CRON_SECRET_CUR="$(grep -E '^CRON_SECRET=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)"
  if [ -z "$CRON_SECRET_CUR" ]; then
    set_env_var "CRON_SECRET" "$(openssl rand -hex 32)"
    echo "Generated CRON_SECRET."
  fi

  ADMIN_SECRET_CUR="$(grep -E '^PLATFORM_ADMIN_SECRET=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)"
  if [ -z "$ADMIN_SECRET_CUR" ]; then
    set_env_var "PLATFORM_ADMIN_SECRET" "$(openssl rand -hex 32)"
    echo "Generated PLATFORM_ADMIN_SECRET (kept distinct from CRON_SECRET)."
  fi

  KEY_CUR="$(grep -E '^CONNECTIONS_MASTER_KEY=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)"
  if [ -z "$KEY_CUR" ]; then
    set_env_var "CONNECTIONS_MASTER_KEY" "$(openssl rand -base64 32)"
    echo "Generated CONNECTIONS_MASTER_KEY."
  fi

  # Values that cannot be generated locally — collect what's still blank.
  for var in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_APP_URL SUPPORT_INBOX_EMAIL; do
    cur="$(grep -E "^${var}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2-)"
    if [ -z "$cur" ]; then
      MANUAL_FILL="$MANUAL_FILL $var"
    fi
  done

  # ---------------------------------------------------------------------
  # 4. Apply migrations (optional, --db-url only)
  # ---------------------------------------------------------------------
  if [ -n "$DB_URL" ]; then
    if ! command -v psql >/dev/null 2>&1; then
      echo "setup.sh: --db-url was given but psql is not installed. Install the Postgres client tools, or apply migrations with the Supabase CLI instead (see docs/INSTALL.md)." >&2
      exit 1
    fi
    MIGRATIONS_DIR="$APP_DIR/supabase/migrations"
    if [ ! -d "$MIGRATIONS_DIR" ]; then
      echo "setup.sh: no migrations directory at $MIGRATIONS_DIR" >&2
      exit 1
    fi
    echo "Applying migrations from $MIGRATIONS_DIR ..."
    applied=0
    for f in "$MIGRATIONS_DIR"/*.sql; do
      [ -e "$f" ] || continue
      echo "  == $(basename "$f")"
      if ! psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"; then
        echo "setup.sh: migration failed at $(basename "$f") after applying $applied migration(s). Fix the error above before re-running." >&2
        exit 1
      fi
      applied=$((applied + 1))
    done
    echo "Applied $applied migration(s) successfully."
  fi
fi

# ---------------------------------------------------------------------------
# 5. Typecheck smoke test
# ---------------------------------------------------------------------------
if [ "$SKIP_INSTALL" -eq 1 ]; then
  echo "Skipping typecheck smoke test (--skip-install implies dependencies may be absent)."
else
  echo "Running typecheck as a smoke check ..."
  (cd "$APP_DIR" && npm run typecheck)
fi

# ---------------------------------------------------------------------------
# 6. Next steps
# ---------------------------------------------------------------------------
echo ""
echo "== Setup complete =="
echo ""
echo "Next steps:"
echo "  cd risk-management && npm run dev"
echo ""
if [ "$MODE" = "demo" ]; then
  echo "Demo tour (once the server is up on http://localhost:3000):"
  echo "  /risk                         risk overview"
  echo "  /violations                   violation queue"
  echo "  /rules/demo-apex-futures      a rule pack in detail"
  echo "  /a/demo                       the trader-facing view"
else
  echo "Live mode — you are not done yet:"
  if [ -n "$MANUAL_FILL" ]; then
    echo "  Fill these in risk-management/.env.local by hand:$MANUAL_FILL"
  fi
  if [ -z "$DB_URL" ]; then
    echo "  Apply migrations (sorted order) — see docs/INSTALL.md Option D,"
    echo "  or re-run: scripts/setup.sh --live --db-url <postgres-url> --skip-install"
  fi
  echo "  Then visit:"
  echo "    /signup       create the first tenant"
  echo "    /connections  validate a provider connection"
  echo "    /rules/new    build a rule pack"
  echo "  Full walkthrough: docs/INSTALL.md"
fi
