# Claude Code Parity — Issues & Gotchas

## [2026-03-11] Known Issues

### machine-manager.ts 버그 (T5에서 수정)
- `lastPrompt: null` 하드코딩 (line ~407)
- `lastPromptTime: startTime` 잘못된 대입 (line ~408)

### ClaudeQueryEntry 타입 불일치 (T4에서 수정)
- `completedAt` 필드 없음
- `source` 타입이 literal 'opencode'만 허용

### pid=0 세션 처리
- `scanProjectsForActiveSessions()`에서 발견된 세션은 pid=0
- PID 체크 스킵해야 함 (pid <= 0 → false 반환)

### EPERM 처리
- `process.kill(pid, 0)` 시 EPERM = 다른 유저의 프로세스 = 살아있음
- ESRCH = 프로세스 없음 = 죽음

### Title은 head-read 필요
- 첫 번째 user message에서 추출
- 세션 생성 후 불변 → 캐싱 가능
