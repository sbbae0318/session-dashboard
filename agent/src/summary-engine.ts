/**
 * Summary Engine — Python DSPy sidecar 클라이언트
 *
 * 요약 생성은 Python 서비스(port 3099)에 HTTP로 위임.
 * 읽기(getLatest/getHistory)는 로컬 SQLite에서 직접 조회.
 * Python 서비스 다운 시 기존 Haiku CLI spawn으로 fallback.
 */

import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: string;
  summary: string;
  promptCount: number;
  version: number;
  generatedAt: number;
}

export interface SummaryPrompt {
  timestamp: number;
  query: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 5;
const PYTHON_SERVICE_URL = 'http://127.0.0.1:3099';
const PYTHON_TIMEOUT_MS = 30_000;
const HAIKU_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// SummaryEngine
// ---------------------------------------------------------------------------

export class SummaryEngine {
  private readonly db: Database.Database;
  private readonly threshold: number;
  private readonly stmtInsert: Statement;
  private readonly stmtGetLatest: Statement;
  private readonly stmtGetHistory: Statement;
  private readonly stmtGetAll: Statement;
  private readonly generating = new Set<string>();
  private pythonAvailable: boolean | null = null;  // null = 미확인

  constructor(db: Database.Database, opts?: { threshold?: number }) {
    this.db = db;
    this.threshold = opts?.threshold ?? DEFAULT_THRESHOLD;

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL,
        summary      TEXT NOT NULL,
        prompt_count INTEGER NOT NULL,
        version      INTEGER NOT NULL DEFAULT 1,
        generated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ss_session
      ON session_summaries(session_id, version DESC)
    `);

    this.stmtInsert = db.prepare(`
      INSERT INTO session_summaries (session_id, summary, prompt_count, version, generated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtGetLatest = db.prepare(
      'SELECT * FROM session_summaries WHERE session_id = ? ORDER BY version DESC LIMIT 1',
    );

    this.stmtGetHistory = db.prepare(
      'SELECT * FROM session_summaries WHERE session_id = ? ORDER BY version ASC',
    );

    this.stmtGetAll = db.prepare(`
      SELECT ss.*, ph.session_title
      FROM session_summaries ss
      LEFT JOIN (
        SELECT session_id, session_title,
               ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp DESC) AS rn
        FROM prompt_history
        WHERE session_title IS NOT NULL
      ) ph ON ph.session_id = ss.session_id AND ph.rn = 1
      WHERE ss.id IN (
        SELECT MAX(id) FROM session_summaries GROUP BY session_id
      )
      ORDER BY ss.generated_at DESC
    `);

    // Python 서비스 가용성 체크 (non-blocking)
    void this.checkPythonService();
  }

  // ── Read (로컬 SQLite) ──

  getLatest(sessionId: string): SessionSummary | null {
    const row = this.stmtGetLatest.get(sessionId) as SummaryRow | undefined;
    return row ? rowToSummary(row) : null;
  }

  getHistory(sessionId: string): SessionSummary[] {
    const rows = this.stmtGetHistory.all(sessionId) as SummaryRow[];
    return rows.map(rowToSummary);
  }

  getAllLatest(): Array<SessionSummary & { sessionTitle?: string }> {
    const rows = this.stmtGetAll.all() as Array<SummaryRow & { session_title?: string }>;
    return rows.map(r => ({
      ...rowToSummary(r),
      sessionTitle: r.session_title ?? undefined,
    }));
  }

  // ── Write (Python sidecar → fallback to Haiku CLI) ──

  async checkAndGenerate(
    sessionId: string,
    allPrompts: SummaryPrompt[],
    opts?: { toolNames?: string[]; sessionTitle?: string },
  ): Promise<boolean> {
    if (this.generating.has(sessionId)) return false;

    const latest = this.getLatest(sessionId);
    const lastCount = latest?.promptCount ?? 0;
    const newCount = allPrompts.length - lastCount;

    if (newCount < this.threshold) return false;

    const result = await this.generate(sessionId, allPrompts, opts);
    return result !== null;
  }

  async generate(
    sessionId: string,
    allPrompts: SummaryPrompt[],
    opts?: { toolNames?: string[]; sessionTitle?: string },
  ): Promise<SessionSummary | null> {
    if (this.generating.has(sessionId)) return null;
    if (allPrompts.length === 0) return null;
    this.generating.add(sessionId);

    try {
      // Python 사이드카 시도
      if (this.pythonAvailable !== false) {
        const result = await this.generateViaPython(sessionId, allPrompts, opts);
        if (result) return result;
      }

      // Fallback: 기존 Haiku CLI
      console.log(`[summary-engine] Python unavailable, falling back to Haiku CLI for ${sessionId.slice(0, 8)}`);
      return await this.generateViaHaiku(sessionId, allPrompts, opts);
    } finally {
      this.generating.delete(sessionId);
    }
  }

  // ── Python sidecar 호출 ──

  private async generateViaPython(
    sessionId: string,
    allPrompts: SummaryPrompt[],
    opts?: { toolNames?: string[]; sessionTitle?: string },
  ): Promise<SessionSummary | null> {
    try {
      const latest = this.getLatest(sessionId);
      // Delta만 전송: 마지막 요약 이후 프롬프트만
      const newPrompts = latest
        ? allPrompts.slice(latest.promptCount)
        : allPrompts;

      if (newPrompts.length === 0 && latest) return latest;

      const body = JSON.stringify({
        session_id: sessionId,
        session_title: opts?.sessionTitle ?? null,
        new_prompts: newPrompts.map(p => ({ timestamp: p.timestamp, query: p.query })),
        total_prompt_count: allPrompts.length,
        tool_names: opts?.toolNames ?? [],
        force: true,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PYTHON_TIMEOUT_MS);

      const res = await fetch(`${PYTHON_SERVICE_URL}/api/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.error(`[summary-engine] Python service returned ${res.status}`);
        this.pythonAvailable = false;
        return null;
      }

      const data = await res.json() as {
        session_id: string;
        summary: string;
        version: number;
        prompt_count: number;
        generated_at: number;
      };

      if (!data.summary) return null;

      this.pythonAvailable = true;

      // Python 서비스가 자체 DB에 저장하므로, Node 측 DB에도 미러링
      this.stmtInsert.run(
        sessionId, data.summary, data.prompt_count, data.version, data.generated_at,
      );

      console.log(`[summary-engine] v${data.version} via Python for ${sessionId.slice(0, 8)}`);

      return {
        sessionId,
        summary: data.summary,
        promptCount: data.prompt_count,
        version: data.version,
        generatedAt: data.generated_at,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('ECONNREFUSED')) {
        this.pythonAvailable = false;
      }
      console.error(`[summary-engine] Python call failed: ${msg}`);
      return null;
    }
  }

  // ── Haiku CLI fallback ──

  private async generateViaHaiku(
    sessionId: string,
    allPrompts: SummaryPrompt[],
    opts?: { toolNames?: string[]; sessionTitle?: string },
  ): Promise<SessionSummary | null> {
    const latest = this.getLatest(sessionId);
    const newPrompts = latest ? allPrompts.slice(latest.promptCount) : allPrompts;

    if (newPrompts.length === 0 && latest) return latest;

    const promptText = latest
      ? buildAdditivePrompt(latest.summary, newPrompts, opts?.toolNames)
      : buildInitialPrompt(
          opts?.sessionTitle ?? sessionId.slice(0, 12),
          allPrompts,
          opts?.toolNames,
        );

    const summary = await callHaiku(promptText);
    if (!summary) return null;

    const version = (latest?.version ?? 0) + 1;
    const now = Date.now();

    this.stmtInsert.run(sessionId, summary, allPrompts.length, version, now);

    return {
      sessionId,
      summary,
      promptCount: allPrompts.length,
      version,
      generatedAt: now,
    };
  }

  // ── Python 서비스 가용성 체크 ──

  private async checkPythonService(): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const res = await fetch(`${PYTHON_SERVICE_URL}/health`, { signal: controller.signal });
      clearTimeout(timer);
      this.pythonAvailable = res.ok;
      console.log(`[summary-engine] Python service: ${this.pythonAvailable ? 'available' : 'unavailable'}`);
    } catch {
      this.pythonAvailable = false;
      console.log('[summary-engine] Python service: unavailable (fallback to Haiku CLI)');
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback: Haiku CLI prompt builders (기존 유지)
// ---------------------------------------------------------------------------

function formatPrompts(prompts: SummaryPrompt[]): string {
  return prompts.map(p => {
    const d = new Date(p.timestamp);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `[${hh}:${mm}] "${p.query}"`;
  }).join('\n');
}

function toolsLine(toolNames?: string[]): string {
  if (!toolNames?.length) return '';
  return `\n사용된 도구: ${toolNames.join(', ')}\n`;
}

function buildInitialPrompt(title: string, prompts: SummaryPrompt[], toolNames?: string[]): string {
  return `다음은 코딩 세션의 사용자 프롬프트 목록입니다. 아래 형식으로 요약하세요.

출력 형식 (반드시 준수):
첫 줄: 이 세션이 무엇을 하는 세션인지 한 문장
이후: 불렛 포인트로 주요 활동 요약 (각 항목은 결과 포함)
  • A를 시도 → 성공
  • B를 수정 → 빌드 실패로 롤백

규칙:
- 한국어로 작성
- 불렛은 최대 5개. 핵심만.
- 각 불렛에 성공/실패/진행중 결과를 명시
- 불렛 기호는 "• " 사용

세션: ${title}
프롬프트 (${prompts.length}개):
${formatPrompts(prompts)}
${toolsLine(toolNames)}`;
}

function buildAdditivePrompt(prev: string, newPrompts: SummaryPrompt[], toolNames?: string[]): string {
  const first = new Date(newPrompts[0].timestamp);
  const last = new Date(newPrompts[newPrompts.length - 1].timestamp);
  const timeRange = `${fmt(first)}~${fmt(last)}`;

  return `기존 요약에 새 활동을 추가하세요. 형식을 반드시 유지하세요.

출력 형식:
첫 줄: 세션 한줄 설명 (기존 유지 또는 범위 확장 시 갱신)
이후: 불렛 포인트 (기존 + 새 활동 병합, 최대 8개)

규칙:
- 한국어, "• " 불렛, 성공/실패/진행중 명시

[기존 요약]
${prev}

[새 활동 — ${newPrompts.length}건, ${timeRange}]
${formatPrompts(newPrompts)}
${toolsLine(toolNames)}
갱신된 요약:`;
}

function fmt(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function callHaiku(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(
        'claude',
        ['-p', '--model', 'claude-haiku-4-5', '--no-session-persistence'],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: HAIKU_TIMEOUT_MS },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else {
          console.error(`[summary-engine] Haiku exited ${code}: ${stderr.slice(0, 200)}`);
          resolve(null);
        }
      });
      child.on('error', (err) => {
        console.error('[summary-engine] Haiku spawn error:', err.message);
        resolve(null);
      });
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      console.error('[summary-engine] callHaiku failed:', err);
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// DB row mapping
// ---------------------------------------------------------------------------

interface SummaryRow {
  id: number;
  session_id: string;
  summary: string;
  prompt_count: number;
  version: number;
  generated_at: number;
}

function rowToSummary(row: SummaryRow): SessionSummary {
  return {
    sessionId: row.session_id,
    summary: row.summary,
    promptCount: row.prompt_count,
    version: row.version,
    generatedAt: row.generated_at,
  };
}
