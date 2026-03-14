# Learnings — header-compression

## [2026-03-10] Session Init

### E2E Selector Safety Analysis
- `page.toHaveTitle(/Session Dashboard/)` → `<title>` 태그 체크, h1이 아님 → h1 제거 안전
- `.connection-status` → 클래스 가시성만 체크, 텍스트 내용 미참조 → dot만 표시 가능
- `.source-filter-btn:has-text("Claude")` → 버튼 텍스트 유지 필수
- `[data-testid="machine-selector"]` → data-testid 유지 필수
- `.machine-btn` → 클래스명 유지 필수

### CSS Style Distribution (3 locations)
- `server/frontend/src/app.css`: `.dashboard-header` (L48-55), `main` (L35-43), mobile breakpoint (L267-326)
- `server/frontend/src/App.svelte` `<style>`: `.source-filter` (L184-189), `.source-filter-btn` (L191-201)
- `server/frontend/src/components/MachineSelector.svelte` `<style>`: `.machine-selector` (L37-46), `.machine-btn` (L48-62), mobile (L90-99)

### Current Measurements
- Desktop (MachineSelector 미표시): ~129px
- Desktop (MachineSelector 표시 시): ~166px
- Target: ~35-40px (1줄 toolbar)

### File Line Numbers (as of plan creation)
- App.svelte HTML: L107-132 (header, MachineSelector, source-filter)
- App.svelte scoped CSS: L179-220
- app.css header: L48-67
- app.css main: L35-43
- app.css mobile breakpoint: L267-326
- MachineSelector.svelte CSS: L36-100

## [2026-03-10] Header Compression 실행 결과

### 성공 패턴
- `<svg class="dashboard-icon">` 스타일은 Svelte 빌드 시 "Unused CSS selector" warning 발생 가능 (SVG 요소에 scoped CSS 적용 시 정적 분석 false positive). 빌드 자체는 성공.
- App.svelte HTML에서 MachineSelector와 source-filter를 header 안으로 이동하면, 별도 행이 사라지고 main의 flex column에서 공간이 회수됨.
- `.source-filter`에 `margin-left: auto` 추가로 toolbar 우측 정렬 자연스럽게 처리됨.
- MachineSelector `.machine-selector`에서 `background`, `border-bottom`, `padding`, `overflow-x` 제거 후 `inline-flex`로 변경하면 header 내 inline 통합이 완성됨.

### 빌드 환경
- `npx vite build` 직접 실행 시 vite 패키지 없어 실패 → `npm install && npm run build` 사용 필요
- worktree에서도 `node_modules`가 없는 경우 주의

## [2026-03-10] 배포 완료

### 배포 결과
- feat/header-toolbar-compress → main Fast-forward merge 성공 (커밋 1527761)
- 테스트 서버(192.168.0.63:3097): Docker 재빌드 성공, HTTP 200 ✅
- 운영 서버(192.168.0.2:3097): git pull + Docker 재빌드 성공, HTTP 200 ✅

### 배포 패턴
- 테스트 서버는 로컬 머신이므로 직접 `docker compose up -d --build` 실행
- 운영 서버는 SSH로 `git pull origin main && cd server && docker compose up -d --build` 원격 실행
- frontend-only 변경이므로 agent 재시작 불필요
- Docker 빌드 시 frontend-builder 단계만 재빌드, backend-builder는 CACHED 활용
