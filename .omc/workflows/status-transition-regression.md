# Workflow: 상태 전환 Regression 테스트

> 세션 상태 판별 + flash 감지 로직의 정합성을 검증하는 반복 가능한 워크플로우.

**Trigger**: 상태 판별 관련 코드 변경 시, 또는 주기적 정합성 확인
**파일**: `server/frontend/src/lib/utils.ts` (getDisplayStatus, detectStatusChanges)
**테스트**: `server/frontend/src/lib/__tests__/utils.test.ts`

---

## 자동 테스트 (Unit)

```bash
cd server && npx vitest run frontend/src/lib/__tests__/utils.test.ts
```

**검증 항목** (16개 케이스):

### getDisplayStatus — 상태 판별 (7개)

| # | 입력 | 기대 결과 |
|---|------|----------|
| 1 | apiStatus=busy, !waiting | Working |
| 2 | currentTool=Bash, !waiting | Working |
| 3 | apiStatus=retry | Retry (cssClass=status-working) |
| 4 | waiting=true, apiStatus=busy | **Waiting** (busy보다 우선) |
| 5 | waiting=true, currentTool=Bash | **Waiting** (tool보다 우선) |
| 6 | apiStatus=null, tool=null, !waiting | Idle |
| 7 | apiStatus=idle | Idle |

### detectStatusChanges — 전환 감지 (9개)

| # | 전환 | flash 기대 |
|---|------|-----------|
| 1 | idle → working | Yes |
| 2 | working → idle | Yes |
| 3 | idle → waiting | Yes |
| 4 | **waiting → working** | **Yes** |
| 5 | working → waiting | Yes |
| 6 | waiting → idle | Yes |
| 7 | 상태 변경 없음 | No |
| 8 | 새 세션 (이전 상태 없음) | No |
| 9 | 복수 세션 동시 전환 | 변경된 것만 Yes |

---

## 수동 검증 (Live)

상태 전환을 실제로 유발하여 대시보드에서 flash 확인:

### idle → working
```bash
# 아무 Claude Code 세션에서 프롬프트 입력
# 대시보드에서 Idle→Working 뱃지 반짝임 확인
```

### working → waiting
```bash
# Claude Code에서 tool 실행 시 permission prompt 표시 (auto-approve off)
# 대시보드에서 Working→Waiting 뱃지 반짝임 확인
```

### waiting → working
```bash
# permission prompt에서 승인
# 대시보드에서 Waiting→Working 뱃지 반짝임 확인
# ⚠️ 주의: 승인이 2초 이내면 프론트엔드가 Waiting 상태를 못 볼 수 있음 (SSE 폴링 한계)
```

### working → idle
```bash
# Claude Code 작업 완료 대기
# 대시보드에서 Working→Idle 뱃지 반짝임 확인
```

---

## 관련 파일

- 상태 판별: `server/frontend/src/lib/utils.ts` (getDisplayStatus, detectStatusChanges)
- 컴포넌트: `server/frontend/src/components/ActiveSessions.svelte` (flash $effect + CSS)
- 테스트: `server/frontend/src/lib/__tests__/utils.test.ts`
- 스펙: `.omc/spec/prd.md` (Feature 1.1 — Status badge)
- Known failure: F-003 (hooks vs JSONL race condition)
