import { get as httpGet, request as httpRequest, type IncomingMessage } from 'node:http';
import type { MachineConfig } from '../config/machines.js';

export interface MachineStatus {
  readonly machineId: string;
  readonly machineAlias: string;
  readonly machineHost: string;
  readonly connected: boolean;
  readonly lastSeen: number | null;
  readonly error: string | null;
  readonly source: "opencode" | "claude-code" | "both";
}

export interface MachineSessionData {
  readonly sessions: Array<Record<string, unknown>>;
  readonly statuses: Record<string, { type: string }>;
}

export interface CachedSessionDetail {
  readonly status: 'busy' | 'idle' | 'retry';
  readonly lastPrompt: string | null;
  readonly lastPromptTime: number;
  readonly currentTool: string | null;
  readonly directory: string | null;
  readonly updatedAt: number;
  readonly lastResponseTime?: number | null;
  readonly lastFileModified?: number | null;
  readonly sseConnected?: boolean;
  readonly waitingForInput?: boolean;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly createdAt?: number;
  readonly lastActiveAt?: number;
}

interface SessionsAllResponse {
  meta: { sseConnected: boolean; lastSseEventAt: number; sseConnectedAt: number };
  projects: Array<{ id: string; worktree: string }>;
  activeDirectories: string[];
  sessions: Record<string, {
    status: string;
    lastPrompt: string | null;
    lastPromptTime: number;
    currentTool: string | null;
    directory: string | null;
    waitingForInput: boolean;
    updatedAt: number;
    title: string | null;
    parentSessionId: string | null;
    createdAt: number;
    lastActiveAt?: number;
  }>;
}

interface PollAllResult {
  sessions: Array<Record<string, unknown> & { machineId: string; machineAlias: string; machineHost: string }>;
  statuses: Record<string, { type: string; machineId: string }>;
  cachedDetails: Record<string, CachedSessionDetail & { machineId: string }>;
}

export class MachineManager {
  static readonly DEFAULT_TIMEOUT_MS = 8000;
  static readonly GRACE_THRESHOLD = 3;

  private readonly machines: readonly MachineConfig[];
  private readonly defaultTimeout: number;
  private readonly machineStatuses: Map<string, MachineStatus> = new Map();
  private readonly consecutiveFailures: Map<string, number> = new Map();
  private onStatusChange: ((statuses: readonly MachineStatus[]) => void) | null = null;
  private readonly projectsCache: Map<string, Array<{ id: string; worktree: string }>> = new Map();

  constructor(machines: readonly MachineConfig[], defaultTimeout?: number) {
    this.machines = machines;
    this.defaultTimeout = defaultTimeout ?? MachineManager.DEFAULT_TIMEOUT_MS;
    // Initialize statuses
    for (const m of machines) {
      this.machineStatuses.set(m.id, {
        machineId: m.id,
        machineAlias: m.alias,
        machineHost: m.host,
        connected: false,
        lastSeen: null,
        error: null,
        source: m.source,
      });
      this.consecutiveFailures.set(m.id, 0);
    }
  }

  setStatusChangeCallback(cb: (statuses: readonly MachineStatus[]) => void): void {
    this.onStatusChange = cb;
  }

  getMachines(): readonly MachineConfig[] {
    return this.machines;
  }

  getMachineStatuses(): readonly MachineStatus[] {
    return [...this.machineStatuses.values()];
  }

