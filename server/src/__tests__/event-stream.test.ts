import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SSEManager } from "../sse/event-stream.js";

/** Minimal mock for FastifyReply.raw (a writable stream) */
function createMockReply() {
  const written: string[] = [];
  const onHandlers = new Map<string, (...args: unknown[]) => void>();

  return {
    raw: {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        written.push(chunk);
        return true;
      }),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        onHandlers.set(event, handler);
      }),
    },
    written,
    onHandlers,
    /** Simulate the client disconnecting */
    simulateClose() {
      const handler = onHandlers.get("close");
      if (handler) handler();
    },
  };
}

describe("SSEManager", () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager(30_000);
  });

  afterEach(() => {
    manager.stop();
  });

  it("should start with 0 clients", () => {
    expect(manager.getClientCount()).toBe(0);
  });

  it("should add a client and send connected event", () => {
    const mock = createMockReply();
    const clientId = manager.addClient(mock as never);

    expect(clientId).toBeTypeOf("string");
    expect(manager.getClientCount()).toBe(1);

    // Should set SSE headers
    expect(mock.raw.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Should send connected event
    expect(mock.written.length).toBeGreaterThanOrEqual(1);
    expect(mock.written[0]).toContain("event: connected");
    expect(mock.written[0]).toContain(clientId);
  });

  it("should remove client on close", () => {
    const mock = createMockReply();
    manager.addClient(mock as never);
    expect(manager.getClientCount()).toBe(1);

    mock.simulateClose();
    expect(manager.getClientCount()).toBe(0);
  });

  it("should remove client by ID", () => {
    const mock = createMockReply();
    const clientId = manager.addClient(mock as never);
    expect(manager.getClientCount()).toBe(1);

    manager.removeClient(clientId);
    expect(manager.getClientCount()).toBe(0);
  });

  it("should broadcast to all clients", () => {
    const mock1 = createMockReply();
    const mock2 = createMockReply();
    manager.addClient(mock1 as never);
    manager.addClient(mock2 as never);

    manager.broadcast("new-card", { id: "card-1" });

    // Both clients should receive the message (index 1 since index 0 is "connected")
    const msg1 = mock1.written[1];
    const msg2 = mock2.written[1];
    expect(msg1).toContain("event: new-card");
    expect(msg1).toContain('"id":"card-1"');
    expect(msg2).toContain("event: new-card");
  });

  it("should remove disconnected clients during broadcast", () => {
    const mock1 = createMockReply();
    const mock2 = createMockReply();
    manager.addClient(mock1 as never);
    manager.addClient(mock2 as never);

    // Make mock2 throw on write (simulating disconnect)
    mock2.raw.write.mockImplementation(() => {
      throw new Error("Connection reset");
    });

    manager.broadcast("test", { data: "hello" });

    // mock2 should be removed
    expect(manager.getClientCount()).toBe(1);
  });

  it("should start and stop heartbeat", () => {
    vi.useFakeTimers();

    const mock = createMockReply();
    manager.addClient(mock as never);
    manager.start();

    // Fast-forward past one heartbeat interval
    vi.advanceTimersByTime(30_000);

    // Should have written a heartbeat
    const heartbeats = mock.written.filter((w) => w.includes(":heartbeat"));
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    manager.stop();
    vi.useRealTimers();
  });

  it("should handle multiple adds and removes", () => {
    const mocks = Array.from({ length: 5 }, () => createMockReply());
    const ids = mocks.map((m) => manager.addClient(m as never));

    expect(manager.getClientCount()).toBe(5);

    manager.removeClient(ids[0]);
    manager.removeClient(ids[2]);
    expect(manager.getClientCount()).toBe(3);

    manager.stop();
    expect(manager.getClientCount()).toBe(0);
  });
});
