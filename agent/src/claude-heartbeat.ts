
import { extractUserPrompt } from './prompt-extractor.js';
import { watch, type FSWatcher, statSync } from 'node:fs';
import { readdir, readFile, mkdir, stat as statFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { ProcessScanner, ProcessMetrics } from './process-scanner.js';

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
  readonly title: string | null;
  readonly lastPromptTime: number | null;
  readonly lastResponseTime: number | null;
  readonly lastFileModified: number;
  readonly lastPrompt: string | null;
  // Hook-sourced fields (real-time updates from Claude Code hooks)
  readonly currentTool: string | null;
  readonly waitingForInput: boolean;
  readonly hooksActive: boolean;
  readonly processMetrics: ProcessMetrics | null;
}

interface ConversationData {
  readonly status: 'busy' | 'idle';
  readonly title: string | null;
  readonly lastPrompt: string | null;
  readonly lastPromptTime: number | null;
  readonly lastResponseTime: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_TTL_MS = 4 * 60 * 60 * 1000;
const EVICTION_INTERVAL_MS = 30_000;
const MAX_TITLE_LENGTH = 100;
const MAX_PROMPT_LENGTH = 200;

/** Background agent sessions run in temp dirs — skip these */
function isTempDir(p: string): boolean {
  return /^\/(private\/)?(tmp|var\/folders)/.test(p);
}

/**
 * 비-대화 user 엔트리 판별 (실제 프롬프트가 아닌 것들)
 * - tool_result: Claude Code tool 실행 결과
 * - 슬래시 명령: /compact, /exit 등
 * - 로컬 명령 결과: <local-command-caveat>, <local-command-stdout/stderr>
 */
function isNonConversationUser(entry: Record<string, unknown>): boolean {
  const msg = entry.message as Record<string, unknown> | undefined;
  const content = msg?.content;

  // array content → tool_result 전용
  if (Array.isArray(content)) {
    return content.length > 0 && content.every(
      (c: Record<string, unknown>) => c.type === 'tool_result',
    );
  }

  // string content → 슬래시 명령 / 로컬 명령 결과
  if (typeof content === 'string') {
    const trimmed = content.trimStart();
    if (trimmed.startsWith('<command-name>')) return true;
    if (trimmed.startsWith('<local-command-')) return true;
    return false;
  }

  return false;
}

/**
 * assistant 엔트리가 interrupt(Esc/Ctrl+C)로 중단되었는지 판별
 * stop_reason === "stop_sequence" → interrupt
 */
function isInterruptedAssistant(entry: Record<string, unknown>): boolean {
  const msg = entry.message as Record<string, unknown> | undefined;
  return msg?.stop_reason === 'stop_sequence';
}

// ---------------------------------------------------------------------------
// ClaudeHeartbeat
// ---------------------------------------------------------------------------

export class ClaudeHeartbeat {
  private readonly heartbeatsDir: string;
  private readonly claudeProjectsDir: string;
  private readonly processScanner: ProcessScanner | null;
  private watcher: FSWatcher | null = null;
  private projectsWatcher: FSWatcher | null = null;
  private sessions: Map<string, ClaudeSessionInfo> = new Map();
  private evictionInterval: NodeJS.Timeout | null = null;

