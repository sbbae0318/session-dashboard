# ADR-002: Dark-only 테마

**Date:** 2026-04-07 (코드 역분석)
**Status:** Accepted
**Deciders:** sb

## Context

대시보드 테마 전략을 결정해야 했다. 선택지:

1. **Light + Dark** — 시스템 설정 연동 또는 토글
2. **Dark only** — 단일 다크 테마
3. **Light only** — 단일 라이트 테마

## Decision

**Dark only** 채택. GitHub Dark 계열 컬러 팔레트 (`--bg-primary: #0d1117`).

## Rationale

- **사용자 프로필**: 개발자 전용 도구. IDE/터미널 사용자 대부분 다크 테마 선호.
- **장시간 모니터링**: 대시보드를 보조 화면에 상시 표시. 다크 테마가 눈 피로도 낮음.
- **CSS 유지보수**: 테마 토글 시 모든 컴포넌트에 CSS 변수 이중 정의 필요. 단일 테마로 유지보수 비용 절반.
- **터미널 친화**: TUI 연동 (Ink 기반 `tui/`)과 시각적 일관성.

## Trade-offs

| 항목 | 득 | 실 |
|------|-----|-----|
| 유지보수 | CSS 변수 1벌만 관리 | - |
| 사용성 | - | 밝은 환경에서 가독성 감소 (드문 케이스) |
| 접근성 | - | 고대비 모드 미지원 (향후 개선 가능) |

## Implementation

- `app.css`: CSS 변수 정의 (`:root` 단일)
- 주요 변수: `--bg-primary`, `--bg-secondary`, `--text-primary`, `--accent`, `--border`
- 상태 색상: Working(파란), Waiting(노란), Idle(회색), 에러(빨간)
