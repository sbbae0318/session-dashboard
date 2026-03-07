
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, mkdir, stat as statFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeSessionInfo {
  readonly sessionId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly project: string;
  readonly startTime: number;
  readonly lastHeartbeat: number;
  readonly source: 'claude-code';
  readonly status: 'busy' | 'idle';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_TTL_MS = 120_000;
const EVICTION_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// ClaudeHeartbeat
// ---------------------------------------------------------------------------

export class ClaudeHeartbeat {
  private readonly heartbeatsDir: string;
  private readonly claudeProjectsDir: string;
  private watcher: FSWatcher | null = null;
  private projectsWatcher: FSWatcher | null = null;
  private sessions: Map<string, ClaudeSessionInfo> = new Map();
  private evictionInterval: NodeJS.Timeout | null = null;

  constructor(heartbeatsDir?: string, claudeProjectsDir?: string) {
    this.heartbeatsDir =
      heartbeatsDir ?? join(homedir(), '.opencode', 'history', 'heartbeats');
    this.claudeProjectsDir =
      claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
  }

  start(): void {
    void this.initialScan();
    this.startWatcher();
    this.startProjectsWatcher();
    this.evictionInterval = setInterval(
      () => this.evictStale(),
      EVICTION_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.projectsWatcher) {
      this.projectsWatcher.close();
      this.projectsWatcher = null;
    }
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
      this.evictionInterval = null;
    }
    this.sessions.clear();
  }

  getActiveSessions(): ClaudeSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  // -------------------------------------------------------------------------
  // Directory scanning
  // -------------------------------------------------------------------------

  private async initialScan(): Promise<void> {
    try {
      const files = await readdir(this.heartbeatsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      await Promise.allSettled(
        jsonFiles.map((f) => this.readHeartbeatFile(join(this.heartbeatsDir, f))),
      );
    } catch {
      // Directory doesn't exist yet — silently ignore
    }
    // Also scan projects directory for active sessions
    await this.scanProjectsForActiveSessions();
  }

  private async scanDirectory(): Promise<void> {
    try {
      const files = await readdir(this.heartbeatsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      const currentIds = new Set<string>();

      const results = await Promise.allSettled(
        jsonFiles.map(async (f) => {
          const info = await this.readHeartbeatFile(join(this.heartbeatsDir, f));
          return info;
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          currentIds.add(result.value.sessionId);
        }
      }

      for (const sessionId of this.sessions.keys()) {
        if (!currentIds.has(sessionId)) {
          this.sessions.delete(sessionId);
        }
      }
    } catch {
      // Directory read failed — keep existing state
    }
  }

  private async readHeartbeatFile(
    filePath: string,
  ): Promise<ClaudeSessionInfo | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;

      const sessionId = String(data['sessionId'] ?? '');
      if (!sessionId) return null;

      const cwd = String(data['cwd'] ?? '');
      const status = await this.detectSessionStatus(sessionId, cwd);

      const info: ClaudeSessionInfo = {
        sessionId,
        pid: Number(data['pid'] ?? 0),
        cwd,
        project: String(data['project'] ?? ''),
        startTime: Number(data['startTime'] ?? 0),
        lastHeartbeat: Number(data['lastHeartbeat'] ?? 0),
        source: 'claude-code',
        status,
      };

      this.sessions.set(info.sessionId, info);
      return info;
    } catch {
      return null;
    }
  }


  // -------------------------------------------------------------------------
  // Status detection
  // -------------------------------------------------------------------------

  private async detectSessionStatus(
    sessionId: string,
    cwd: string,
  ): Promise<'busy' | 'idle'> {
    try {
      // Encode cwd: /Users/sbbae/project/foo → -Users-sbbae-project-foo
      const encodedCwd = cwd.replace(/\//g, '-');
      const conversationPath = join(
        this.claudeProjectsDir,
        encodedCwd,
        `${sessionId}.jsonl`,
      );

      const content = await readFile(conversationPath, 'utf-8');
      const lines = content.trimEnd().split('\n');

      // Scan from end, find last user or assistant entry
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === 'user') return 'busy';
          if (entry.type === 'assistant') {
            const msg = entry.message as Record<string, unknown> | undefined;
            const msgContent = msg?.content;
            if (
              Array.isArray(msgContent) &&
              msgContent.some(
                (c: Record<string, unknown>) => c.type === 'tool_use',
              )
            ) {
              return 'busy';
            }
            return 'idle';
          }
        } catch {
          continue;
        }
      }
      return 'busy';
    } catch {
      return 'busy';
    }
  }

  /**
   * ~/.claude/projects/ 디렉토리를 스캔하여 최근 수정된 JSONL 파일로 활성 세션 감지.
   * heartbeats 디렉토리가 비어있을 때 폴백으로 동작.
   */
  private async scanProjectsForActiveSessions(): Promise<void> {
    try {
      const projectDirs = await readdir(this.claudeProjectsDir);
      const now = Date.now();
      const activeSessionIds = new Set<string>();

      for (const encodedDir of projectDirs) {
        const dirPath = join(this.claudeProjectsDir, encodedDir);
        try {
          const files = await readdir(dirPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const filePath = join(dirPath, file);
            try {
              const fileStat = await statFile(filePath);
              if (now - fileStat.mtimeMs > STALE_TTL_MS) continue;

              const sessionId = file.replace('.jsonl', '');
              activeSessionIds.add(sessionId);

              // heartbeat 파일로 이미 추적 중인 세션은 건드리지 않음
              if (this.sessions.has(sessionId)) continue;

              const status = await this.detectStatusFromFile(filePath);
              this.sessions.set(sessionId, {
                sessionId,
                pid: 0,
                cwd: this.decodePath(encodedDir),
                project: encodedDir,
                startTime: fileStat.birthtimeMs,
                lastHeartbeat: fileStat.mtimeMs,
                source: 'claude-code',
                status,
              });
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
      }

      // 프로젝트 스캔으로 추가된 세션 중 더 이상 활성이 아닌 것 제거
      // (pid === 0 인 세션 = 프로젝트 스캔으로 추가된 세션)
      for (const [sessionId, session] of this.sessions) {
        if (session.pid === 0 && !activeSessionIds.has(sessionId)) {
          this.sessions.delete(sessionId);
        }
      }
    } catch {
      // claudeProjectsDir doesn't exist — silently ignore
    }
  }

  /** JSONL 파일 경로를 직접 받아 상태 감지 */
  private async detectStatusFromFile(filePath: string): Promise<'busy' | 'idle'> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === 'user') return 'busy';
          if (entry.type === 'assistant') {
            const msg = entry.message as Record<string, unknown> | undefined;
            const msgContent = msg?.content;
            if (
              Array.isArray(msgContent) &&
              msgContent.some(
                (c: Record<string, unknown>) => c.type === 'tool_use',
              )
            ) {
              return 'busy';
            }
            return 'idle';
          }
        } catch {
          continue;
        }
      }
      return 'busy';
    } catch {
      return 'busy';
    }
  }

  /** -Users-sbbae-project-foo → /Users/sbbae/project/foo (best-effort) */
  private decodePath(encodedDir: string): string {
    return encodedDir.replace(/^-/, '/').replace(/-/g, '/');
  }

  private startProjectsWatcher(): void {
    try {
      this.projectsWatcher = watch(
        this.claudeProjectsDir,
        { recursive: true },
        (_eventType, _filename) => {
          void this.scanProjectsForActiveSessions();
        },
      );
      this.projectsWatcher.on('error', () => {
        if (this.projectsWatcher) {
          this.projectsWatcher.close();
          this.projectsWatcher = null;
        }
      });
    } catch {
      // claudeProjectsDir doesn't exist — silently ignore
    }
  }

  // -------------------------------------------------------------------------
  // File watcher
  // -------------------------------------------------------------------------

  private startWatcher(): void {
    try {
      this.watcher = watch(this.heartbeatsDir, (_eventType, _filename) => {
        void this.scanDirectory();
      });

      this.watcher.on('error', () => {
        if (this.watcher) {
          this.watcher.close();
          this.watcher = null;
        }
        setTimeout(() => void this.ensureDirectoryAndRewatch(), 5_000);
      });
    } catch {
      setTimeout(() => void this.ensureDirectoryAndRewatch(), 5_000);
    }
  }

  private async ensureDirectoryAndRewatch(): Promise<void> {
    try {
      await mkdir(this.heartbeatsDir, { recursive: true });
    } catch {
      // mkdir failed — will retry on next attempt
    }
    if (!this.watcher) {
      this.startWatcher();
    }
  }

  // -------------------------------------------------------------------------
  // Eviction
  // -------------------------------------------------------------------------

  private evictStale(): void {
    const now = Date.now();
    for (const [sessionId, info] of this.sessions) {
      if (now - info.lastHeartbeat > STALE_TTL_MS) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
