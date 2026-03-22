
## [Task 7] "전체" 모드 enrichment에서 merged 엔드포인트 미사용 버그

### 증상
- "전체" 버튼 클릭 시 `/api/enrichment/merged/timeline`이 아닌 `/api/enrichment/macbook/timeline`이 호출됨
- Timeline에 "타임라인 데이터 없음" 표시

### 원인
`enrichment.ts`의 `resolveEnrichmentMachineId()` 함수:
```typescript
function resolveEnrichmentMachineId(): string | null {
  const selected = getSelectedMachineId();  // "전체" = null
  if (selected) return selected;            // null → skip
  const machines = getMachines();
  return machines[0]?.id ?? null;           // ← BUG: "macbook" 반환
}
```
- "전체" 선택 시 `getSelectedMachineId()`가 `null` 반환
- 그러나 fallback `machines[0]?.id`가 첫 번째 머신 ID를 반환
- 결과: merged 엔드포인트 절대 호출 안됨

### 수정 방안
`resolveEnrichmentMachineId()` 함수에서 "전체" 모드일 때 `null` 직접 반환:
```typescript
function resolveEnrichmentMachineId(): string | null {
  const selected = getSelectedMachineId();
  return selected;  // null이면 그대로 null 반환 → merged 엔드포인트 사용
}
```

### 발견 시점
Task 7 QA 중 Playwright 브라우저 테스트에서 network request 확인

