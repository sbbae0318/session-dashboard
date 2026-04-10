import { describe, it, expect, beforeEach, vi } from "vitest";

// Vitest는 Node 환경이라 localStorage/window가 없다. 모듈 import 전에 스텁을 전역에 등록한다.
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
};
vi.stubGlobal("localStorage", localStorageMock);
vi.stubGlobal("window", { localStorage: localStorageMock });

const { togglePin, isPinned, getPinnedIds, getPinnedCount, clearAllPins } =
  await import("../pinned.svelte.js");

describe("pinned store", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllPins();
  });

  it("isPinned returns false for unpinned session", () => {
    expect(isPinned("s1")).toBe(false);
  });

  it("togglePin adds an unpinned session", () => {
    togglePin("s1");
    expect(isPinned("s1")).toBe(true);
    expect(getPinnedCount()).toBe(1);
  });

  it("togglePin removes a pinned session", () => {
    togglePin("s1");
    togglePin("s1");
    expect(isPinned("s1")).toBe(false);
    expect(getPinnedCount()).toBe(0);
  });

  it("getPinnedIds returns current set", () => {
    togglePin("s1");
    togglePin("s2");
    const ids = getPinnedIds();
    expect(ids.has("s1")).toBe(true);
    expect(ids.has("s2")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("persists to localStorage", () => {
    togglePin("s1");
    togglePin("s2");
    const raw = localStorage.getItem("session-dashboard:pinned");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(parsed.length).toBe(2);
  });

  it("clearAllPins empties the set and persists", () => {
    togglePin("s1");
    togglePin("s2");
    clearAllPins();
    expect(getPinnedCount()).toBe(0);
    expect(isPinned("s1")).toBe(false);
    const raw = localStorage.getItem("session-dashboard:pinned");
    expect(JSON.parse(raw!)).toEqual([]);
  });
});
