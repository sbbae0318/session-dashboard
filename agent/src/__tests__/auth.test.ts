import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authPreHandler, jwtPreHandler, createAuthToken } from '../auth.js';
import type { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';

// ── Test helpers ──

function createMockRequest(url: string, authHeader?: string): FastifyRequest {
  return {
    url,
    headers: authHeader !== undefined
      ? { authorization: authHeader }
      : {},
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function createMockReply(): FastifyReply & { sentCode: number | null; sentBody: unknown } {
  const reply = {
    sentCode: null as number | null,
    sentBody: null as unknown,
    code(statusCode: number) {
      reply.sentCode = statusCode;
      return reply;
    },
    send(body: unknown) {
      reply.sentBody = body;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { sentCode: number | null; sentBody: unknown };
}

describe('authPreHandler', () => {
  const originalEnv = process.env['API_KEY'];

  beforeEach(() => {
    delete process.env['API_KEY'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['API_KEY'] = originalEnv;
    } else {
      delete process.env['API_KEY'];
    }
  });

  it('should pass through for /health without auth', () => {
    process.env['API_KEY'] = 'test-secret';
    const request = createMockRequest('/health');
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    expect(done).toHaveBeenCalledOnce();
    expect(reply.sentCode).toBeNull();
  });

  it('should pass through with valid Bearer token', () => {
    process.env['API_KEY'] = 'test-secret';
    const request = createMockRequest('/api/cards', 'Bearer test-secret');
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    expect(done).toHaveBeenCalledOnce();
    expect(reply.sentCode).toBeNull();
  });

  it('should return 401 when Authorization header is missing', () => {
    process.env['API_KEY'] = 'test-secret';
    const request = createMockRequest('/api/cards');
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    expect(done).not.toHaveBeenCalled();
    expect(reply.sentCode).toBe(401);
    expect(reply.sentBody).toEqual({ error: 'Unauthorized' });
  });

  it('should return 401 when token is wrong', () => {
    process.env['API_KEY'] = 'test-secret';
    const request = createMockRequest('/api/cards', 'Bearer wrong-token');
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    expect(done).not.toHaveBeenCalled();
    expect(reply.sentCode).toBe(401);
    expect(reply.sentBody).toEqual({ error: 'Unauthorized' });
  });

  it('should return 401 when Authorization header has no Bearer prefix', () => {
    process.env['API_KEY'] = 'test-secret';
    const request = createMockRequest('/api/cards', 'Basic test-secret');
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    expect(done).not.toHaveBeenCalled();
    expect(reply.sentCode).toBe(401);
  });

  it('should allow all requests when API_KEY is not set (dev mode)', () => {
    // API_KEY not set
    const request = createMockRequest('/api/cards');
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    expect(done).toHaveBeenCalledOnce();
    expect(reply.sentCode).toBeNull();
  });

  it('should log warning when API_KEY is not set', () => {
    const request = createMockRequest('/api/cards');
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    const logWarn = (request.log as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
    expect(logWarn).toHaveBeenCalledWith('API_KEY not set — authentication disabled');
  });
});

describe('jwtPreHandler', () => {
  it('should pass through when JWT is valid', async () => {
    const request = {
      jwtVerify: vi.fn().mockResolvedValue({ role: 'mobile' }),
    } as unknown as FastifyRequest;
    const reply = createMockReply();

    await jwtPreHandler(request, reply as unknown as FastifyReply);

    expect(request.jwtVerify).toHaveBeenCalledOnce();
    expect(reply.sentCode).toBeNull();
  });

  it('should return 401 when JWT is invalid', async () => {
    const request = {
      jwtVerify: vi.fn().mockRejectedValue(new Error('invalid token')),
    } as unknown as FastifyRequest;
    const reply = createMockReply();

    await jwtPreHandler(request, reply as unknown as FastifyReply);

    expect(reply.sentCode).toBe(401);
    expect(reply.sentBody).toEqual({ error: 'Invalid or missing JWT token' });
  });

  it('should return 401 when no token provided', async () => {
    const request = {
      jwtVerify: vi.fn().mockRejectedValue(new Error('No Authorization was found')),
    } as unknown as FastifyRequest;
    const reply = createMockReply();

    await jwtPreHandler(request, reply as unknown as FastifyReply);

    expect(reply.sentCode).toBe(401);
  });
});

describe('createAuthToken', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyJwt, { secret: 'test-secret-key' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return token when API key is valid', () => {
    const result = createAuthToken(app, 'correct-key', 'correct-key');

    expect(result).not.toBeNull();
    expect(result!.token).toBeDefined();
    expect(typeof result!.token).toBe('string');
    expect(result!.expiresIn).toBe('24h');
  });

  it('should return null when API key is wrong', () => {
    const result = createAuthToken(app, 'wrong-key', 'correct-key');

    expect(result).toBeNull();
  });

  it('should return null when config API key is empty', () => {
    const result = createAuthToken(app, 'any-key', '');

    expect(result).toBeNull();
  });
});

describe('authPreHandler — skip conditions', () => {
  const originalEnv = process.env['API_KEY'];

  beforeEach(() => {
    delete process.env['API_KEY'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['API_KEY'] = originalEnv;
    } else {
      delete process.env['API_KEY'];
    }
  });

  it('should skip for /api/auth/token', () => {
    process.env['API_KEY'] = 'test-secret';
    const request = createMockRequest('/api/auth/token');
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    expect(done).toHaveBeenCalledOnce();
    expect(reply.sentCode).toBeNull();
  });

  it('should skip for POST /proxy/* routes', () => {
    process.env['API_KEY'] = 'test-secret';
    const request = { ...createMockRequest('/proxy/session'), method: 'POST' } as unknown as FastifyRequest;
    const reply = createMockReply();
    const done = vi.fn() as unknown as HookHandlerDoneFunction;

    authPreHandler(request, reply, done);

    expect(done).toHaveBeenCalledOnce();
    expect(reply.sentCode).toBeNull();
  });
});
