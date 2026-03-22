/**
 * OS 프로세스 테이블에서 claude/opencode 프로세스를 감지하고
 * CPU%, RSS 등 메트릭을 제공하는 보조 모니터링 모듈.
 *
 * 기존 Heartbeat/Hook/SSE 상태를 덮어쓰지 않으며,
 * 메트릭 보강 + alive 확인 + orphan 감지 용도로만 사용.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly cpu: number;       // CPU %
  readonly rss: number;       // KB
  readonly comm: string;      // "claude" | "opencode" | etc.
  readonly cwd: string | null;
}

export interface ProcessMetrics {
  readonly alive: boolean;
  readonly cpuPercent: number;
  readonly rssKb: number;
}

export interface ProcessScanResult {
  readonly processes: readonly ProcessInfo[];
  readonly scannedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10_000; // 10 seconds
const EXEC_TIMEOUT_MS = 5_000;
const TARGET_COMMS = new Set(['claude', 'opencode']);

// ---------------------------------------------------------------------------
// ProcessScanner
// ---------------------------------------------------------------------------

export class ProcessScanner {
  private cache: ProcessScanResult = { processes: [], scannedAt: 0 };

  /** 캐시 적용 스캔 */
  async scan(): Promise<ProcessScanResult> {
    const now = Date.now();
    if (now - this.cache.scannedAt < CACHE_TTL_MS) {
      return this.cache;
    }
    const result = await this.scanUncached();
    this.cache = result;
    return result;
  }

  /** 캐시 없이 직접 스캔 (테스트용) */
  async scanUncached(): Promise<ProcessScanResult> {
    const processes = await scanProcesses();
    return { processes, scannedAt: Date.now() };
  }

  /** PID로 프로세스 조회 (캐시에서) */
  getProcessByPid(pid: number): ProcessInfo | null {
    return this.cache.processes.find(p => p.pid === pid) ?? null;
  }

  /** CWD로 프로세스 조회 (캐시에서) */
  getProcessesByCwd(cwd: string): ProcessInfo[] {
    return this.cache.processes.filter(
      p => p.cwd !== null && p.cwd === cwd,
    );
  }

  /** 특정 PID의 메트릭 반환 */
  getMetricsByPid(pid: number): ProcessMetrics | null {
    const proc = this.getProcessByPid(pid);
    if (!proc) return null;
    return { alive: true, cpuPercent: proc.cpu, rssKb: proc.rss };
  }

  /** CWD + comm 기반 메트릭 반환 (첫 번째 매칭) */
  getMetricsByCwd(cwd: string, comm: string): ProcessMetrics | null {
    const proc = this.cache.processes.find(
      p => p.cwd !== null && p.cwd === cwd && p.comm === comm,
    );
    if (!proc) return null;
    return { alive: true, cpuPercent: proc.cpu, rssKb: proc.rss };
  }

  resetCache(): void {
    this.cache = { processes: [], scannedAt: 0 };
  }
}

// ---------------------------------------------------------------------------
// ps 파싱
// ---------------------------------------------------------------------------

/**
 * `ps -eo pid,ppid,%cpu,rss,comm` 출력을 파싱.
 * claude/opencode 프로세스만 필터링.
 */
export function parsePsOutput(stdout: string): ProcessInfo[] {
  const lines = stdout.split('\n');
  const results: ProcessInfo[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('PID')) continue;

    // ps 출력: "  PID  PPID  %CPU   RSS COMMAND"
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;

    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const cpu = parseFloat(parts[2]);
    const rss = parseInt(parts[3], 10);
    // comm 은 마지막 path component만 포함 (e.g., "/usr/bin/claude" → "claude")
    const rawComm = parts[4];
    const comm = rawComm.split('/').pop() ?? rawComm;

    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
    if (!TARGET_COMMS.has(comm)) continue;

    results.push({
      pid,
      ppid,
      cpu: Number.isNaN(cpu) ? 0 : cpu,
      rss: Number.isNaN(rss) ? 0 : rss,
      comm,
      cwd: null, // lsof로 채움
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// lsof 파싱
// ---------------------------------------------------------------------------

/**
 * `lsof -a -d cwd -Fpn -p <pids>` 출력을 파싱.
 * 반환: pid → cwd 매핑
 */
export function parseLsofOutput(stdout: string): Map<number, string> {
  const result = new Map<number, string>();
  let currentPid: number | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      currentPid = parseInt(line.slice(1), 10);
    } else if (line.startsWith('n') && currentPid !== null) {
      result.set(currentPid, line.slice(1));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 내부 실행 함수
// ---------------------------------------------------------------------------

function runPs(): Promise<string> {
  return new Promise((resolve) => {
    const isLinux = platform() === 'linux';
    const args = isLinux
      ? ['-eo', 'pid,ppid,%cpu,rss,comm']
      : ['-eo', 'pid,ppid,%cpu,rss,comm'];

    execFile('ps', args, { timeout: EXEC_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

function runLsof(pids: number[]): Promise<string> {
  if (pids.length === 0) return Promise.resolve('');

  return new Promise((resolve) => {
    const pidArg = pids.join(',');
    execFile(
      'lsof',
      ['-a', '-d', 'cwd', '-Fpn', '-p', pidArg],
      { timeout: EXEC_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error ? '' : stdout);
      },
    );
  });
}

async function scanProcesses(): Promise<ProcessInfo[]> {
  const psOutput = await runPs();
  if (!psOutput) return [];

  const processes = parsePsOutput(psOutput);
  if (processes.length === 0) return [];

  // 배치 lsof로 CWD 확보
  const pids = processes.map(p => p.pid);
  const lsofOutput = await runLsof(pids);
  const cwdMap = parseLsofOutput(lsofOutput);

  // CWD 매핑
  return processes.map(p => {
    const cwd = cwdMap.get(p.pid) ?? null;
    return cwd !== null ? { ...p, cwd } : p;
  });
}
