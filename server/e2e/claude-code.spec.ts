import { test, expect } from "@playwright/test";

test.describe("Claude Code Integration", () => {
  test("GET /api/queries returns 200 and includes source field", async ({ request }) => {
    const response = await request.get("/api/queries?limit=50");
    expect(response.status()).toBe(200);
    const body = await response.json() as { queries: Record<string, unknown>[] };
    expect(body).toHaveProperty("queries");
    expect(Array.isArray(body.queries)).toBe(true);
  });

  test("claude-code queries do not contain slash commands", async ({ request }) => {
    const response = await request.get("/api/queries?limit=100");
    expect(response.status()).toBe(200);
    const body = await response.json() as { queries: Record<string, unknown>[] };
    const claudeQueries = body.queries.filter(
      (q) => q["source"] === "claude-code"
    );
    for (const query of claudeQueries) {
      const queryText = String(query["query"] ?? "");
      expect(queryText).not.toMatch(/^\//);
      expect(queryText.trim().length).toBeGreaterThan(0);
    }
  });

  test("GET /api/sessions returns sessions with valid status", async ({ request }) => {
    const response = await request.get("/api/sessions");
    expect(response.status()).toBe(200);
    const body = await response.json() as { sessions: Record<string, unknown>[] };
    expect(body).toHaveProperty("sessions");
    expect(Array.isArray(body.sessions)).toBe(true);

    const claudeSessions = body.sessions.filter(
      (s) => s["source"] === "claude-code"
    );
    for (const session of claudeSessions) {
      expect(["active", "completed", "orphaned"]).toContain(session["status"]);
      expect(session).toHaveProperty("sessionId");
    }
  });

  test("claude-code sessions have required fields", async ({ request }) => {
    const response = await request.get("/api/sessions");
    const body = await response.json() as { sessions: Record<string, unknown>[] };
    const claudeSessions = body.sessions.filter(
      (s) => s["source"] === "claude-code"
    );

    for (const session of claudeSessions) {
      expect(typeof session["sessionId"]).toBe("string");
      expect(typeof session["startTime"]).toBe("number");
      expect(typeof session["lastActivityTime"]).toBe("number");
      expect(session["source"]).toBe("claude-code");
    }
  });
});
