# Workflow: Frontend Performance Audit

**Status:** Active
**Date:** 2026-04-10
**Frequency:** 사용자가 "느림/프리징" 보고 시 또는 정기 점검

---

## Trigger

- 사용자가 "프리징", "느림", "로딩 오래 걸림", "탭 멈춤" 등 보고
- 새 페이지/컴포넌트 추가 후 회귀 점검
- 데이터 규모 증가 후 (세션 100+ 또는 쿼리 1000+)

## Preconditions

- [ ] 운영 서버 접근 가능 (`http://192.168.0.2:3097`)
- [ ] SSH 접근 가능 (`192.168.0.2`)
- [ ] `frontend-perf.md` 도메인 지식 숙지

## Steps

### Step 1: 증상 재현 + 객관적 측정

```bash
# 1-A. API 응답 시간 + 페이로드 크기
for endpoint in "/api/sessions" "/api/queries?limit=500" "/api/machines" "/api/sessions?all=true"; do
  curl -s -o /dev/null -w "$endpoint → %{time_total}s %{size_download}B\n" \
    "http://192.168.0.2:3097$endpoint"
done

# 1-B. 데이터 규모 확인
curl -s "http://192.168.0.2:3097/api/sessions" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Sessions: {len(d[\"sessions\"])}, Payload: {len(json.dumps(d))//1024}KB')
"
```

**임계값**:
- `/api/sessions` > 100KB → 7d 필터 누락 또는 sessionMemory 누적
- `/api/queries` > 300KB → limit 과다 또는 캐시 미정리

### Step 2: SSE 페이로드 측정

```bash
curl -s -N --max-time 10 http://192.168.0.2:3097/api/events 2>/dev/null | python3 -c "
import sys, json
delta = 0
delta_bytes = 0
update = 0
update_bytes = 0
buf = ''
for line in sys.stdin:
    buf += line
    if line.strip() == '':
        if 'session.delta' in buf:
            delta += 1; delta_bytes += len(buf)
        elif 'session.update' in buf:
            update += 1; update_bytes += len(buf)
        buf = ''
print(f'session.delta: {delta} events, {delta_bytes}B avg {delta_bytes//max(delta,1)}B')
print(f'session.update: {update} events, {update_bytes}B avg {update_bytes//max(update,1)}B')
"
```

**임계값**:
- `session.update`가 0이 아니면 → delta 전환 안 됨 (cli.ts 점검)
- `session.delta` 평균 > 5KB → hash 비교 누락 (processMetrics 포함 등)

### Step 3: Svelte 안티패턴 grep

```bash
cd /Users/sbbae/project/session-dashboard

# {#each} 안의 array.find() — 가장 흔한 O(n²)
grep -B 2 "\.find(" server/frontend/src/components/**/*.svelte | grep -B 5 "{@const"

# Math.max(...spread) — stack overflow + 2회 순회
grep -rn "Math\.\(max\|min\)(\.\.\." server/frontend/src/

# bind:value + filter (debounce 누락)
grep -B 2 -A 8 "bind:value" server/frontend/src/components/**/*.svelte | grep "fuzzyMatch\|\.filter("

# 무조건 polling (SSE-aware 미적용)
grep -B 2 -A 5 "setInterval" server/frontend/src/App.svelte | grep -v "if (connected)"
```

### Step 4: 컴포넌트별 검증

| 컴포넌트 | 점검 항목 |
|---------|---------|
| `RecentPrompts.svelte` | sessionMap derived 존재? isBackgroundQuery에 sessionMap 전달? |
| `CommandPalette.svelte` | debouncedQuery 사용? sessionMap 존재? |
| `ProjectsPage.svelte` | sessionsByProject 인덱싱 derived 존재? |
| `CodeImpactPage.svelte` | Math.max spread 없음? `$derived.by` 사용? |
| `App.svelte` | refetchTimer가 connected guard 있음? visibility debounce? |
| `SummariesPage.svelte` | projectGroups 이중 정렬 — 점검 필요 |
| `TimelinePage.svelte` | fetchSessionSegments 캐시 skip — 점검 필요 |

### Step 5: 수정 적용

`frontend-perf.md`의 안티패턴별 해결안을 적용한다. **Worktree 격리** 권장:

```bash
git worktree add .claude/worktrees/perf-fix -b perf-fix-$(date +%Y-%m-%d) main
cd .claude/worktrees/perf-fix
# ...수정...
cd server/frontend && npm run build
cd ../ && npm run build && npx vitest run
git add -A && git commit -m "perf(frontend): ..."
cd /Users/sbbae/project/session-dashboard
git merge perf-fix-$(date +%Y-%m-%d) --no-edit
git worktree remove .claude/worktrees/perf-fix
git branch -D perf-fix-$(date +%Y-%m-%d)
```

### Step 6: 배포 + 측정 비교

```bash
git push
ssh sbbae@192.168.0.2 "bash -lc 'cd ~/project/session-dashboard/server && git pull && docker compose up -d --build --force-recreate'"
sleep 5
# Step 1 + Step 2 재실행하여 before/after 비교
```

## Verification

- [ ] API 응답 시간 < 50ms
- [ ] `/api/sessions` < 100KB
- [ ] `session.delta` < 5KB/event, idle 시 0 events
- [ ] 브라우저 DevTools Network 탭에서 SSE 연결 후 30초 동안 polling REST 요청 0건
- [ ] 사용자 체감 개선 확인

## Rollback

```bash
git revert <commit>
git push
ssh sbbae@192.168.0.2 "bash -lc 'cd ~/project/session-dashboard/server && git pull && docker compose up -d --build --force-recreate'"
```

## Related

- **Domain**: `.omc/knowledge/domains/frontend-perf.md` — 안티패턴 5가지 + 해결 패턴
- **Workflow**: `deploy-dashboard.md` — 배포 절차
- **PRD**: `spec/prd.md` F1.2 — 렌더링 최적화 패턴 규칙
