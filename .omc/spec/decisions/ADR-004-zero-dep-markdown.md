# ADR-004: Zero-dependency Markdown 렌더러

**Date:** 2026-04-07 (코드 역분석)
**Status:** Accepted
**Deciders:** sb

## Context

프롬프트 응답을 Markdown으로 렌더링해야 했다. 선택지:

1. **marked** — 인기 Markdown 파서 (43KB min)
2. **markdown-it** — 플러그인 확장 가능 (102KB min)
3. **Custom renderer** — 필요한 기능만 직접 구현

## Decision

**Custom renderer** (`markdown.ts`) 채택. 외부 의존성 0개.

## Rationale

- **필요 기능 제한적**: 코드 블록, 인라인 서식, 리스트, 테이블, 헤더, 링크만 필요. 수학 수식, footnote 등 불필요.
- **Code block folding**: 8줄 초과 코드 블록을 `<details>` 태그로 자동 접는 커스텀 기능이 핵심 요구사항. 외부 라이브러리에서 이 동작을 구현하려면 post-processing 또는 플러그인 작성 필요.
- **번들 크기**: 커스텀 렌더러 ~200줄 vs marked 43KB. Docker 이미지 크기 및 초기 로드에 영향.
- **보안**: HTML 이스케이프를 직접 제어. XSS 벡터를 최소화.

## Trade-offs

| 항목 | 득 | 실 |
|------|-----|-----|
| 번들 크기 | ~5KB vs 43-102KB | - |
| 기능 커버리지 | - | 비표준 Markdown 미지원 (nested blockquote, footnote 등) |
| 유지보수 | - | 새 Markdown 기능 추가 시 직접 구현 |
| Code folding | 네이티브 지원 | - |

## Supported Features

- Fenced code blocks (언어 라벨 + 8줄 초과 자동 접힘)
- Inline code, bold, italic, links
- Ordered/unordered lists
- Pipe-delimited tables
- Horizontal rules
- Headers (h3-h6, Markdown 레벨 +2 시프트)
- HTML escaping
