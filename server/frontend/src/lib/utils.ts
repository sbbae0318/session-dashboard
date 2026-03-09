export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금 전";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function getQueryResult(
  query: { sessionId: string; timestamp: number; completedAt?: number | null },
  sessions: Array<{ sessionId: string; status: string; apiStatus: string | null }>
): string | null {
  // completedAt이 있으면 완료된 것
  if (query.completedAt) return 'completed';

  // Fallback to session status
  const session = sessions.find((s) => s.sessionId === query.sessionId);
  if (session) {
    if (session.apiStatus === 'busy') return 'busy';
    if (session.apiStatus === 'idle') return 'idle';
    return session.status;
  }

  return null;
}

/**
 * Get the completion timestamp for a query.
 * Returns completedAt (Unix ms) if available, null otherwise.
 */
export function getCompletionTime(
  query: { completedAt?: number | null },
): number | null {
  return query.completedAt ?? null;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  // Try Clipboard API first (requires secure context: HTTPS or localhost)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Safari NotAllowedError, etc. — fall through to fallback
    }
  }

  // Fallback: execCommand('copy') for non-secure context (LAN IP, etc.)
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.userSelect = 'text';
  textarea.setAttribute('aria-hidden', 'true');
  const previousFocus = document.activeElement as HTMLElement | null;
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    previousFocus?.focus({ preventScroll: true });
  }
}

/**
 * Determine if a query is from a background session.
 * Checks q.isBackground flag first, then cross-references session metadata.
 * Used to filter out explore/librarian subagent queries from the main feed.
 */
export function isBackgroundQuery(
  q: { isBackground: boolean; sessionId: string; sessionTitle?: string | null },
  sessions: Array<{ sessionId: string; parentSessionId?: string | null; title?: string | null }>,
): boolean {
  // Explicit flag from backend
  if (q.isBackground) return true;

  // Cross-reference session metadata
  const session = sessions.find(s => s.sessionId === q.sessionId);

  // If the session has a parent, it is a child/subagent session
  if (session?.parentSessionId) return true;

  // Title-based detection (matches isBackgroundSession() in prompt-extractor.ts)
  const title = q.sessionTitle || session?.title || null;
  if (title !== null) {
    if (title.startsWith('Background:') || title.startsWith('Task:') || title.includes('@')) {
      return true;
    }
  }

  return false;
}
