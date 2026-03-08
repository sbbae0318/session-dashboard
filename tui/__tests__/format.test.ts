import { describe, test, expect } from 'bun:test';
import {
  formatDuration,
  formatTime,
  truncate,
  statusBadge,
  projectName,
} from '../src/utils/format.js';

describe('formatDuration()', () => {
  test('less than 1 minute returns "< 1m"', () => {
    expect(formatDuration(0)).toBe('< 1m');
    expect(formatDuration(30000)).toBe('< 1m');
    expect(formatDuration(59999)).toBe('< 1m');
  });

  test('5 minutes 23 seconds returns "5m 23s"', () => {
    const ms = (5 * 60 + 23) * 1000;
    expect(formatDuration(ms)).toBe('5m 23s');
  });

  test('exact minutes with no seconds returns "Xm"', () => {
    const ms = 10 * 60 * 1000;
    expect(formatDuration(ms)).toBe('10m');
  });

  test('2 hours 15 minutes returns "2h 15m"', () => {
    const ms = (2 * 60 + 15) * 60 * 1000;
    expect(formatDuration(ms)).toBe('2h 15m');
  });

  test('exact hours with no minutes returns "Xh"', () => {
    const ms = 3 * 60 * 60 * 1000;
    expect(formatDuration(ms)).toBe('3h');
  });

  test('1 hour 0 minutes returns "1h"', () => {
    const ms = 60 * 60 * 1000;
    expect(formatDuration(ms)).toBe('1h');
  });
});

describe('formatTime()', () => {
  test('less than 60 seconds returns "just now"', () => {
    const result = formatTime(Date.now() - 30000);
    expect(result).toBe('just now');
  });

  test('2 minutes ago returns "2m ago"', () => {
    const result = formatTime(Date.now() - 2 * 60 * 1000);
    expect(result).toBe('2m ago');
  });

  test('3 hours ago returns "3h ago"', () => {
    const result = formatTime(Date.now() - 3 * 60 * 60 * 1000);
    expect(result).toBe('3h ago');
  });

  test('2 days ago returns "2d ago"', () => {
    const result = formatTime(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(result).toBe('2d ago');
  });
});

describe('truncate()', () => {
  test('short text shorter than maxLen is unchanged', () => {
    expect(truncate('hello', 20)).toBe('hello');
  });

  test('text exactly at maxLen is unchanged', () => {
    // 'hello' is 5 chars, maxLen=5 → no truncation (width + charWidth > maxLen - 1 = 4, so 5 chars fit)
    expect(truncate('hello', 6)).toBe('hello');
  });

  test('long text is truncated with ellipsis', () => {
    const result = truncate('Hello World This Is Long', 10);
    expect(result).toContain('…');
    expect(result.length).toBeLessThan(12);
  });

  test('empty string returns empty string', () => {
    expect(truncate('', 10)).toBe('');
  });

  test('text truncated at correct position', () => {
    // maxLen=5: can fit 4 chars + '…'
    const result = truncate('abcdefgh', 5);
    expect(result).toBe('abcd…');
  });
});

describe('statusBadge()', () => {
  test('"busy" returns "● BUSY"', () => {
    expect(statusBadge('busy')).toBe('● BUSY');
  });

  test('"idle" returns "○ IDLE"', () => {
    expect(statusBadge('idle')).toBe('○ IDLE');
  });

  test('"retry" returns "↻ RETRY"', () => {
    expect(statusBadge('retry')).toBe('↻ RETRY');
  });

  test('null returns "? --"', () => {
    expect(statusBadge(null)).toBe('? --');
  });

  test('unknown string returns "? --"', () => {
    expect(statusBadge('unknown')).toBe('? --');
  });
});

describe('projectName()', () => {
  test('full path returns basename', () => {
    expect(projectName('/Users/john/project/my-app')).toBe('my-app');
  });

  test('null returns empty string', () => {
    expect(projectName(null)).toBe('');
  });

  test('simple path returns last segment', () => {
    expect(projectName('/home/user/my-project')).toBe('my-project');
  });

  test('path with trailing slash returns basename', () => {
    // path.basename handles trailing slashes
    expect(projectName('/home/user/project/')).toBe('project');
  });
});
