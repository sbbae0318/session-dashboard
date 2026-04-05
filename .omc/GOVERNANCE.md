# .omc/ Governance

이 문서는 `.omc/` 디렉토리를 **어떻게 채워나갈지**를 정의한다. CLAUDE.md가 프로젝트의 **헌법(constitution)**이라면, 이 파일은 **관리 규칙**이다.

---

## Directory Map

| 디렉토리 | 목적 | 라이프사이클 |
|---------|------|-------------|
| `spec/` | 의도 계층 (PRD, ADR, AC, status) | LOCKED 결정은 영구 |
| `knowledge/` | 학습 축적 (domains, sidecars, known-failures) | 유기적 성장 |
| `plans/` | **일회성** 구현 계획 | Draft→Active→Completed |
| `scripts/` | 자동화 (drift-check.sh 등) | 불변 원칙과 정렬 |
| `state/` | Runtime ephemeral (HUD, session ID) | Gitignored, tool-managed |
| `workflows/` | **반복 가능한** 절차 | 안정화 후 LOCKED |

**plans/ vs workflows/**:
- `plans/`: "이번 분기에 A 기능 구현" — 1회 실행, 완료시 archive
- `workflows/`: "프로덕션 배포 절차" — 조건부로 반복 실행

---

## Usage Scenarios (언제 어떤 커맨드를 쓰는가)

| 상황 | 커맨드 | 예시 |
|------|--------|------|
| 트레이드오프 있는 기술 결정 | `/cc-new-adr` | "SQLite vs Postgres" |
| 여러 단계 1회성 구현 | `/cc-new-plan` | "Auth flow 구현" |
| 조건부 반복 절차 | `/cc-new-workflow` | "Prod 배포 절차" |
| 복잡한 새 도메인 (2+회 디버깅) | `/cc-new-domain` | "CGR 파이프라인" |
| 버그 패턴 기록 | `/cc-new-failure` | "Embedding 차원 불일치" |
| 새 기능 검증 기준 | `/cc-new-ac` | "새 Phase DoD" |

**결정 순서**:
1. 아키텍처 결정? → ADR
2. 여러 단계 구현? → Plan
3. 복잡한 새 영역? → Domain
4. 반복 절차? → Workflow
5. 검증 기준 필요? → AC
6. 버그 고쳤나? → Failure

---

## Per-Directory 규칙

### spec/
- **prd.md**: 프로젝트당 1개. Haberlah Prompt 0/N 포맷
- **status.md**: GSD STATE 포맷. Current Position, Locked Decisions, Learned
- **decisions/**: NNN-kebab-case.md. 각 ADR은 Status/Context/Options/Decision/Consequences
- **acceptance/**: `<verify>`/`<done>` GSD 태그 사용
- 새 결정 → `/cc-new-adr`, 새 AC → `/cc-new-ac`

### knowledge/
- **domains/**: 같은 영역 2+회 디버깅 후 추가. Activation/Architecture/Patterns 섹션
- **sidecars/**: 세션 간 축적. `[domain].memories.md`
- **known-failures.md**: 증상-원인-수정 테이블. Append-only
- 새 도메인 → `/cc-new-domain` (domain+sidecar 쌍 생성)
- 새 실패 → `/cc-new-failure`

### plans/
- **1회성**. Date/Scope/Complexity/Phases 구조
- 완료시 파일명에 `.completed.md` suffix 또는 archive/ 이동 (선택)
- `/cc-new-plan "feature-name"`

### workflows/
- **반복 가능**. Trigger/Preconditions/Steps/Rollback/Verification 구조
- 안정화 후 상단에 `Status: LOCKED` 추가
- `/cc-new-workflow "process-name"`

### scripts/
- `drift-check.sh`: 불변 원칙 검증. CLAUDE.md의 P1-P5를 grep로 변환
- 프로젝트별 커스터마이징

### state/
- Runtime/ephemeral. Gitignored
- HUD JSON, session ID 등 tool-managed 파일만
- 수동 편집 금지

---

## Content Flow (관측 → 기록 경로)

```
관측 (대화 중) 
  ↓ (working memory)
sidecar (knowledge/sidecars/*.memories.md)
  ↓ (2+회 발생 또는 패턴 확립)
domain knowledge (knowledge/domains/*.md)
  ↓ (아키텍처 영향시)
ADR (spec/decisions/NNN-*.md)

실패 관측
  ↓
known-failures.md entry (F000)
  ↓ (재발 패턴)
domain doc의 Known Failures 섹션 참조

기술 결정
  ↓
ADR: Proposed → Accepted → LOCKED (또는 Superseded)
  ↓
status.md Locked Decisions
```

---

## Agent Protocol (에이전트 행동 규칙)

에이전트(Claude)는 대화 중 아래 Triggers를 **지속 모니터링**하고, 감지 즉시 Actions을 수행한다.
커맨드는 에이전트가 사용하는 **인프라**이며, 사용자는 대부분 자연어로 대화만 하면 된다.

### Triggers → Actions 매핑

| Trigger 감지 기준 | 자동 제안 Action | Draft 자동 추출 항목 |
|----------------|---------------|-------------------|
| 버그 수정 후 테스트 통과, "fix"/"bug" 커밋 메시지 | `/cc-new-failure` | 증상/원인/수정/심각도/파일 |
| "A vs B", "~할까", "고민 중" 패턴 대화 | `/cc-new-adr` | Context/Options/Decision/Consequences |
| 같은 파일 세션 중 2+회 편집 | `/cc-new-domain` | 파일/패턴/핵심 함수 |
| "구현 시작", "Phase N 시작" 선언 | `/cc-new-ac` | Verify/Done criteria |
| "매번 이렇게", "반복해서" 패턴 | `/cc-new-workflow` | Trigger/Steps/Rollback |
| drift-check.sh 새 위반 발견 | `/cc-new-failure` | P 원칙 번호/파일:라인 |
| 도메인 파일 수정 후 새 사실 | 해당 sidecar append | 날짜-요약 한 줄 |

### Interaction Pattern (BMAD HALT/WAIT)

Trigger 감지 시 에이전트는 **다음 순서**를 엄격히 따른다:

```
1. Draft 생성: 대화 맥락에서 필수 항목 자동 추출
2. 사용자에게 제시: 구조화된 블록으로 표시
3. HALT AND WAIT: 사용자 입력 대기 (Y/n/edit)
4. 분기:
   - Y: 해당 커맨드 자동 실행
   - n: 무시 (다음 trigger로 이동)
   - edit: 사용자가 draft 수정 후 실행
```

### 제시 포맷 (Interaction UX)

```
🎯 감지: [Trigger 이름]
📝 제안: [Action 명]
📋 Draft:
  - [Field 1]: [자동 추출 값]
  - [Field 2]: [자동 추출 값]
  - [Field 3]: [자동 추출 값]

기록할까요? [Y/n/edit]
```

### 원칙

- **사용자는 커맨드를 외울 필요 없음**. 자연어로 대화만 해도 에이전트가 알아서 제안.
- **수동 호출 필수 커맨드는 4개만**: `/cc-start`, `/cc-end`, `/cc-drift`, `/cc-scaffold`.
- **나머지 6개 `/cc-new-*`는 Agent Protocol이 자동 호출**.
- **HALT 준수**: 사용자 confirm 없이 자동 실행 절대 금지.

---

## Session Protocol

```
세션 시작 → /cc-start (status.md 로드, Current Position 파악)
  ↓
작업 (필요시 /cc-new-* 커맨드로 아티팩트 생성)
  ↓
/cc-drift (정합성 검증, 위반시 /cc-new-failure 제안)
  ↓
세션 종료 → /cc-end (git log 파싱, status/sidecars/failures 업데이트 제안)
```

---

## Command Reference

| 커맨드 | 용도 |
|--------|------|
| `/cc-scaffold` | 새 프로젝트 초기화 (1회) |
| `/cc-start` | 세션 시작, status 로드 |
| `/cc-drift` | 정합성 검증 실행 |
| `/cc-end` | 세션 종료, git log 기반 업데이트 제안 |
| `/cc-new-adr <title>` | ADR 생성 (auto-number) |
| `/cc-new-plan <name>` | 1회성 플랜 생성 |
| `/cc-new-workflow <name>` | 반복 절차 생성 |
| `/cc-new-domain <name>` | 도메인+sidecar 쌍 생성 |
| `/cc-new-ac <name>` | AC 파일 생성 |
| `/cc-new-failure <summary>` | known-failure entry 추가 (auto F-number) |

---

## 유지보수 체크리스트

**매 세션** (~5분):
- status.md Current Position 갱신
- 새 사실 → sidecar append
- 새 버그 패턴 → `/cc-new-failure`

**매주** (~1시간):
- CLAUDE.md 구조 반영
- `/cc-drift` 실행, 새 위반 확인
- known-failures 해결된 항목 표시

**새 Phase 시작**:
- `/cc-new-plan` + `/cc-new-ac` 쌍 생성
- 결정 있으면 `/cc-new-adr`
- status.md Phase Progress 갱신
