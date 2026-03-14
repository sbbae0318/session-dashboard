# Claude Code Parity — Decisions

## [2026-03-11] Architectural Decisions

### G10 재정의: tail-read → single-pass extraction
- 5x 중복 파일 읽기 제거가 핵심
- `parseConversationFile()` 함수 하나로 모든 필드 추출

### TTL 이중 조건
- PID alive → TTL 무시 (evict 안 함)
- PID dead (또는 pid=0) + TTL 초과 → evict
- `lastFileModified`도 activity signal로 사용

### Plugin Architecture
- 별도 플랜으로 분리 결정 (이번 플랜 scope OUT)

### 시스템 프롬프트 필터링
- `session-cache.ts`의 `isSystemPrompt()` 수정 금지 (OpenCode 경로)
- `prompt-extractor.ts`의 `extractUserPrompt()` 재사용

### QueryEntry.source 타입 확장
- `'opencode'` → `'opencode' | 'claude-code'`
- OcQueryCollector 내부 로직 변경 금지
