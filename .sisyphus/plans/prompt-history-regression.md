# Plan: prompt-history-regression

## Goal
`oc-query-collector.ts`의 `break` 버그를 수정하여 장기 실행 세션의 최신 프롬프트가
PROMPT HISTORY에 표시되도록 한다. 관련 단위 테스트를 수정하고 Regression Test를 추가한다.

## Root Cause
`collectFromSession()`에서 세션당 첫 번째 유효 user 메시지만 수집 후 `break`로 중단.
장기 세션(MacBook)은 최초 프롬프트(몇 시간 전)만 수집되어 최신 프롬프트가 보이지 않음.

## Fix Strategy
`break` 제거 → 세션당 **마지막** 유효 user 메시지 수집 (lastEntry 패턴).
`INSERT OR REPLACE` + 안정적 타임스탬프 덕분에 중복 없음.

## Tasks

- [ ] 코드 수정: `agent/src/oc-query-collector.ts` — break → lastEntry 패턴
- [ ] 단위 테스트 수정: `agent/src/__tests__/oc-query-collector.test.ts` — 4개 수정 + 새 describe block
- [ ] Regression Test 추가: `server/e2e/opencode-regression.spec.ts` — Scenario 8
- [ ] 검증: agent npm test + TypeScript 타입 체크

## Key Files
- `agent/src/oc-query-collector.ts` (L141-191): collectFromSession()
- `agent/src/__tests__/oc-query-collector.test.ts` (L36, L165, L316, L393)
- `server/e2e/opencode-regression.spec.ts`
