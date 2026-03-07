import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock node:http before imports ──
const mockHttpGet = vi.fn();
const mockHttpRequest = vi.fn();
vi.mock('node:http', () => ({
  get: (...args: unknown[]) => mockHttpGet(...args),
  request: (...args: unknown[]) => mockHttpRequest(...args),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { registerProxyRoutes, registerPostProxyRoutes, checkOcServeConnection } from '../oc-serve-proxy.js';

// ── Test helpers ──

function mockSuccessResponse(body: string): void {
  mockHttpGet.mockImplementationOnce(
    (_url: string, _opts: unknown, callback: (res: unknown) => void) => {
      const response = {
        statusCode: 200,
        statusMessage: 'OK',
        on: vi.fn((event: string, handler: (chunk?: unknown) => void) => {
          if (event === 'data') handler(Buffer.from(body));
          if (event === 'end') handler();
        }),
      };
      callback(response);
      return {
        on: vi.fn(),
      };
    },
  );
}

function mockErrorResponse(message: string): void {
  mockHttpGet.mockImplementationOnce(
    (_url: string, _opts: unknown, _callback: unknown) => {
      const request = {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') handler(new Error(message));
          // 'abort' handler does nothing
        }),
      };
      return request;
    },
  );
}

function mockPostSuccessResponse(body: string): void {
  mockHttpRequest.mockImplementationOnce(
    (_opts: unknown, callback: (res: unknown) => void) => {
      const response = {
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'content-type': 'application/json' },
        on: vi.fn((event: string, handler: (chunk?: unknown) => void) => {
          if (event === 'data') handler(Buffer.from(body));
          if (event === 'end') handler();
        }),
        pipe: vi.fn(),
      };
      callback(response);
      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };
    },
  );
}

function mockPostErrorResponse(message: string): void {
  mockHttpRequest.mockImplementationOnce(
    (_opts: unknown, _callback: unknown) => {
      const request = {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') handler(new Error(message));
        }),
        write: vi.fn(),
        end: vi.fn(),
      };
      return request;
    },
  );
}

function mockPostStreamResponse(body: string): void {
  mockHttpRequest.mockImplementationOnce(
    (_opts: unknown, callback: (res: unknown) => void) => {
      const response = {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        pipe: vi.fn((writable: { end: (data?: string) => void }) => {
          writable.end(body);
        }),
      };
      callback(response);
      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };
    },
  );
}

describe('oc-serve-proxy', () => {
  let app: FastifyInstance;
  const originalEnv = process.env['OC_SERVE_PORT'];

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env['OC_SERVE_PORT'] = '4096';
    app = Fastify({ logger: false });
    registerProxyRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnv !== undefined) {
      process.env['OC_SERVE_PORT'] = originalEnv;
    } else {
      delete process.env['OC_SERVE_PORT'];
    }
  });

  describe('GET /proxy/session/status', () => {
    it('should forward request to oc-serve and return data', async () => {
      const mockData = { 'sess-1': { type: 'active' } };
      mockSuccessResponse(JSON.stringify(mockData));

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/session/status',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockData);
    });

    it('should return 502 when oc-serve is not running', async () => {
      mockErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/session/status',
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('oc-serve unavailable');
      expect(body.code).toBe('OC_SERVE_DOWN');
    });
  });

  describe('GET /proxy/session', () => {
    it('should forward request to oc-serve and return session list', async () => {
      const mockSessions = [{ sessionId: 'sess-1', title: 'Work' }];
      mockSuccessResponse(JSON.stringify(mockSessions));

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/session',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockSessions);
    });

    it('should return 502 when oc-serve is unreachable', async () => {
      mockErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/session',
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('OC_SERVE_DOWN');
    });
  });

  describe('GET /proxy/session/:id', () => {
    it('should forward request with session id', async () => {
      const mockSession = { sessionId: 'sess-123', title: 'Debug session' };
      mockSuccessResponse(JSON.stringify(mockSession));

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/session/sess-123',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockSession);

      // Verify the correct URL was called
      const calledUrl = mockHttpGet.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/session/sess-123');
    });

    it('should return 502 when oc-serve is down', async () => {
      mockErrorResponse('Connection refused');

      const response = await app.inject({
        method: 'GET',
        url: '/proxy/session/any-id',
      });

      expect(response.statusCode).toBe(502);
    });
  });

  describe('checkOcServeConnection()', () => {
    it('should return true when oc-serve responds', async () => {
      mockSuccessResponse(JSON.stringify({ status: 'ok' }));

      const connected = await checkOcServeConnection();
      expect(connected).toBe(true);
    });

    it('should return false when oc-serve is not reachable', async () => {
      mockErrorResponse('ECONNREFUSED');

      const connected = await checkOcServeConnection();
      expect(connected).toBe(false);
    });
  });
});

