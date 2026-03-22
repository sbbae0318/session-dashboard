# Enrichment Pipeline — Learnings

## [2026-03-15] Phase 1 결과 (완료됨)

### 배포 환경
- 서버: `192.168.0.2`, 포트: `3097`
- SSH: `ssh sbbae@192.168.0.2`
- 배포 경로: `/home/sbbae/project/session-dashboard`
- Docker: `cd server && docker compose build --no-cache && docker compose up -d --force-recreate`
- main repo: `/Users/sbbae/project/session-dashboard`
- Phase 2 worktree: `/Users/sbbae/project/session-dashboard-enrichment-pipeline`

### 아키텍처 패턴
- CSS는 기존 CSS 변수 사용 (Tailwind 금지)
- `as any` / `@ts-ignore` 금지
- agent/frontend 변경을 같은 커밋에 섞기 금지
- agent/src 원본 타입(TimelineEntry 등) 변경 금지

### better-sqlite3 참고
- agent에서 이미 사용 중: `agent/package.json` 참고
- Docker Alpine 빌드: python3/make/g++ 필요
- WAL mode + synchronous=NORMAL 권장
- `INSERT OR REPLACE` 금지 → `ON CONFLICT DO UPDATE` 사용

### machines.yml (192.168.0.2 서버)
- `macbook`: 192.168.0.63:3098, alias "MacBook Pro"
- `workstation-local`: host.docker.internal:3098

### Phase 1 발견 사항 (참고용)
1. NaN 버그: `''` 빈 문자열에 `??` 연산자 사용 → `|| '0'` 패턴 사용
2. Svelte 키 중복: composite key `${id}-${machineId}` 패턴 사용
3. enrichment store의 `resolveEnrichmentMachineId()` = `getSelectedMachineId()` 래퍼

## [2026-03-15] T12: Build + Deploy + QA
- 배포 완료: 192.168.0.2:3097
- Docker 재기동 후 데이터 유지: before 1098 → after 1098 (100% 보존)
- 24h payload: 47.4KB (< 50KB 기준 통과, 기존 390KB → 47.4KB 약 88% 감소)
- 5개 탭: Tokens, Impact, Timeline, Projects, Recovery 모두 정상
- SSE: enrichment.cache, machine.status, session.update 이벤트 정상 수신
- 주의: Docker 호스트 data/ 디렉토리 권한 필요 (chmod 777) — 컨테이너가 uid 1001 (nodejs)로 실행되므로 호스트의 uid 1000 (sbbae) 소유 디렉토리에 쓰기 불가
