import { describe, it, expect } from "vitest";
import { getQueryResult } from "../utils.js";

describe("getQueryResult", () => {
  const baseQuery = { sessionId: "sess-abc", timestamp: 1000 };

  it("returns 'completed' when card matches sessionId and endReason is 'completed'", () => {
    const cards = [{ sessionId: "sess-abc", endTime: 2000, endReason: "completed" }];
    const sessions: Array<{ sessionId: string; status: string; apiStatus: string | null }> = [];
    expect(getQueryResult(baseQuery, cards, sessions)).toBe("completed");
  });

  it("returns 'error' when card matches sessionId and endReason is 'error'", () => {
    const cards = [{ sessionId: "sess-abc", endTime: 2000, endReason: "error" }];
    const sessions: Array<{ sessionId: string; status: string; apiStatus: string | null }> = [];
    expect(getQueryResult(baseQuery, cards, sessions)).toBe("error");
  });

  it("returns 'user_exit' when card matches sessionId and endReason is 'user_exit'", () => {
    const cards = [{ sessionId: "sess-abc", endTime: 2000, endReason: "user_exit" }];
    const sessions: Array<{ sessionId: string; status: string; apiStatus: string | null }> = [];
    expect(getQueryResult(baseQuery, cards, sessions)).toBe("user_exit");
  });

  it("returns 'busy' when no card match but session has apiStatus 'busy'", () => {
    const cards: Array<{ sessionId: string; endTime: number; endReason?: string }> = [];
    const sessions = [{ sessionId: "sess-abc", status: "active", apiStatus: "busy" }];
    expect(getQueryResult(baseQuery, cards, sessions)).toBe("busy");
  });

  it("returns 'idle' when no card match but session has apiStatus 'idle'", () => {
    const cards: Array<{ sessionId: string; endTime: number; endReason?: string }> = [];
    const sessions = [{ sessionId: "sess-abc", status: "active", apiStatus: "idle" }];
    expect(getQueryResult(baseQuery, cards, sessions)).toBe("idle");
  });

  it("returns null when no card and no session match", () => {
    const cards: Array<{ sessionId: string; endTime: number; endReason?: string }> = [];
    const sessions: Array<{ sessionId: string; status: string; apiStatus: string | null }> = [];
    expect(getQueryResult(baseQuery, cards, sessions)).toBeNull();
  });

  it("does NOT match card when endTime is before query.timestamp", () => {
    const cards = [{ sessionId: "sess-abc", endTime: 500, endReason: "completed" }];
    const sessions: Array<{ sessionId: string; status: string; apiStatus: string | null }> = [];
    expect(getQueryResult(baseQuery, cards, sessions)).toBeNull();
  });

  it("returns endReason from most recent card (highest endTime) when multiple cards match", () => {
    const cards = [
      { sessionId: "sess-abc", endTime: 2000, endReason: "error" },
      { sessionId: "sess-abc", endTime: 5000, endReason: "completed" },
      { sessionId: "sess-abc", endTime: 3000, endReason: "user_exit" },
    ];
    const sessions: Array<{ sessionId: string; status: string; apiStatus: string | null }> = [];
    expect(getQueryResult(baseQuery, cards, sessions)).toBe("completed");
  });

  it("returns session.status when apiStatus is null", () => {
    const cards: Array<{ sessionId: string; endTime: number; endReason?: string }> = [];
    const sessions = [{ sessionId: "sess-abc", status: "active", apiStatus: null }];
    expect(getQueryResult(baseQuery, cards, sessions)).toBe("active");
  });
});
