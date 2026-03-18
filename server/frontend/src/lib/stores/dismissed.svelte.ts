/**
 * Tracks dismissed sessions.
 * Key: sessionId, Value: lastActivityTime at time of dismissal.
 * Session reappears when its lastActivityTime exceeds the stored value.
 * Persisted to localStorage so state survives page reload.
 */

const STORAGE_KEY = 'session-dashboard:dismissed';

function loadFromStorage(): Map<string, number> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const entries: [string, number][] = JSON.parse(raw);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function saveToStorage(map: Map<string, number>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map.entries()]));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

let dismissed = $state<Map<string, number>>(loadFromStorage());

export function dismissSession(sessionId: string, lastActivityTime: number): void {
  const next = new Map(dismissed);
  next.set(sessionId, lastActivityTime);
  dismissed = next;
  saveToStorage(next);
}

export function isDismissed(sessionId: string): boolean {
  return dismissed.has(sessionId);
}

/**
 * Revive sessions whose lastActivityTime has changed since dismissal.
 * Call this on every session update (SSE / poll).
 */
export function reviveSessions(sessions: { sessionId: string; lastActivityTime: number }[]): void {
  let changed = false;
  const next = new Map(dismissed);
  for (const s of sessions) {
    const dismissedAt = next.get(s.sessionId);
    if (dismissedAt !== undefined && s.lastActivityTime > dismissedAt) {
      next.delete(s.sessionId);
      changed = true;
    }
  }
  if (changed) {
    dismissed = next;
    saveToStorage(next);
  }
}

export function getDismissedCount(): number {
  return dismissed.size;
}

export function restoreAll(): void {
  dismissed = new Map();
  saveToStorage(dismissed);
}
