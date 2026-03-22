import { describe, it, expect } from 'vitest';
import { parsePsOutput, parseLsofOutput, ProcessScanner } from '../process-scanner.js';

describe('parsePsOutput', () => {
  it('parses standard ps output with claude and opencode processes', () => {
    const stdout = `  PID  PPID  %CPU   RSS COMM
    1     0   0.0  1234 launchd
 1234   100  12.5 45678 claude
 5678   100   3.2 12345 opencode
 9999  1234   0.1  5678 node
`;
    const result = parsePsOutput(stdout);
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      pid: 1234, ppid: 100, cpu: 12.5, rss: 45678,
      comm: 'claude', cwd: null,
    });
    expect(result[1]).toEqual({
      pid: 5678, ppid: 100, cpu: 3.2, rss: 12345,
      comm: 'opencode', cwd: null,
    });
  });

  it('handles full path in comm column', () => {
    const stdout = `  PID  PPID  %CPU   RSS COMM
 1234   100   5.0  8000 /usr/local/bin/claude
`;
    const result = parsePsOutput(stdout);
    expect(result).toHaveLength(1);
    expect(result[0].comm).toBe('claude');
  });

  it('returns empty array for empty input', () => {
    expect(parsePsOutput('')).toEqual([]);
  });

  it('skips malformed lines', () => {
    const stdout = `  PID  PPID  %CPU   RSS COMM
 abc   100   5.0  8000 claude
 1234   100   5.0  8000 claude
`;
    const result = parsePsOutput(stdout);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(1234);
  });

  it('filters out non-target processes', () => {
    const stdout = `  PID  PPID  %CPU   RSS COMM
 1234   100   5.0  8000 node
 5678   100   3.0  4000 python
 9012   100   1.0  2000 claude
`;
    const result = parsePsOutput(stdout);
    expect(result).toHaveLength(1);
    expect(result[0].comm).toBe('claude');
  });
});

describe('parseLsofOutput', () => {
  it('parses lsof -Fpn output', () => {
    const stdout = `p1234
n/Users/user/project-a
p5678
n/Users/user/project-b
`;
    const result = parseLsofOutput(stdout);
    expect(result.size).toBe(2);
    expect(result.get(1234)).toBe('/Users/user/project-a');
    expect(result.get(5678)).toBe('/Users/user/project-b');
  });

  it('returns empty map for empty input', () => {
    expect(parseLsofOutput('').size).toBe(0);
  });

  it('handles missing cwd lines', () => {
    const stdout = `p1234
p5678
n/Users/user/project-b
`;
    const result = parseLsofOutput(stdout);
    expect(result.size).toBe(1);
    expect(result.get(5678)).toBe('/Users/user/project-b');
  });
});

describe('ProcessScanner', () => {
  it('initializes with empty cache', () => {
    const scanner = new ProcessScanner();
    expect(scanner.getProcessByPid(1234)).toBeNull();
    expect(scanner.getProcessesByCwd('/test')).toEqual([]);
  });

  it('getMetricsByPid returns null for unknown PID', () => {
    const scanner = new ProcessScanner();
    expect(scanner.getMetricsByPid(9999)).toBeNull();
  });

  it('getMetricsByCwd returns null for unknown CWD', () => {
    const scanner = new ProcessScanner();
    expect(scanner.getMetricsByCwd('/unknown', 'claude')).toBeNull();
  });

  it('resetCache clears cached data', async () => {
    const scanner = new ProcessScanner();
    // scan() 호출 후 캐시가 채워짐 (실제 ps 실행)
    await scanner.scan();
    scanner.resetCache();
    // 캐시 리셋 후 scannedAt이 0
    expect(scanner.getProcessByPid(1)).toBeNull();
  });
});
