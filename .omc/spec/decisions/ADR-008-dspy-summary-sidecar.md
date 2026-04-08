# ADR-008: Summary 기능을 Python DSPy 사이드카로 이관

**Status**: Proposed
**Date**: 2026-04-09
**Decision Maker**: sb

## Context

현재 SummaryEngine(TypeScript)은 하드코딩된 프롬프트로 `claude -p` CLI를 spawn하여 요약을 생성한다.

문제점:
- **프롬프트 하드코딩**: 품질 개선 = 수동 string 수정. 체계적 최적화 불가.
- **평가 체계 부재**: 요약 품질을 측정하는 metric이 없어 개선 여부를 판단할 수 없음.
- **모델 종속성**: CLI spawn 방식은 모델 전환/비교가 번거로움.
- **구조화 출력 없음**: LLM 응답을 raw text로 받아 파싱이 fragile.

## Decision

**Summary 생성을 Python DSPy 사이드카 서비스(port 3099)로 이관한다.**

- Node agent는 트리거/데이터 수집만 담당, 요약 생성은 Python 서비스에 위임.
- DSPy Signature로 입출력을 선언적으로 정의, Optimizer로 프롬프트 자동 최적화.
- LLM-as-judge metric으로 요약 품질을 정량 평가.

## Options Considered

### Option A: Python 사이드카 서비스 ✅ (선택)
- FastAPI 서비스 (port 3099), Node agent가 HTTP로 호출
- DSPy compiled model을 메모리에 로드, 장기 실행
- 장점: DSPy optimizer/metric 완전 활용, 독립 배포, 모델 전환 용이
- 단점: 서비스 하나 추가, 배포 복잡도 증가

### Option B: Node에서 Python 스크립트 spawn
- `spawn('python', ['summarize.py', ...])` 패턴
- 장점: 기존 패턴 유사, 인프라 변경 최소
- 단점: 프로세스 오버헤드, compiled model 매번 로드, optimizer 활용 제한

### Option C: TypeScript에서 Anthropic SDK 직접 호출
- CLI spawn 대신 `@anthropic-ai/sdk` 사용
- 장점: 인프라 변경 없음
- 단점: DSPy 사용 불가, 프롬프트 최적화/평가 체계 구축해야 함

## Architecture

```
Node Agent (port 3098)                 Python Summary Service (port 3099)
  ├─ doCollection() [30초마다]            ├─ POST /api/summarize
  │   └─ HTTP POST → :3099/api/summarize  │   ├─ DSPy ChainOfThought(SummarizeSession)
  ├─ GET /api/session-summaries           │   └─ SQLite session_summaries 저장
  │   └─ SQLite에서 직접 조회              ├─ GET /api/summaries
  └─ prompt_history (SQLite, read/write)  ├─ POST /api/optimize (수동 최적화 트리거)
                                          └─ summarizer.json (compiled model)
```

**DB 전략**: Python 서비스가 `session_summaries` 테이블 소유. Node agent는 읽기만.
- `prompt_history`는 Node agent 소유 (기존 유지).
- Python 서비스는 Node agent의 `/api/queries?sessionId=X` API로 프롬프트를 fetch.

## Consequences

### Positive
- DSPy optimizer로 10개 예제만으로 프롬프트 자동 최적화 가능
- Metric 기반 품질 측정 → 회귀 방지
- `Signature` 변경만으로 출력 형식 조정 (코드 아닌 선언)
- 모델 전환이 `dspy.LM(...)` 한 줄로 가능

### Negative
- Python 런타임 + 의존성 관리 추가 (pyproject.toml, venv)
- 서비스 간 통신 레이턴시 (~1ms, 무시 가능)
- 배포 스크립트 복잡도 증가 (install/agent.sh 수정)
- 워크스테이션에 Python 3.11+ 필요 (확인 필요)

### Risks
- 워크스테이션 Python 버전 호환성 → 사전 확인
- DSPy 라이브러리 안정성 → pip freeze로 버전 고정
- SQLite 동시 접근 → WAL 모드 + 읽기/쓰기 분리로 안전
