/**
 * Plan-name parsing. Pure string work, no server dependencies.
 *
 * This lives apart from `platform/client.ts` deliberately. That module is the
 * provider facade, and it now transitively reaches the per-tenant credential
 * vault and `node:crypto`. A client component importing one pure helper from it
 * dragged the entire server-side credential stack into the browser bundle and
 * broke the production build — the tests never saw it, because a unit test does
 * not care which bundle a module lands in.
 *
 * Anything a client component needs from the platform layer belongs here.
 */

const ADDON_MAP: Record<string, string> = {
  NT: 'NT',
  DL: 'DL',
  WT: 'WT',
  '10PS': '10PS',
  HMLPT: 'HMLPT',
  EA: 'EA',
  NMTD: 'NMTD',
};

export function parsePlanName(planName: string): { platform: string; addons: string[] } {
  const upper = planName.toUpperCase();
  let platform = '—';
  if (upper.includes('MT5')) platform = 'MT5';
  else if (upper.includes('MATCHTRADER') || upper.includes('MATCH-TRADER')) platform = 'MatchTrader';
  else if (upper.includes('A-TRADER') || upper.includes('ATRADER')) platform = 'A-Trader';

  const addons: string[] = [];
  const parts = planName.split(',').map((p) => p.trim().toUpperCase());
  for (const part of parts) {
    if (ADDON_MAP[part]) addons.push(ADDON_MAP[part]);
  }
  return { platform, addons: addons.length > 0 ? addons : ['No Add-on'] };
}
