import Database from 'better-sqlite3';
import type {
  TurnSummaryPayload,
  PromptTurnSummary,
  PromptAuditResponse,
  ToolInvocationEntry,
  SubagentRunEntry,
} from '../../shared/api-contract.js';

const TRUNCATE_LEN = 120;

function trunc(s: string | null | undefined, len = TRUNCATE_LEN): string | null {
  if (s == null) return null;
  return s.length > len ? s.slice(0, len) : s;
}

export class AuditDB {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initPragmas();
    this.initSchema();
  }

  private initPragmas(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -32000');
    this.db.pragma('temp_store = MEMORY');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_session (
        session_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'claude-code',
        cwd TEXT,
        slug TEXT,
        git_branch TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        title TEXT,
        total_turns INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session_machine ON audit_session(machine_id);

      CREATE TABLE IF NOT EXISTS prompt_turn (
        prompt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES audit_session(session_id),
        seq INTEGER NOT NULL,
        user_text TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        tool_count INTEGER DEFAULT 0,
        subagent_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'running'
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_turn_session ON prompt_turn(session_id, seq);

      CREATE TABLE IF NOT EXISTS tool_invocation (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES prompt_turn(prompt_id),
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_subname TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        input_summary TEXT,
        result_summary TEXT,
        error INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tool_inv_prompt ON tool_invocation(prompt_id, started_at);

      CREATE TABLE IF NOT EXISTS subagent_run (
        agent_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL REFERENCES prompt_turn(prompt_id),
        parent_tool_use_id TEXT,
        agent_type TEXT,
        description TEXT,
        form TEXT NOT NULL DEFAULT 'file',
        storage_ref TEXT,
        cwd TEXT,
        model TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        message_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        PRIMARY KEY (session_id, agent_key)
      );
      CREATE INDEX IF NOT EXISTS idx_subagent_prompt ON subagent_run(prompt_id);
    `);
  }

  upsertTurnSummary(payload: TurnSummaryPayload, machineId: string): void {
    const { sessionId, slug, gitBranch, cwd, turn } = payload;
    const now = Date.now();
    const status = turn.endedAt != null ? 'done' : 'running';
    const toolCount = turn.tools.length;
    const subagentCount = turn.subagents.length;

    const doUpsert = this.db.transaction(() => {
      // 1. UPSERT audit_session
      this.db.prepare(`
        INSERT INTO audit_session
          (session_id, machine_id, cwd, slug, git_branch, first_seen_at, last_seen_at)
        VALUES
          (:sessionId, :machineId, :cwd, :slug, :gitBranch, :now, :now)
        ON CONFLICT (session_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          slug = COALESCE(excluded.slug, audit_session.slug),
          git_branch = COALESCE(excluded.git_branch, audit_session.git_branch),
          cwd = COALESCE(excluded.cwd, audit_session.cwd)
      `).run({
        sessionId,
        machineId,
        cwd: cwd ?? null,
        slug: slug ?? null,
        gitBranch: gitBranch ?? null,
        now,
      });

      // 2. UPSERT prompt_turn
      this.db.prepare(`
        INSERT INTO prompt_turn
          (prompt_id, session_id, seq, user_text, started_at, ended_at,
           tool_count, subagent_count, input_tokens, output_tokens, model, status)
        VALUES
          (:promptId, :sessionId, :seq, :userText, :startedAt, :endedAt,
           :toolCount, :subagentCount, :inputTokens, :outputTokens, :model, :status)
        ON CONFLICT (prompt_id) DO UPDATE SET
          ended_at = excluded.ended_at,
          tool_count = excluded.tool_count,
          subagent_count = excluded.subagent_count,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          model = excluded.model,
          status = excluded.status
      `).run({
        promptId: turn.promptId,
        sessionId,
        seq: turn.seq,
        userText: trunc(turn.userText),
        startedAt: turn.startedAt,
        endedAt: turn.endedAt ?? null,
        toolCount,
        subagentCount,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        model: turn.model ?? null,
        status,
      });

      // 3. DELETE + INSERT tool_invocation
      this.db.prepare('DELETE FROM tool_invocation WHERE prompt_id = ?').run(turn.promptId);

      if (turn.tools.length > 0) {
        const insertTool = this.db.prepare(`
          INSERT INTO tool_invocation
            (id, prompt_id, session_id, tool_name, tool_subname, started_at, ended_at,
             input_summary, result_summary, error)
          VALUES
            (:id, :promptId, :sessionId, :toolName, :toolSubname, :startedAt, :endedAt,
             :inputSummary, :resultSummary, :error)
        `);
        for (const tool of turn.tools) {
          insertTool.run({
            id: tool.id,
            promptId: turn.promptId,
            sessionId,
            toolName: tool.toolName,
            toolSubname: tool.toolSubname ?? null,
            startedAt: tool.startedAt,
            endedAt: tool.endedAt ?? null,
            inputSummary: trunc(tool.inputSummary),
            resultSummary: trunc(tool.resultSummary),
            error: tool.error ? 1 : 0,
          });
        }
      }

      // 4. DELETE + INSERT subagent_run
      this.db.prepare('DELETE FROM subagent_run WHERE prompt_id = ?').run(turn.promptId);

      if (turn.subagents.length > 0) {
        const insertSubagent = this.db.prepare(`
          INSERT INTO subagent_run
            (agent_key, session_id, prompt_id, parent_tool_use_id, agent_type, description,
             form, storage_ref, cwd, model, started_at, ended_at,
             message_count, input_tokens, output_tokens)
          VALUES
            (:agentKey, :sessionId, :promptId, :parentToolUseId, :agentType, :description,
             'file', :storageRef, :cwd, :model, :startedAt, :endedAt,
             :messageCount, :inputTokens, :outputTokens)
          ON CONFLICT (session_id, agent_key) DO UPDATE SET
            prompt_id = excluded.prompt_id,
            parent_tool_use_id = excluded.parent_tool_use_id,
            agent_type = excluded.agent_type,
            description = excluded.description,
            storage_ref = excluded.storage_ref,
            cwd = excluded.cwd,
            model = excluded.model,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            message_count = excluded.message_count,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens
        `);
        for (const agent of turn.subagents) {
          insertSubagent.run({
            agentKey: agent.agentKey,
            sessionId,
            promptId: turn.promptId,
            parentToolUseId: agent.parentToolUseId ?? null,
            agentType: agent.agentType ?? null,
            description: agent.description ?? null,
            storageRef: `subagents/agent-${agent.agentKey}.jsonl`,
            cwd: agent.cwd ?? null,
            model: agent.model ?? null,
            startedAt: agent.startedAt,
            endedAt: agent.endedAt ?? null,
            messageCount: agent.messageCount,
            inputTokens: agent.inputTokens,
            outputTokens: agent.outputTokens,
          });
        }
      }

      // 5. Update denormalized counters on audit_session
      const counts = this.db.prepare(`
        SELECT COUNT(*) as total_turns,
               COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
        FROM prompt_turn WHERE session_id = ?
      `).get(sessionId) as { total_turns: number; total_tokens: number };

      this.db.prepare(`
        UPDATE audit_session
        SET total_turns = :totalTurns, total_tokens = :totalTokens
        WHERE session_id = :sessionId
      `).run({
        totalTurns: counts.total_turns,
        totalTokens: counts.total_tokens,
        sessionId,
      });
    });

    doUpsert();
  }

  getSessionTurns(sessionId: string): PromptTurnSummary[] {
    const rows = this.db.prepare(`
      SELECT prompt_id, seq, user_text, started_at, ended_at,
             tool_count, subagent_count, input_tokens, output_tokens, model, status
      FROM prompt_turn
      WHERE session_id = ?
      ORDER BY seq ASC
    `).all(sessionId) as Array<{
      prompt_id: string;
      seq: number;
      user_text: string | null;
      started_at: number;
      ended_at: number | null;
      tool_count: number;
      subagent_count: number;
      input_tokens: number;
      output_tokens: number;
      model: string | null;
      status: string;
    }>;

    return rows.map((r) => ({
      promptId: r.prompt_id,
      seq: r.seq,
      userText: r.user_text,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      toolCount: r.tool_count,
      subagentCount: r.subagent_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      model: r.model,
      status: r.status as PromptTurnSummary['status'],
    }));
  }

  getPromptAudit(promptId: string): PromptAuditResponse | null {
    const turnRow = this.db.prepare(`
      SELECT prompt_id, seq, user_text, started_at, ended_at,
             tool_count, subagent_count, input_tokens, output_tokens, model, status
      FROM prompt_turn WHERE prompt_id = ?
    `).get(promptId) as {
      prompt_id: string;
      seq: number;
      user_text: string | null;
      started_at: number;
      ended_at: number | null;
      tool_count: number;
      subagent_count: number;
      input_tokens: number;
      output_tokens: number;
      model: string | null;
      status: string;
    } | undefined;

    if (!turnRow) return null;

    const turn: PromptTurnSummary = {
      promptId: turnRow.prompt_id,
      seq: turnRow.seq,
      userText: turnRow.user_text,
      startedAt: turnRow.started_at,
      endedAt: turnRow.ended_at,
      toolCount: turnRow.tool_count,
      subagentCount: turnRow.subagent_count,
      inputTokens: turnRow.input_tokens,
      outputTokens: turnRow.output_tokens,
      model: turnRow.model,
      status: turnRow.status as PromptTurnSummary['status'],
    };

    const toolRows = this.db.prepare(`
      SELECT id, tool_name, tool_subname, started_at, ended_at,
             input_summary, result_summary, error
      FROM tool_invocation
      WHERE prompt_id = ?
      ORDER BY started_at ASC
    `).all(promptId) as Array<{
      id: string;
      tool_name: string;
      tool_subname: string | null;
      started_at: number;
      ended_at: number | null;
      input_summary: string | null;
      result_summary: string | null;
      error: number;
    }>;

    const tools: ToolInvocationEntry[] = toolRows.map((r) => ({
      id: r.id,
      toolName: r.tool_name,
      toolSubname: r.tool_subname,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      inputSummary: r.input_summary,
      resultSummary: r.result_summary,
      error: r.error !== 0,
    }));

    const subagentRows = this.db.prepare(`
      SELECT agent_key, agent_type, description, parent_tool_use_id,
             cwd, model, started_at, ended_at,
             message_count, input_tokens, output_tokens
      FROM subagent_run
      WHERE prompt_id = ?
      ORDER BY started_at ASC
    `).all(promptId) as Array<{
      agent_key: string;
      agent_type: string | null;
      description: string | null;
      parent_tool_use_id: string | null;
      cwd: string | null;
      model: string | null;
      started_at: number;
      ended_at: number | null;
      message_count: number;
      input_tokens: number;
      output_tokens: number;
    }>;

    const subagents: SubagentRunEntry[] = subagentRows.map((r) => ({
      agentKey: r.agent_key,
      agentType: r.agent_type,
      description: r.description,
      parentToolUseId: r.parent_tool_use_id,
      cwd: r.cwd,
      model: r.model,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      messageCount: r.message_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    }));

    return { turn, tools, subagents };
  }

  getKnownPromptIds(sessionId: string): Set<string> {
    const rows = this.db.prepare(
      'SELECT prompt_id FROM prompt_turn WHERE session_id = ?',
    ).all(sessionId) as Array<{ prompt_id: string }>;
    return new Set(rows.map((r) => r.prompt_id));
  }

  getSessionMachineId(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT machine_id FROM audit_session WHERE session_id = ?',
    ).get(sessionId) as { machine_id: string } | undefined;
    return row?.machine_id ?? null;
  }

  getSessionMeta(sessionId: string): { slug: string | null; gitBranch: string | null } | null {
    const row = this.db.prepare(
      'SELECT slug, git_branch FROM audit_session WHERE session_id = ?',
    ).get(sessionId) as { slug: string | null; git_branch: string | null } | undefined;
    if (!row) return null;
    return { slug: row.slug, gitBranch: row.git_branch };
  }

  getSessionIdByPromptId(promptId: string): string | null {
    const row = this.db.prepare(
      'SELECT session_id FROM prompt_turn WHERE prompt_id = ?',
    ).get(promptId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  close(): void {
    this.db.close();
  }
}
