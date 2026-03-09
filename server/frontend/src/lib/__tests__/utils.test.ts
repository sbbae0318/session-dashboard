import { describe, it, expect } from "vitest";
import { getQueryResult, getCompletionTime } from "../utils.js";

describe("getQueryResult", () => {
  const sessions: Array<{ sessionId: string; status: string; apiStatus: string | null }> = [];

  it("returns 'completed' when query has completedAt", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: 2000 };
    expect(getQueryResult(query, sessions)).toBe("completed");
  });

  it("returns 'busy' when no completedAt and session has apiStatus 'busy'", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: null };
    const sessions = [{ sessionId: "sess-abc", status: "active", apiStatus: "busy" }];
    expect(getQueryResult(query, sessions)).toBe("busy");
  });

  it("returns 'idle' when no completedAt and session has apiStatus 'idle'", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: null };
    const sessions = [{ sessionId: "sess-abc", status: "active", apiStatus: "idle" }];
    expect(getQueryResult(query, sessions)).toBe("idle");
  });

  it("returns null when no completedAt and no session match", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: null };
    expect(getQueryResult(query, sessions)).toBeNull();
  });

  it("returns session.status when apiStatus is null", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: null };
    const sessions = [{ sessionId: "sess-abc", status: "active", apiStatus: null }];
    expect(getQueryResult(query, sessions)).toBe("active");
  });
});

describe("getCompletionTime", () => {
  it("returns completedAt when present", () => {
    expect(getCompletionTime({ completedAt: 5000 })).toBe(5000);
  });

  it("returns null when completedAt is null", () => {
    expect(getCompletionTime({ completedAt: null })).toBeNull();
  });

  it("returns null when completedAt is undefined", () => {
    expect(getCompletionTime({})).toBeNull();
  });
});
