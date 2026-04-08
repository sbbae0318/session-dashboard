# PRD: DSPy Session Summary Service

**Date**: 2026-04-09
**Status**: Draft
**Owner**: sb

## Problem

"오랜만에 돌아온 유저"가 여러 세션의 맥락을 빠르게 파악할 수 없다.
현재 요약 시스템의 한계:
- 프롬프트 하드코딩 → 품질 개선이 수동적
- 평가 체계 없음 → 개선 여부 판단 불가
- 출력이 비구조화 → 파싱 불안정

## Target User

코딩 세션을 여러 개 운영하다가, 하루 이상 경과 후 돌아온 사용자.
"이 세션에서 뭘 하고 있었지?" → 10초 안에 파악해야 한다.

## Solution

Python DSPy 사이드카 서비스로 요약 생성을 이관.
DSPy의 Signature → Module → Optimizer 파이프라인으로 요약 품질을 체계적으로 관리.

## Core Features

### F1: 구조화된 요약 생성
- **입력**: 프롬프트 목록 + 도구 이름 + 이전 요약
- **출력**: `one_line` (세션 목적 한줄) + `bullets` (활동 불렛 포인트)
- DSPy `ChainOfThought(SummarizeSession)` 모듈로 reasoning 후 출력

### F2: Progressive/Additive 요약 (기존 유지)
- 프롬프트 5개 threshold → 자동 트리거
- 이전 요약 + 새 활동 → 누적 요약
- 버전 히스토리 (v1, v2, v3...)

### F3: 자동 최적화 (DSPy Optimizer)
- 10+ labeled examples → BootstrapFewShot
- 50+ examples → MIPROv2 업그레이드
- compiled model (`summarizer.json`) 저장/로드

### F4: 품질 평가 (LLM-as-judge)
- Metric: accuracy (one_line이 실제 세션 목적과 일치) + completeness (bullets가 주요 활동 커버)
- 목표: 평균 score >= 0.7

### F5: Node agent 호환
- 기존 프론트엔드 API 응답 형식 유지 (`SessionSummary`)
- 기존 자동 트리거 로직 유지 (Node agent → HTTP POST)
- Python 서비스 다운 시 graceful degradation

## Output Format

```
대시보드 세션 카드 정렬 로직을 개선하는 세션
• 정렬 우선순위를 WAITING > WORKING > RENAME > IDLE로 변경 → 성공
• ProjectsPage P2 drift 수정 → getDisplayStatus 통일 완료
• 전체 배포 (agent + server) → 2/2 머신 헬스체크 통과
```

## Non-Goals

- 실시간 스트리밍 요약 (batch 생성으로 충분)
- 다국어 지원 (한국어 only)
- 사용자별 개인화 (단일 사용자 시스템)

## Key Decisions

- [ADR-008] Python 사이드카 서비스 선택 (spawn 방식 기각)
- DB 분리: Python 서비스가 `summaries.db` 소유, Node는 `session-cache.db` 유지
- 모델: Anthropic Haiku 4.5 (비용/속도 최적)

## Metrics

| Metric | 현재 | 목표 |
|--------|------|------|
| 요약 품질 (LLM-as-judge) | 측정 불가 | >= 0.7 |
| 요약 생성 시간 | ~5s (CLI spawn) | ~2s (API 직접 호출) |
| 프롬프트 유지보수 | 수동 string 편집 | DSPy Optimizer 자동 |
