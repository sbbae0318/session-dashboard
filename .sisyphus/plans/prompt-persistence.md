# Prompt Persistence Plan

## Goal
프롬프트 데이터를 SQLite에 persistent하게 저장하여 서버 재시작 후에도 유지

## Tasks

- [ ] `prompt-store.ts` 신규 생성 — SQLite CRUD (PromptStore 클래스, prompt_history 테이블)
- [ ] `prompt-extractor.ts` 수정 — `"## **NO EXCUSES"` 시스템 프롬프트 필터 추가
- [ ] `oc-query-collector.ts` 수정 — 백그라운드 인터벌 수집 + PromptStore 연동, 타임스탬프 개선
- [ ] `server.ts` 수정 — GET /api/queries → PromptStore.getRecent()로 변경
- [ ] 테스트 작성 — prompt-store.test.ts 신규, 기존 테스트 수정
- [ ] 빌드 + 전체 테스트 통과 + 실제 검증

## Schema

```sql
CREATE TABLE IF NOT EXISTS prompt_history (
  id            TEXT PRIMARY KEY,       -- sessionId:msgIndex
  session_id    TEXT NOT NULL,
  session_title TEXT,
  timestamp     INTEGER NOT NULL,
  query         TEXT NOT NULL,
  is_background INTEGER DEFAULT 0,
  source        TEXT DEFAULT 'opencode',
  collected_at  INTEGER NOT NULL
);
CREATE INDEX idx_ph_timestamp ON prompt_history(timestamp DESC);
CREATE INDEX idx_ph_session ON prompt_history(session_id);
```

## Design

- 기존 `session-cache.db`에 테이블 추가 (better-sqlite3 이미 사용 중)
- 백그라운드 30초~1분 인터벌로 수집 → DB 저장
- API 응답은 SQLite에서 직접 읽기 (oc-serve 폴링 불필요 → <100ms)
- TTL 30일, INSERT OR IGNORE로 중복 방지
- 기존 SessionStore 패턴 (WAL mode, prepared statements) 따름
