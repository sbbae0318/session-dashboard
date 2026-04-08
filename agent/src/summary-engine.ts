/**
 * Progressive Session Summary Engine
 *
 * 세션 프롬프트가 threshold만큼 쌓이면 additive 요약을 자동 생성.
 * 기존 요약 + 새 활동 → 누적 요약 (meta-prompt 패턴).
 * SQLite에 버전별 히스토리 영구 저장.
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
  }

  /** 특정 세션의 최신 요약. */
  getLatest(sessionId: string): SessionSummary | null {
    const row = this.stmtGetLatest.get(sessionId) as SummaryRow | undefined;
    return row ? rowToSummary(row) : null;
  }

  /** 특정 세션의 요약 히스토리 (version 순). */
  getHistory(sessionId: string): SessionSummary[] {
    const rows = this.stmtGetHistory.all(sessionId) as SummaryRow[];
    return rows.map(rowToSummary);
  }

  /** 모든 세션의 최신 요약 목록. */
  getAllLatest(): Array<SessionSummary & { sessionTitle?: string }> {
    const rows = this.stmtGetAll.all() as Array<SummaryRow & { session_title?: string }>;
    return rows.map(r => ({
      ...rowToSummary(r),
      sessionTitle: r.session_title ?? undefined,
    }));
  }

  /**
   * threshold 체크 후 필요 시 요약 생성 (fire-and-forget용).
   * @returns 생성되었으면 true
   */
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

  /**
   * 요약 강제 생성 (수동 버튼 / threshold 도달).
   */
  async generate(
    sessionId: string,
    allPrompts: SummaryPrompt[],
    opts?: { toolNames?: string[]; sessionTitle?: string },
  ): Promise<SessionSummary | null> {
    if (this.generating.has(sessionId)) return null;
    if (allPrompts.length === 0) return null;
    this.generating.add(sessionId);

    try {
      const latest = this.getLatest(sessionId);
      const newPrompts = latest
        ? allPrompts.slice(latest.promptCount)
        : allPrompts;

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

      const result: SessionSummary = {
        sessionId,
        summary,
        promptCount: allPrompts.length,
        version,
        generatedAt: now,
      };

      console.log(`[summary-engine] v${version} generated for ${sessionId.slice(0, 8)} (${allPrompts.length} prompts)`);
      return result;
    } finally {
      this.generating.delete(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
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

function buildInitialPrompt(
  title: string,
  prompts: SummaryPrompt[],
  toolNames?: string[],
): string {
  return `다음은 코딩 세션의 사용자 프롬프트 목록입니다. 아래 형식으로 요약하세요.

출력 형식 (반드시 준수):
첫 줄: 이 세션이 무엇을 하는 세션인지 한 문장 (예: "대시보드 정렬 로직을 개선하는 세션")
이후: 불렛 포인트로 주요 활동 요약 (각 항목은 결과 포함)
  • A를 시도 → 성공
  • B를 수정 → 빌드 실패로 롤백
  • C 계획 중

규칙:
- 한국어로 작성
- 불렛은 최대 5개. 사소한 것 제외, 핵심만.
- 각 불렛에 성공/실패/진행중 결과를 명시
- 불렛 기호는 "• " 사용

세션: ${title}
프롬프트 (${prompts.length}개):
${formatPrompts(prompts)}
${toolsLine(toolNames)}`;
}

function buildAdditivePrompt(
  prevSummary: string,
  newPrompts: SummaryPrompt[],
  toolNames?: string[],
): string {
  const first = new Date(newPrompts[0].timestamp);
  const last = new Date(newPrompts[newPrompts.length - 1].timestamp);
  const hh1 = String(first.getHours()).padStart(2, '0');
  const mm1 = String(first.getMinutes()).padStart(2, '0');
  const hh2 = String(last.getHours()).padStart(2, '0');
  const mm2 = String(last.getMinutes()).padStart(2, '0');
  const timeRange = `${hh1}:${mm1}~${hh2}:${mm2}`;

  return `기존 요약에 새 활동을 추가하세요. 형식을 반드시 유지하세요.

출력 형식 (반드시 준수):
첫 줄: 세션 한줄 설명 (기존 유지 또는 범위 확장 시 갱신)
이후: 불렛 포인트 (기존 + 새 활동 병합)
  • 기존 활동은 유지
  • 새 활동을 아래에 추가
  • 너무 많으면 오래된 사소한 항목 병합

규칙:
- 한국어로 작성
- 불렛은 최대 8개. 핵심만.
- 각 불렛에 성공/실패/진행중 결과를 명시
- 불렛 기호는 "• " 사용

[기존 요약]
${prevSummary}

[새 활동 — ${newPrompts.length}건, ${timeRange}]
${formatPrompts(newPrompts)}
${toolsLine(toolNames)}
갱신된 요약:`;
}

// ---------------------------------------------------------------------------
// Haiku call
// ---------------------------------------------------------------------------

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
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          console.error(`[summary-engine] claude -p exited ${code}: ${stderr.slice(0, 200)}`);
          resolve(null);
        }
      });

      child.on('error', (err) => {
        console.error('[summary-engine] spawn error:', err.message);
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
