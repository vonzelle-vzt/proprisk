#!/usr/bin/env node
/**
 * Provision auth users for a client instance.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/provision/create-users.mjs users.json
 *
 * users.json: [{ "email": "analyst@client.com", "role": "risk_analyst" }, ...]
 * Roles must be one of: risk_analyst | risk_manager | admin
 * (see ALLOWED_RISK_ROLES in src/lib/auth/guards.ts).
 *
 * Prints one-time passwords to stdout — deliver them over a secure channel
 * and have users change them on first login (Settings → password change).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ALLOWED_ROLES = new Set(['risk_analyst', 'risk_manager', 'admin']);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const file = process.argv[2];

if (!url || !serviceKey || !file) {
  console.error('Usage: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node create-users.mjs users.json');
  process.exit(1);
}

const users = JSON.parse(readFileSync(file, 'utf8'));
const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

function generatePassword() {
  // 24 chars, URL-safe — strong enough as a one-time credential
  return randomBytes(18).toString('base64url');
}

let failed = 0;
for (const { email, role } of users) {
  if (!ALLOWED_ROLES.has(role)) {
    console.error(`SKIP ${email}: invalid role "${role}" (allowed: ${[...ALLOWED_ROLES].join(', ')})`);
    failed++;
    continue;
  }
  const password = generatePassword();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role },
  });
  if (error) {
    console.error(`FAIL ${email}: ${error.message}`);
    failed++;
  } else {
    console.log(`OK   ${email}  role=${role}  id=${data.user.id}  one-time-password=${password}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
