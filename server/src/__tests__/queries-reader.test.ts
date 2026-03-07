import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { QueriesReader, type QueryEntry } from "../modules/recent-prompts/queries-reader.js";

function tempFile(): string {
  const dir = join(tmpdir(), "queries-reader-test");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.jsonl`);
}

const cleanupFiles: string[] = [];

afterEach(() => {
  for (const f of cleanupFiles) {
    try {
      unlinkSync(f);
    } catch {
      // ignore
    }
  }
  cleanupFiles.length = 0;
});

// makeQuery builds a raw JSONL-shaped object (no machine fields) for writing to file
function makeQuery(overrides: Partial<{ sessionId: string; sessionTitle: string | null; timestamp: number; query: string; isBackground: boolean }> = {}): Record<string, unknown> {
  return {
    sessionId: randomUUID(), // NOTE: lowercase d
    sessionTitle: "Test Session",
    timestamp: Date.now(),
    query: "Help me with this code",
    isBackground: false,
    ...overrides,
  };
}

describe("QueriesReader", () => {
  it("should parse QueryEntry fields correctly (sessionId lowercase d)", async () => {
    const path = tempFile();
    cleanupFiles.push(path);

    const entry = makeQuery({
      sessionId: "query-sess-abc",
      sessionTitle: "My Session",
      query: "What does this function do?",
      isBackground: false,
    });

    writeFileSync(path, `#AB|${JSON.stringify(entry)}\n`);

    const reader = new QueriesReader(path);
    const queries = await reader.getRecentQueries();

    expect(queries).toHaveLength(1);
    expect(queries[0].sessionId).toBe("query-sess-abc"); // lowercase d
    expect(queries[0].sessionTitle).toBe("My Session");
    expect(queries[0].query).toBe("What does this function do?");
    expect(queries[0].isBackground).toBe(false);
    expect(queries[0].timestamp).toBeTypeOf("number");
  });

  it("should return default limit of 10 queries", async () => {
    const path = tempFile();
    cleanupFiles.push(path);

    const lines: string[] = [];
    for (let i = 0; i < 15; i++) {
      const entry = makeQuery({ sessionId: `q-sess-${i}`, query: `Query ${i}` });
      lines.push(`#AB|${JSON.stringify(entry)}`);
    }
    writeFileSync(path, lines.join("\n") + "\n");

    const reader = new QueriesReader(path);
    const queries = await reader.getRecentQueries();

    expect(queries).toHaveLength(10);
    // Last 10 (index 5-14)
    expect(queries[0].sessionId).toBe("q-sess-5");
    expect(queries[9].sessionId).toBe("q-sess-14");
  });

  it("should respect custom limit", async () => {
    const path = tempFile();
    cleanupFiles.push(path);

    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      const entry = makeQuery({ sessionId: `q-${i}` });
      lines.push(`#CD|${JSON.stringify(entry)}`);
    }
    writeFileSync(path, lines.join("\n") + "\n");

    const reader = new QueriesReader(path);
    const queries = await reader.getRecentQueries(5);

    expect(queries).toHaveLength(5);
    expect(queries[0].sessionId).toBe("q-5");
    expect(queries[4].sessionId).toBe("q-9");
  });

  it("should handle background queries", async () => {
    const path = tempFile();
    cleanupFiles.push(path);

    const entry = makeQuery({
      isBackground: true,
      sessionTitle: null,
      query: "Background task",
    });

    writeFileSync(path, `#EF|${JSON.stringify(entry)}\n`);

    const reader = new QueriesReader(path);
    const queries = await reader.getRecentQueries();

    expect(queries[0].isBackground).toBe(true);
    expect(queries[0].sessionTitle).toBeNull();
  });

  it("should return empty array for non-existent file", async () => {
    const reader = new QueriesReader("/tmp/nonexistent-" + randomUUID() + ".jsonl");
    const queries = await reader.getRecentQueries();
    expect(queries).toEqual([]);
  });
});
