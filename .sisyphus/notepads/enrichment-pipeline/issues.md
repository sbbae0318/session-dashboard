# Enrichment Pipeline — Issues & Gotchas

## [2026-03-15] Pre-existing LSP errors (NON-BLOCKING)

Svelte language server가 `.svelte.ts` 파일을 `.svelte`로 임포트할 때 에러 표시.
예: `machine.svelte.ts`를 `import { onMachineChange } from '../../lib/stores/machine.svelte'`로 임포트.
이는 Svelte의 Vite 빌드에서는 정상 동작. LSP 이슈일 뿐, 실제 빌드에는 영향 없음.

## [2026-03-15] Dockerfile better-sqlite3 네이티브 빌드

better-sqlite3는 C++ 네이티브 addon. Alpine에서 빌드하려면:
- `python3`, `make`, `g++` 필요
- 옵션 1: 두 스테이지(backend-builder, production) 모두에 apk add
- 옵션 2: backend-builder에서 빌드 후 production 스테이지에서 node_modules 복사 (build tools 불필요)
  - backend-builder에서: `npm ci && npm prune --omit=dev`
  - production에서: `COPY --from=backend-builder /app/node_modules ./node_modules`
  - 이 방법이 더 clean (production 이미지 크기 감소)
- T1 subagent가 최소 변경으로 어느 방법이든 택할 수 있음

## [2026-03-15] UPSERT 패턴 필수

`INSERT OR REPLACE` 는 내부적으로 DELETE+INSERT 수행 → rowid 변경, WAL 비효율
반드시 `INSERT INTO ... ON CONFLICT DO UPDATE SET ...` 패턴 사용

## [2026-03-15] Docker non-root user

현재 Dockerfile에서 `addgroup/adduser nodejs` 생성 후 `USER nodejs`
`/app/data` 디렉토리는 production 스테이지에서 생성 필요:
```dockerfile
RUN mkdir -p /app/data && chown nodejs:nodejs /app/data
```
또는 node_modules 복사 방식이면 RUN 전에 USER를 잠시 root로 설정

## [2026-03-15] server/package.json 타입 설정

server는 `"type": "module"` (ESM). better-sqlite3는 CJS 패키지이나 ESM에서 import 가능.
`import Database from 'better-sqlite3'` 패턴 사용.

## [2026-03-15] F3 Fix: merged tokens 정규화
- 문제: fetchTokenStats()가 MergedTokensData를 그대로 store에 저장
- 수정: merged 모드에서 machines[].data.sessions를 flat하게 합쳐 TokensData로 정규화
- Impact/Projects/Recovery는 이미 배열 반환으로 정상 동작

## [2026-03-15] F3 Fix: each_key_duplicate in TokenCostPage (2차 버그)
- 문제: getProjectRows()가 full path를 Map key로 사용 → 다른 머신의 동일 프로젝트 short name이 중복
  - 예: macbook의 `/Users/sbbae/project/bae-settings`와 workstation의 `/home/sbbae/project/bae-settings`가
    각각 다른 Map 엔트리가 되지만 row.name은 둘 다 `project/bae-settings`
  - Svelte 5의 {#each ... (row.name)} 에서 each_key_duplicate 에러 발생
  - 이 에러는 console error로 표시되지만 렌더링도 실패시켜 tokenLoading이 stuck됨
- 수정: Map key를 projectLabel() 결과로 변경 → 동일 short name을 가진 프로젝트 자동 병합
- 교훈: merged 모드에서 여러 머신이 동일 상대 경로 프로젝트를 가질 수 있으므로,
  short name 기반 key 사용이 올바른 집계 방식
