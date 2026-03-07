/**
 * HTTP proxy to local oc-serve instance
 *
 * Forwards requests to oc-serve running on the same machine.
 * Uses node:http for HTTP requests (same pattern as serve-client.ts).
 */

import { get as httpGet, request as httpRequest } from 'node:http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { jwtPreHandler } from './auth.js';
import { detectActiveDirectories } from './active-directories.js';
import type { CreateSessionBody, SendMessageBody, ReplyToQuestionBody, ReplyToPermissionBody, RunCommandBody } from './types.js';

const PROXY_TIMEOUT = 3000;

/**
 * Fetch JSON from a local HTTP endpoint
 */
export function fetchJson(url: string, headers: Record<string, string>, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const request = httpGet(
      url,
      {
        headers,
        signal: controller.signal,
      },
      (response) => {
        let data = '';

        response.on('data', (chunk: Buffer) => {
          data += chunk;
        });

        response.on('end', () => {
          clearTimeout(timeoutId);

          if (
            response.statusCode &&
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            try {
              resolve(JSON.parse(data));
            } catch (parseError) {
              reject(
                new Error(
                  `Failed to parse response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                ),
              );
            }
          } else {
            reject(
              new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`),
            );
          }
        });
      },
    );

    request.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });

    request.on('abort', () => {
      clearTimeout(timeoutId);
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Send a POST JSON request to a local HTTP endpoint
 */
export function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeout: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const parsedUrl = new URL(url);
    const req = httpRequest(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString(),
        },
        signal: controller.signal,
      },
      (response) => {
        let data = '';
        response.on('data', (chunk: Buffer) => { data += chunk; });
        response.on('end', () => {
          clearTimeout(timeoutId);
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch (parseError) {
              reject(new Error(`Failed to parse response: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
            }
          } else {
            reject(new Error(`HTTP ${response.statusCode}: ${data || response.statusMessage}`));
          }
        });
      },
    );

    req.on('error', (error) => { clearTimeout(timeoutId); reject(error); });
    req.on('abort', () => { clearTimeout(timeoutId); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Stream a POST request to oc-serve, piping the response back to the client.
 * Used for sendMessage which returns a streaming response.
 */
export function streamProxy(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  reply: FastifyReply,
): void {
  const payload = JSON.stringify(body);
  const parsedUrl = new URL(url);

  void reply.hijack();

  const req = httpRequest(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
      },
    },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'];
      if (contentType) {
        reply.raw.setHeader('Content-Type', contentType);
      }
      reply.raw.writeHead(proxyRes.statusCode ?? 200);
      proxyRes.pipe(reply.raw);
    },
  );

  req.on('error', () => {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(502, { 'Content-Type': 'application/json' });
    }
    reply.raw.end(JSON.stringify({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' }));
  });

  req.write(payload);
  req.end();
}

/**
 * Build headers to forward to oc-serve
 */
function buildProxyHeaders(incomingHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  const opencodeDirHeader = incomingHeaders['x-opencode-directory'];

  if (typeof opencodeDirHeader === 'string') {
    headers['x-opencode-directory'] = opencodeDirHeader;
  }

  return headers;
}

/**
 * Register oc-serve proxy routes on the Fastify instance
 */
export function registerProxyRoutes(app: FastifyInstance): void {
  const ocServePort = parseInt(process.env['OC_SERVE_PORT'] ?? '4096', 10);
  const baseUrl = `http://127.0.0.1:${ocServePort}`;

  // GET /proxy/session/status?directory=... → oc-serve /session/status?directory=...
  app.get<{ Querystring: { directory?: string } }>('/proxy/session/status', async (request, reply) => {
    try {
      const headers = buildProxyHeaders(request.headers);
      const params = new URLSearchParams();
      if (request.query.directory) params.set('directory', request.query.directory);
      const qs = params.toString();
      const url = `${baseUrl}/session/status${qs ? `?${qs}` : ''}`;
      const data = await fetchJson(url, headers, PROXY_TIMEOUT);
      return data;
    } catch {
      return reply.code(502).send({
        error: 'oc-serve unavailable',
        code: 'OC_SERVE_DOWN',
      });
    }
  });

  // GET /proxy/projects → oc-serve /project (all registered projects)
  app.get('/proxy/projects', async (_request, reply) => {
    try {
      const data = await fetchJson(`${baseUrl}/project`, {}, PROXY_TIMEOUT);
      return data;
    } catch {
      return reply.code(502).send({
        error: 'oc-serve unavailable',
        code: 'OC_SERVE_DOWN',
      });
    }
  });

  // GET /proxy/active-directories → detect running opencode attach processes
  app.get('/proxy/active-directories', async () => {
    const directories = await detectActiveDirectories();
    return { directories };
  });


  // GET /proxy/session?directory=... → oc-serve /session?directory=...&limit=...
  app.get<{ Querystring: { directory?: string; limit?: string } }>('/proxy/session', async (request, reply) => {
    try {
      const headers = buildProxyHeaders(request.headers);
      const params = new URLSearchParams();
      if (request.query.directory) params.set('directory', request.query.directory);
      if (request.query.limit) params.set('limit', request.query.limit);
      const qs = params.toString();
      const url = `${baseUrl}/session${qs ? `?${qs}` : ''}`;
      const data = await fetchJson(url, headers, PROXY_TIMEOUT);
      return data;
    } catch {
      return reply.code(502).send({
        error: 'oc-serve unavailable',
        code: 'OC_SERVE_DOWN',
      });
    }
  });

  // GET /proxy/session/:id → oc-serve /session/:id
  app.get<{ Params: { id: string } }>('/proxy/session/:id', async (request, reply) => {
    try {
      const headers = buildProxyHeaders(request.headers);
      const data = await fetchJson(
        `${baseUrl}/session/${request.params.id}`,
        headers,
        PROXY_TIMEOUT,
      );
      return data;
    } catch {
      return reply.code(502).send({
        error: 'oc-serve unavailable',
        code: 'OC_SERVE_DOWN',
      });
    }
  });

  // GET /proxy/session/:id/message → oc-serve /session/:id/message
  app.get<{ Params: { id: string } }>('/proxy/session/:id/message', async (request, reply) => {
    try {
      const headers = buildProxyHeaders(request.headers);
      const data = await fetchJson(
        `${baseUrl}/session/${request.params.id}/message`,
        headers,
        PROXY_TIMEOUT,
      );
      return data;
    } catch {
      return reply.code(502).send({
        error: 'oc-serve unavailable',
        code: 'OC_SERVE_DOWN',
      });
    }
  });
}

/**
 * Register POST proxy routes for mobile app (JWT-authenticated)
 */
export function registerPostProxyRoutes(app: FastifyInstance): void {
  const ocServePort = parseInt(process.env['OC_SERVE_PORT'] ?? '4096', 10);
  const baseUrl = `http://127.0.0.1:${ocServePort}`;
  const preHandler = jwtPreHandler;

  // POST /proxy/session → oc-serve /session (create session)
  app.post<{ Body: CreateSessionBody }>(
    '/proxy/session',
    { preHandler },
    async (request, reply) => {
      try {
        const headers = buildProxyHeaders(request.headers);
        const data = await postJson(`${baseUrl}/session`, request.body, headers, PROXY_TIMEOUT);
        return data;
      } catch {
        return reply.code(502).send({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' });
      }
    },
  );

  // POST /proxy/session/:id/message → oc-serve /session/:id/message (streaming)
  app.post<{ Params: { id: string }; Body: SendMessageBody }>(
    '/proxy/session/:id/message',
    { preHandler },
    (request, reply) => {
      const headers = buildProxyHeaders(request.headers);
      streamProxy(
        `${baseUrl}/session/${request.params.id}/message`,
        request.body,
        headers,
        reply,
      );
    },
  );

  // POST /proxy/session/:id/abort → oc-serve /session/:id/abort
  app.post<{ Params: { id: string } }>(
    '/proxy/session/:id/abort',
    { preHandler },
    async (request, reply) => {
      try {
        const headers = buildProxyHeaders(request.headers);
        const data = await postJson(`${baseUrl}/session/${request.params.id}/abort`, {}, headers, PROXY_TIMEOUT);
        return data;
      } catch {
        return reply.code(502).send({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' });
      }
    },
  );

  // POST /proxy/question/:id/reply → oc-serve /question/:id/reply
  app.post<{ Params: { id: string }; Body: ReplyToQuestionBody }>(
    '/proxy/question/:id/reply',
    { preHandler },
    async (request, reply) => {
      try {
        const headers = buildProxyHeaders(request.headers);
        const data = await postJson(`${baseUrl}/question/${request.params.id}/reply`, request.body, headers, PROXY_TIMEOUT);
        return data;
      } catch {
        return reply.code(502).send({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' });
      }
    },
  );

  // POST /proxy/permission/:id/reply → oc-serve /permission/:id/reply
  app.post<{ Params: { id: string }; Body: ReplyToPermissionBody }>(
    '/proxy/permission/:id/reply',
    { preHandler },
    async (request, reply) => {
      try {
        const headers = buildProxyHeaders(request.headers);
        const data = await postJson(`${baseUrl}/permission/${request.params.id}/reply`, request.body, headers, PROXY_TIMEOUT);
        return data;
      } catch {
        return reply.code(502).send({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' });
      }
    },
  );

  // POST /proxy/session/:id/fork → oc-serve /session/:id/fork
  app.post<{ Params: { id: string } }>(
    '/proxy/session/:id/fork',
    { preHandler },
    async (request, reply) => {
      try {
        const headers = buildProxyHeaders(request.headers);
        const data = await postJson(`${baseUrl}/session/${request.params.id}/fork`, {}, headers, PROXY_TIMEOUT);
        return data;
      } catch {
        return reply.code(502).send({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' });
      }
    },
  );

  // POST /proxy/session/:id/command → oc-serve /session/:id/command
  app.post<{ Params: { id: string }; Body: RunCommandBody }>(
    '/proxy/session/:id/command',
    { preHandler },
    async (request, reply) => {
      try {
        const headers = buildProxyHeaders(request.headers);
        const data = await postJson(`${baseUrl}/session/${request.params.id}/command`, request.body, headers, PROXY_TIMEOUT);
        return data;
      } catch {
        return reply.code(502).send({ error: 'oc-serve unavailable', code: 'OC_SERVE_DOWN' });
      }
    },
  );
}
/**
 * Quick check if oc-serve is reachable (1s timeout)
 * Returns true if oc-serve responds to /session/status
 */
export function checkOcServeConnection(): Promise<boolean> {
  const ocServePort = parseInt(process.env['OC_SERVE_PORT'] ?? '4096', 10);
  const url = `http://127.0.0.1:${ocServePort}/session/status`;

  return fetchJson(url, {}, 1000)
    .then(() => true)
    .catch(() => false);
}
