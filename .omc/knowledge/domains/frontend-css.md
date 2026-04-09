# Domain: Frontend CSS & Animation

> 프론트엔드 CSS 아키텍처, 애니메이션 규칙, Svelte 5 주의사항.

## CSS 파일 구조

| 파일 | 역할 | 스코핑 |
|------|------|--------|
| `server/frontend/src/app.css` | 글로벌 스타일 + **애니메이션 전용** | 없음 (글로벌) |
| 각 `.svelte` 컴포넌트 `<style>` | 레이아웃/색상/폰트 등 | Svelte 자동 스코핑 (`:where(.svelte-HASH)`) |

## 핵심 규칙: @keyframes는 반드시 app.css (F-007)

**Svelte 5 컴포넌트 `<style>` 내 `@keyframes` 정의 금지.**

- Svelte 5가 `@keyframes` 이름에 해시 접두사(`svelte-HASH-name`) 추가
- headless Chrome(Playwright)에서는 `getComputedStyle`이 정상 보고 → 진단 혼란
- **실제 브라우저에서 시각적 렌더링 미적용** (Chrome, Safari 등 모두)
- 순수 HTML/CSS(`test-animation.html`)로 격리 확인하여 Svelte 스코핑 특정

### 올바른 패턴

```css
/* app.css — 글로벌 */
@keyframes dot-bounce { ... }
.dot-loader span { animation: dot-bounce 1.4s ease-in-out infinite; }
```

```svelte
<!-- Component.svelte — HTML만, 애니메이션 CSS 없음 -->
<span class="dot-loader"><span></span><span></span><span></span></span>
```

### 금지 패턴

```svelte
<style>
  /* ❌ Svelte가 스코핑하여 실제 브라우저에서 미동작 */
  @keyframes dot-bounce { ... }
  .dot-loader span { animation: dot-bounce 1.4s ...; }
</style>
```

## 글로벌 애니메이션 목록 (app.css)

| 클래스 | keyframes | 용도 | 크기 |
|--------|-----------|------|------|
| `.dot-loader` | `dot-bounce` | Working 상태 스피너 | 4px dots, 3px gap |
| `.dot-loader-sm` | `dot-bounce` | 결과 뱃지 내 소형 스피너 | 3px dots, 2px gap |
| `.status-flash` | `badge-flash` | 상태 전환 시 뱃지 펄스 | brightness+scale 1.2s |

## 사용 컴포넌트

| 컴포넌트 | dot-loader | dot-loader-sm | status-flash |
|----------|:---:|:---:|:---:|
| ActiveSessions | ✓ | | ✓ |
| SessionCards | ✓ | | ✓ |
| RecentPrompts | ✓ | ✓ | |
| PromptDetailModal | ✓ | | |

## 진단 도구

- `server/frontend/public/test-animation.html` — 순수 HTML/CSS 애니메이션 5종 + `prefers-reduced-motion` 감지
- 접속: `http://<server>:3097/test-animation.html`
- Svelte vs 브라우저 문제 격리에 사용

## prefers-reduced-motion

**`prefers-reduced-motion` 규칙 제거됨 (480bf80)** — 실제 브라우저에서 이 미디어 쿼리가 예상치 않게 매칭되어 `animation:none` 적용되는 문제 발생. headless Chrome은 기본 `no-preference`라 진단 불일치. 스피너/flash는 핵심 상태 표시이므로 항상 애니메이션 유지.

## Docker 배포 주의사항

프론트엔드 CSS 변경 후 Docker 배포 시:
```bash
# ❌ 불충분 — 캐시된 이미지 서빙될 수 있음
docker compose up -d --build
docker compose build --no-cache && docker compose up -d

# ✅ 확실한 방법
docker compose down && docker compose up -d --build --force-recreate
```

배포 후 확인: `curl -s http://host:3097/ | grep 'assets/index-'` — CSS 해시가 변경되었는지 검증.
