/**
 * Tracks pinned (favorited) sessions.
 * Persisted to localStorage so state survives page reload.
 * Unlike `dismissed`, pin has no expiry — user must explicitly unpin.
 */

const STORAGE_KEY = 'session-dashboard:pinned';

function loadFromStorage(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const ids: string[] = JSON.parse(raw);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveToStorage(set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

let pinned = $state<Set<string>>(loadFromStorage());

export function togglePin(sessionId: string): void {
  const next = new Set(pinned);
  if (next.has(sessionId)) {
    next.delete(sessionId);
  } else {
    next.add(sessionId);
  }
  pinned = next;
  saveToStorage(next);
}

export function isPinned(sessionId: string): boolean {
  return pinned.has(sessionId);
}

export function getPinnedIds(): Set<string> {
  return pinned;
}

export function getPinnedCount(): number {
  return pinned.size;
}

export function clearAllPins(): void {
  pinned = new Set();
  saveToStorage(pinned);
}
