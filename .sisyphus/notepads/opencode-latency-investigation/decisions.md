# Decisions — opencode-latency-investigation

## 2026-03-10: Instrumentation Approach
- **결정**: Fork + Patch (`git diff` 포맷 패치 파일 생성)
- **이유**: 소스를 복사하지 않고 apply/reverse apply로 깨끗한 적용/제거 가능
- **타이머**: `Bun.nanoseconds()`

## 2026-03-10: Deliverable Scope
- **결정**: 계측 패치 + 분석 도구 + 분석 리포트만 (개선 PR 아님)
- **이유**: 사용자 요청 "측정 + 분석 리포트"

## 2026-03-10: Worktree
- **결정**: `/Users/sbbae/project/session-dashboard` 메인 워크트리 사용
- **이유**: investigate/ 프로젝트는 새 독립 디렉터리로 생성됨. session-dashboard worktree 내에서 커밋

## 2026-03-10: Log Format
- JSON Lines (`.jsonl`), 스키마:
  ```json
  {"phase": string, "startNs": number, "endNs": number, "durationMs": number, "step": number, "metadata": object}
  ```
