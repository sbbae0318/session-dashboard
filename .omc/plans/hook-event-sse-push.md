# Plan: Agent Hook-Event SSE Push (B')

> Agent가 Claude Code hook 이벤트 발생 시 SSE로 실시간 브로드캐스트,
> Server가 구독하여 폴링 없이 즉시 상태 반영.

**Date:** 2026-04-07
**Status:** Draft
**Motivation:** WAITING→WORKING 등 짧은 상태 전환을 프론트엔드에서 즉시 감지
**선행 조건:** A (폴링 2초→1초) 적용 완료

---

## 현재 아키텍처

```
Claude Code hooks ─POST→ Agent(즉시) ─── 1초 폴링 ──→ Server ── SSE 즉시 ──→ Frontend
                                         ^^^^^^^^^^^^
                                         병목: 0~1초 지연
```

## 목표 아키텍처

```
Claude Code hooks ─POST→ Agent(즉시) ── SSE push(즉시) ──→ Server ── SSE 즉시 ──→ Frontend
                                      └── 2초 폴링 (fallback) ──┘
                                                                    ← A를 2초로 복원 가능 (push가 주력)
```

---

## 설계

### 1. Agent: Hook-Event SSE 엔드포인트

**파일:** `agent/src/server.ts`

**엔드포인트:** `GET /api/claude/events`

**동작:**
- SSE 스트림 제공 (text/event-stream)
- 클라이언트(Server) 접속 시 `connected` 이벤트 전송
- hook 이벤트 발생 시 해당 세션의 **full snapshot** 브로드캐스트
- 30초 heartbeat (`:heartbeat\n\n`)

**이벤트 포맷:**
```
event: hook.sessionUpdate
data: {"sessionId":"abc","status":"busy","currentTool":"Bash","waitingForInput":false,"hooksActive":true,"lastFileModified":1234567890,...}

```

**왜 full snapshot인가:**
- Server가 hook 이벤트를 해석할 필요 없음 (PreToolUse→status 매핑 불필요)
- 기존 세션 데이터 구조와 동일 → Server 처리 로직 재활용
- Idempotent — 동일 데이터 수신해도 무해

**구현 가이드:**

```typescript
// agent/src/server.ts 내

// SSE 클라이언트 관리 (경량 — event-stream.ts 패턴 참고하되 agent용으로 간소화)
const hookSseClients = new Map<string, FastifyReply>();

// SSE 엔드포인트
app.get('/api/claude/events', (request, reply) => {
  const clientId = crypto.randomUUID();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);
  hookSseClients.set(clientId, reply);
  request.raw.on('close', () => hookSseClients.delete(clientId));
});

// Heartbeat (30초)
setInterval(() => {
  for (const [id, reply] of hookSseClients) {
    try { reply.raw.write(':heartbeat\n\n'); }
    catch { hookSseClients.delete(id); }
  }
}, 30_000);

// Hook 이벤트 후 브로드캐스트 함수
function broadcastHookUpdate(sessionId: string) {
  const session = claudeHeartbeat.getSession(sessionId);
  if (!session || hookSseClients.size === 0) return;
  const msg = `event: hook.sessionUpdate\ndata: ${JSON.stringify(session)}\n\n`;
  for (const [id, reply] of hookSseClients) {
    try { reply.raw.write(msg); }
    catch { hookSseClients.delete(id); }
  }
}
```

**hook handler에 1줄 추가:**
```typescript
case 'PreToolUse': {
  claudeHeartbeat.handleToolEvent(sessionId, toolName);
  broadcastHookUpdate(sessionId);  // ← 추가
  break;
}
// ... 각 case에 동일하게 추가
```

**ClaudeHeartbeat에 getter 추가:**
```typescript
getSession(sessionId: string): ClaudeSessionInfo | undefined {
  return this.sessions.get(sessionId);
}
```

### 2. Server: Hook SSE 구독

**파일:** `server/src/machines/machine-manager.ts`

**동작:**
- 머신 설정에 `source: 'both'` 또는 `source: 'claude-code'`인 머신에 대해 SSE 구독
- `GET http://{host}:{port}/api/claude/events` 연결
- `hook.sessionUpdate` 이벤트 수신 시 `cachedDetails` 즉시 갱신
- 갱신 콜백 호출 → `ActiveSessionsModule`이 즉시 세션 목록 재빌드 → SSE 브로드캐스트

