import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionDetail } from '../session-cache.js';
import { SessionStore } from '../session-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    status: 'idle',
    lastPrompt: null,
    lastPromptTime: 0,
    currentTool: null,
    directory: null,
    waitingForInput: false,
    updatedAt: Date.now(),
    title: null,
    parentSessionId: null,
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // 이미 닫힌 경우 무시
    }
  });

  // ── 1. 스키마 초기화 ──

  it('creates the session_status table on construction', () => {
    // 테이블이 존재하면 count()가 에러 없이 동작
    expect(store.count()).toBe(0);
  });

  // ── 2. get() — 존재하지 않는 세션 ──

  it('get() returns null for nonexistent session', () => {
    expect(store.get('nonexistent-id')).toBeNull();
  });

  // ── 3. upsert() + get() 라운드트립 ──

  it('upsert() stores and get() retrieves a session detail', () => {
    const detail = makeDetail({
      status: 'busy',
      lastPrompt: 'write tests',
      lastPromptTime: 1000,
      currentTool: 'vitest',
      directory: '/project/foo',
      updatedAt: 2000,
    });

    store.upsert('ses_001', detail);
    const result = store.get('ses_001');

    expect(result).toEqual(detail);
  });

  // ── 4. upsert() 기존 항목 갱신 ──

  it('upsert() updates an existing entry', () => {
    const original = makeDetail({ status: 'idle', updatedAt: 1000 });
    store.upsert('ses_002', original);

    const updated = makeDetail({
      status: 'busy',
      lastPrompt: 'refactoring',
      updatedAt: 2000,
    });
    store.upsert('ses_002', updated);

    const result = store.get('ses_002');
    expect(result).toEqual(updated);
    expect(store.count()).toBe(1); // 중복 없이 1개
  });

  // ── 5. getAll() — Record 형식 반환 ──

  it('getAll() returns all sessions as Record<string, SessionDetail>', () => {
    const d1 = makeDetail({ status: 'idle', updatedAt: 1000 });
    const d2 = makeDetail({ status: 'busy', updatedAt: 2000 });
    const d3 = makeDetail({ status: 'retry', updatedAt: 3000 });

    store.upsert('ses_a', d1);
    store.upsert('ses_b', d2);
    store.upsert('ses_c', d3);

    const all = store.getAll();

    expect(Object.keys(all)).toHaveLength(3);
    expect(all['ses_a']).toEqual(d1);
    expect(all['ses_b']).toEqual(d2);
    expect(all['ses_c']).toEqual(d3);
  });

  // ── 6. delete() ──

  it('delete() removes a specific session', () => {
    store.upsert('ses_del', makeDetail());
    expect(store.count()).toBe(1);

    store.delete('ses_del');
    expect(store.get('ses_del')).toBeNull();
    expect(store.count()).toBe(0);
  });

  // ── 7. evict() — 오래된 세션 제거 / 최신 유지 ──

  it('evict() removes old entries and keeps recent ones', () => {
    const now = Date.now();
    const old = makeDetail({ updatedAt: now - 700_000 }); // 700초 전
    const recent = makeDetail({ updatedAt: now - 100_000 }); // 100초 전

    store.upsert('ses_old', old);
    store.upsert('ses_recent', recent);
    expect(store.count()).toBe(2);

    // 600초(600_000ms) 이상 된 세션 제거
    const evicted = store.evict(600_000);

    expect(evicted).toBe(1);
    expect(store.get('ses_old')).toBeNull();
    expect(store.get('ses_recent')).not.toBeNull();
    expect(store.count()).toBe(1);
  });

  // ── 8. count() ──

  it('count() returns the correct number of sessions', () => {
    expect(store.count()).toBe(0);

    store.upsert('ses_1', makeDetail());
    expect(store.count()).toBe(1);

    store.upsert('ses_2', makeDetail());
    store.upsert('ses_3', makeDetail());
    expect(store.count()).toBe(3);

    store.delete('ses_2');
    expect(store.count()).toBe(2);
  });

  // ── 9. close() 후 작업 시 에러 ──

  it('close() makes further operations throw', () => {
    store.close();

    expect(() => store.get('any')).toThrow();
    expect(() => store.upsert('any', makeDetail())).toThrow();
    expect(() => store.getAll()).toThrow();
    expect(() => store.count()).toThrow();
  });

  // ── 10. null 필드 라운드트립 ──

  it('preserves null fields correctly through upsert/get cycle', () => {
    const detail = makeDetail({
      lastPrompt: null,
      currentTool: null,
      directory: null,
    });

    store.upsert('ses_nulls', detail);
    const result = store.get('ses_nulls');

    expect(result?.lastPrompt).toBeNull();
    expect(result?.currentTool).toBeNull();
    expect(result?.directory).toBeNull();
  });

  // ── 11. evict() — 빈 스토어에서 호출 ──

  it('evict() returns 0 when store is empty', () => {
    const evicted = store.evict(600_000);
    expect(evicted).toBe(0);
  });

  // ── 12. delete() — 존재하지 않는 세션 ──

  it('delete() is a no-op for nonexistent session', () => {
    expect(() => store.delete('ghost')).not.toThrow();
    expect(store.count()).toBe(0);
  });
});
