import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CardsReader, type HistoryCard } from "../modules/session-cards/cards-reader.js";

function tempFile(): string {
  const dir = join(tmpdir(), "cards-reader-test");
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

// makeCard builds a raw JSONL-shaped object (sessionID capital D) for writing to file
function makeCard(overrides: Partial<{ sessionID: string } & Omit<HistoryCard, 'sessionId' | 'machineId' | 'machineHost' | 'machineAlias'>> = {}): Record<string, unknown> {
  return {
    version: 1,
    sessionID: randomUUID(), // raw JSONL format uses capital D
    startTime: Date.now() - 60_000,
    endTime: Date.now(),
    endedAt: new Date().toISOString(),
    duration: "1m 0s",
    summary: "Test session",
    tools: ["Read", "Write"],
    source: "test",
    ...overrides,
  };
}

describe("CardsReader", () => {
  it("should parse HistoryCard fields correctly", async () => {
    const path = tempFile();
    cleanupFiles.push(path);

    const card = makeCard({
      sessionID: "sess-abc-123",
      summary: "Implemented feature X",
      tools: ["Bash", "Read", "Write"],
      source: "claude-code",
    });

    writeFileSync(path, `#AB|${JSON.stringify(card)}\n`);

    const reader = new CardsReader(path);
    const cards = await reader.getRecentCards();

    expect(cards).toHaveLength(1);
    expect(cards[0].sessionId).toBe("sess-abc-123"); // normalized from sessionID
    expect(cards[0].summary).toBe("Implemented feature X");
    expect(cards[0].tools).toEqual(["Bash", "Read", "Write"]);
    expect(cards[0].source).toBe("claude-code");
    expect(cards[0].version).toBe(1);
  });

  it("should return default limit of 20 cards", async () => {
    const path = tempFile();
    cleanupFiles.push(path);

    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      const card = makeCard({ sessionID: `sess-${i}`, summary: `Session ${i}` });
      lines.push(`#AB|${JSON.stringify(card)}`);
    }
    writeFileSync(path, lines.join("\n") + "\n");

    const reader = new CardsReader(path);
    const cards = await reader.getRecentCards();

    expect(cards).toHaveLength(20);
    // Should return the last 20 (index 5-24)
    expect(cards[0].sessionId).toBe("sess-5"); // normalized from sessionID
    expect(cards[19].sessionId).toBe("sess-24");
  });

  it("should respect custom limit", async () => {
    const path = tempFile();
    cleanupFiles.push(path);

    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      const card = makeCard({ sessionID: `sess-${i}` });
      lines.push(`#CD|${JSON.stringify(card)}`);
    }
    writeFileSync(path, lines.join("\n") + "\n");

    const reader = new CardsReader(path);
    const cards = await reader.getRecentCards(3);

    expect(cards).toHaveLength(3);
    expect(cards[0].sessionId).toBe("sess-7"); // normalized from sessionID
    expect(cards[2].sessionId).toBe("sess-9");
  });

  it("should parse V2 cards with extended fields", async () => {
    const path = tempFile();
    cleanupFiles.push(path);

    const card = makeCard({
      version: 2,
      project: { cwd: "/home/user/project", root: "/home/user/project" },
      parentSessionID: "parent-sess-1",
      endReason: "completed",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadTokens: 200,
      },
    });

    writeFileSync(path, `#EF|${JSON.stringify(card)}\n`);

    const reader = new CardsReader(path);
    const cards = await reader.getRecentCards();

    expect(cards[0].version).toBe(2);
    expect(cards[0].project?.cwd).toBe("/home/user/project");
    expect(cards[0].parentSessionID).toBe("parent-sess-1");
    expect(cards[0].tokenUsage?.totalTokens).toBe(1500);
  });

  it("should return empty array for non-existent file", async () => {
    const reader = new CardsReader("/tmp/nonexistent-" + randomUUID() + ".jsonl");
    const cards = await reader.getRecentCards();
    expect(cards).toEqual([]);
  });
});
