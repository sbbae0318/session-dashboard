export interface SSEClientOptions {
  url: string;
  reconnectMs?: number;
}

export type SSEHandler = (data: unknown) => void;

export function createSSEClient(options: SSEClientOptions) {
  const { url, reconnectMs = 3000 } = options;
  const handlers = new Map<string, SSEHandler>();
  let es: EventSource | null = null;
  let onConnectedChange: ((connected: boolean) => void) | null = null;

  function connect() {
    es = new EventSource(url);
    
    es.addEventListener("connected", () => {
      onConnectedChange?.(true);
    });
    
    // Wire up all registered handlers
    for (const [event, handler] of handlers) {
      es.addEventListener(event, (e: MessageEvent) => {
        handler(JSON.parse(e.data));
      });
    }
    
    es.onerror = () => {
      onConnectedChange?.(false);
      es?.close();
      setTimeout(connect, reconnectMs);
    };
  }

  return {
    on(event: string, handler: SSEHandler) {
      handlers.set(event, handler);
      // If already connected, wire up immediately
      if (es) {
        es.addEventListener(event, (e: MessageEvent) => {
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
      es?.close();
      es = null;
    }
  };
}
