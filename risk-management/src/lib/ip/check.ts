import type { IPCheckResult } from '@/types/payouts';

const TIMEOUT_MS = 15000;

async function fetchWithTimeout(url: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function checkWithIPAPI(ip: string): Promise<IPCheckResult> {
  const res = await fetchWithTimeout(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}`);
  if (!res.ok) throw new Error(`ipapi.is HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  return {
    ip: data.ip || ip,
    city: data.location?.city || 'Unknown',
    region: data.location?.state || 'Unknown',
    country: data.location?.country || 'Unknown',
    isp: data.company?.name || data.asn?.org || 'Unknown',
    isProxy: data.is_proxy || false,
    isVpn: data.is_vpn || false,
    isTor: data.is_tor || false,
    isDatacenter: data.is_datacenter || false,
    source: 'ipapi',
  };
}

async function checkWithIPWho(ip: string): Promise<IPCheckResult> {
  const res = await fetchWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (!res.ok) throw new Error(`ipwho.is HTTP ${res.status}`);
  const data = await res.json();
  if (data.success === false) throw new Error(data.message || 'ipwho.is lookup failed');

  return {
    ip: data.ip || ip,
    city: data.city || 'Unknown',
    region: data.region || 'Unknown',
    country: data.country || 'Unknown',
    isp: data.connection?.isp || data.connection?.org || 'Unknown',
    isProxy: false,
    isVpn: false,
    isTor: false,
    isDatacenter: false,
    source: 'ipwho',
  };
}

export async function checkIP(ip: string): Promise<IPCheckResult> {
  try {
    return await checkWithIPAPI(ip);
  } catch {
    try {
      return await checkWithIPWho(ip);
    } catch {
      return {
        ip,
        city: 'Lookup failed',
        region: '—',
        country: '—',
        isp: 'Failed to fetch',
        isProxy: false,
        isVpn: false,
        isTor: false,
        isDatacenter: false,
        source: 'ipwho',
      };
    }
  }
}

export async function checkIPs(ips: string[]): Promise<IPCheckResult[]> {
  const results: IPCheckResult[] = [];
  for (let i = 0; i < ips.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    results.push(await checkIP(ips[i].trim()));
  }
  return results;
}
