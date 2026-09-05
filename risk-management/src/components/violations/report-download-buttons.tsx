'use client';

import { useState } from 'react';
import { Download, FileText, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEMO_MODE } from '@/lib/demo';

/**
 * PDF / CSV download buttons for one violation's decision record.
 *
 * The download is triggered through a synthetic `<a download>` click rather
 * than by wrapping the `Button` primitive in an anchor: a `<button>` inside an
 * `<a>` is invalid HTML and breaks keyboard interaction, and rebuilding the
 * button's styles on a bare anchor would fork the one card/button treatment
 * DESIGN.md asks the product to keep. `src/lib/export/csv.ts`'s `downloadCsv`
 * already uses exactly this idiom for client-side exports.
 *
 * "Regenerate" is deliberately absent unless the caller can say the viewer is
 * a risk manager. There is no client-side session/role source in this app
 * today (roles live in `app_metadata`, read server-side by
 * `src/lib/auth/guards.ts`), so a page that does not pass `role` gets the two
 * read-only buttons and nothing that writes. The API enforces the same rule —
 * this only stops the product offering an action it will refuse.
 */

const MANAGER_ROLES = new Set(['risk_manager', 'admin']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReportDownloadButtonsProps {
  /**
   * `violations.id`. Some operator surfaces (the funded-payouts violation
   * list) are fed by the PROVIDER analysis rather than the `violations`
   * table, and their row ids are synthetic `${accountId}-${type}` strings —
   * see src/app/api/platform/violations/route.ts:157. Those cannot address a
   * per-violation report in live mode, so pass `accountId` alongside and the
   * buttons fall back to the account-level export rather than linking to a
   * 400. In demo mode the synthetic id IS the addressable id.
   */
  violationId?: string;
  /** Account login or internal id, for the account-level CSV fallback. */
  accountId?: string;
  /** 'sm' for a header action row; 'icon' for a dense table cell. */
  size?: 'sm' | 'icon';
  /** Viewer's role, when the page knows it. Gates the Regenerate action. */
  role?: string;
  className?: string;
}

function triggerDownload(url: string): void {
  if (typeof document === 'undefined') return;
  const link = document.createElement('a');
  link.href = url;
  // The server sets Content-Disposition; `download` keeps the browser from
  // navigating away when it decides it can render a PDF inline.
  link.download = '';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function ReportDownloadButtons({
  violationId,
  accountId,
  size = 'sm',
  role,
  className,
}: ReportDownloadButtonsProps) {
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dense = size === 'icon';
  const buttonClass = dense ? '!px-1.5 !py-1 !text-[10px]' : '!text-[11px]';
  const iconClass = dense ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const addressable = Boolean(violationId) && (DEMO_MODE || UUID_RE.test(violationId!));
  const base = addressable
    ? `/api/violations/${encodeURIComponent(violationId!)}/report`
    : accountId
      ? `/api/violations/account/${encodeURIComponent(accountId)}/report`
      : null;

  if (!base) return null;

  const handleRegenerate = async () => {
    setRegenerating(true);
    setError(null);
    try {
      const res = await fetch(base, { method: 'POST', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className={`flex items-center gap-1 ${className ?? ''}`}>
      {addressable && (
        <Button
          variant="ghost"
          size="sm"
          className={buttonClass}
          title="Download the full decision record as a PDF"
          onClick={() => triggerDownload(`${base}?format=pdf`)}
        >
          <FileText className={`${iconClass} mr-1`} /> PDF
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className={buttonClass}
        title={
          addressable
            ? 'Download the full decision record as a CSV'
            : 'Download every decision record on this account as a CSV'
        }
        onClick={() => triggerDownload(addressable ? `${base}?format=csv` : base)}
      >
        <Download className={`${iconClass} mr-1`} /> CSV
      </Button>

      {addressable && role && MANAGER_ROLES.has(role) && (
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={regenerating}
          className="ml-1 inline-flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 disabled:opacity-40"
          title="Re-run the report against today's rows. Returns the existing record if nothing changed."
        >
          <RefreshCw className={`h-3 w-3 ${regenerating ? 'animate-spin' : ''}`} />
          Regenerate
        </button>
      )}

      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}
