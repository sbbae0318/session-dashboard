# Decisions

## [2026-03-10] Plan Confirmed

- 상태 모델: Working / Waiting / Idle (3단계)
- Waiting 감지: ToolStatePending + permission.updated SSE
- 삭제 감지: session.deleted SSE (1차) + REST /session/{id} 404 fallback (2차, 60초)
- Retry: Working의 변형 (별도 상태 아님, badge 텍스트만 다름)
- Claude Code: OpenCode 전용 로직(pending/permission) 적용 금지
- SQLite 테이블명: `session_status` (sessions 아님 - Momus 지적 수정 완료)
