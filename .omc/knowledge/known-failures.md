# Known Failures — session-dashboard

> 반복 방지용 실패 패턴 카탈로그. 새 버그 수정 후 `/cc-new-failure`로 추가.

**Format**: `F-NNN | 증상 | 원인 | 수정 | 심각도 | 파일`

---

## Entries

| ID | 증상 | 원인 | 수정 | 심각도 | 파일 |
|----|------|------|------|--------|------|
| F-001 | Claude 세션 rename 시 대시보드 title 지연 반영 (영구 안되는 경우 존재) | `scanProjectsForActiveSessions()`가 이미 tracked된 세션을 `continue`로 skip → JSONL의 `custom-title` 엔트리 재파싱 안 됨. fs.watch 이벤트는 트리거되나 title 업데이트 경로 없음. Hook 이벤트(heartbeat 파일 쓰기)가 발생해야만 재파싱되므로, 사용자가 rename만 하고 상호작용 안 하면 영영 반영 안 됨 | `refreshSessionFromFile(filename)` 메서드 추가: `projectsWatcher` 콜백에서 `_filename`을 활용해 변경된 JSONL 파일만 타깃팅 (O(1)). Tracked 세션이면 title만 refresh (live 필드 보존), 아니면 full scan으로 폴백 | High | `agent/src/claude-heartbeat.ts:667-705` |
| F-002 | 비활성 세션이 "Working"으로 영구 표시 (hooksActive=true인 idle 세션) | stale busy guard가 `!hooksActive` 조건으로 hooks-fire 이력 있는 세션 면제 → Stop/idle_prompt hook 누락 시 10분 guard 미작동 | `!hooksActive` 조건 제거 — lastActivityTime 기준으로만 판단 | High | `server/src/modules/active-sessions/index.ts:190-194` |
| F-003 | Working 세션이 간헐적으로 IDLE 깜빡임 (수초 내 복구) | readHeartbeatFile/refreshSessionFromFile의 JSONL 파싱이 hook-set status/currentTool/waitingForInput 덮어씀 (text-only assistant → 'idle' 파싱 vs hooks 'busy' race condition) | hooks active 시 hooks를 status 권한자로, JSONL은 fallback으로만 사용 | Medium | `agent/src/claude-heartbeat.ts:428-456, 716-724` |
| F-004 | 세션 뱃지 Working인데 프롬프트 스피너 미표시 (반복 발생) | 프롬프트 스피너 busy 판정(`apiStatus==='busy' ∨ status==='active'`)이 세션 뱃지 판정(`apiStatus∈{busy,retry} ∨ currentTool ∧ ¬waiting`)과 불일치. Hook이 `currentTool`만 먼저 세팅하고 `apiStatus`가 아직 null인 타이밍에 발생 | `getQueryResult`, `busySessions`, `isSessionBusy` 조건을 `getDisplayStatus`와 동일하게 정렬: `(apiStatus∈{busy,retry} ∨ currentTool) ∧ ¬waitingForInput` | High | `server/frontend/src/lib/utils.ts:41-57`, `server/frontend/src/components/RecentPrompts.svelte:59-63,338` |
| F-005 | Esc interrupt 후 대시보드 Working 유지 (idle 전환 안 됨) | Claude Code가 Esc interrupt 시 Stop hook 미발사. JSONL에 `stop_reason: "stop_sequence"` 기록되지만 `hooksActive=true` 가드(F-003)가 JSONL 상태 갱신 차단 | `parseConversationFile`에 `interrupted` 플래그 추가. `refreshSessionFromFile`에서 `interrupted && status==='idle'`이면 hooksActive 가드 예외 → idle 전환 + currentTool/waitingForInput 초기화. F-003 보호는 유지 (일반 busy/idle 전환은 여전히 hooks 우선) | High | `agent/src/claude-heartbeat.ts:538,563,629,735-742` |
