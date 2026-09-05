// SERVER ONLY. This module holds the master key and decrypts customers'
// broker credentials; it must never be bundled for the browser.
//
// A transitive import once dragged it clientward through the provider facade
// and the build failed with a cryptic "node:crypto is not handled by plugins".
// This assertion turns that into a readable failure at the point of the
// mistake, and is why the pure helper it travelled with now lives in
// src/lib/platform/plan-name.ts.
if (typeof window !== 'undefined') {
  throw new Error(
    'src/lib/crypto/envelope.ts was imported into a browser bundle. It holds the ' +
      'credential master key and must stay server-side. Import the pure helper you ' +
      'need directly rather than reaching through a module that pulls this in.'
  );
}

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for per-tenant provider secrets (connections.encrypted_secrets).
 *
 * One master key lives in the environment (CONNECTIONS_MASTER_KEY); it never
 * touches the database and is never used to encrypt data directly. Each
 * tenant gets its own AES-256-GCM data key, derived from the master via HKDF
 * with the tenant id as salt and the key version as info. That means:
 *   - a leaked database row is useless without CONNECTIONS_MASTER_KEY (the
 *     ciphertext alone decrypts to nothing);
 *   - tenant A's derived key cannot decrypt tenant B's blob, even for someone
 *     holding the master key, unless they also know tenant B's id AND the
 *     blob was actually encrypted under it — GCM's auth tag makes a
 *     wrong-key attempt fail closed rather than return garbage plaintext;
 *   - rotating to a new master key or a new derivation scheme is a version
 *     bump (`key_version`), not a rewrite of the HKDF function, so old blobs
 *     stay decryptable during a rotation window.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM's recommended nonce size
const KEY_LENGTH = 32; // AES-256
const HKDF_HASH = 'sha256';

export const CURRENT_KEY_VERSION = 1;

export class EnvelopeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeConfigError';
  }
}

/** Ciphertext failed to authenticate — wrong tenant, wrong key version, or tampering. */
export class EnvelopeDecryptError extends Error {
  constructor(message = 'Failed to decrypt secrets: wrong tenant, wrong key, or tampered ciphertext') {
    super(message);
    this.name = 'EnvelopeDecryptError';
  }
}

function loadMasterKey(): Buffer {
  const raw = process.env.CONNECTIONS_MASTER_KEY;
  if (!raw) {
    throw new EnvelopeConfigError(
      'CONNECTIONS_MASTER_KEY is not set. Generate one with `openssl rand -base64 32` and set it in ' +
        'the environment — it must never be committed or logged.'
    );
  }
  // Accept 64-char hex or base64; either must decode to exactly 32 bytes.
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LENGTH) {
    throw new EnvelopeConfigError(
      `CONNECTIONS_MASTER_KEY must decode to ${KEY_LENGTH} bytes (AES-256); got ${buf.length}.`
    );
  }
  return buf;
}

/**
 * Per-tenant, per-version data key. Salted on the tenant id so no two
 * tenants ever share a derived key even though they share one master; keyed
 * on info=version so a future rotation can mint v2 keys without disturbing
 * v1 blobs still on disk.
 */
function deriveTenantKey(tenantId: string, keyVersion: number): Buffer {
  const master = loadMasterKey();
  const derived = hkdfSync(HKDF_HASH, master, tenantId, `connections-secrets-v${keyVersion}`, KEY_LENGTH);
  return Buffer.from(derived);
}

/**
 * Encrypt a secrets object for one tenant. Output is a single opaque string
 * (safe for a TEXT column): `<keyVersion>.<iv>.<authTag>.<ciphertext>`, all
 * base64. The key version is carried alongside the ciphertext (not read from
 * the row's `key_version` column) so decryption is self-describing even if
 * the two ever drift.
 */
export function encryptSecrets(
  tenantId: string,
  secrets: Record<string, unknown>,
  keyVersion: number = CURRENT_KEY_VERSION
): string {
  const key = deriveTenantKey(tenantId, keyVersion);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [keyVersion, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** Decrypt a blob produced by encryptSecrets for the SAME tenant id. */
export function decryptSecrets(tenantId: string, blob: string): Record<string, unknown> {
  const parts = blob.split('.');
  if (parts.length !== 4) {
    throw new EnvelopeDecryptError('Malformed envelope blob (expected 4 dot-separated segments).');
  }
  const [versionRaw, ivB64, authTagB64, ciphertextB64] = parts;
  const keyVersion = Number(versionRaw);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new EnvelopeDecryptError('Malformed envelope blob (invalid key version).');
  }

  const key = deriveTenantKey(tenantId, keyVersion);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    // GCM authentication failure and JSON.parse failure both land here —
    // deliberately not distinguished, so callers can't use the error shape
    // to probe whether a given tenant id happens to be "close" to correct.
    throw new EnvelopeDecryptError();
  }
}
