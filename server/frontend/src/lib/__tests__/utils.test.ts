import { describe, it, expect } from "vitest";
import { getQueryResult, getCompletionTime, getDisplayStatus, detectStatusChanges } from "../utils.js";

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

  // ── F-004 regression: currentTool 기반 busy 판정 ──

  it("returns 'busy' when currentTool set and apiStatus is null (F-004)", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: null };
    const sessions = [{ sessionId: "sess-abc", status: "idle" as const, apiStatus: null, currentTool: "Bash", waitingForInput: false }];
    expect(getQueryResult(query, sessions)).toBe("busy");
  });

  it("returns 'busy' when apiStatus=retry (F-004)", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: null };
    const sessions = [{ sessionId: "sess-abc", status: "active" as const, apiStatus: "retry", currentTool: null, waitingForInput: false }];
    expect(getQueryResult(query, sessions)).toBe("busy");
  });

  it("returns idle-fallback when currentTool set but waitingForInput=true (F-004)", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: null };
    const sessions = [{ sessionId: "sess-abc", status: "active" as const, apiStatus: null, currentTool: "Bash", waitingForInput: true }];
    // waitingForInput → not busy, falls through to apiStatus check → idle fallback
    expect(getQueryResult(query, sessions)).toBe("active");
  });

  it("returns 'completed' even if currentTool set (completedAt takes priority)", () => {
    const query = { sessionId: "sess-abc", timestamp: 1000, completedAt: 2000 };
    const sessions = [{ sessionId: "sess-abc", status: "active" as const, apiStatus: "busy", currentTool: "Bash", waitingForInput: false }];
    expect(getQueryResult(query, sessions)).toBe("completed");
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

// ── getDisplayStatus: 상태 판별 regression ──

describe("getDisplayStatus", () => {
  it("returns Working when apiStatus=busy and not waiting", () => {
    const ds = getDisplayStatus({ apiStatus: "busy", currentTool: null, waitingForInput: false });
    expect(ds).toEqual({ label: "Working", cssClass: "status-working" });
  });

  it("returns Working when currentTool is set and not waiting", () => {
    const ds = getDisplayStatus({ apiStatus: null, currentTool: "Bash", waitingForInput: false });
    expect(ds).toEqual({ label: "Working", cssClass: "status-working" });
  });

  it("returns Retry when apiStatus=retry", () => {
    const ds = getDisplayStatus({ apiStatus: "retry", currentTool: null, waitingForInput: false });
    expect(ds).toEqual({ label: "Retry", cssClass: "status-working" });
  });

  it("returns Waiting when waitingForInput=true (even if apiStatus=busy)", () => {
    const ds = getDisplayStatus({ apiStatus: "busy", currentTool: null, waitingForInput: true });
    expect(ds).toEqual({ label: "Waiting", cssClass: "status-waiting" });
  });

  it("returns Waiting when waitingForInput=true and currentTool set", () => {
    const ds = getDisplayStatus({ apiStatus: null, currentTool: "Bash", waitingForInput: true });
    expect(ds).toEqual({ label: "Waiting", cssClass: "status-waiting" });
  });

  it("returns Idle when no busy/tool/waiting", () => {
    const ds = getDisplayStatus({ apiStatus: null, currentTool: null, waitingForInput: false });
    expect(ds).toEqual({ label: "Idle", cssClass: "status-idle" });
  });

  it("returns Idle when apiStatus=idle", () => {
    const ds = getDisplayStatus({ apiStatus: "idle", currentTool: null, waitingForInput: false });
    expect(ds).toEqual({ label: "Idle", cssClass: "status-idle" });
  });
});

// ── detectStatusChanges: 상태 전환 flash 감지 regression ──

describe("detectStatusChanges", () => {
  const mkSession = (id: string, apiStatus: string | null, currentTool: string | null, waitingForInput: boolean) =>
    ({ sessionId: id, apiStatus, currentTool, waitingForInput });

  it("detects idle → working transition", () => {
    const prev = new Map([["s1", "status-idle"]]);
    const sessions = [mkSession("s1", "busy", null, false)];
    expect(detectStatusChanges(prev, sessions)).toEqual(new Set(["s1"]));
  });

  it("detects working → idle transition", () => {
    const prev = new Map([["s1", "status-working"]]);
    const sessions = [mkSession("s1", null, null, false)];
    expect(detectStatusChanges(prev, sessions)).toEqual(new Set(["s1"]));
  });

  it("detects idle → waiting transition", () => {
    const prev = new Map([["s1", "status-idle"]]);
    const sessions = [mkSession("s1", null, null, true)];
    expect(detectStatusChanges(prev, sessions)).toEqual(new Set(["s1"]));
  });

  it("detects waiting → working transition", () => {
    const prev = new Map([["s1", "status-waiting"]]);
    const sessions = [mkSession("s1", "busy", null, false)];
    expect(detectStatusChanges(prev, sessions)).toEqual(new Set(["s1"]));
  });

  it("detects working → waiting transition", () => {
    const prev = new Map([["s1", "status-working"]]);
    const sessions = [mkSession("s1", "busy", null, true)];
    expect(detectStatusChanges(prev, sessions)).toEqual(new Set(["s1"]));
  });

  it("detects waiting → idle transition", () => {
    const prev = new Map([["s1", "status-waiting"]]);
    const sessions = [mkSession("s1", null, null, false)];
    expect(detectStatusChanges(prev, sessions)).toEqual(new Set(["s1"]));
  });

  it("returns empty set when no status change", () => {
    const prev = new Map([["s1", "status-working"]]);
    const sessions = [mkSession("s1", "busy", null, false)];
    expect(detectStatusChanges(prev, sessions).size).toBe(0);
  });

  it("ignores new sessions (no previous status)", () => {
    const prev = new Map<string, string>();
    const sessions = [mkSession("s1", "busy", null, false)];
    expect(detectStatusChanges(prev, sessions).size).toBe(0);
  });

  it("detects multiple simultaneous transitions", () => {
    const prev = new Map([["s1", "status-idle"], ["s2", "status-working"], ["s3", "status-idle"]]);
    const sessions = [
      mkSession("s1", "busy", null, false),   // idle → working
      mkSession("s2", null, null, false),      // working → idle
      mkSession("s3", null, null, false),      // idle → idle (no change)
    ];
    expect(detectStatusChanges(prev, sessions)).toEqual(new Set(["s1", "s2"]));
  });
});