describe('POST proxy routes', () => {
  let app: FastifyInstance;
  let testToken: string;
  const originalEnv = process.env['OC_SERVE_PORT'];

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env['OC_SERVE_PORT'] = '4096';
    app = Fastify({ logger: false });
    await app.register(fastifyJwt, { secret: 'test-secret' });
    registerProxyRoutes(app);
    registerPostProxyRoutes(app);
    await app.ready();
    testToken = app.jwt.sign({ role: 'mobile' });
  });

  afterEach(async () => {
    await app.close();
    if (originalEnv !== undefined) {
      process.env['OC_SERVE_PORT'] = originalEnv;
    } else {
      delete process.env['OC_SERVE_PORT'];
    }
  });

  describe('POST /proxy/session', () => {
    it('should create session via oc-serve', async () => {
      const mockData = { sessionId: 'new-sess', title: 'New Session' };
      mockPostSuccessResponse(JSON.stringify(mockData));

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { directory: '/test/project' },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockData);
      expect(mockHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/session', method: 'POST' }),
        expect.any(Function),
      );
    });

    it('should return 502 when oc-serve is down', async () => {
      mockPostErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { directory: '/test/project' },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('oc-serve unavailable');
      expect(body.code).toBe('OC_SERVE_DOWN');
    });

    it('should return 401 without JWT token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session',
        payload: { directory: '/test/project' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /proxy/session/:id/message', () => {
    it('should forward message to oc-serve', async () => {
      const streamData = JSON.stringify({ type: 'text', content: 'Hello' });
      mockPostStreamResponse(streamData);

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session/sess-1/message',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { content: 'Hello, world!' },
      });

      expect(mockHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/session/sess-1/message', method: 'POST' }),
        expect.any(Function),
      );
      expect(response.statusCode).toBe(200);
    });

    it('should return 502 when oc-serve is down', async () => {
      mockPostErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session/sess-1/message',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { content: 'Hello, world!' },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('oc-serve unavailable');
      expect(body.code).toBe('OC_SERVE_DOWN');
    });
  });

  describe('POST /proxy/session/:id/abort', () => {
    it('should abort session', async () => {
      const mockData = { success: true };
      mockPostSuccessResponse(JSON.stringify(mockData));

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session/sess-1/abort',
        headers: { authorization: `Bearer ${testToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockData);
    });

    it('should return 502 when oc-serve is down', async () => {
      mockPostErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session/sess-1/abort',
        headers: { authorization: `Bearer ${testToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('oc-serve unavailable');
      expect(body.code).toBe('OC_SERVE_DOWN');
    });
  });

  describe('POST /proxy/question/:id/reply', () => {
    it('should forward question reply', async () => {
      const mockData = { success: true };
      mockPostSuccessResponse(JSON.stringify(mockData));

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/question/q-1/reply',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { answer: 'yes' },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockData);
    });

    it('should return 502 when oc-serve is down', async () => {
      mockPostErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/question/q-1/reply',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { answer: 'yes' },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('oc-serve unavailable');
      expect(body.code).toBe('OC_SERVE_DOWN');
    });
  });

  describe('POST /proxy/permission/:id/reply', () => {
    it('should forward permission reply', async () => {
      const mockData = { success: true };
      mockPostSuccessResponse(JSON.stringify(mockData));

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/permission/p-1/reply',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { granted: true },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockData);
    });

    it('should return 502 when oc-serve is down', async () => {
      mockPostErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/permission/p-1/reply',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { granted: true },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('oc-serve unavailable');
      expect(body.code).toBe('OC_SERVE_DOWN');
    });
  });

  describe('POST /proxy/session/:id/fork', () => {
    it('should fork session', async () => {
      const mockData = { sessionId: 'forked-sess' };
      mockPostSuccessResponse(JSON.stringify(mockData));

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session/sess-1/fork',
        headers: { authorization: `Bearer ${testToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockData);
    });

    it('should return 502 when oc-serve is down', async () => {
      mockPostErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session/sess-1/fork',
        headers: { authorization: `Bearer ${testToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('oc-serve unavailable');
      expect(body.code).toBe('OC_SERVE_DOWN');
    });
  });

  describe('POST /proxy/session/:id/command', () => {
    it('should run command', async () => {
      const mockData = { output: 'command output' };
      mockPostSuccessResponse(JSON.stringify(mockData));

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session/sess-1/command',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { command: 'ls -la' },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(mockData);
    });

    it('should return 502 when oc-serve is down', async () => {
      mockPostErrorResponse('ECONNREFUSED');

      const response = await app.inject({
        method: 'POST',
        url: '/proxy/session/sess-1/command',
        headers: { authorization: `Bearer ${testToken}` },
        payload: { command: 'ls -la' },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('oc-serve unavailable');
      expect(body.code).toBe('OC_SERVE_DOWN');
    });
  });
});
