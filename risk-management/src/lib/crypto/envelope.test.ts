import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_KEY_VERSION,
  EnvelopeConfigError,
  EnvelopeDecryptError,
  decryptSecrets,
  encryptSecrets,
} from './envelope';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeEach(() => {
  // A fixed 32-byte key for deterministic tests; production keys come from a
  // real secret manager and are never checked in.
  process.env.CONNECTIONS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
});

describe('envelope encryption', () => {
  it('round-trips a secrets object for the tenant it was encrypted for', () => {
    const secrets = { apiKey: 'sk_live_abc123', SYSTEM_UUID: 'uuid-1', GROUPS: 'a,b' };
    const blob = encryptSecrets(TENANT_A, secrets);
    const decrypted = decryptSecrets(TENANT_A, blob);
    expect(decrypted).toEqual(secrets);
  });

  it('embeds the key version in the blob', () => {
    const blob = encryptSecrets(TENANT_A, { apiKey: 'x' });
    expect(blob.startsWith(`${CURRENT_KEY_VERSION}.`)).toBe(true);
  });

  it('tenant B cannot decrypt a blob encrypted for tenant A', () => {
    const blob = encryptSecrets(TENANT_A, { apiKey: 'super-secret' });
    expect(() => decryptSecrets(TENANT_B, blob)).toThrow(EnvelopeDecryptError);
  });

  it('throws on tampered ciphertext rather than returning corrupted plaintext', () => {
    const blob = encryptSecrets(TENANT_A, { apiKey: 'super-secret' });
    const [version, iv, authTag, ciphertext] = blob.split('.');
    // Flip one byte of the ciphertext.
    const bytes = Buffer.from(ciphertext, 'base64');
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = [version, iv, authTag, bytes.toString('base64')].join('.');

    expect(() => decryptSecrets(TENANT_A, tampered)).toThrow(EnvelopeDecryptError);
  });

  it('throws on a tampered auth tag', () => {
    const blob = encryptSecrets(TENANT_A, { apiKey: 'super-secret' });
    const [version, iv, authTag, ciphertext] = blob.split('.');
    const bytes = Buffer.from(authTag, 'base64');
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = [version, iv, bytes.toString('base64'), ciphertext].join('.');

    expect(() => decryptSecrets(TENANT_A, tampered)).toThrow(EnvelopeDecryptError);
  });

  it('throws EnvelopeConfigError when CONNECTIONS_MASTER_KEY is missing', () => {
    delete process.env.CONNECTIONS_MASTER_KEY;
    expect(() => encryptSecrets(TENANT_A, { apiKey: 'x' })).toThrow(EnvelopeConfigError);
  });

  it('throws EnvelopeConfigError when the key does not decode to 32 bytes', () => {
    process.env.CONNECTIONS_MASTER_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptSecrets(TENANT_A, { apiKey: 'x' })).toThrow(EnvelopeConfigError);
  });

  it('rejects a malformed blob', () => {
    expect(() => decryptSecrets(TENANT_A, 'not-a-real-blob')).toThrow(EnvelopeDecryptError);
  });
});
