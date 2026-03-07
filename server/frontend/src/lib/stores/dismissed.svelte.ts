/**
 * Tracks dismissed sessions.
 * Key: sessionId, Value: lastActivityTime at time of dismissal.
 * Session reappears when its lastActivityTime exceeds the stored value.
 */
let dismissed = $state<Map<string, number>>(new Map());

export function dismissSession(sessionId: string, lastActivityTime: number): void {
  const next = new Map(dismissed);
  next.set(sessionId, lastActivityTime);
  dismissed = next;
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
  }
}

export function getDismissedCount(): number {
  return dismissed.size;
}

export function restoreAll(): void {
  dismissed = new Map();
}
