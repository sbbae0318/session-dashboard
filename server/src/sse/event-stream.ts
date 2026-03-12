import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";

interface SSEClient {
  id: string;
  reply: FastifyReply;
}

/**
 * SSE Manager — broadcasts events to all connected clients
 * 
 * Protocol: text/event-stream
 * Format: event: {type}\ndata: {json}\n\n
 * Heartbeat: every 30s sends `:heartbeat\n\n`
 */
export class SSEManager {
  private clients = new Map<string, SSEClient>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatMs: number;

  constructor(heartbeatMs: number = 30_000) {
    this.heartbeatMs = heartbeatMs;
  }

  /**
   * Start the heartbeat timer
   */
  start(): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatMs);
  }

  /**
   * Stop and clean up all clients + heartbeat
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.clients.clear();
  }

  /**
   * Add a new SSE client
   * Sets up the response headers and returns the client ID
   */
  addClient(reply: FastifyReply): string {
    const clientId = randomUUID();

    // Set SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connection event
    reply.raw.write(`retry: 1000\nevent: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

    this.clients.set(clientId, { id: clientId, reply });

    // Auto-remove on close
    reply.raw.on("close", () => {
      this.removeClient(clientId);
    });

    return clientId;
  }

  /**
   * Remove a client by ID
   */
  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  /**
   * Broadcast an event to ALL connected clients
   */
  broadcast(eventType: string, data: unknown): void {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    
    for (const [clientId, client] of this.clients) {
      try {
        client.reply.raw.write(message);
      } catch {
        // Client disconnected, remove
        this.clients.delete(clientId);
      }
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Send heartbeat to keep connections alive
   */
  private sendHeartbeat(): void {
    const heartbeat = `:heartbeat\n\n`;
    
    for (const [clientId, client] of this.clients) {
      try {
        client.reply.raw.write(heartbeat);
      } catch {
        this.clients.delete(clientId);
      }
    }
  }
}