  /**
   * Poll ALL machines for session data in parallel.
   * Uses Promise.allSettled() so one slow/dead agent doesn't block others.
   * Returns aggregated session data with machineId tags.
   */
  async pollAllSessions(): Promise<{
    sessions: Array<Record<string, unknown> & { machineId: string; machineAlias: string; machineHost: string }>;
    statuses: Record<string, { type: string; machineId: string }>;
  }> {
    const results = await Promise.allSettled(
      this.machines.map(machine => this.pollMachine(machine))
    );

    const allSessions: Array<Record<string, unknown> & { machineId: string; machineAlias: string; machineHost: string }> = [];
    const allStatuses: Record<string, { type: string; machineId: string }> = {};

    for (const [index, result] of results.entries()) {
      const machine = this.machines[index];
      if (result.status === 'fulfilled') {
        // Tag sessions with machine info
        for (const session of result.value.sessions) {
          allSessions.push({
            ...session,
            machineId: machine.id,
            machineAlias: machine.alias,
            machineHost: machine.host,
          });
        }
        // Tag statuses with machineId
        for (const [sessionId, status] of Object.entries(result.value.statuses)) {
          allStatuses[sessionId] = { ...status, machineId: machine.id };
        }
        this.consecutiveFailures.set(machine.id, 0);
        this.machineStatuses.set(machine.id, {
          machineId: machine.id,
          machineAlias: machine.alias,
          machineHost: machine.host,
          connected: true,
          lastSeen: Date.now(),
          error: null,
          source: machine.source,
        });
      } else {
        // Grace period: only mark disconnected after GRACE_THRESHOLD consecutive failures
        const failures = (this.consecutiveFailures.get(machine.id) ?? 0) + 1;
        this.consecutiveFailures.set(machine.id, failures);
        const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[MachineManager] ${machine.alias} (${machine.host}) poll failed (${failures}/${MachineManager.GRACE_THRESHOLD}): ${errorMsg}`);

        const prev = this.machineStatuses.get(machine.id);
        if (failures >= MachineManager.GRACE_THRESHOLD) {
          this.machineStatuses.set(machine.id, {
            machineId: machine.id,
            machineAlias: machine.alias,
            machineHost: machine.host,
            connected: false,
            lastSeen: prev?.lastSeen ?? null,
            error: errorMsg,
            source: machine.source,
          });
        } else if (prev) {
          // Keep previous connected state during grace period
          this.machineStatuses.set(machine.id, {
            ...prev,
            error: errorMsg,
          });
        }
      }
    }

    this.onStatusChange?.(this.getMachineStatuses());

    return { sessions: allSessions, statuses: allStatuses };
  }

  /**
   * Poll ALL machines via /proxy/sessions-all (single request per machine).
   * Returns sessions, statuses, and cached details in one call.
   */
  async pollAll(): Promise<PollAllResult> {
    const results = await Promise.allSettled(
      this.machines.map(machine => this.pollMachineCached(machine))
    );

    const allSessions: PollAllResult['sessions'] = [];
    const allStatuses: PollAllResult['statuses'] = {};
    const allCachedDetails: PollAllResult['cachedDetails'] = {};

    for (const [index, result] of results.entries()) {
      const machine = this.machines[index];
      if (result.status === 'fulfilled') {
        for (const session of result.value.sessions) {
          allSessions.push({
            ...session,
            machineId: machine.id,
            machineAlias: machine.alias,
            machineHost: machine.host,
          });
        }
        for (const [sessionId, status] of Object.entries(result.value.statuses)) {
          allStatuses[sessionId] = { ...status, machineId: machine.id };
        }
        for (const [sessionId, detail] of Object.entries(result.value.cachedDetails)) {
          allCachedDetails[sessionId] = { ...detail, machineId: machine.id };
        }
        this.consecutiveFailures.set(machine.id, 0);
        this.machineStatuses.set(machine.id, {
          machineId: machine.id,
          machineAlias: machine.alias,
          machineHost: machine.host,
          connected: true,
          lastSeen: Date.now(),
          error: null,
          source: machine.source,
        });
      } else {
        const failures = (this.consecutiveFailures.get(machine.id) ?? 0) + 1;
        this.consecutiveFailures.set(machine.id, failures);
        const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[MachineManager] ${machine.alias} (${machine.host}) pollAll failed (${failures}/${MachineManager.GRACE_THRESHOLD}): ${errorMsg}`);

        const prev = this.machineStatuses.get(machine.id);
        if (failures >= MachineManager.GRACE_THRESHOLD) {
          this.machineStatuses.set(machine.id, {
            machineId: machine.id,
            machineAlias: machine.alias,
            machineHost: machine.host,
            connected: false,
            lastSeen: prev?.lastSeen ?? null,
            error: errorMsg,
            source: machine.source,
          });
        } else if (prev) {
          this.machineStatuses.set(machine.id, { ...prev, error: errorMsg });
        }
      }
    }

