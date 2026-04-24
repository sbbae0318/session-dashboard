# Prompt History — Density Redesign

**Date:** 2026-04-24
**Owner:** sbbae
**Status:** Draft (brainstormed, awaiting review)

## Summary

`RecentPrompts.svelte`의 아이템 세로 공간을 약 **3배** 밀도로 압축하면서 모든 기존 정보를 보존한다. 카드 레이아웃을 행(row) 기반 **7컬럼 테이블**로 전환하고, 세로 높이를 결정하던 요소(2줄 헤더, `padding 0.75rem`, `line-height 1.6`, `gap 0.5rem`)를 제거한다. Project 식별은 색 + 첫 글자 아이콘으로 인코딩하여 시각적 추적을 가속한다. 반응형은 단일 브레이크포인트(≤600px)에서 project 이름 컬럼만 숨기고 icon·session·prompt·duration을 유지한다.

## Motivation

현재 한 아이템 ≈ 100–110px → 800px 뷰포트에 ~7개만 표시. 대시보드 주사용 케이스인 "최근 N개 프롬프트를 한눈에 스캔"에 부적합. 목표: 동일 뷰포트에서 **10–12개 이상** 표시.

## Goals

- 정보 손실 없이 row 높이를 ~30px (현재의 ≈28%)로 축소
- Project 추적을 시각적(아이콘 색)으로 가속 — 같은 repo는 어디서든 같은 색
- Git repo 이름으로 project 그룹핑 (서브폴더 흩어짐 방지)
- 반응형 (휴대폰 ≤600px) 지원

## Non-Goals

- 밀도 토글 UI (compact/comfortable 사용자 설정) — 단일 밀도 고정
- 가상 스크롤링 — 현재 리스트 규모에선 불필요
- Prompt 필터링/검색 UI 변경 — 기존 유지

## Design

### 레이아웃

**Wide (>600px)** — 7 columns:

```
[icon 24px] [project 120px] [session 140px] [prompt 1fr] [start 62px] [dur 54px] [⎘ 20px]
```

**Narrow (≤600px)** — 5 columns (project 이름 드롭, icon·session·prompt·dur 유지):

```
[icon 24px] [session 140px] [prompt 1fr] [dur 54px] [⎘ 20px]
```

**Row 규격**
- padding: `5px 12px` (wide) / `5px 10px` (narrow)
- font-size: `12.5px` · line-height: `1.4`
- row border-bottom: 1px `#21262d`
- no card border/radius, no inter-row gap
- 결과 높이: ~30px/row

### 컬럼 스펙

| 컬럼 | 폭 | 내용 | 비고 |
|---|---|---|---|
| status | 16–24 | ✓ (완료) / ⟳ (실행중) / ⚠ (에러) / ↩ (user exit) / ○ (idle) | 기존 `result` 그대로 매핑, 색으로 인코딩 |
| project | 120 | `⎇ session-dashboard` (git) / `Documents` (fallback, italic 회색) | narrow에서 숨김 |
| session | 140 | `sessionTitle` → `title` → `sessionId.slice(0,8)` (기존) | wide/narrow 모두 표시, 링크(click = filter) |
| prompt | 1fr | 기본 1-line ellipsis. hover/expanded 시 multi-line wrap | 세로 방향만 자람 |
| start | 62 | `HH:MM:SS` monospace | narrow에서 숨김 |
| dur | 54 | `formatDuration(completionTs - timestamp)` 진행 중=`—` | wide/narrow 모두 표시 |
| copy | 20 | ⎘ resume 명령 복사 (기존 동작) | wide/narrow 모두 표시 |

### Project Icon

20×20 monogram, 결정론적 생성:

- **색**: `djb2(projectRepo) % palette.length` — 8색 팔레트 (`#58a6ff`, `#f78166`, `#3fb950`, `#d29922`, `#bc8cff`, `#f85149`, `#39c5cf`, `#8b949e`). djb2 = `name.split('').reduce((h,c) => ((h << 5) + h + c.charCodeAt(0)) & 0xffffffff, 5381)`. 같은 repo는 세션이 달라도 같은 색.
- **글자**: `projectRepo[0].toLowerCase()` — 예: `session-dashboard` → `s`, `oh-my-claudecode` → `o`, fallback(non-git) → `?`
- **source 인디케이터**: 아이콘 우하단 6px dot — `claude=#a871ff`, `opencode=#3fb950` — 기존 텍스트 badge(`Claude`/`OpenCode`)를 대체
- **title 툴팁**: `{projectRepo} · {source} · {machineAlias}`

### Project 해석 (백엔드 확장)

1. **우선**: agent가 `git rev-parse --show-toplevel` 호출 → `basename` 저장
2. **fallback**: `projectCwd.split('/').pop()` (git이 아니면, italic+회색으로 렌더, `⎇` prefix 없음)