  constructor(heartbeatsDir?: string, claudeProjectsDir?: string, processScanner?: ProcessScanner) {
    this.heartbeatsDir =
      heartbeatsDir ?? join(homedir(), '.opencode', 'history', 'heartbeats');
    this.claudeProjectsDir =
      claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
    this.processScanner = processScanner ?? null;
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
  // On-demand response fetch (JSONL 역순 파싱)
  // -------------------------------------------------------------------------

  private responseCache = new Map<string, { response: string; cachedAt: number }>();
  private static readonly RESPONSE_CACHE_MAX = 50;

  async fetchResponse(sessionId: string, promptTimestamp: number): Promise<string | null> {
    const cacheKey = `${sessionId}:${promptTimestamp}`;

    // 캐시 히트 (idle 세션만 캐시됨)
    const cached = this.responseCache.get(cacheKey);
    if (cached) return cached.response;

    // 세션의 JSONL 파일 찾기
    const conversationPath = await this.findConversationFile(sessionId);
    if (!conversationPath) return null;

    let content: string;
    try {
      content = await readFile(conversationPath, 'utf-8');
    } catch {
      return null;
    }

    const lines = content.trimEnd().split('\n');
    const targetMs = promptTimestamp;

    // 역순으로 해당 user 메시지를 찾고, 그 이후의 assistant text를 수집
    let userLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>;
        if (entry.type !== 'user') continue;
        const ts = typeof entry.timestamp === 'string' ? new Date(entry.timestamp).getTime() : 0;
        // timestamp 매칭: ±2초 허용 (폴링 지연)
        if (Math.abs(ts - targetMs) < 2000) {
          userLineIndex = i;
          break;
        }
      } catch { continue; }
    }
    if (userLineIndex < 0) return null;

