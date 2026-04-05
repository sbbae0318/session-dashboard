# Known Failures — session-dashboard

> 반복 방지용 실패 패턴 카탈로그. 새 버그 수정 후 `/cc-new-failure`로 추가.

**Format**: `F-NNN | 증상 | 원인 | 수정 | 심각도 | 파일`

---

## Entries

| ID | 증상 | 원인 | 수정 | 심각도 | 파일 |
|----|------|------|------|--------|------|
| F-001 | Claude 세션 rename 시 대시보드 title 지연 반영 (영구 안되는 경우 존재) | `scanProjectsForActiveSessions()`가 이미 tracked된 세션을 `continue`로 skip → JSONL의 `custom-title` 엔트리 재파싱 안 됨. fs.watch 이벤트는 트리거되나 title 업데이트 경로 없음. Hook 이벤트(heartbeat 파일 쓰기)가 발생해야만 재파싱되므로, 사용자가 rename만 하고 상호작용 안 하면 영영 반영 안 됨 | `refreshSessionFromFile(filename)` 메서드 추가: `projectsWatcher` 콜백에서 `_filename`을 활용해 변경된 JSONL 파일만 타깃팅 (O(1)). Tracked 세션이면 title만 refresh (live 필드 보존), 아니면 full scan으로 폴백 | High | `agent/src/claude-heartbeat.ts:667-705` |
