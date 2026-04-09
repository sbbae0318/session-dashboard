/**
 * Summary Engine — Python DSPy CLI spawn + Haiku CLI fallback
 *
 * 요약 생성: python -m src (stdin JSON → stdout JSON)
 * Python 실패 시 기존 Haiku CLI spawn으로 fallback.
 * 읽기(getLatest/getHistory)는 로컬 SQLite.
 */

import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

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

export interface SummaryEngineOpts {
  threshold?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PYTHON_DIR = join(__dirname, '..', 'python');
const PYTHON_VENV = join(PYTHON_DIR, '.venv', 'bin', 'python3');
const PYTHON_TIMEOUT_MS = 90_000;
const HAIKU_TIMEOUT_MS = 60_000;
const DEFAULT_THRESHOLD = 5;

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

  constructor(db: Database.Database, opts?: SummaryEngineOpts) {
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
        FROM prompt_history WHERE session_title IS NOT NULL
      ) ph ON ph.session_id = ss.session_id AND ph.rn = 1
      WHERE ss.id IN (SELECT MAX(id) FROM session_summaries GROUP BY session_id)
      ORDER BY ss.generated_at DESC
    `);
  }

  // ── Read (로컬 SQLite) ──

  getLatest(sessionId: string): SessionSummary | null {
    const row = this.stmtGetLatest.get(sessionId) as SummaryRow | undefined;
    return row ? rowToSummary(row) : null;
  }

  getHistory(sessionId: string): SessionSummary[] {
    return (this.stmtGetHistory.all(sessionId) as SummaryRow[]).map(rowToSummary);
  }

  getAllLatest(): Array<SessionSummary & { sessionTitle?: string }> {
    return (this.stmtGetAll.all() as Array<SummaryRow & { session_title?: string }>).map(r => ({
      ...rowToSummary(r),
      sessionTitle: r.session_title ?? undefined,
    }));
  }

  // ── Write (async, fire-and-forget) ──

  /**
   * 마지막 요약 이후 threshold 이상 새 프롬프트가 있으면 async 생성.
   * doCollection()에서 호출 — void로 fire-and-forget.
   */
  async checkAndGenerate(
    sessionId: string,
    allPrompts: SummaryPrompt[],
    opts?: { toolNames?: string[]; sessionTitle?: string },
  ): Promise<boolean> {
    if (this.generating.has(sessionId)) return false;

    const latest = this.getLatest(sessionId);
    const newCount = allPrompts.length - (latest?.promptCount ?? 0);
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
      const latest = this.getLatest(sessionId);
      const newPrompts = latest ? allPrompts.slice(latest.promptCount) : allPrompts;
      if (newPrompts.length === 0 && latest) return latest;

      // 1차: Python DSPy CLI
      const pyResult = await this.spawnPython(sessionId, newPrompts, allPrompts.length, opts);
      if (pyResult) return pyResult;

      // 2차: Haiku CLI fallback
      console.log(`[summary-engine] Python failed, Haiku fallback for ${sessionId.slice(0, 8)}`);
      return await this.spawnHaiku(sessionId, allPrompts, newPrompts, latest, opts);
    } finally {
      this.generating.delete(sessionId);
    }
  }

  // ── Python DSPy CLI spawn ──

  private spawnPython(
    sessionId: string,
    newPrompts: SummaryPrompt[],
    totalCount: number,
    opts?: { toolNames?: string[]; sessionTitle?: string },
  ): Promise<SessionSummary | null> {
    const input = JSON.stringify({
      session_id: sessionId,
      session_title: opts?.sessionTitle ?? null,
      new_prompts: newPrompts.map(p => ({ timestamp: p.timestamp, query: p.query })),
      total_prompt_count: totalCount,
      tool_names: opts?.toolNames ?? [],
    });

    return new Promise((resolve) => {
      try {
        const child = spawn(PYTHON_VENV, ['-m', 'src'], {
          cwd: PYTHON_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: PYTHON_TIMEOUT_MS,
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c; });
        child.stderr.on('data', (c: Buffer) => { stderr += c; });

        child.on('close', (code) => {
          if (code !== 0) {
            console.error(`[summary-engine] Python exited ${code}: ${stderr.slice(0, 300)}`);
            resolve(null);
            return;
          }

          try {
            const data = JSON.parse(stdout) as Record<string, unknown>;
            if (data.error || !data.summary) {
              console.error(`[summary-engine] Python error: ${data.error ?? 'no summary'}`);
              resolve(null);
              return;
            }

            const version = data.version as number;
            const promptCount = data.prompt_count as number;
            const generatedAt = data.generated_at as number;
            const summary = data.summary as string;

            // Node DB에 미러링
            this.stmtInsert.run(sessionId, summary, promptCount, version, generatedAt);
            console.log(`[summary-engine] v${version} via Python for ${sessionId.slice(0, 8)}`);

            resolve({ sessionId, summary, promptCount, version, generatedAt });
          } catch (e) {
            console.error(`[summary-engine] Python output parse failed: ${stdout.slice(0, 200)}`);
            resolve(null);
          }
        });

        child.on('error', (err) => {
          console.error(`[summary-engine] Python spawn error: ${err.message}`);
          resolve(null);
        });

        child.stdin.write(input);
        child.stdin.end();
      } catch (err) {
        console.error(`[summary-engine] Python spawn failed:`, err);
        resolve(null);
      }
    });
  }

  // ── Haiku CLI fallback ──

  private async spawnHaiku(
    sessionId: string,
    allPrompts: SummaryPrompt[],
    newPrompts: SummaryPrompt[],
    latest: SessionSummary | null,
    opts?: { toolNames?: string[]; sessionTitle?: string },
  ): Promise<SessionSummary | null> {
    const promptText = latest
      ? buildAdditivePrompt(latest.summary, newPrompts, opts?.toolNames)
      : buildInitialPrompt(opts?.sessionTitle ?? sessionId.slice(0, 12), allPrompts, opts?.toolNames);

    const summary = await callHaiku(promptText);
    if (!summary) return null;

    const version = (latest?.version ?? 0) + 1;
    const now = Date.now();
    this.stmtInsert.run(sessionId, summary, allPrompts.length, version, now);

    return { sessionId, summary, promptCount: allPrompts.length, version, generatedAt: now };
  }
}

// ---------------------------------------------------------------------------
// Haiku CLI helpers (fallback)
// ---------------------------------------------------------------------------

function formatPrompts(prompts: SummaryPrompt[]): string {
  return prompts.map(p => {
    const d = new Date(p.timestamp);
    return `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}] "${p.query}"`;
  }).join('\n');
}

function buildInitialPrompt(title: string, prompts: SummaryPrompt[], toolNames?: string[]): string {
  const tools = toolNames?.length ? `\n사용된 도구: ${toolNames.join(', ')}\n` : '';
  return `다음은 코딩 세션의 사용자 프롬프트 목록입니다. 아래 형식으로 요약하세요.