    // user 이후의 assistant text 엔트리들을 수집 (다음 real user 전까지)
    // tool_result만 포함된 user 엔트리는 skip (Claude Code의 tool 결과 반환)
    const textParts: string[] = [];
    for (let i = userLineIndex + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>;
        if (entry.type === 'user') {
          if (isNonConversationUser(entry)) continue; // tool_result → skip
          break; // 실제 user 프롬프트 → 중단
        }
        if (entry.type !== 'assistant') continue;
        const msg = entry.message as Record<string, unknown> | undefined;
        const contentArr = msg?.content;
        if (!Array.isArray(contentArr)) continue;
        for (const part of contentArr) {
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string') {
            textParts.push(p.text);
          }
          // thinking, tool_use 는 스킵
        }
      } catch { continue; }
    }

    if (textParts.length === 0) return null;

    const response = textParts.join('\n\n');
    const truncated = response.length > 30_000
      ? response.slice(0, 30_000) + '\n\n... (truncated)'
      : response;

    // idle 세션만 캐시
    const session = this.sessions.get(sessionId);
    if (session?.status === 'idle') {
      if (this.responseCache.size >= ClaudeHeartbeat.RESPONSE_CACHE_MAX) {
        const oldest = this.responseCache.keys().next().value;
        if (oldest) this.responseCache.delete(oldest);
      }
      this.responseCache.set(cacheKey, { response: truncated, cachedAt: Date.now() });
    }

    return truncated;
  }

  // -------------------------------------------------------------------------
  // JSONL file lookup
  // -------------------------------------------------------------------------

  /** 세션 맵 → 프로젝트 디렉토리 스캔 순으로 JSONL 경로 탐색 */
  private async findConversationFile(sessionId: string): Promise<string | null> {
    // 1) 세션 맵에서 cwd 기반 경로
    const session = this.sessions.get(sessionId);
    if (session?.cwd) {
      const encodedCwd = session.cwd.replace(/\//g, '-');
      const path = join(this.claudeProjectsDir, encodedCwd, `${sessionId}.jsonl`);
      try { await statFile(path); return path; } catch { /* fall through */ }
    }

    // 2) 프로젝트 디렉토리 스캔 (history.jsonl에만 있는 세션)
    try {
      const dirs = await readdir(this.claudeProjectsDir);
      for (const dir of dirs) {
        const path = join(this.claudeProjectsDir, dir, `${sessionId}.jsonl`);
        try { await statFile(path); return path; } catch { continue; }
      }
    } catch { /* claudeProjectsDir 없음 */ }

    return null;
  }

  // -------------------------------------------------------------------------
  // Hook event handlers (real-time updates from Claude Code hooks)
  // -------------------------------------------------------------------------

  /** Update currentTool from PreToolUse/PostToolUse hook events */
  handleToolEvent(sessionId: string, toolName: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const now = Date.now();
    // PreToolUse means permission was granted → clear waitingForInput
    this.sessions.set(sessionId, {
      ...session,
      currentTool: toolName,
      hooksActive: true,
      lastHeartbeat: now,
      lastFileModified: now,
      ...(toolName ? { waitingForInput: false, status: 'busy' as const } : {}),
    });
  }

  /** Update status from UserPromptSubmit/Stop hook events */
  handleStatusEvent(sessionId: string, status: 'busy' | 'idle'): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const now = Date.now();
    this.sessions.set(sessionId, {
      ...session,
      status,
      hooksActive: true,
      lastHeartbeat: now,
      lastFileModified: now,
      // Clear tool and waitingForInput on idle
      ...(status === 'idle' ? { currentTool: null, waitingForInput: false } : {}),
    });
  }

  /** Update waitingForInput from Notification hook events */
  handleWaitingEvent(sessionId: string, waiting: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const now = Date.now();
    this.sessions.set(sessionId, { ...session, waitingForInput: waiting, hooksActive: true, lastHeartbeat: now, lastFileModified: now });
  }

  /** Update lastPrompt from UserPromptSubmit hook events */
  handlePromptEvent(sessionId: string, prompt: string, timestamp: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const lastPrompt = prompt.length > MAX_PROMPT_LENGTH
      ? prompt.slice(0, MAX_PROMPT_LENGTH)
      : prompt;
    const now = Date.now();
    this.sessions.set(sessionId, {
      ...session,
      status: 'busy',
      lastPrompt,
      lastPromptTime: timestamp,
      waitingForInput: false,
      hooksActive: true,
      lastHeartbeat: now,
      lastFileModified: now,
      // 첫 prompt를 title로 설정 (JSONL 파싱 전에도 즉시 title 확보)
      title: session.title ?? lastPrompt.slice(0, MAX_TITLE_LENGTH),
    });
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

      const rawCwd = String(data['cwd'] ?? '');
      const cwd = (!rawCwd || rawCwd === '.') ? '' : (isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd));

      // Skip background agent sessions (temp directory)
      if (cwd && isTempDir(cwd)) return null;

      // single-pass conversation file parsing
      const encodedCwd = cwd.replace(/\//g, '-');
      const conversationPath = join(
        this.claudeProjectsDir,
        encodedCwd,
        `${sessionId}.jsonl`,
      );
      const parsed = await this.parseConversationFile(conversationPath);
      const status = parsed?.status ?? 'busy';
      const title = parsed?.title ?? null;
      const lastPromptTime = parsed?.lastPromptTime ?? null;
      const lastResponseTime = parsed?.lastResponseTime ?? null;

      // JSONL 파일의 mtime을 실제 활동 시간으로 사용 (lastHeartbeat는 프로세스 생존 확인용)
      let lastFileModified: number;
      try {
        const jsonlStat = await statFile(conversationPath);
        lastFileModified = jsonlStat.mtimeMs;
      } catch {
        // JSONL 파일이 없으면 lastHeartbeat를 폴백으로 사용
        lastFileModified = Number(data['lastHeartbeat'] ?? 0);
      }

      const rawLastPrompt = parsed?.lastPrompt ?? null;
      const lastPrompt = rawLastPrompt ? (extractUserPrompt(rawLastPrompt) ?? null) : null;

      // 프로세스 메트릭: PID 직접 매칭 → CWD 매칭 순
      const pid = Number(data['pid'] ?? 0);
      let processMetrics: ProcessMetrics | null = null;
      if (this.processScanner) {
        processMetrics = pid > 0
          ? this.processScanner.getMetricsByPid(pid)
          : this.processScanner.getMetricsByCwd(cwd, 'claude');
      }

      const info: ClaudeSessionInfo = {
        sessionId,
        pid,
        cwd,
        project: String(data['project'] ?? ''),
        startTime: Number(data['startTime'] ?? 0),
        lastHeartbeat: Number(data['lastHeartbeat'] ?? 0),
        source: 'claude-code',
        status,
        title,
        lastPromptTime,
        lastFileModified,
        lastResponseTime,
        lastPrompt,
        // JSONL re-scan: always reset waitingForInput.
        // If waitingForInput is truly active, the next Notification hook will re-set it.
        // This prevents stale WAITING state after permission grant or crash.
        currentTool: status === 'idle' ? null : (this.sessions.get(sessionId)?.currentTool ?? null),
        waitingForInput: false,
        hooksActive: this.sessions.get(sessionId)?.hooksActive ?? false,
        processMetrics,
      };

      this.sessions.set(info.sessionId, info);
      return info;
    } catch {
      return null;
    }
  }


  // -------------------------------------------------------------------------
  // Single-pass JSONL parsing
  // -------------------------------------------------------------------------

  /** 단일 readFile 호출로 JSONL 파일에서 모든 세션 메타데이터를 추출 */
  private async parseConversationFile(
    filePath: string,
  ): Promise<ConversationData | null> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const lines = content.trimEnd().split('\n');

    // Defaults: 대화 엔트리가 없으면 idle (비-대화 엔트리만 있는 경우 포함)
    let status: 'busy' | 'idle' = 'idle';
    let title: string | null = null;
    let lastPrompt: string | null = null;
    let lastPromptTime: number | null = null;
    let lastResponseTime: number | null = null;

    // Forward scan: find first user message → title, also detect custom-title
    let firstUserTitle: string | null = null;
    let customTitle: string | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        // custom-title: 사용자가 세션 이름을 변경한 경우 (마지막 값 우선)
        if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
          customTitle = entry.customTitle.slice(0, MAX_TITLE_LENGTH).trim();
          continue;
        }
        if (!firstUserTitle && entry.type === 'user') {
          const msg = entry.message as Record<string, unknown> | undefined;
          const msgContent = msg?.content;
          if (typeof msgContent === 'string' && msgContent.trim()) {
            firstUserTitle = msgContent.slice(0, MAX_TITLE_LENGTH).trim();
          } else if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              const p = part as Record<string, unknown>;
              if (
                p.type === 'text' &&
                typeof p.text === 'string' &&
                p.text.trim()
              ) {
                firstUserTitle = (p.text as string).slice(0, MAX_TITLE_LENGTH).trim();
                break;
              }
            }
          }
        }
      } catch {
        continue;
      }
    }
    // custom-title이 있으면 우선, 없으면 첫 user 메시지를 title로
    title = customTitle ?? firstUserTitle;

    // Reverse scan: find last user/assistant → status, timestamps, lastPrompt
    let foundStatus = false;
    let foundLastUser = false;
    let foundLastAssistant = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      if (foundStatus && foundLastUser && foundLastAssistant) break;
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>;

        // Status: 역순으로 첫 번째 대화 엔트리 기준
        // - 비-대화 user (tool_result, 슬래시 명령, 로컬 명령 결과) → skip
        // - interrupt된 assistant (stop_sequence) → idle
        // - tool_use assistant → busy
        // - text-only assistant → idle
        // - real user → busy
        if (!foundStatus) {
          if (entry.type === 'user') {
            if (isNonConversationUser(entry)) {
              // skip — 비-대화 엔트리
            } else {
              status = 'busy';
              foundStatus = true;
            }
          } else if (entry.type === 'assistant') {
            if (isInterruptedAssistant(entry)) {
              status = 'idle';
            } else {
              const msg = entry.message as Record<string, unknown> | undefined;
              const msgContent = msg?.content;
              if (
                Array.isArray(msgContent) &&
                msgContent.some(
                  (c: Record<string, unknown>) => c.type === 'tool_use',
                )
              ) {
                status = 'busy';
              } else {
                status = 'idle';
              }
            }
            foundStatus = true;
          }
        }

        // Last real user entry → lastPromptTime + lastPrompt (tool_result skip)
        if (!foundLastUser && entry.type === 'user' && !isNonConversationUser(entry)) {
          foundLastUser = true;
          const ts = entry.timestamp;
          if (typeof ts === 'string') {
            const ms = new Date(ts).getTime();
            if (!Number.isNaN(ms)) {
              lastPromptTime = ms;
            }
          }
          const msg = entry.message as Record<string, unknown> | undefined;
          const msgContent = msg?.content;
          if (typeof msgContent === 'string' && msgContent.trim()) {
            lastPrompt = msgContent.slice(0, MAX_PROMPT_LENGTH);
          } else if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              const p = part as Record<string, unknown>;
              if (
                p.type === 'text' &&
                typeof p.text === 'string' &&
                p.text.trim()
              ) {
                lastPrompt = (p.text as string).slice(0, MAX_PROMPT_LENGTH);
                break;
              }
            }
          }
        }

        // Last assistant entry → lastResponseTime
        if (!foundLastAssistant && entry.type === 'assistant') {
          foundLastAssistant = true;
          const ts = entry.timestamp;
          if (typeof ts === 'string') {
            const ms = new Date(ts).getTime();
            if (!Number.isNaN(ms)) {
              lastResponseTime = ms;
            }
          }
        }
      } catch {
        continue;
      }
    }

    return { status, title, lastPrompt, lastPromptTime, lastResponseTime };
  }

  // -------------------------------------------------------------------------
  // Status detection
  // -------------------------------------------------------------------------

  private async detectSessionStatus(
    sessionId: string,
    cwd: string,
  ): Promise<'busy' | 'idle'> {
    try {
      // Encode cwd: /Users/john/project/foo → -Users-john-project-foo
      const encodedCwd = cwd.replace(/\//g, '-');
      const conversationPath = join(
        this.claudeProjectsDir,
        encodedCwd,
        `${sessionId}.jsonl`,
      );

      const content = await readFile(conversationPath, 'utf-8');
      const lines = content.trimEnd().split('\n');

      // Scan from end: skip 비-대화 user, interrupt assistant → idle
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === 'user') {
            if (isNonConversationUser(entry)) continue;
            return 'busy';
          }
          if (entry.type === 'assistant') {
            if (isInterruptedAssistant(entry)) return 'idle';
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
      return 'idle'; // 대화 엔트리 없음
    } catch {
      return 'busy'; // 파일 읽기 실패 → 안전하게 busy
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
        // Skip background agent sessions (temp directory)
        const decodedDir = this.decodePath(encodedDir);
        if (isTempDir(decodedDir)) continue;

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

              const parsed = await this.parseConversationFile(filePath);
              const status = parsed?.status ?? 'busy';
              const title = parsed?.title ?? null;
              const rawLastPrompt = parsed?.lastPrompt ?? null;
              const lastPrompt = rawLastPrompt ? (extractUserPrompt(rawLastPrompt) ?? null) : null;
              const lastPromptTime = parsed?.lastPromptTime ?? null;
              const lastResponseTime = parsed?.lastResponseTime ?? null;
              this.sessions.set(sessionId, {
                sessionId,
                pid: 0,
                cwd: decodedDir,
                project: encodedDir,
                startTime: fileStat.birthtimeMs,
                lastHeartbeat: fileStat.mtimeMs,
                source: 'claude-code',
                status,
                title,
                lastPromptTime,
                lastFileModified: fileStat.mtimeMs,
                lastResponseTime,
                lastPrompt,
                currentTool: null,
                waitingForInput: false,
                hooksActive: false,
                processMetrics: this.processScanner?.getMetricsByCwd(decodedDir, 'claude') ?? null,
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
          if (entry.type === 'user') {
            if (isNonConversationUser(entry)) continue;
            return 'busy';
          }
          if (entry.type === 'assistant') {
            if (isInterruptedAssistant(entry)) return 'idle';
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
      return 'idle'; // 대화 엔트리 없음
    } catch {
      return 'busy'; // 파일 읽기 실패 → 안전하게 busy
    }
  }

  /** JSONL 파일에서 첫 번째 user 메시지의 content를 title로 추출 */
  private async extractTitleFromFile(
    filePath: string,
  ): Promise<string | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type === 'user') {
            const msg = entry.message as Record<string, unknown> | undefined;
            const msgContent = msg?.content;
            if (typeof msgContent === 'string' && msgContent.trim()) {
              return msgContent.slice(0, MAX_TITLE_LENGTH).trim();
            }
            if (Array.isArray(msgContent)) {
              for (const part of msgContent) {
                const p = part as Record<string, unknown>;
                if (
                  p.type === 'text' &&
                  typeof p.text === 'string' &&
                  p.text.trim()
                ) {
                  return (p.text as string).slice(0, MAX_TITLE_LENGTH).trim();
                }
              }
            }
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** JSONL 파일에서 마지막 user 엔트리의 timestamp를 ms로 추출 */
  private async extractLastPromptTimeFromFile(
    filePath: string,
  ): Promise<number | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === 'user') {
            const ts = entry.timestamp;
            if (typeof ts !== 'string') return null;
            const ms = new Date(ts).getTime();
            if (Number.isNaN(ms)) return null;
            return ms;
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** JSONL 파일에서 마지막 assistant 엔트리의 timestamp를 ms로 추출 */
  private async extractLastResponseTimeFromFile(
    filePath: string,
  ): Promise<number | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === 'assistant') {
            const ts = entry.timestamp;
            if (typeof ts !== 'string') return null;
            const ms = new Date(ts).getTime();
            if (Number.isNaN(ms)) return null;
            return ms;
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * -Users-sbbae-project-session-dashboard → /Users/sbbae/project/session-dashboard
   *
   * Claude encodes paths by replacing / with -.
   * Path segments themselves may contain hyphens (e.g. "session-dashboard").
   * DFS: at each `-`, try treating it as `/` or as literal `-`, with filesystem pruning.
   */
  private decodePathCache = new Map<string, string>();

  private decodePath(encodedDir: string): string {
    const cached = this.decodePathCache.get(encodedDir);
    if (cached) return cached;

    const raw = encodedDir.startsWith('-') ? encodedDir.slice(1) : encodedDir;
    const dashes = this.findDashPositions(raw);
    const result = this.decodePathDfs(raw, dashes, 0, '') ?? ('/' + raw.replace(/-/g, '/'));
    this.decodePathCache.set(encodedDir, result);
    return result;
  }

  private findDashPositions(s: string): number[] {
    const positions: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '-') positions.push(i);
    }
    return positions;
  }

  /**
   * At each dash position, choose `/` or `-`.
   * `dirEnd` tracks where the last `/` was placed, so we know the current directory prefix for pruning.
   */
  private decodePathDfs(raw: string, dashes: number[], dashIdx: number, dirPrefix: string): string | null {
    if (dashIdx >= dashes.length) {
      // No more dashes — the remaining chars form the last segment
      const finalPath = dirPrefix + '/' + raw;
      try { statSync(finalPath); return finalPath; } catch { return null; }
    }

    const pos = dashes[dashIdx];

    // Option 1: treat dash at `pos` as `/`
    // dirPrefix + '/' + raw[0..pos-1] becomes the new directory
    const segment = raw.slice(0, pos);
    const newDir = dirPrefix + '/' + segment;
    const remaining = raw.slice(pos + 1);
    if (this.isDirSafe(newDir)) {
      const newDashes = this.findDashPositions(remaining);
      const r1 = this.decodePathDfs(remaining, newDashes, 0, newDir);
      if (r1) return r1;
    }

    // Option 2: treat dash at `pos` as literal `-`, try next dash
    return this.decodePathDfs(raw, dashes, dashIdx + 1, dirPrefix);
  }

  private isDirCache = new Map<string, boolean>();

  private isDirSafe(p: string): boolean {
    const cached = this.isDirCache.get(p);
    if (cached !== undefined) return cached;
    try {
      const result = statSync(p).isDirectory();
      this.isDirCache.set(p, result);
      return result;
    } catch {
      this.isDirCache.set(p, false);
      return false;
    }
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

  private isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EPERM') return true;
      return false;
    }
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [sessionId, info] of this.sessions) {
      // PID alive 세션은 TTL 무시 — 절대 evict 안 함
      if (this.isProcessAlive(info.pid)) continue;

      // PID dead (또는 pid=0) + 최근 활동 없음 → evict
      const lastActivity = Math.max(info.lastHeartbeat, info.lastFileModified);
      if (now - lastActivity > STALE_TTL_MS) {
        this.sessions.delete(sessionId);
      }
    }
}
}