구현:

- `agent/src`에 `GitRepoResolver` — per-cwd memoized 캐시. 세션 첫 등장 시 1회 `git rev-parse --show-toplevel` 실행, 결과를 메모리 캐시.
- `api-contract.ts`의 `DashboardSession`에 `projectRepo?: string` 필드 추가. 없으면 프론트엔드는 fallback.
- `QueryEntry`도 `projectRepo?: string` 추가 (세션 lookup 없이 렌더 가능하도록).
- 서브폴더 세션(예: `session-dashboard/agent`)도 루트 repo 이름(`session-dashboard`)으로 그룹됨 → 같은 색 아이콘.

### Interaction

| 이벤트 | 동작 |
|---|---|
| row hover | prompt 컬럼만 `white-space: normal` → multi-line wrap. 다른 컬럼 폭은 불변. |
| row click | 기존 동작 유지: response area inline 확장 + 페칭 |
| project icon click | **신규** — 해당 `projectRepo`로 필터 (동일 repo의 모든 세션) |
| session name click | 기존 — 해당 `sessionId`로 필터 |
| copy 버튼 | 기존 — resume 명령 복사 |
| 키보드 | j/k/↑↓ 이동, Enter/e expand, c copy, gg/G top/bottom, Escape collapse (기존 유지) |

### State Encoding

- **in-progress** → row 배경 gradient `linear-gradient(90deg, rgba(88,166,255,0.1), transparent 60%)` + 기존 pulse 애니메이션 유지
- **background query** → `opacity 0.75` + 좌측 2px 회색 border (기존 유지, 행 기반으로 재구현)
- **focused (keyboard j/k)** → outline `2px rgba(88,166,255,0.6)`, offset `-1px` (기존 유지)
- **expanded (response 펼침)** → row에 `expanded` 클래스, prompt multi-line 유지 + response area 아래 삽입

## Information Preservation Audit

| 현재 정보 | 신규 위치 | 손실 |
|---|---|---|
| session title | `session` 컬럼 (wide+narrow) | 없음 |
| timestamp | `start` 컬럼 (HH:MM:SS) | narrow에서 숨김 (hover로 복원 가능하지만 non-goal) |
| duration | `dur` 컬럼 | 없음 |
| prompt text | `prompt` 컬럼 + hover multi-line | 없음 |
| machine alias | icon 툴팁 (multi-machine 시에만) | 시각적 배지 → 툴팁으로 후퇴 (허용) |
| result badge (✓/⚠/↩/○/⟳) | `status` 컬럼 | 없음 |
| source (Claude/OpenCode) | icon 우하단 dot | 텍스트 → 색 인코딩으로 변경 |
| copy button | `copy` 컬럼 | 없음 |
| project (신규) | `project` 컬럼 + icon | — (추가 정보) |

## Testing

**단위 테스트** (`server/frontend/src/lib/__tests__/`):

- `projectIcon.test.ts` — `colorFor(name)`·`letterFor(name)` 결정론적 검증 (같은 입력 = 같은 출력)
- `projectRepo.test.ts` — git 있을 때 repo 이름 / 없을 때 fallback 분기

**E2E 테스트** (`server/e2e/ui/`):

- `prompt-history-density.spec.ts`:
  - 10개 프롬프트 렌더 시 row 높이 ≤ 40px
  - hover 시 prompt 컬럼 multi-line 확장, 다른 컬럼 폭 불변
  - click 시 response area 확장 (기존 테스트 갱신)
  - icon click → project 필터 적용
  - ≤600px 뷰포트에서 project 컬럼 숨김, session 컬럼 유지
- `prompt-history-project-icon.spec.ts`: 같은 projectRepo를 가진 세션들이 같은 색 아이콘을 받음

**Backend 테스트** (`agent/src/__tests__/`):

- `git-repo-resolver.test.ts` — git repo 탐지, non-git fallback, 캐싱 hit 검증

## Rollback

- Feature flag 불필요 — CSS + 컴포넌트 변경이 격리됨
- `projectRepo` 필드는 optional, 프론트엔드 fallback으로 안전
- 기존 E2E 회귀: `prompt-history-*.spec.ts`가 모두 새 DOM 구조로 업데이트 필요. 실패 시 revert는 RecentPrompts.svelte 및 agent의 GitRepoResolver 두 파일만 되돌리면 됨.

## Out of Scope (후속 작업 후보)

- compact/comfortable density 토글 사용자 설정
- virtual scroll (리스트 1000+ 규모가 되면 재검토)
- project icon 커스터마이징 (이름→색 매핑 override)
- narrow 뷰포트에서 start time 복원 (툴팁 or 두 번째 줄)
