import { z } from 'zod';

/**
 * Push-path body validation (src/app/api/ingest/equity-snapshots).
 *
 * Accounts are identified by `account_login` — the identifier the firm's own
 * platform/bridge actually knows (matches `accounts.login`) — not our
 * internal `accounts.id` UUID, which a third-party bridge has no reason to
 * have ever seen. The route resolves login -> internal id within the
 * authenticated tenant's own account book (src/lib/ingest/snapshots.ts),
 * mirroring how src/app/api/cron/ingest-trades resolves external ids to
 * internal ones before writing.
 */

const snapshotSchema = z.object({
  account_login: z.string().trim().min(1).max(50),
  /** Observation instant, ISO 8601. This is `EquitySnapshot.at`, not the write time. */
  captured_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'captured_at must be a parseable timestamp',
  }),
  balance: z.number().finite(),
  equity: z.number().finite(),
  open_pnl: z.number().finite().nullable().optional(),
  /**
   * The bridge's own sampling cadence in seconds, if it knows one. Omitted
   * (not zero) means "unknown" — the loader must not assume tick-level
   * fidelity just because this came from a push rather than a poll.
   */
  sample_interval_seconds: z.number().int().positive().nullable().optional(),
});

export const pushEquitySnapshotsBodySchema = z.object({
  snapshots: z.array(snapshotSchema).min(1).max(500),
});

export type PushSnapshotInput = z.infer<typeof snapshotSchema>;

export const createIngestKeyBodySchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
});
