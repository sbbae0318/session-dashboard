# Plan: DSPy Summary Service

**Date**: 2026-04-09
**Branch**: main (feat/dspy-summary 머지 완료)
**ADR**: ADR-008 (v2: spawn 방식)

## Goal

SummaryEngine을 Python DSPy CLI spawn 방식으로 이관.
"오랜만에 돌아온 유저"가 세션 맥락을 10초 안에 파악할 수 있는 고품질 요약 제공.

## Success Criteria

- [x] Python CLI (`python -m src`)가 stdin/stdout JSON으로 요약 생성
- [x] Node agent가 threshold 도달 시 async spawn
- [x] DSPy Signature로 structured output (one_line + bullets)
- [x] Incremental 패턴: delta만 처리 (O(delta))
- [x] Python 실패 시 Haiku CLI fallback
- [ ] 10개 labeled examples로 BootstrapFewShot 최적화 실행
- [ ] LLM-as-judge metric으로 품질 >= 0.7 달성

## Phases

### Phase 1: Python 서비스 스캐폴드
> verify: `curl -X POST localhost:3099/api/summarize` 응답 확인

1. `agent/python/` 디렉토리 생성
2. `pyproject.toml` — dspy, fastapi, uvicorn, anthropic, better-sqlite3
3. `agent/python/src/main.py` — FastAPI 앱
4. `agent/python/src/signatures.py` — DSPy SummarizeSession Signature
5. `agent/python/src/engine.py` — SummaryService (DB + DSPy 모듈 래핑)
6. `agent/python/src/db.py` — SQLite session_summaries CRUD
7. 기본 동작 테스트 (Haiku로 요약 생성)

### Phase 2: Node agent 연동
> verify: 프론트엔드 SummariesPage에서 자동/수동 요약 동작

8. `agent/src/summary-engine.ts` → HTTP 클라이언트로 교체
   - `checkAndGenerate()` → POST localhost:3099/api/summarize
   - `getLatest()` / `getHistory()` → GET localhost:3099/api/summaries/:id
   - `generate()` → POST localhost:3099/api/summarize (force=true)
9. `agent/src/server.ts` — 기존 엔드포인트 유지, 내부 호출만 변경
10. Fallback: Python 서비스 다운 시 기존 TS 엔진으로 폴백

### Phase 3: 최적화 & 평가
> verify: BootstrapFewShot 전후 metric 비교 리포트

11. 실제 세션 데이터에서 10개 labeled examples 수집
    - input: prompts + tool_calls + previous_summary
    - output: expected one_line + expected bullets
12. `agent/python/src/metric.py` — LLM-as-judge metric 함수
13. `agent/python/src/optimize.py` — BootstrapFewShot 실행 스크립트
14. `summarizer.json` 저장, 서비스 시작 시 자동 로드

### Phase 4: 배포
> verify: 양쪽 머신에서 헬스체크 통과

15. `install/agent.sh` — Python 서비스 시작/중지 추가
16. 워크스테이션 배포 스크립트 업데이트
17. Docker 대안 검토 (서버에서 실행 시)

## File Structure (예상)

```
agent/
├── python/
│   ├── pyproject.toml
│   ├── src/
│   │   ├── __init__.py
│   │   ├── main.py          # FastAPI 앱 + 라우트
│   │   ├── signatures.py    # DSPy Signature 정의
│   │   ├── engine.py        # SummaryService (DSPy 모듈 + DB)
│   │   ├── db.py            # SQLite CRUD
│   │   ├── metric.py        # LLM-as-judge 평가 함수
│   │   └── optimize.py      # 최적화 실행 스크립트
│   ├── data/
│   │   ├── examples.json    # Labeled training examples
│   │   └── summarizer.json  # Compiled DSPy model
│   └── tests/
│       └── test_engine.py
├── src/                     # 기존 TypeScript agent (수정)
│   ├── summary-engine.ts    # HTTP 클라이언트로 변경
│   └── server.ts            # 기존 API 유지
```

## API Contract (Python 서비스)

### POST /api/summarize
```json
// Request
{
  "session_id": "abc123",
  "session_title": "Dashboard fixes",
  "prompts": [
    {"timestamp": 1712688000000, "query": "정렬 기준 변경해줘"}
  ],
  "tool_names": ["Edit", "Bash", "Read"],
  "previous_summary": "기존 요약 텍스트...",  // optional
  "force": false
}

// Response
{
  "session_id": "abc123",
  "one_line": "대시보드 세션 카드 정렬 로직을 개선하는 세션",
  "bullets": [
    "• 정렬 우선순위를 WAITING > WORKING > RENAME > IDLE로 변경 → 성공",
    "• drift-check로 P2 위반 발견 및 수정 → 배포 완료"
  ],
  "summary": "대시보드 세션 카드 정렬 로직을 개선하는 세션\n• 정렬 우선순위를...",
  "version": 2,
  "prompt_count": 12,
  "generated_at": 1712688001000
}
```

### GET /api/summaries/{session_id}
```json
{
  "latest": { /* SessionSummary */ },
  "history": [ /* version 순 */ ]
}
```

### GET /api/summaries
```json
{
  "summaries": [ /* 모든 세션 최신 요약 */ ]
}
```

### GET /health
```json
{
  "status": "ok",
  "model": "anthropic/claude-haiku-4-5",
  "compiled_model_loaded": true,
  "total_summaries": 42
}
```

## Dependencies

```toml
[project]
name = "session-summary-service"
requires-python = ">=3.11"
dependencies = [
  "dspy>=2.0",
  "fastapi>=0.115",
  "uvicorn>=0.30",
  "anthropic>=0.40",
]
```

## Open Questions

1. ~~Option A vs B~~ → ADR-008에서 Option A 결정
2. DB 파일 위치: `agent/python/data/summaries.db` vs `agent/data/session-cache.db` 공유?
   → 분리 권장 (Python 소유 DB 별도)
3. 워크스테이션 Python 버전 확인 필요
4. Optimizer 실행 빈도: 수동? 주 1회 자동?
   → Phase 3에서 수동 시작, 자동화는 후속
