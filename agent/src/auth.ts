/**
 * Bearer token authentication middleware for Fastify
 *
 * Validates Authorization: Bearer {API_KEY} header.
 * Skips authentication for /health, /api/auth/token, and POST /proxy/* endpoints.
 * If API_KEY env is not set, allows all requests (dev convenience).
 */

import '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import type { TokenResponse } from './types.js';

export function authPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  // Skip auth for health and token endpoints
  if (request.url === '/health' || request.url === '/api/auth/token') {
    done();
    return;
  }

  // /hooks/event — allow only from localhost (Claude Code hooks are always local)
  if (request.url === '/hooks/event') {
    const ip = request.ip;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      done();
      return;
    }
    reply.code(403).send({ error: 'Hooks only accepted from localhost' });
    return;
  }

  // Skip API_KEY auth for POST /proxy/* routes — they use JWT auth instead
  if (request.method === 'POST' && request.url.startsWith('/proxy/')) {
    done();
    return;
  }

  const apiKey = process.env['API_KEY'];

  // If no API_KEY configured, allow all (dev mode)
  if (!apiKey) {
    request.log.warn('API_KEY not set — authentication disabled');
    done();
    return;
  }

  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);

  if (token !== apiKey) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  done();
}

/**
 * JWT-based authentication preHandler for POST proxy routes.
 * Validates the JWT token using @fastify/jwt's request.jwtVerify().
 * Use as route-level preHandler: { preHandler: jwtPreHandler }
 */
export async function jwtPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    void reply.code(401).send({ error: 'Invalid or missing JWT token' });
  }
}

/**
 * Validate API key and create a JWT token.
 * Returns null if the API key is invalid.
 */
export function createAuthToken(
  app: FastifyInstance,
  apiKey: string,
  configApiKey: string,
): TokenResponse | null {
  if (!configApiKey || apiKey !== configApiKey) {
    return null;
  }

  const token = app.jwt.sign(
    { role: 'mobile' },
    { expiresIn: '24h' },
  );

  return { token, expiresIn: '24h' };
}
