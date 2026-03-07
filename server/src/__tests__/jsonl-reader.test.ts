import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { JsonlReader } from "../readers/jsonl-reader.js";

interface TestItem {
  id: number;
  name: string;
}

function tempFile(): string {
  const dir = join(tmpdir(), "jsonl-reader-test");
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

describe("JsonlReader", () => {
  describe("tailLines()", () => {
    it("should parse lines with #XX| prefix", async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(
        path,
        [
          '#AB|{"id":1,"name":"alpha"}',
          '#CD|{"id":2,"name":"beta"}',
          '#EF|{"id":3,"name":"gamma"}',
        ].join("\n") + "\n",
      );

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(3);
      expect(items[0]).toEqual({ id: 1, name: "alpha" });
      expect(items[1]).toEqual({ id: 2, name: "beta" });
      expect(items[2]).toEqual({ id: 3, name: "gamma" });
    });

    it("should return last N items when n < total lines", async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(
        path,
        [
          '#AB|{"id":1,"name":"first"}',
          '#CD|{"id":2,"name":"second"}',
          '#EF|{"id":3,"name":"third"}',
          '#GH|{"id":4,"name":"fourth"}',
          '#IJ|{"id":5,"name":"fifth"}',
        ].join("\n") + "\n",
      );

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(2);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ id: 4, name: "fourth" });
      expect(items[1]).toEqual({ id: 5, name: "fifth" });
    });

    it("should return empty array for non-existent file", async () => {
      const reader = new JsonlReader<TestItem>("/tmp/does-not-exist-" + randomUUID() + ".jsonl");
      const items = await reader.tailLines(10);
      expect(items).toEqual([]);
    });

    it("should return empty array for empty file", async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, "");

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);
      expect(items).toEqual([]);
    });

    it("should skip lines with invalid JSON", async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(
        path,
        [
          '#AB|{"id":1,"name":"valid"}',
          "#CD|not valid json",
          '#EF|{"id":3,"name":"also valid"}',
        ].join("\n") + "\n",
      );

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ id: 1, name: "valid" });
      expect(items[1]).toEqual({ id: 3, name: "also valid" });
    });

    it("should parse lines without prefix as regular JSON", async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(
        path,
        ['{"id":1,"name":"no-prefix"}', '{"id":2,"name":"also-no-prefix"}'].join("\n") + "\n",
      );

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ id: 1, name: "no-prefix" });
      expect(items[1]).toEqual({ id: 2, name: "also-no-prefix" });
    });

    it("should skip empty lines and whitespace-only lines", async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(
        path,
        ['#AB|{"id":1,"name":"one"}', "", "   ", '#CD|{"id":2,"name":"two"}'].join("\n") + "\n",
      );

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(2);
    });

    it("should handle mixed prefixed and non-prefixed lines", async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(
        path,
        [
          '#AB|{"id":1,"name":"prefixed"}',
          '{"id":2,"name":"bare"}',
          '#XY|{"id":3,"name":"prefixed-again"}',
        ].join("\n") + "\n",
      );

      const reader = new JsonlReader<TestItem>(path);
      const items = await reader.tailLines(10);

      expect(items).toHaveLength(3);
      expect(items[1]).toEqual({ id: 2, name: "bare" });
    });
  });

  describe("watchFile()", () => {
    it("should detect new lines appended to the file", async () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, '#AB|{"id":1,"name":"initial"}\n');

      const reader = new JsonlReader<TestItem>(path);
      const received: TestItem[] = [];

      const stop = reader.watchFile((item) => {
        received.push(item);
      });

      // Wait for chokidar to initialize
      await new Promise((r) => setTimeout(r, 300));

      // Append a new line
      const { appendFileSync } = await import("node:fs");
      appendFileSync(path, '#CD|{"id":2,"name":"appended"}\n');

      // Wait for chokidar to detect the change + debounce
      await new Promise((r) => setTimeout(r, 500));

      stop();

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]).toEqual({ id: 2, name: "appended" });
    });

    it("should return a cleanup function that stops watching", () => {
      const path = tempFile();
      cleanupFiles.push(path);
      writeFileSync(path, '#AB|{"id":1,"name":"test"}\n');

      const reader = new JsonlReader<TestItem>(path);
      const stop = reader.watchFile(() => {});

      expect(stop).toBeTypeOf("function");
      // Should not throw when called
      stop();
    });

    it("should handle watching a non-existent file path", () => {
      const path = "/tmp/nonexistent-watch-" + randomUUID() + ".jsonl";
      const reader = new JsonlReader<TestItem>(path);
      const stop = reader.watchFile(() => {});

      expect(stop).toBeTypeOf("function");
      stop();
    });
  });
});
