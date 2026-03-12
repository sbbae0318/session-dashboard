export interface SSEClientOptions {
  url: string;
  /** Must be greater than server heartbeat interval (default 30s) */
  heartbeatTimeoutMs?: number;
}

export type SSEHandler = (data: unknown) => void;

export function createSSEClient(options: SSEClientOptions) {
  const { url, heartbeatTimeoutMs = 40_000 } = options;
  const handlers = new Map<string, SSEHandler>();
  let es: EventSource | null = null;
  let onConnectedChange: ((connected: boolean) => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let isConnected = false;

  function setConnected(value: boolean): void {
    if (isConnected !== value) {
      isConnected = value;
      onConnectedChange?.(value);
    }
  }

  function resetHeartbeat(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      setConnected(false);
    }, heartbeatTimeoutMs);
  }

  function wireHandlers(source: EventSource): void {
    for (const [event, handler] of handlers) {
      source.addEventListener(event, (e: MessageEvent) => {
        resetHeartbeat();
        handler(JSON.parse(e.data));
      });
    }
  }

  function connect(): void {
    es = new EventSource(url);

    es.onopen = () => {
      setConnected(true);
      resetHeartbeat();
    };

    // Intentionally empty — browser auto-reconnects; heartbeat timer detects real disconnect
    es.onerror = () => {};

    wireHandlers(es);
  }

  return {
    on(event: string, handler: SSEHandler) {
      handlers.set(event, handler);
      if (es) {
        es.addEventListener(event, (e: MessageEvent) => {
          resetHeartbeat();
          handler(JSON.parse(e.data));
        });
      }
      return this;
    },
    onConnectionChange(cb: (connected: boolean) => void) {
      onConnectedChange = cb;
      return this;
    },
    start() {
      connect();
      return this;
    },
    stop() {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      es?.close();
      es = null;
      setConnected(false);
    },
  };
}
