# PropRisk (Next.js 14, App Router) — multi-stage build on node:20-alpine.
#
# IMPORTANT — build-time vs. run-time env: every NEXT_PUBLIC_* variable is
# inlined into the client bundle at `next build` time, not read at container
# start. The build args below default to demo-safe placeholders, which is
# fine for `docker build` in CI or for the bundled demo image. A LIVE-MODE
# image must be built with its real NEXT_PUBLIC_SUPABASE_URL and
# NEXT_PUBLIC_SUPABASE_ANON_KEY (and NEXT_PUBLIC_APP_URL, and any
# NEXT_PUBLIC_BRAND_* you use) passed as --build-arg, e.g.:
#
#   docker build \
#     --build-arg NEXT_PUBLIC_DEMO_MODE=false \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://yourproject.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
#     -t proprisk .
#
# Server-only secrets (SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET,
# PLATFORM_ADMIN_SECRET, CONNECTIONS_MASTER_KEY, ...) are NOT build args —
# pass them at `docker run` time with --env-file or -e, same as any other
# server process. If you need to rebuild the same image for multiple
# Supabase projects without rebuilding, put a runtime-config layer in front
# of these NEXT_PUBLIC_* values instead (out of scope here).
#
# See docs/INSTALL.md for the full self-hosted deployment path.

# ---- deps: install once, shared by the build stage ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- build: compile the Next.js app ----
FROM node:20-alpine AS build
WORKDIR /app

ARG NEXT_PUBLIC_DEMO_MODE=true
ARG NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
# Server-only values the build needs present (not secret at build time —
# only used so `next build` doesn't fail env validation; real values are
# supplied at `docker run` time and take over).
ARG SUPABASE_SERVICE_ROLE_KEY=placeholder-service-role-key
ARG CRON_SECRET=placeholder-cron-secret

ENV NEXT_PUBLIC_DEMO_MODE=$NEXT_PUBLIC_DEMO_MODE \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY \
    CRON_SECRET=$CRON_SECRET \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal production image ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# Next's standalone file tracer does not pick up pdfkit's AFM font data
# (loaded via its `#standard-fonts/*` package.json "imports" map rather than
# a traceable static require), so violation/report PDF generation 500s on
# "Cannot find module '#standard-fonts/Helvetica'" without this. Copy the
# whole package rather than just the data files, since its own internal
# requires expect the normal package layout.
COPY --from=build --chown=nextjs:nodejs /app/node_modules/pdfkit ./node_modules/pdfkit

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
