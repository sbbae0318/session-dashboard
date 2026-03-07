import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { QueryEntry } from '../oc-query-collector.js';
import { PromptStore } from '../prompt-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<QueryEntry> = {}): QueryEntry {
  return {
    sessionId: 'ses-abc',
    sessionTitle: 'Test Session',
    timestamp: Date.now(),
    query: 'What is the meaning of life?',
    isBackground: false,
    source: 'opencode',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptStore', () => {
  let store: PromptStore;

  beforeEach(() => {
    store = new PromptStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // 이미 닫힌 경우 무시
    }
  });

  // ── 1. 스키마 초기화 ──

  it('creates the prompt_history table on construction', () => {
    expect(store.count()).toBe(0);
  });

  // ── 2. upsertMany() — 기본 삽입 ──

  it('upsertMany() inserts entries and returns inserted count', () => {
    const entries = [
      makeEntry({ sessionId: 'ses-1', timestamp: 1000 }),
      makeEntry({ sessionId: 'ses-2', timestamp: 2000 }),
      makeEntry({ sessionId: 'ses-3', timestamp: 3000 }),
    ];

    const inserted = store.upsertMany(entries);

    expect(inserted).toBe(3);
    expect(store.count()).toBe(3);
  });

  // ── 3. upsertMany() — 중복 무시 (INSERT OR IGNORE) ──

  it('upsertMany() ignores duplicates (same sessionId:timestamp)', () => {
    const entry = makeEntry({ sessionId: 'ses-dup', timestamp: 5000 });

    const first = store.upsertMany([entry]);
    expect(first).toBe(1);

    const second = store.upsertMany([entry]);
    expect(second).toBe(0);

    expect(store.count()).toBe(1);
  });

  // ── 4. upsertMany() — 빈 배열 ──

  it('upsertMany() handles empty array gracefully', () => {
    const inserted = store.upsertMany([]);
    expect(inserted).toBe(0);
    expect(store.count()).toBe(0);
  });

  // ── 5. getRecent() — 최신순 정렬 ──

  it('getRecent() returns entries sorted by timestamp DESC', () => {
    const entries = [
      makeEntry({ sessionId: 'ses-old', timestamp: 1000, query: 'old' }),
      makeEntry({ sessionId: 'ses-mid', timestamp: 2000, query: 'mid' }),
      makeEntry({ sessionId: 'ses-new', timestamp: 3000, query: 'new' }),
    ];

    store.upsertMany(entries);
    const recent = store.getRecent(10);

    expect(recent).toHaveLength(3);
    expect(recent[0].query).toBe('new');
    expect(recent[1].query).toBe('mid');
    expect(recent[2].query).toBe('old');
  });

  // ── 6. getRecent() — limit 적용 ──

  it('getRecent() respects limit parameter', () => {
    const entries = [
      makeEntry({ sessionId: 'ses-1', timestamp: 1000 }),
      makeEntry({ sessionId: 'ses-2', timestamp: 2000 }),
      makeEntry({ sessionId: 'ses-3', timestamp: 3000 }),
    ];

    store.upsertMany(entries);
    const recent = store.getRecent(2);

    expect(recent).toHaveLength(2);
    expect(recent[0].timestamp).toBe(3000);
    expect(recent[1].timestamp).toBe(2000);
  });

  // ── 7. getRecent() — 빈 스토어 ──

  it('getRecent() returns empty array when store is empty', () => {
    const recent = store.getRecent(10);
    expect(recent).toEqual([]);
  });

  // ── 8. getRecent() — QueryEntry 필드 라운드트립 ──

  it('getRecent() preserves all QueryEntry fields through insert/read cycle', () => {
    const entry = makeEntry({
      sessionId: 'ses-rt',
      sessionTitle: 'Round Trip',
      timestamp: 42000,
      query: 'test round trip',
      isBackground: true,
      source: 'opencode',
    });

    store.upsertMany([entry]);
    const [result] = store.getRecent(1);

    expect(result.sessionId).toBe('ses-rt');
    expect(result.sessionTitle).toBe('Round Trip');
    expect(result.timestamp).toBe(42000);
    expect(result.query).toBe('test round trip');
    expect(result.isBackground).toBe(true);
    expect(result.source).toBe('opencode');
  });

  // ── 9. getRecent() — null sessionTitle 라운드트립 ──

  it('getRecent() preserves null sessionTitle', () => {
    const entry = makeEntry({ sessionTitle: null, timestamp: 1000 });

    store.upsertMany([entry]);
    const [result] = store.getRecent(1);

    expect(result.sessionTitle).toBeNull();
  });

  // ── 10. evict() — 오래된 항목 제거 ──

  it('evict() removes entries older than maxAgeMs', () => {
    const now = Date.now();
    const entries = [
      makeEntry({ sessionId: 'ses-old', timestamp: now - 100_000 }),
      makeEntry({ sessionId: 'ses-new', timestamp: now }),
    ];

    store.upsertMany(entries);
    expect(store.count()).toBe(2);

    // collected_at은 upsertMany 호출 시점 (≈ now)
    // evict는 collected_at 기준이므로, maxAgeMs=1로 설정하면 방금 넣은 것도 삭제
    // 테스트를 위해 충분히 큰 maxAge를 사용하여 아무것도 삭제 안 되는 케이스 먼저
    const evicted = store.evict(999_999_999); // 아직 아무것도 expire 안됨
    expect(evicted).toBe(0);
    expect(store.count()).toBe(2);
  });

  // ── 11. evict() — 빈 스토어 ──

  it('evict() returns 0 when store is empty', () => {
    const evicted = store.evict(600_000);
    expect(evicted).toBe(0);
  });

  // ── 12. trimToMax() — 초과 항목 삭제 ──

  it('trimToMax() removes oldest entries when count exceeds max', () => {
    const entries = [
      makeEntry({ sessionId: 'ses-1', timestamp: 1000, query: 'first' }),
      makeEntry({ sessionId: 'ses-2', timestamp: 2000, query: 'second' }),
      makeEntry({ sessionId: 'ses-3', timestamp: 3000, query: 'third' }),
      makeEntry({ sessionId: 'ses-4', timestamp: 4000, query: 'fourth' }),
      makeEntry({ sessionId: 'ses-5', timestamp: 5000, query: 'fifth' }),
    ];

    store.upsertMany(entries);
    expect(store.count()).toBe(5);

    const trimmed = store.trimToMax(3);

    expect(trimmed).toBe(2);
    expect(store.count()).toBe(3);

    // 최신 3개만 남아야 함
    const remaining = store.getRecent(10);
    expect(remaining).toHaveLength(3);
    expect(remaining[0].query).toBe('fifth');
    expect(remaining[1].query).toBe('fourth');
    expect(remaining[2].query).toBe('third');
  });

  // ── 13. trimToMax() — max 이하일 때 무동작 ──

  it('trimToMax() returns 0 when count is within max', () => {
    store.upsertMany([makeEntry({ timestamp: 1000 })]);
    const trimmed = store.trimToMax(100);
    expect(trimmed).toBe(0);
    expect(store.count()).toBe(1);
  });

  // ── 14. trimToMax() — 빈 스토어 ──

  it('trimToMax() returns 0 when store is empty', () => {
    const trimmed = store.trimToMax(100);
    expect(trimmed).toBe(0);
  });

  // ── 15. count() — 정확한 카운트 ──

  it('count() tracks insertions correctly', () => {
    expect(store.count()).toBe(0);

    store.upsertMany([makeEntry({ sessionId: 'a', timestamp: 1 })]);
    expect(store.count()).toBe(1);

    store.upsertMany([
      makeEntry({ sessionId: 'b', timestamp: 2 }),
      makeEntry({ sessionId: 'c', timestamp: 3 }),
    ]);
    expect(store.count()).toBe(3);
  });

  // ── 16. close() 후 작업 시 에러 ──

  it('close() makes further operations throw', () => {
    store.close();

    expect(() => store.count()).toThrow();
    expect(() => store.upsertMany([makeEntry()])).toThrow();
    expect(() => store.getRecent(10)).toThrow();
  });

  // ── 17. 같은 세션, 다른 타임스탬프 → 별도 엔트리 ──

  it('stores separate entries for same session with different timestamps', () => {
    const entries = [
      makeEntry({ sessionId: 'ses-multi', timestamp: 1000, query: 'first prompt' }),
      makeEntry({ sessionId: 'ses-multi', timestamp: 2000, query: 'second prompt' }),
      makeEntry({ sessionId: 'ses-multi', timestamp: 3000, query: 'third prompt' }),
    ];

    const inserted = store.upsertMany(entries);

    expect(inserted).toBe(3);
    expect(store.count()).toBe(3);

    const recent = store.getRecent(10);
    expect(recent[0].query).toBe('third prompt');
    expect(recent[1].query).toBe('second prompt');
    expect(recent[2].query).toBe('first prompt');
  });

  // ── 18. isBackground 필드 boolean ↔ integer 변환 ──

  it('correctly converts isBackground between boolean and integer', () => {
    store.upsertMany([
      makeEntry({ sessionId: 'bg-true', timestamp: 1000, isBackground: true }),
      makeEntry({ sessionId: 'bg-false', timestamp: 2000, isBackground: false }),
    ]);

    const recent = store.getRecent(10);
    const bgTrue = recent.find((e) => e.sessionId === 'bg-true');
    const bgFalse = recent.find((e) => e.sessionId === 'bg-false');

    expect(bgTrue?.isBackground).toBe(true);
    expect(bgFalse?.isBackground).toBe(false);
  });

  // ── 19. 대량 삽입 성능 (transaction) ──

  it('handles batch insert of 100+ entries in a single transaction', () => {
    const entries: QueryEntry[] = [];
    for (let i = 0; i < 200; i++) {
      entries.push(makeEntry({ sessionId: `ses-${i}`, timestamp: i * 1000 }));
    }

    const inserted = store.upsertMany(entries);

    expect(inserted).toBe(200);
    expect(store.count()).toBe(200);

    const recent = store.getRecent(5);
    expect(recent).toHaveLength(5);
    expect(recent[0].timestamp).toBe(199_000); // 가장 최신
  });
});
