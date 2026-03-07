import { useState, useEffect, useRef, useCallback } from 'react';
import type { DashboardSession, HistoryCard, QueryEntry, MachineInfo } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseCallbacks {
  onSessionUpdate?: (sessions: DashboardSession[]) => void;
  onCardNew?: (card: HistoryCard) => void;
  onQueryNew?: (query: QueryEntry) => void;
  onMachineStatus?: (machines: MachineInfo[]) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

interface SseConnectOptions extends SseCallbacks {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// SSE line-based parser helpers
// ---------------------------------------------------------------------------

interface SseFrame {
  event: string;
  data: string;
}

function parseLines(buffer: string, lines: string[]): { buffer: string; frames: SseFrame[] } {
  let currentEvent = '';
  let currentData = '';
  const frames: SseFrame[] = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent !== '') {
      frames.push({ event: currentEvent, data: currentData });
      currentEvent = '';
      currentData = '';
    }
    // Ignore heartbeat comments (`:heartbeat`) and unknown lines
  }

  return { buffer, frames };
}

function dispatchFrame(frame: SseFrame, callbacks: SseCallbacks): void {
  try {
    const parsed: unknown = JSON.parse(frame.data);
    switch (frame.event) {
      case 'session.update':
        callbacks.onSessionUpdate?.(parsed as DashboardSession[]);
        break;
      case 'card.new':
        callbacks.onCardNew?.(parsed as HistoryCard);
        break;
      case 'query.new':
        callbacks.onQueryNew?.(parsed as QueryEntry);
        break;
      case 'machine.status':
        callbacks.onMachineStatus?.(parsed as MachineInfo[]);
        break;
      case 'connected':
        callbacks.onConnect?.();
        break;
      default:
        break;
    }
  } catch {
    // Malformed JSON — skip silently
  }
}

// ---------------------------------------------------------------------------
// Core SSE reader (processes ReadableStream chunks)
// ---------------------------------------------------------------------------

async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SseCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    const { frames } = parseLines(buffer, lines);
    for (const frame of frames) {
      dispatchFrame(frame, callbacks);
    }
  }
}

// ---------------------------------------------------------------------------
// Exponential backoff helper
// ---------------------------------------------------------------------------

const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

function nextDelay(current: number): number {
  return Math.min(current * 2, MAX_DELAY_MS);
}

// ---------------------------------------------------------------------------
// connectSse — low-level, non-React
// ---------------------------------------------------------------------------

export function connectSse(baseUrl: string, options: SseConnectOptions): void {
  const { signal, ...callbacks } = options;
  let delay = MIN_DELAY_MS;

  async function attempt(): Promise<void> {
    if (signal?.aborted) return;

    try {
      const response = await fetch(`${baseUrl}/api/events`, {
        headers: { Accept: 'text/event-stream' },
        signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      delay = MIN_DELAY_MS; // reset on successful connect
      const reader = response.body.getReader();

      await readSseStream(reader, callbacks, signal ?? new AbortController().signal);
    } catch (err) {
      if (signal?.aborted) return;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) return;
    }

    if (signal?.aborted) return;
    callbacks.onDisconnect?.();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });

    delay = nextDelay(delay);
    void attempt();
  }

  void attempt();
}

// ---------------------------------------------------------------------------
// useSse — React hook wrapper
// ---------------------------------------------------------------------------

export function useSse(
  baseUrl: string,
  callbacks: SseCallbacks,
): { connected: boolean; reconnecting: boolean } {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const callbacksRef = useRef(callbacks);

  // Keep callbacks ref fresh without re-triggering effect
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  const stableCallbacks = useCallback((): SseCallbacks => ({
    onSessionUpdate: (s) => callbacksRef.current.onSessionUpdate?.(s),
    onCardNew: (c) => callbacksRef.current.onCardNew?.(c),
    onQueryNew: (q) => callbacksRef.current.onQueryNew?.(q),
    onMachineStatus: (m) => callbacksRef.current.onMachineStatus?.(m),
    onConnect: () => {
      setConnected(true);
      setReconnecting(false);
      callbacksRef.current.onConnect?.();
    },
    onDisconnect: () => {
      setConnected(false);
      setReconnecting(true);
      callbacksRef.current.onDisconnect?.();
    },
  }), []);

  useEffect(() => {
    const controller = new AbortController();

    connectSse(baseUrl, {
      ...stableCallbacks(),
      signal: controller.signal,
    });

    return () => {
      controller.abort();
      setConnected(false);
      setReconnecting(false);
    };
  }, [baseUrl, stableCallbacks]);

  return { connected, reconnecting };
}
