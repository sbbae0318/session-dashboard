import type { FastifyInstance } from 'fastify';
import type { BackendModule } from '../types.js';
import type { MachineManager } from '../../machines/machine-manager.js';
import type { TurnSummaryPayload } from '../../shared/api-contract.js';
import { AuditDB } from './audit-db.js';

export { AuditDB };

export class AuditModule implements BackendModule {
  readonly id = 'audit';

  constructor(
    private readonly db: AuditDB,
    private readonly machineManager: MachineManager | null,
  ) {}

  registerRoutes(app: FastifyInstance): void {
    app.post('/api/ingest/turn-summary', async (request, reply) => {
      const body = request.body as (TurnSummaryPayload & { machineId: string }) | null;
      if (!body?.sessionId || !body?.machineId) {
        return reply.code(400).send({ error: 'sessionId and machineId are required' });
      }
      const { machineId, ...payload } = body;
      this.db.upsertTurnSummary(payload, machineId);
      return { ok: true };
    });

    app.get('/api/sessions/:sessionId/turns', async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const turns = this.db.getSessionTurns(sessionId);
      const meta = this.db.getSessionMeta(sessionId);
      return {
        sessionId,
        slug: meta?.slug ?? null,
        gitBranch: meta?.gitBranch ?? null,
        turns,
      };
    });

    app.get('/api/prompts/:promptId/audit', async (request, reply) => {
      const { promptId } = request.params as { promptId: string };
      const result = this.db.getPromptAudit(promptId);
      if (!result) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }
      return result;
    });

    app.get('/api/audit/known-prompts', async (request) => {
      const query = request.query as { sessionId?: string };
      if (!query.sessionId) {
        return { promptIds: [] };
      }
      const ids = this.db.getKnownPromptIds(query.sessionId);
      return { promptIds: [...ids] };
    });

    app.get('/api/prompts/:promptId/transcript', async (request, reply) => {
      const { promptId } = request.params as { promptId: string };

      const sessionId = this.db.getSessionIdByPromptId(promptId);
      if (!sessionId) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      if (!this.machineManager) {
        return reply.code(503).send({ error: 'agent_offline' });
      }

      const machineId = this.db.getSessionMachineId(sessionId);
      if (!machineId) {
        return reply.code(503).send({ error: 'agent_offline' });
      }

      const machines = this.machineManager.getMachines();
      const machine = machines.find(m => m.id === machineId);
      if (!machine) {
        return reply.code(503).send({ error: 'agent_offline' });
      }

      // TODO: proxy to agent once endpoint is implemented
      const data = await this.machineManager.fetchFromMachine(
        machine,
        `/claude/transcript/${sessionId}/${promptId}`,
      );
      return data;
    });

    app.get('/api/prompts/:promptId/subagent/:agentKey/transcript', async (request, reply) => {
      const { promptId, agentKey } = request.params as { promptId: string; agentKey: string };

      const sessionId = this.db.getSessionIdByPromptId(promptId);
      if (!sessionId) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      if (!this.machineManager) {
        return reply.code(503).send({ error: 'agent_offline' });
      }

      const machineId = this.db.getSessionMachineId(sessionId);
      if (!machineId) {
        return reply.code(503).send({ error: 'agent_offline' });
      }

      const machines = this.machineManager.getMachines();
      const machine = machines.find(m => m.id === machineId);
      if (!machine) {
        return reply.code(503).send({ error: 'agent_offline' });
      }

      // TODO: proxy to agent once endpoint is implemented
      const data = await this.machineManager.fetchFromMachine(
        machine,
        `/claude/transcript/${sessionId}/${promptId}/subagent/${agentKey}`,
      );
      return data;
    });
  }
}