    this.onStatusChange?.(this.getMachineStatuses());
    return { sessions: allSessions, statuses: allStatuses, cachedDetails: allCachedDetails };
  }

  async fetchFromMachine<T = unknown>(machine: MachineConfig, path: string, options?: { method?: 'GET' | 'POST' }): Promise<T> {
    const url = `http://${machine.host}:${machine.port}${path}`;
    const headers = { 'Authorization': `Bearer ${machine.apiKey}` };
    if (options?.method === 'POST') {
      const raw = await this.httpPost(url, headers, machine.timeout);
      return JSON.parse(raw) as T;
    }
    const raw = await this.httpGet(url, headers, machine.timeout);
    return JSON.parse(raw) as T;
  }

  private async pollMachineCached(machine: MachineConfig): Promise<{
    sessions: Array<Record<string, unknown>>;
    statuses: Record<string, { type: string }>;
    cachedDetails: Record<string, CachedSessionDetail>;
  }> {
    const sessions: Array<Record<string, unknown>> = [];
    const statuses: Record<string, { type: string }> = {};
    const cachedDetails: Record<string, CachedSessionDetail> = {};
    const seenIds = new Set<string>();

    if (machine.source === 'opencode' || machine.source === 'both') {
      const baseUrl = `http://${machine.host}:${machine.port}`;
      const headers = { 'Authorization': `Bearer ${machine.apiKey}` };
      const raw = await this.httpGet(`${baseUrl}/proxy/sessions-all`, headers, machine.timeout);
      const response = JSON.parse(raw) as SessionsAllResponse;

      for (const [id, detail] of Object.entries(response.sessions)) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        sessions.push({
          id,
          title: detail.title ?? null,
          parentID: detail.parentSessionId ?? null,
          directory: detail.directory,
          time: { created: detail.createdAt ?? 0, updated: detail.lastActiveAt ?? detail.updatedAt },
        });
        statuses[id] = { type: detail.status };
        cachedDetails[id] = {
          status: detail.status as CachedSessionDetail['status'],
          lastPrompt: detail.lastPrompt,
          lastPromptTime: detail.lastPromptTime,
          currentTool: detail.currentTool,
          directory: detail.directory,
          waitingForInput: detail.waitingForInput,
          updatedAt: detail.updatedAt,
          title: detail.title,
          parentSessionId: detail.parentSessionId,
          createdAt: detail.createdAt,
          lastActiveAt: detail.lastActiveAt,
          sseConnected: response.meta.sseConnected,
        };
      }
    }

    if (machine.source === 'claude-code' || machine.source === 'both') {
      let claudeSessions: Array<Record<string, unknown>> = [];
      try {
        claudeSessions = await this.fetchClaudeSessions(machine);
      } catch {
        // Agent may not have Claude Code routes enabled — skip gracefully
      }
      for (const session of claudeSessions) {
        const sessionId = String(session.sessionId ?? '');
        if (sessionId && !seenIds.has(sessionId)) {
          seenIds.add(sessionId);
          sessions.push({ ...session, id: sessionId, source: 'claude-code' });
          const sessionStatus = String(session.status ?? 'busy');
          statuses[sessionId] = { type: sessionStatus === 'idle' ? 'idle' : 'active' };
          cachedDetails[sessionId] = {
            status: sessionStatus === 'idle' ? 'idle' : 'busy',
            lastPrompt: (session.lastPrompt as string) ?? null,
            lastPromptTime: (session.lastPromptTime as number) ?? 0,
            currentTool: (session.currentTool as string | null) ?? null,
            directory: (session.cwd as string) ?? null,
            updatedAt: (session.lastHeartbeat as number) ?? Date.now(),
            lastResponseTime: (session.lastResponseTime as number) ?? null,
            lastFileModified: (session.lastFileModified as number) ?? null,
            waitingForInput: (session.waitingForInput as boolean) ?? false,
          };
        }
      }
    }

    return { sessions, statuses, cachedDetails };
  }

  private async pollMachine(machine: MachineConfig): Promise<MachineSessionData> {
    const allSessions: Array<Record<string, unknown>> = [];
    const statuses: Record<string, { type: string }> = {};
    const seenIds = new Set<string>();

    // === OpenCode (oc-serve proxy) polling ===
    if (machine.source === 'opencode' || machine.source === 'both') {
      const baseUrl = `http://${machine.host}:${machine.port}`;
      const headers = { 'Authorization': `Bearer ${machine.apiKey}` };

      // Fetch projects list + active directories in parallel
      let projects: Array<{ id: string; worktree: string }>;
      let activeDirs: string[];
      try {
        const [projectsRaw, activeDirsRaw] = await Promise.all([
          this.httpGet(`${baseUrl}/proxy/projects`, headers, machine.timeout),
          this.httpGet(`${baseUrl}/proxy/active-directories`, headers, machine.timeout).catch(() => '{"directories":[]}'),
        ]);
        projects = JSON.parse(projectsRaw) as Array<{ id: string; worktree: string }>;
        this.projectsCache.set(machine.id, projects);
        const activeResponse = JSON.parse(activeDirsRaw) as { directories?: string[] };
        activeDirs = activeResponse.directories ?? [];
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[MachineManager] ${machine.alias}: poll error detail:`, errorMsg);
        const cached = this.projectsCache.get(machine.id);
        if (!cached || cached.length === 0) {
          // No cache available — skip OpenCode polling entirely for this cycle
          console.warn(`[MachineManager] ${machine.alias}: /proxy/projects failed, no cache — skipping OpenCode poll`);
          projects = [];
          activeDirs = [];
        } else {
          console.warn(`[MachineManager] ${machine.alias}: /proxy/projects failed — using cached ${cached.length} projects`);
          projects = cached;
          activeDirs = [];
        }
      }

      // Merge: registered projects + active directories not already in project list
      const registeredWorktrees = new Set(projects.map(p => p.worktree));
      const extraDirs = activeDirs.filter(d => d !== '/' && !registeredWorktrees.has(d));
      const validProjects = [
        ...projects.filter(p => p.worktree && p.worktree !== '/'),
        ...extraDirs.map(d => ({ id: `active-${d}`, worktree: d })),
      ];

      // Fetch sessions and statuses per-project in parallel
      // /session/status is project-scoped — must call with ?directory= for each project
      const [sessionResults, statusResults] = await Promise.all([
        Promise.allSettled(
          validProjects.map(p =>
            this.httpGet(
              `${baseUrl}/proxy/session?directory=${encodeURIComponent(p.worktree)}&limit=100`,
              headers,
              machine.timeout,
            ).then(raw => JSON.parse(raw) as Array<Record<string, unknown>>)
          ),
        ),
        Promise.allSettled(
          validProjects.map(p =>
            this.httpGet(
              `${baseUrl}/proxy/session/status?directory=${encodeURIComponent(p.worktree)}`,
              headers,
              machine.timeout,
            ).then(raw => JSON.parse(raw) as Record<string, { type: string }>)
          ),
        ),
      ]);

      // Aggregate statuses from all projects
      for (const result of statusResults) {
        if (result.status === 'fulfilled' && result.value) {
          Object.assign(statuses, result.value);
        }
      }

      // Aggregate sessions from all projects (deduplicate by id)
      for (const result of sessionResults) {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          for (const session of result.value) {
            const id = String(session.id ?? '');
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              allSessions.push(session);
            }
          }
        }
      }

      // === Catch sessions from oc-serve's global project (worktree="/") ===
      // Sessions created before their directory was registered as a project end up
      // in the global project. Per-directory queries miss them. Fetch all sessions
      // without directory filter to discover them, then deduplicate with seenIds.
      const hasGlobalProject = projects.some(p => p.worktree === '/');
      if (hasGlobalProject) {
        try {
          const unfilteredRaw = await this.httpGet(
            `${baseUrl}/proxy/session?limit=200`,
            headers,
            machine.timeout,
          );
          const unfilteredSessions = JSON.parse(unfilteredRaw) as Array<Record<string, unknown>>;
          for (const session of unfilteredSessions) {
            const id = String(session.id ?? '');
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              allSessions.push(session);
            }
          }
        } catch {
          // Unfiltered fetch failed — per-project sessions still collected above
        }
      }
    }

    // === Claude Code polling ===
    if (machine.source === 'claude-code' || machine.source === 'both') {
      try {
        const claudeSessions = await this.fetchClaudeSessions(machine);
        for (const session of claudeSessions) {
          const sessionId = String(session.sessionId ?? '');
          if (sessionId && !seenIds.has(sessionId)) {
            seenIds.add(sessionId);
            allSessions.push({ ...session, id: sessionId, source: 'claude-code' });
            const sessionStatus = String(session.status ?? 'busy');
            statuses[sessionId] = { type: sessionStatus === 'idle' ? 'idle' : 'active' };
          }
        }
      } catch (err) {
        if (machine.source === 'claude-code') throw err;
        // source=both: Claude Code endpoint unavailable — skip silently, OpenCode sessions still collected
      }
    }

    return {
      statuses,
      sessions: allSessions,
    };
  }

  private httpGet(url: string, headers: Record<string, string>, timeout?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout ?? this.defaultTimeout);

      const request = httpGet(url, { headers, signal: controller.signal }, (response: IncomingMessage) => {
        let data = '';
        response.on('data', (chunk: Buffer) => { data += chunk; });
        response.on('error', (err: Error) => { clearTimeout(timeoutId); reject(err); });
        response.on('end', () => {
          clearTimeout(timeoutId);
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          }
        });
      });

      request.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  private httpPost(url: string, headers: Record<string, string>, timeout?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout ?? 60_000);

      const req = httpRequest({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        signal: controller.signal,
      }, (response: IncomingMessage) => {
        let data = '';
        response.on('data', (chunk: Buffer) => { data += chunk; });
        response.on('error', (err: Error) => { clearTimeout(timeoutId); reject(err); });
        response.on('end', () => {
          clearTimeout(timeoutId);
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          }
        });
      });

      req.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      req.end();
    });
  }


 /**
 * Fetch queries from all machines in parallel.
 */
 async pollAllQueries(limit: number = 50): Promise<Array<Record<string, unknown> & { machineId: string; machineAlias: string; machineHost: string }>> {
   // Build fetch tasks based on each machine's source configuration
   const fetchTasks: Array<Promise<{ machine: MachineConfig; queries: Array<Record<string, unknown>> }>> = [];

   for (const machine of this.machines) {
     // OpenCode queries from oc-serve
     if (machine.source === 'opencode' || machine.source === 'both') {
       fetchTasks.push(
         this.fetchQueries(machine, limit).then(queries => ({ machine, queries }))
       );
     }
     // Claude Code queries from dashboard-agent
     if (machine.source === 'claude-code' || machine.source === 'both') {
       fetchTasks.push(
         this.fetchClaudeQueries(machine, limit).then(queries => ({ machine, queries }))
       );
     }
   }

   const results = await Promise.allSettled(fetchTasks);

   const allQueries: Array<Record<string, unknown> & { machineId: string; machineAlias: string; machineHost: string }> = [];
   for (const result of results) {
     if (result.status === 'fulfilled') {
       const { machine, queries } = result.value;
       for (const query of queries) {
         allQueries.push({
           ...query,
           machineId: machine.id,
           machineAlias: machine.alias,
           machineHost: machine.host,
         });
       }
     }
   }

   // Sort by timestamp descending
   allQueries.sort((a, b) => ((b.timestamp as number) ?? 0) - ((a.timestamp as number) ?? 0));
   return allQueries;
 }

 /**
  * Poll ALL machines for session details in parallel.
  * Returns merged session details keyed by sessionId, each tagged with machineId.
  */
 async pollSessionDetails(): Promise<Record<string, CachedSessionDetail & { machineId: string }>> {
   const merged: Record<string, CachedSessionDetail & { machineId: string }> = {};

   // === OpenCode session details from oc-serve ===
   const ocServeMachines = this.machines.filter(m => m.source === 'opencode' || m.source === 'both');
   const ocResults = await Promise.allSettled(
     ocServeMachines.map(machine => this.fetchSessionDetails(machine))
   );

   for (const [index, result] of ocResults.entries()) {
     const machine = ocServeMachines[index];
     if (result.status === 'fulfilled') {
       for (const [sessionId, detail] of Object.entries(result.value)) {
         merged[sessionId] = { ...detail, machineId: machine.id };
       }
     }
   }

   // === Claude Code session details (synthesized from active sessions) ===
   const claudeMachines = this.machines.filter(m => m.source === 'claude-code' || m.source === 'both');
   const claudeResults = await Promise.allSettled(
     claudeMachines.map(machine =>
       this.fetchClaudeSessions(machine).then(sessions => ({ machine, sessions }))
     )
   );

   for (const result of claudeResults) {
     if (result.status === 'fulfilled') {
       const { machine, sessions } = result.value;
       for (const session of sessions) {
         const sessionId = String(session.sessionId ?? '');
           const sessionStatus = String(session.status ?? 'busy');
         if (sessionId) {
          merged[sessionId] = {
            status: sessionStatus === 'idle' ? 'idle' : 'busy',
            lastPrompt: (session.lastPrompt as string) ?? null,
            lastPromptTime: (session.lastPromptTime as number) ?? null,
            currentTool: null,
            directory: (session.cwd as string) ?? null,
            updatedAt: (session.lastHeartbeat as number) ?? Date.now(),
            lastResponseTime: (session.lastResponseTime as number) ?? null,
            lastFileModified: (session.lastFileModified as number) ?? null,
            machineId: machine.id,
          };
         }
       }
     }
   }

   return merged;
 }


 private async fetchQueries(machine: MachineConfig, limit: number): Promise<Array<Record<string, unknown>>> {
 const url = `http://${machine.host}:${machine.port}/api/queries?limit=${limit}`;
 const headers = { 'Authorization': `Bearer ${machine.apiKey}` };
 const raw = await this.httpGet(url, headers, machine.timeout);
 const response = JSON.parse(raw) as { queries?: Array<Record<string, unknown>> };
 return response.queries ?? [];
 }

 private async fetchSessionDetails(machine: MachineConfig): Promise<Record<string, CachedSessionDetail>> {
   const url = `http://${machine.host}:${machine.port}/proxy/session/details`;
   const headers = { 'Authorization': `Bearer ${machine.apiKey}` };
   const raw = await this.httpGet(url, headers, machine.timeout);
   const parsed = JSON.parse(raw) as Record<string, unknown>;

   // New wrapper format: { meta: {...}, sessions: {...} }
   if (parsed && typeof parsed === 'object' && 'meta' in parsed && 'sessions' in parsed) {
     const meta = parsed.meta as { sseConnected?: boolean } | undefined;
     const sseConnected = meta?.sseConnected ?? false;
     const sessions = parsed.sessions as Record<string, CachedSessionDetail>;
     const result: Record<string, CachedSessionDetail> = {};
     for (const [id, detail] of Object.entries(sessions)) {
       result[id] = { ...detail, sseConnected };
     }
     return result;
   }

   // Backward compat: old flat format (no meta wrapper)
   return parsed as Record<string, CachedSessionDetail>;
 }

  /**
   * Fetch Claude Code active sessions from dashboard-agent
   */
  private async fetchClaudeSessions(machine: MachineConfig): Promise<Array<Record<string, unknown>>> {
    const url = `http://${machine.host}:${machine.port}/api/claude/sessions`;
    const headers = { 'Authorization': `Bearer ${machine.apiKey}` };
    const raw = await this.httpGet(url, headers, machine.timeout);
    const response = JSON.parse(raw) as { sessions?: Array<Record<string, unknown>> };
    return response.sessions ?? [];
  }

  /**
   * Fetch Claude Code queries from dashboard-agent
   */
  private async fetchClaudeQueries(machine: MachineConfig, limit: number): Promise<Array<Record<string, unknown>>> {
    const url = `http://${machine.host}:${machine.port}/api/claude/queries?limit=${limit}`;
    const headers = { 'Authorization': `Bearer ${machine.apiKey}` };
    const raw = await this.httpGet(url, headers, machine.timeout);
    const response = JSON.parse(raw) as { queries?: Array<Record<string, unknown>> };
    return response.queries ?? [];
  }
}
