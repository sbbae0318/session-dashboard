# ADR-005: Svelte 5 Runes + Svelte 4 Store 혼용

**Date:** 2026-04-07 (코드 역분석)
**Status:** Accepted (기술적 제약)
**Deciders:** sb

## Context

Svelte 5로 마이그레이션하면서 상태 관리 패턴을 결정해야 했다. 선택지:

1. **Svelte 5 runes 전면 사용** — `$state`, `$derived`, `$effect`
2. **Svelte 4 stores 유지** — `writable()`, `derived()`
3. **혼용** — `.svelte.ts` 파일은 runes, `.ts` 파일은 stores

## Decision

**혼용** 채택. Svelte 5 기술적 제약에 의한 선택.

## Rationale

- **Svelte 5 runes 제한**: `$state`, `$derived` 등 rune 문법은 `.svelte` 또는 `.svelte.ts` 파일에서만 사용 가능. 일반 `.ts` 파일에서는 컴파일러가 rune을 인식하지 않음.
- **enrichment.ts의 경우**: 순수 TypeScript 모듈로, 컴포넌트 외부에서 import되는 유틸리티 함수 + 상태를 포함. `.svelte.ts`로 변환하면 import 경로가 달라지고, 비-Svelte 코드에서의 사용이 제한됨.
- **점진적 마이그레이션**: 새로 작성하는 store는 `.svelte.ts` + runes, 기존 것은 `writable()` 유지.

## Trade-offs

| 항목 | 득 | 실 |
|------|-----|-----|
| 호환성 | 기존 코드 변경 최소화 | 두 가지 패턴 공존 (인지 부하) |
| 타입 안전성 | runes: 컴파일 타임 검증 | stores: 런타임에만 |
| 리액티비티 | runes: 세밀한 제어 | stores: subscribe/unsubscribe 수동 |

## Current State

| 파일 | 패턴 | 이유 |
|------|------|------|
| `sessions.svelte.ts` | Runes (`$state`) | 핵심 상태, 컴포넌트 전용 |
| `queries.svelte.ts` | Runes | 핵심 상태, 컴포넌트 전용 |
| `filter.svelte.ts` | Runes | localStorage 영속 |
| `machine.svelte.ts` | Runes | observer 패턴 |
| `dismissed.svelte.ts` | Runes | localStorage 영속 |
| `navigation.svelte.ts` | Runes | URL 동기화 |
| `memos.svelte.ts` | Runes | CRUD 상태 |
| `enrichment.ts` | Svelte 4 `writable()` | `.ts` 파일 제약 |