**구독 관리:**
```typescript
// machine-manager.ts 내

private hookSseConnections = new Map<string, { destroy: () => void }>();

// 머신 연결 시 SSE 구독 시작
private subscribeToHookEvents(machine: MachineConfig): void {
  const url = `http://${machine.host}:${machine.port}/api/claude/events`;
  
  // node:http GET (SessionCache 패턴 참고)
  const req = http.get(url, { headers: { Authorization: `Bearer ${machine.apiKey}` } }, (res) => {
    let buffer = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      // SSE 파싱: \n\n 단위로 분리
      const messages = buffer.split('\n\n');
      buffer = messages.pop() ?? '';
      for (const msg of messages) {
        this.handleHookSseMessage(machine.id, msg);
      }
    });
    res.on('end', () => { /* reconnect with backoff */ });
  });

  req.on('error', () => { /* reconnect with backoff */ });
  this.hookSseConnections.set(machine.id, { destroy: () => req.destroy() });
}

private handleHookSseMessage(machineId: string, raw: string): void {
  // event: hook.sessionUpdate\ndata: {...}
  const eventMatch = raw.match(/^event:\s*(.+)$/m);
  const dataMatch = raw.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;
  if (eventMatch[1] !== 'hook.sessionUpdate') return;
  
  try {
    const session = JSON.parse(dataMatch[1]);
    // cachedDetails 즉시 갱신
    this.updateCachedSession(machineId, session);
    // 콜백 호출 → 즉시 SSE 브로드캐스트 트리거
    this.onHookUpdate?.();
  } catch { /* ignore parse errors */ }
}
```

**ActiveSessionsModule 연동:**
```typescript
// active-sessions/index.ts

// MachineManager에 hook update 콜백 등록
machineManager.setHookUpdateCallback(() => {
  // 즉시 poll 실행 (cached data가 이미 갱신되었으므로 빠름)
  this.poll().catch(() => {});
});
```

### 3. 재연결 전략

| 상황 | 동작 |
|------|------|
| Agent SSE 연결 성공 | connected 이벤트 수신, 상태 정상 |
| Agent SSE 연결 끊김 | exponential backoff (1초→2초→4초...최대 30초) |
| Agent 미응답 (heartbeat 60초 초과) | 연결 종료 → 재연결 |
| Agent 재시작 | Server 자동 재연결 (backoff 후) |
| 폴링 fallback | SSE 연결 여부와 무관하게 1초 폴링 계속 (안전망) |

### 4. 헬스체크 확장

**Agent health 응답에 추가:**
```json
{
  "hookSseClients": 1,
  "lastHookEvent": 1234567890
}
```

**Server health 응답에 추가:**
```json
{
  "hookSseConnections": {
    "macbook": "connected",
    "workstation": "disconnected"
  }
}
```

---

## 구현 순서

| Step | 파일 | 내용 | 검증 |
|------|------|------|------|
| 1 | `agent/src/claude-heartbeat.ts` | `getSession()` 메서드 추가 | 빌드 |
| 2 | `agent/src/server.ts` | `/api/claude/events` SSE 엔드포인트 + broadcastHookUpdate() | `curl` 테스트 |
| 3 | `agent/src/server.ts` | 각 hook case에 `broadcastHookUpdate()` 호출 추가 | hook 발생 시 SSE 수신 확인 |
| 4 | `server/src/machines/machine-manager.ts` | `subscribeToHookEvents()` + `handleHookSseMessage()` | 연결 + 이벤트 수신 |
| 5 | `server/src/modules/active-sessions/index.ts` | hook update 콜백으로 즉시 poll 트리거 | 프론트엔드에서 즉시 반영 확인 |
| 6 | 양쪽 health 엔드포인트 | hookSse 연결 상태 표시 | health check |
| 7 | 폴링 주기 복원 | 1초→2초 (push가 주력이므로) | 부하 감소 확인 |

---

## 리스크 & 완화

| 리스크 | 확률 | 완화 |
|--------|------|------|
| SSE 연결 불안정 (네트워크) | 중 | 폴링 fallback 유지, 재연결 backoff |
| Agent 재시작 시 SSE 끊김 | 높음 | Server 자동 재연결 + 폴링이 커버 |
| 다수 Server 동시 구독 (부하) | 낮 | Server는 1대 → 클라이언트 1개 |
| hook 이벤트 폭주 (빠른 tool 실행) | 중 | 브로드캐스트는 경량 (JSON write만) |

---

## 측정 기준 (완료 조건)

1. WAITING→WORKING 전환이 프론트엔드에서 **200ms 이내** 반영
2. `GET /api/claude/events`에 `curl`로 연결 시 hook 이벤트 실시간 수신
3. Server health에 `hookSseConnections` 표시
4. SSE 끊김 후 30초 이내 자동 재연결
5. 폴링 2초로 복원해도 동작 이상 없음
