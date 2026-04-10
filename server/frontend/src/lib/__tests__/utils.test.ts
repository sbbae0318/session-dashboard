import { describe, it, expect } from "vitest";
import { getQueryResult, getCompletionTime, getDisplayStatus, detectStatusChanges, statusSortPriority, sortSessionsByStatusAndPin } from "../utils.js";

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

  it("returns Disconnected when machineConnected=false", () => {
    const ds = getDisplayStatus({ apiStatus: null, currentTool: null, waitingForInput: false, machineConnected: false });
    expect(ds).toEqual({ label: "Disconnected", cssClass: "status-disconnected" });
  });

  it("returns Disconnected even if apiStatus=busy when machineConnected=false (stale data)", () => {
    const ds = getDisplayStatus({ apiStatus: "busy", currentTool: "Bash", waitingForInput: false, machineConnected: false });
    expect(ds).toEqual({ label: "Disconnected", cssClass: "status-disconnected" });
  });

  it("Rename takes priority over Disconnected", () => {
    const ds = getDisplayStatus({ apiStatus: null, currentTool: null, waitingForInput: false, recentlyRenamed: true, machineConnected: false });
    expect(ds).toEqual({ label: "Rename", cssClass: "status-rename" });
  });

  it("machineConnected=true behaves normally (Working)", () => {
    const ds = getDisplayStatus({ apiStatus: "busy", currentTool: null, waitingForInput: false, machineConnected: true });
    expect(ds).toEqual({ label: "Working", cssClass: "status-working" });
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

describe("statusSortPriority", () => {
  const base = { recentlyRenamed: false, machineConnected: true };

  it("orders Waiting < Working < Rename < Idle < Disconnected", () => {
    const waiting = { ...base, apiStatus: null, currentTool: null, waitingForInput: true };
    const working = { ...base, apiStatus: "busy", currentTool: null, waitingForInput: false };
    const rename = { ...base, apiStatus: null, currentTool: null, waitingForInput: false, recentlyRenamed: true };
    const idle = { ...base, apiStatus: null, currentTool: null, waitingForInput: false };
    const disconnected = { ...base, apiStatus: "busy", currentTool: null, waitingForInput: false, machineConnected: false };

    expect(statusSortPriority(waiting)).toBe(0);
    expect(statusSortPriority(working)).toBe(1);
    expect(statusSortPriority(rename)).toBe(2);
    expect(statusSortPriority(idle)).toBe(3);
    // disconnected는 getDisplayStatus에서 rename 이후 분기, rename=false라 disconnected로 빠짐
    expect(statusSortPriority({ ...disconnected, recentlyRenamed: false })).toBe(4);
  });

  it("treats currentTool as working", () => {
    const s = { ...base, apiStatus: null, currentTool: "bash", waitingForInput: false };
    expect(statusSortPriority(s)).toBe(1);
  });

  it("sort produces Waiting → Working → Idle order regardless of input order", () => {
    const sessions = [
      { id: "idle1", ...base, apiStatus: null, currentTool: null, waitingForInput: false, lastActivityTime: 30 },
      { id: "work1", ...base, apiStatus: "busy", currentTool: null, waitingForInput: false, lastActivityTime: 10 },
      { id: "wait1", ...base, apiStatus: null, currentTool: null, waitingForInput: true, lastActivityTime: 20 },
      { id: "work2", ...base, apiStatus: "retry", currentTool: null, waitingForInput: false, lastActivityTime: 50 },
    ];
    const sorted = sessions.slice().sort((a, b) => {
      const sp = statusSortPriority(a) - statusSortPriority(b);
      if (sp !== 0) return sp;
      return b.lastActivityTime - a.lastActivityTime;
    });
    expect(sorted.map(s => s.id)).toEqual(["wait1", "work2", "work1", "idle1"]);
  });
});

describe("sortSessionsByStatusAndPin", () => {
  const base = { recentlyRenamed: false, machineConnected: true };

  function mk(id: string, kind: "waiting" | "working" | "idle", activity: number) {
    return {
      sessionId: id,
      lastActivityTime: activity,
      apiStatus: kind === "working" ? "busy" : null,
      currentTool: null,
      waitingForInput: kind === "waiting",
      ...base,
    };
  }

  it("pins go first within same status, status order preserved", () => {
    const sessions = [
      mk("idle-unpin-recent", "idle", 100),
      mk("work-pin-old",      "working", 10),
      mk("wait-unpin",        "waiting", 50),
      mk("idle-pin-old",      "idle", 1),
      mk("work-unpin-recent", "working", 200),
      mk("wait-pin",          "waiting", 5),
    ];
    const pinnedIds = new Set(["work-pin-old", "idle-pin-old", "wait-pin"]);
    const sorted = sortSessionsByStatusAndPin(sessions, pinnedIds);
    expect(sorted.map(s => s.sessionId)).toEqual([
      "wait-pin",          // waiting + pinned
      "wait-unpin",        // waiting + unpinned
      "work-pin-old",      // working + pinned
      "work-unpin-recent", // working + unpinned
      "idle-pin-old",      // idle + pinned
      "idle-unpin-recent", // idle + unpinned
    ]);
  });

  it("idle pinned never outranks working unpinned (status invariant)", () => {
    const sessions = [
      mk("idle-pin", "idle", 999),
      mk("work-unpin", "working", 1),
    ];
    const sorted = sortSessionsByStatusAndPin(sessions, new Set(["idle-pin"]));
    expect(sorted[0].sessionId).toBe("work-unpin");
    expect(sorted[1].sessionId).toBe("idle-pin");
  });

  it("within same status and pin state, sorts by lastActivityTime desc", () => {
    const sessions = [
      mk("a", "idle", 10),
      mk("b", "idle", 30),
      mk("c", "idle", 20),
    ];
    const sorted = sortSessionsByStatusAndPin(sessions, new Set());
    expect(sorted.map(s => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate input array", () => {
    const sessions = [mk("a", "idle", 1), mk("b", "waiting", 1)];
    const snapshot = sessions.map(s => s.sessionId);
    sortSessionsByStatusAndPin(sessions, new Set());
    expect(sessions.map(s => s.sessionId)).toEqual(snapshot);
  });

  it("empty pinnedIds falls back to pure status+activity order", () => {
    const sessions = [
      mk("i", "idle", 5),
      mk("w", "waiting", 1),
    ];
    const sorted = sortSessionsByStatusAndPin(sessions, new Set());
    expect(sorted.map(s => s.sessionId)).toEqual(["w", "i"]);
  });
});