출력 형식:
첫 줄: 세션 목적 한 문장
이후: • 작업 → 결과(성공/실패/진행중) 불렛 (최대 5개)

세션: ${title}
프롬프트 (${prompts.length}개):
${formatPrompts(prompts)}
${tools}`;
}

function buildAdditivePrompt(prev: string, newPrompts: SummaryPrompt[], toolNames?: string[]): string {
  const tools = toolNames?.length ? `사용된 도구: ${toolNames.join(', ')}\n` : '';
  const first = new Date(newPrompts[0].timestamp);
  const last = new Date(newPrompts[newPrompts.length - 1].timestamp);
  const range = `${fmt(first)}~${fmt(last)}`;

  return `기존 요약에 새 활동 불렛만 추가하세요.

[기존 요약]
${prev}

[새 활동 — ${newPrompts.length}건, ${range}]
${formatPrompts(newPrompts)}
${tools}
새 불렛만 추가 (기존 유지, 최대 3개 추가):`;
}

function fmt(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function callHaiku(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn('claude', ['-p', '--model', 'claude-haiku-4-5', '--no-session-persistence'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: HAIKU_TIMEOUT_MS,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => { stdout += c; });
      child.stderr.on('data', (c: Buffer) => { stderr += c; });
      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else { console.error(`[summary-engine] Haiku exited ${code}: ${stderr.slice(0, 200)}`); resolve(null); }
      });
      child.on('error', (err) => { console.error('[summary-engine] Haiku error:', err.message); resolve(null); });
      child.stdin.write(prompt);
      child.stdin.end();
    } catch { resolve(null); }
  });
}

// ---------------------------------------------------------------------------
// DB row mapping
// ---------------------------------------------------------------------------

interface SummaryRow {
  id: number; session_id: string; summary: string;
  prompt_count: number; version: number; generated_at: number;
}

function rowToSummary(row: SummaryRow): SessionSummary {
  return {
    sessionId: row.session_id, summary: row.summary,
    promptCount: row.prompt_count, version: row.version, generatedAt: row.generated_at,
  };
}
