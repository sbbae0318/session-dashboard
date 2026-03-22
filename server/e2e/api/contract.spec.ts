/**
 * API Contract E2E Tests
 *
 * 실제 서버에 HTTP 요청을 보내 응답이 api-contract.ts 계약을 준수하는지 검증.
 * 브라우저 불필요 — Playwright request context만 사용.
 */

import { test, expect } from '@playwright/test';
import {
  validateHealthResponse,
  validateSessionsResponse,
  validateQueriesResponse,
  validateMachinesResponse,
  validateSession,
  validateMachineInfo,
} from '../../src/shared/contract-validators.js';

// =============================================================================
// GET /health
// =============================================================================

test.describe('GET /health — HealthResponse 계약', () => {
  test('200 반환 + HealthResponse 스키마 준수', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const result = validateHealthResponse(body);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test('uptime > 0', async ({ request }) => {
    const body = await (await request.get('/health')).json();
    expect(body.uptime).toBeGreaterThan(0);
  });

  test('timestamp is recent (within 10s)', async ({ request }) => {
    const body = await (await request.get('/health')).json();
    expect(Math.abs(body.timestamp - Date.now())).toBeLessThan(10_000);
  });

  test('connectedMachines <= totalMachines', async ({ request }) => {
    const body = await (await request.get('/health')).json();
    expect(body.connectedMachines).toBeLessThanOrEqual(body.totalMachines);
  });
});

// =============================================================================
// GET /api/sessions
// =============================================================================

test.describe('GET /api/sessions — SessionsResponse 계약', () => {
  test('200 반환 + SessionsResponse 스키마 준수', async ({ request }) => {
    const res = await request.get('/api/sessions');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const result = validateSessionsResponse(body);
    if (!result.valid) {
      console.error('Contract violations:', result.errors);
    }
    expect(result.valid).toBe(true);
  });

  test('모든 세션에 machineId 존재', async ({ request }) => {
    const body = await (await request.get('/api/sessions')).json();
    for (const s of body.sessions) {
      expect(s.machineId).toBeTruthy();
    }
  });

  test('source는 "opencode" 또는 "claude-code"만 허용', async ({ request }) => {
    const body = await (await request.get('/api/sessions')).json();
    for (const s of body.sessions) {
      expect(['opencode', 'claude-code']).toContain(s.source);
    }
  });

  test('waitingForInput은 boolean (undefined 불가)', async ({ request }) => {
    const body = await (await request.get('/api/sessions')).json();
    for (const s of body.sessions) {
      expect(typeof s.waitingForInput).toBe('boolean');
    }
  });

  test('apiStatus는 idle/busy/retry/null만 허용', async ({ request }) => {
    const body = await (await request.get('/api/sessions')).json();
    for (const s of body.sessions) {
      expect([null, 'idle', 'busy', 'retry']).toContain(s.apiStatus);
    }
  });

  test('childSessionIds는 배열', async ({ request }) => {
    const body = await (await request.get('/api/sessions')).json();
    for (const s of body.sessions) {
      expect(Array.isArray(s.childSessionIds)).toBe(true);
    }
  });

  test('Working 세션의 lastActivityTime이 최근이어야 함 (5분 이내)', async ({ request }) => {
    const body = await (await request.get('/api/sessions')).json();
    const now = Date.now();
    for (const s of body.sessions) {
      if (s.apiStatus === 'busy' || s.currentTool) {
        const ageMinutes = (now - s.lastActivityTime) / 60_000;
        // Working 세션은 hook으로 lastActivityTime이 갱신되므로 5분 이내여야 함
        expect(ageMinutes).toBeLessThan(5);
      }
    }
  });

  test('lastActivityTime 기준 내림차순 정렬', async ({ request }) => {
    const body = await (await request.get('/api/sessions')).json();
    const times: number[] = body.sessions.map((s: { lastActivityTime: number }) => s.lastActivityTime);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });

  test('apiKey가 응답에 포함되지 않음 (보안)', async ({ request }) => {
    const body = await (await request.get('/api/sessions')).json();
    expect(JSON.stringify(body)).not.toContain('apiKey');
  });
});

// =============================================================================
// GET /api/queries
// =============================================================================

test.describe('GET /api/queries — QueriesResponse 계약', () => {
  test('200 반환 + QueriesResponse 스키마 준수', async ({ request }) => {
    const res = await request.get('/api/queries');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const result = validateQueriesResponse(body);
    if (!result.valid) {
      console.error('Contract violations:', result.errors);
    }
    expect(result.valid).toBe(true);
  });

  test('limit 파라미터 동작', async ({ request }) => {
    const body = await (await request.get('/api/queries?limit=3')).json();
    expect(body.queries.length).toBeLessThanOrEqual(3);
  });

  test('timestamp 기준 내림차순 정렬', async ({ request }) => {
    const body = await (await request.get('/api/queries')).json();
    const times: number[] = body.queries.map((q: { timestamp: number }) => q.timestamp);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });
});

// =============================================================================
// GET /api/machines
// =============================================================================

test.describe('GET /api/machines — MachinesResponse 계약', () => {
  test('200 반환 + MachinesResponse 스키마 준수', async ({ request }) => {
    const res = await request.get('/api/machines');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const result = validateMachinesResponse(body);
    if (!result.valid) {
      console.error('Contract violations:', result.errors);
    }
    expect(result.valid).toBe(true);
  });

  test('apiKey가 응답에 포함되지 않음 (보안)', async ({ request }) => {
    const body = await (await request.get('/api/machines')).json();
    expect(JSON.stringify(body)).not.toContain('apiKey');
  });

  test('모든 머신에 고유 id', async ({ request }) => {
    const body = await (await request.get('/api/machines')).json();
    const ids = body.machines.map((m: { id: string }) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// =============================================================================
// Cross-endpoint 일관성
// =============================================================================

test.describe('Cross-endpoint 일관성', () => {
  test('sessions의 machineId가 machines에 존재', async ({ request }) => {
    const [sessionsBody, machinesBody] = await Promise.all([
      (await request.get('/api/sessions')).json(),
      (await request.get('/api/machines')).json(),
    ]);

    const machineIds = new Set(machinesBody.machines.map((m: { id: string }) => m.id));
    for (const s of sessionsBody.sessions) {
      expect(machineIds.has(s.machineId)).toBe(true);
    }
  });

  test('health.totalMachines === machines.length', async ({ request }) => {
    const [healthBody, machinesBody] = await Promise.all([
      (await request.get('/health')).json(),
      (await request.get('/api/machines')).json(),
    ]);
    expect(healthBody.totalMachines).toBe(machinesBody.machines.length);
  });

  test('health.connectedMachines === connected machines count', async ({ request }) => {
    const [healthBody, machinesBody] = await Promise.all([
      (await request.get('/health')).json(),
      (await request.get('/api/machines')).json(),
    ]);
    const connected = machinesBody.machines.filter((m: { status: string }) => m.status === 'connected').length;
    expect(healthBody.connectedMachines).toBe(connected);
  });
});
