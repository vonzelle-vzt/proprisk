const STORAGE_KEY = 'rmp_audit_history';
const MAX_ENTRIES = 500;

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  entityType: 'payout' | 'violation' | 'deduction' | 'account' | 'report';
  entityId: string;
  details: string;
  previousValue?: string;
  newValue?: string;
  metadata?: Record<string, any>;
}

export function logAuditEntry(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
  try {
    const history = getAuditHistory();
    const newEntry: AuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    history.unshift(newEntry);
    // Keep only the most recent entries
    if (history.length > MAX_ENTRIES) {
      history.length = MAX_ENTRIES;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // localStorage may be full or unavailable
  }
}

export function getAuditHistory(): AuditEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clearAuditHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
}
