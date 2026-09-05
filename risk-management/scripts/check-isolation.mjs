#!/usr/bin/env node
/**
 * Isolation guard.
 *
 * The product promise is that no prop firm can see another firm's data. That
 * promise does not fail in one dramatic commit — it decays, one ordinary edit
 * at a time: a table added without `tenant_id`, a route reaching for the
 * service-role client because it was quicker, a policy written `USING (true)`
 * while debugging and never tightened.
 *
 * This script is what makes those edits fail the build instead of shipping. It
 * is deliberately dumb and greppable rather than clever: a guard nobody can
 * read is a guard nobody maintains.
 *
 * Run: node scripts/check-isolation.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p);

// ── 1. Every new table must carry tenant_id ────────────────────────────────
//
// Tables that are genuinely global must be listed here WITH a reason, so that
// making something global is a decision someone signed rather than an omission.
const GLOBAL_TABLES = {
  news_events: 'the economic calendar is identical for every firm',
  tenants: 'the tenant registry itself',
  tenant_members: 'scoped by its own tenant_id column, which is the FK not a scope',
  tenant_invites: 'scoped by its own tenant_id column',
};

const migrationsDir = join(ROOT, 'supabase/migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of migrations) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');

  // Only CREATE TABLE statements; ALTERs that add tenant_id are the fix, not
  // the problem.
  const created = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/gi)];

  for (const [, table, body] of created) {
    if (GLOBAL_TABLES[table]) continue;
    if (/tenant_id/i.test(body)) continue;

    // A table created before tenancy is fine if a later migration adds the
    // column — 00015 does exactly that for the original 23.
    const backfilled = migrations.some((m) => {
      const later = readFileSync(join(migrationsDir, m), 'utf8');
      return new RegExp(`'${table}'`).test(later) && /ADD COLUMN IF NOT EXISTS tenant_id/i.test(later);
    });
    if (backfilled) continue;

    failures.push(
      `${file}: table "${table}" has no tenant_id.\n` +
        `    Every table holding customer data must be tenant-scoped. If this table is\n` +
        `    genuinely shared reference data, add it to GLOBAL_TABLES in this script\n` +
        `    with the reason it is safe.`
    );
  }
}

// ── 2. No USING (true) for the authenticated role ──────────────────────────
//
// RLS enabled with an unconditional predicate is authentication without
// isolation — which is exactly the state this codebase was in before tenancy,
// and it looked secure the whole time.
// Migrations before tenancy are historical: 00015 drops EVERY policy on every
// tenant-scoped table and recreates it with a tenant predicate, so a permissive
// policy in an older file describes a state that no longer exists by the time
// the schema is built. Checking them would report 21 permanent false positives
// and train everyone to ignore this script. The end state is verified
// empirically instead, by supabase/tests/verify-isolation.sh against a real
// database.
const TENANCY_MIGRATION = '00015';

for (const file of migrations) {
  if (file.localeCompare(TENANCY_MIGRATION) < 0) continue;
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  const policies = [...sql.matchAll(/CREATE POLICY[\s\S]{0,400}?;/gi)];

  for (const [policy] of policies) {
    if (!/TO\s+authenticated/i.test(policy)) continue;
    if (!/USING\s*\(\s*true\s*\)/i.test(policy)) continue;
    // The shared economic calendar is legitimately readable by everyone.
    if (/news_events/i.test(policy)) continue;

    const name = policy.match(/CREATE POLICY\s+"?(\w+)"?/i)?.[1] ?? '(unnamed)';
    failures.push(
      `${file}: policy "${name}" grants USING (true) to authenticated.\n` +
        `    That is RLS with no isolation. Scope it with tenant_id = auth_tenant_id().`
    );
  }
}

// ── 3. Route handlers must not reach for the service-role client ───────────
//
// createAdminClient() holds BYPASSRLS, so a route using it directly is a route
// where every isolation policy is switched off. Routes run as the signed-in
// user; background jobs go through tenantDb(), which cannot build a query
// without a tenant.
const apiDir = join(ROOT, 'src/app/api');
const ALLOWED_ADMIN_CLIENT = [
  // Cron routes have no session by definition. They are already gated on
  // CRON_SECRET at the edge and must fan out per tenant internally.
  /src\/app\/api\/cron\//,
  // Health check reads no tenant data.
  /src\/app\/api\/health\//,
  // Signup and invite acceptance run BEFORE the caller has a tenant claim, so
  // there is no session to scope by; both are constrained to the tenant named
  // by the row they were handed.
  /src\/app\/api\/tenancy\/signup\//,
  /src\/app\/api\/tenancy\/invites\/accept\//,
];

for (const file of walk(apiDir)) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
  if (ALLOWED_ADMIN_CLIENT.some((re) => re.test(file))) continue;

  const src = readFileSync(file, 'utf8');
  if (!/createAdminClient/.test(src)) continue;

  failures.push(
    `${rel(file)}: route handler calls createAdminClient() directly.\n` +
      `    That client bypasses RLS, so every isolation policy is off for this route.\n` +
      `    Use the request-scoped client, or tenantDb(auth.tenantId) for service work.\n` +
      `    If this route genuinely has no session, add it to ALLOWED_ADMIN_CLIENT with a reason.`
  );
}

// ── 4. Guards must never read a role or tenant from user_metadata ──────────
//
// user_metadata is writable by the user via supabase.auth.updateUser(). Reading
// authorization from it lets any signed-in user promote themselves. This was a
// real defect in this codebase, so it gets a permanent guard.
for (const file of walk(join(ROOT, 'src'))) {
  if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
  if (file.endsWith('.test.ts')) continue;

  const src = readFileSync(file, 'utf8');
  const offending = src
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /user_metadata\s*(\?\.|\[)\s*['"]?(role|tenant_id)/.test(line));

  for (const [lineNo] of offending) {
    failures.push(
      `${rel(file)}:${lineNo}: reads role or tenant_id from user_metadata.\n` +
        `    user_metadata is user-editable, so this is a privilege-escalation path.\n` +
        `    Read from app_metadata, which only the server can write.`
    );
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\nIsolation guard: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(
    'These checks exist because tenant isolation is a product promise, not a best effort.\n'
  );
  process.exit(1);
}

console.log('Isolation guard: clean');
console.log(`  ${migrations.length} migrations checked for tenant_id and permissive policies`);
console.log('  no route handler bypasses RLS; no guard reads user_metadata');
