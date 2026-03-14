## [2026-03-09] Plan: session-timestamps 초기 분석

### JSONL timestamp 형식
- 각 엔트리: `{"type": "user"|"assistant", "timestamp": "2026-03-08T16:08:50.930Z", ...}`
- 파싱: `new Date(entry.timestamp as string).getTime()` → ms (숫자)
- `type: 'last-prompt'` 엔트리는 timestamp 없음 (null) → 건너뜀

### 데이터 파이프라인
- Claude Code: agent(claude-heartbeat.ts) → machine-manager(fetchClaudeSessions) → active-sessions(buildSessionMap) → 프론트
- OpenCode: oc-serve SSE캐시(CachedSessionDetail.lastPromptTime) → machine-manager(fetchSessionDetails) → active-sessions(buildSessionMap) → 프론트

### 기존 타임스탬프 버그 수정 완료 (commit 799e2cb)
- `buildSessionMap`에서 Claude Code 세션 `startTime`/`lastActivityTime`이 `Date.now()` 폴백되던 문제
- `isClaudeCode` 분기로 `s.startTime`/`s.lastHeartbeat` 사용하도록 수정

### CachedSessionDetail 필드 (OpenCode용, 이미 존재)
```typescript
interface CachedSessionDetail {
  status: 'busy' | 'idle' | 'retry';
  lastPrompt: string | null;
  lastPromptTime: number;      // ← query 전송 시각 (ms)
  currentTool: string | null;
  directory: string | null;
  updatedAt: number;           // ← 마지막 업데이트 시각 (≈ completion time)
}
```

### RecentPrompts 표시 방식 (참고)
- `{formatTimestamp(entry.timestamp)} → {formatTimestamp(completionTs)}`
- `completionTs` = cards(HistoryCard.endTime) 에서 추출, null이면 dot-loader 표시
- Session list에서는 cards 대신 `lastActivityTime`(idle 시 ≈ 완료)을 사용할 예정

### Docker 재빌드 필요
- 서버는 Docker 컨테이너로 실행 중 (`session-dashboard` 컨테이너)
- `cd server && docker compose build && docker compose up -d` 로 재시작
- agent는 로컬에서 직접 실행 중 (PID 68266), `npm run build` 후 재시작 필요
