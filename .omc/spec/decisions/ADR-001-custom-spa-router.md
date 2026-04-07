# ADR-001: Custom SPA Router (SvelteKit 대신)

**Date:** 2026-04-07 (코드 역분석)
**Status:** Accepted
**Deciders:** sb

## Context

프론트엔드 라우팅 방식을 결정해야 했다. 선택지:

1. **SvelteKit** — Svelte 공식 풀스택 프레임워크 (파일 기반 라우팅, SSR)
2. **svelte-routing** — 경량 SPA 라우터 라이브러리
3. **Custom router** — URL query params + `popstate` 직접 구현

## Decision

**Custom router** (`navigation.svelte.ts`) 채택.

URL query params 기반 (`?view=token-cost`, `?session={id}`), `history.pushState` / `popstate` 직접 제어.

## Rationale

- **SSR 불필요**: 대시보드는 인증된 LAN 내부에서만 접근. SEO, 초기 로드 최적화 무의미.
- **서버 통합**: 백엔드 Fastify가 이미 `/api/*` 라우팅 소유. SvelteKit의 서버 레이어와 중복.
- **빌드 단순성**: Vite + `svelte` 플러그인만으로 빌드. SvelteKit의 adapter 설정 불필요.
- **배포 단순성**: Docker 내 `dist/public/` 정적 파일 서빙. SvelteKit Node adapter 불필요.
- **뷰 수 제한적**: 9개 뷰로 파일 기반 라우팅의 이점이 크지 않음.

## Trade-offs

| 항목 | 득 | 실 |
|------|-----|-----|
| 번들 크기 | 라우터 라이브러리 0KB | - |
| 유지보수 | - | 스크롤 위치 복원, 히스토리 관리 직접 구현 필요 |
| 확장성 | - | 뷰 10개+ 시 수동 관리 부담 증가 |
| SSR | - | 향후 SSR 필요 시 마이그레이션 비용 높음 (가능성 낮음) |

## Implementation

- `navigation.svelte.ts`: 상태 관리 + URL 동기화
- `App.svelte`: `{#if currentView === '...'}` 조건부 렌더링
- URL 형식: `?view=X` (페이지) / `?session=X` (세션 디테일) / 파라미터 없음 (오버뷰)
- 스크롤 위치: `.main-content` scrollTop 저장/복원
