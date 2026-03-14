# Issues — header-compression

## [2026-03-10] Session Init
(No issues yet — starting fresh)

## [2026-03-10] Task-2: 테스트 검증 결과

### 유닛 테스트 (vitest run)
- **결과**: 13 파일, 157 테스트 전체 통과 ✅
- 헤더 변경으로 인한 유닛 테스트 실패 없음

### E2E 테스트 (playwright test)
- **결과**: 45 테스트 중 37 통과, 8 실패
- **핵심 셀렉터 테스트 전체 통과** ✅:
  - `dashboard.spec.ts`: `.connection-status` 가시성 → PASS
  - `machine-filter.spec.ts`: `[data-testid="machine-selector"]`, `.machine-btn` → PASS
  - `dashboard.spec.ts`: `page.toHaveTitle(/Session Dashboard/)` → PASS

### 실패한 테스트 (기존 실패 — 헤더 변경과 무관)
원본 `session-dashboard` 프로젝트에서도 동일하게 실패 확인됨:

1. `claude-real-pipeline.spec.ts:264` — Scenario B: 타임아웃 (데이터 전파 대기)
2. `claude-real-pipeline.spec.ts:383` — Scenario D: stale session 제외 로직 타이밍 이슈
3. `claude-real-pipeline.spec.ts:419` — Scenario E: 타임아웃
4. `opencode-regression.spec.ts:47` — Scenario 2: `Not Found` JSON 파싱 오류 (oc-serve 미실행)
5. `opencode-regression.spec.ts:80` — Scenario 3: ECONNREFUSED (oc-serve 미실행 — 예상된 실패)
6. `opencode-regression.spec.ts:93` — Scenario 4: `Not Found` JSON 파싱 오류
7. `opencode-regression.spec.ts:126` — Scenario 6: ECONNREFUSED (oc-serve 미실행)
8. `opencode-regression.spec.ts:141` — Scenario 8: `toSatisfy` 미지원 (playwright 버전 이슈)

### 결론
헤더 압축 변경으로 인한 회귀 없음. 실패 테스트는 모두 기존 환경 의존성 문제 (oc-serve 미실행, playwright 버전).
