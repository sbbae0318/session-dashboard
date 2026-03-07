import * as path from 'path';

/**
 * Format duration in milliseconds to human-readable string.
 * Examples: '< 1m', '5m 23s', '2h 15m'
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);

  if (totalMinutes < 1) {
    return '< 1m';
  }

  if (totalHours < 1) {
    const minutes = totalMinutes;
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = totalHours;
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Format timestamp to relative time string.
 * Examples: '2m ago', '1h ago', '3d ago'
 */
export function formatTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  return `${diffDays}d ago`;
}

/**
 * Get display width of a character (CJK characters are width 2).
 */
function getCharWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  // CJK Unified Ideographs, Hangul, Japanese, etc.
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals
    (code >= 0x3040 && code <= 0x33ff) || // Japanese
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
    (code >= 0xfe10 && code <= 0xfe1f) || // Vertical Forms
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
    (code >= 0x1f300 && code <= 0x1f9ff)  // Emoji
  ) {
    return 2;
  }
  return 1;
}

/**
 * Truncate text to maxLen characters, appending '…' if truncated.
 * CJK-aware: counts wide characters as 2 units.
 */
export function truncate(text: string, maxLen: number): string {
  let width = 0;
  let result = '';

  for (const char of text) {
    const charWidth = getCharWidth(char);
    if (width + charWidth > maxLen - 1) {
      return result + '…';
    }
    result += char;
    width += charWidth;
  }

  return text;
}

/**
 * Format API status as a badge string.
 * Examples: '● BUSY', '○ IDLE', '? --'
 */
export function statusBadge(apiStatus: string | null): string {
  switch (apiStatus) {
    case 'busy':
      return '● BUSY';
    case 'idle':
      return '○ IDLE';
    case 'retry':
      return '↻ RETRY';
    default:
      return '? --';
  }
}

/**
 * Extract project name from cwd path (basename).
 * Example: '/Users/sbbae/project/bae-settings' → 'bae-settings'
 */
export function projectName(cwd: string | null): string {
  if (!cwd) return '';
  return path.basename(cwd);
}
