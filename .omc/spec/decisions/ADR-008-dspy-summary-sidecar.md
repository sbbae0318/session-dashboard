# ADR-008: Summary 기능을 Python DSPy로 이관

**Status**: Accepted (revised: sidecar → spawn)
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

**Summary 생성을 Python DSPy CLI spawn 방식으로 이관한다.**

- Node agent가 threshold 도달 시 `python -m src` spawn (stdin JSON → stdout JSON)
- 별도 상시 프로세스 없음 — 필요할 때만 Python 호출
- Python 실패 시 기존 Haiku CLI spawn으로 자동 fallback

### 변경 이력

- v1 (초안): FastAPI 사이드카 서비스 (port 3099) — **기각**
  - 이유: 프로세스 2개 운영 복잡도, 30초에 1번 호출에 상시 프로세스 과잉
- v2 (현재): Node에서 Python CLI spawn — **채택**
  - 단일 프로세스, 필요 시만 호출, 인프라 최소

## Architecture

```
Node Agent (PID 1, port 3098) — 단일 프로세스
  │
  ├─ doCollection() [30초마다]
  │   └─ 세션별 threshold 체크 (configurable, default 5)
  │       └─ delta prompts >= threshold?
  │           ├─ YES → spawn('python3', ['-m', 'src'])
  │           │         cwd: agent/python/
  │           │         stdin: JSON {session_id, new_prompts, total_prompt_count, tool_names}
  │           │         stdout: JSON {summary, version, one_line, bullets, ...}
  │           │         Python 실패 → Haiku CLI fallback
  │           └─ NO → skip
  │
  └─ 별도 상시 프로세스 없음
```

**Incremental 패턴**:
- InitialSummary: 첫 요약 (프롬프트 전체 → one_line + bullets)
- IncrementalUpdate: delta만 → new_bullets 추가 + one_line 마이너 갱신
- 기존 bullets는 DB에 누적, LLM에 재전송하지 않음 (O(delta), not O(total))

## Consequences

### Positive
- DSPy Signature로 구조화 입출력 선언 (one_line, bullets)
- Optimizer 적용 시 프롬프트 자동 최적화 가능 (Phase 3)
- 단일 프로세스 — 운영/배포 복잡도 최소
- Python 다운 시 Haiku fallback으로 무중단

### Negative
- Python venv 필요 (`agent/python/.venv/`)
- spawn 오버헤드 (~1s venv 로드) — 30초 간격에서 무시 가능
- compiled model 매 호출 로드 (향후 캐싱 고려)

### Risks
- 워크스테이션에 Python venv 미설치 시 Haiku fallback만 동작 → 기능 저하 없음
