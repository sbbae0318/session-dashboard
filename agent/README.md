# dashboard-agent

Lightweight HTTP agent deployed on each remote machine. Exposes session history JSONL files via authenticated API and proxies requests to local `oc-serve` (port 4096). The central `session-dashboard` polls multiple agents to aggregate data across machines.

## Architecture

```
session-dashboard (Docker, :3097)
    |
    | polls via HTTP (Bearer auth)
    v
dashboard-agent (Node.js, :3098)
    |                    |
    | reads              | proxies (REST + SSE)
    v                    v
cards.jsonl          oc-serve (:4096)
queries.jsonl
```

The agent also maintains an internal SQLite cache (`./data/session-cache.db`) populated by subscribing to oc-serve's SSE event stream (`/global/event`). This cache powers the `/proxy/session/details` endpoint with real-time session status without hammering oc-serve on every poll.

## Prerequisites

- Node.js 18+
- npm
- OpenCode installed and running (provides `oc-serve` on port 4096 and writes history JSONL files)

## Quick Start

```bash
cd services/dashboard-agent
cp .env.example .env
# Edit .env: set API_KEY to a strong random secret
npm install
npm run build && npm start  # production
npm run dev                  # development (auto-reload via tsx)
```

Or use the install script from the repo root:

```bash
./install/dashboard-agent.sh           # Install + start
./install/dashboard-agent.sh --status  # Check status
./install/dashboard-agent.sh --logs    # Stream logs
./install/dashboard-agent.sh --stop    # Stop agent
```

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3098` | Agent HTTP port |
| `API_KEY` | (required) | Shared secret for Bearer auth. Must match the `apiKey` in `machines.yml` on the dashboard side. If unset, all requests are allowed (dev mode only). |
| `OC_SERVE_PORT` | `4096` | Local oc-serve port |
| `HISTORY_DIR` | `~/.opencode/history` | Path to OpenCode history directory containing `cards.jsonl` and `queries.jsonl` |

## API Reference

All endpoints except `/health` require `Authorization: Bearer <API_KEY>`.

### GET /health

Health check. No authentication required.

```bash
curl http://localhost:3098/health
```

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "ocServeConnected": true,
  "sseConnected": true
}
```

| Field | Description |
|-------|-------------|
| `status` | Always `"ok"` if the agent is running |
| `version` | Agent version from `package.json` |
| `uptime` | Seconds since agent started |
| `ocServeConnected` | Whether oc-serve responded to a recent health probe (cached 10s) |
| `sseConnected` | Whether the SSE subscription to oc-serve is active |

### GET /api/cards

Returns the last N session history cards from `cards.jsonl`.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3098/api/cards?limit=50"
```

**Query parameters:**

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| `limit` | `50` | `500` | Number of cards to return (tail of file) |

**Response:**
```json
{
  "cards": [
    { "sessionId": "ses_abc123", "title": "...", "duration": "5m", ... }
  ]
}
```

### GET /api/queries

Returns the last N queries from `queries.jsonl`.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3098/api/queries?limit=50"
```

**Query parameters:**

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| `limit` | `50` | `500` | Number of queries to return (tail of file) |

**Response:**
```json
{
  "queries": [
    { ... }
  ]
}
```

### GET /proxy/session/status

Proxies to oc-serve `/session/status`. Returns session status map for a project directory.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3098/proxy/session/status?directory=/path/to/project"
```

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `directory` | Project directory path (optional) |

Returns `502` with `{ "error": "oc-serve unavailable", "code": "OC_SERVE_DOWN" }` if oc-serve is unreachable.

### GET /proxy/projects

Lists all registered oc-serve projects. Proxies to oc-serve `/project`.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3098/proxy/projects
```

### GET /proxy/session

Lists sessions for a project. Proxies to oc-serve `/session`.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3098/proxy/session?directory=/path/to/project&limit=20"
```

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `directory` | Project directory path (optional) |
| `limit` | Max sessions to return (optional) |

### GET /proxy/session/:id

Gets a specific session by ID. Proxies to oc-serve `/session/:id`.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3098/proxy/session/ses_abc123
```

### GET /proxy/session/:id/message

Gets messages for a session. Proxies to oc-serve `/session/:id/message`.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3098/proxy/session/ses_abc123/message
```

### GET /proxy/session/details

Returns cached real-time session details for all known sessions. Powered by the internal SSE subscription to oc-serve, so this is fast and doesn't hit oc-serve directly.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3098/proxy/session/details
```

**Response:**
```json
{
  "ses_abc123": {
    "status": "busy",
    "lastPrompt": "Implement the new feature...",
    "lastPromptTime": 1706745600000,
    "currentTool": "mcp_bash",
    "directory": "/path/to/project",
    "updatedAt": 1706745610000
  }
}
```

| Field | Values | Description |
|-------|--------|-------------|
| `status` | `busy`, `idle`, `retry` | Current session state |
| `lastPrompt` | string or null | Last user prompt (truncated to 200 chars, system prompts filtered) |
| `lastPromptTime` | timestamp (ms) | When the last prompt was received |
| `currentTool` | string or null | Tool currently executing, if any |
| `directory` | string or null | Project directory |
| `updatedAt` | timestamp (ms) | When this entry was last updated |

## Connecting to Session Dashboard

Register this agent in `services/session-dashboard/machines.yml`:

```yaml
machines:
  - id: my-machine
    alias: My Dev Machine
    host: 10.0.0.1      # Agent's IP or hostname
    port: 3098           # Must match agent's PORT
    apiKey: your-key     # Must match agent's API_KEY
```

The `id` field must be unique across all machines. The `apiKey` must match exactly what's set in the agent's `.env`.

See `services/session-dashboard/machines.yml.example` for a full example.

## Deployment Options

### Direct (nohup)

Simplest option. Use the install script:

```bash
./install/dashboard-agent.sh
```

This builds the agent, starts it with `nohup`, and writes a PID file.

### systemd (Linux servers)

Create `/etc/systemd/system/dashboard-agent.service`:

```ini
[Unit]
Description=Dashboard Agent
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/bae-settings/services/dashboard-agent
EnvironmentFile=/path/to/bae-settings/services/dashboard-agent/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable dashboard-agent
sudo systemctl start dashboard-agent
sudo systemctl status dashboard-agent
```

### pm2

```bash
cd services/dashboard-agent
npm run build
pm2 start dist/index.js --name dashboard-agent
pm2 save
pm2 startup  # follow the printed command to enable on boot
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 3098 already in use | `lsof -i :3098` to find the process, then kill it or change `PORT` in `.env` |
| `ocServeConnected: false` | Verify oc-serve is running: `curl http://localhost:4096/session/status` |
| `sseConnected: false` | oc-serve SSE stream unavailable. Agent will reconnect automatically with exponential backoff (up to 30s). |
| 401 Unauthorized | Check that `API_KEY` in `.env` matches `apiKey` in `machines.yml` |
| Cards/queries empty | Verify `HISTORY_DIR` points to the correct path and `cards.jsonl` exists there |
| Agent won't start | Check Node.js version (`node --version`, need 18+). Run `npm run build` first for production. |
| Session details stale | The SSE cache has a 24h TTL and evicts every 60s. If oc-serve restarted, the agent reconnects and re-bootstraps automatically. |

### Debug Commands

```bash
# Check if agent is running
curl http://localhost:3098/health

# Test auth
curl -H "Authorization: Bearer your-key" http://localhost:3098/api/cards

# Check oc-serve directly
curl http://localhost:4096/session/status

# View agent logs (if started via install script)
./install/dashboard-agent.sh --logs

# Check port
lsof -i :3098
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (auto-reload)
npm run dev

# Build TypeScript
npm run build

# Start production server
npm start

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Project Structure

```
services/dashboard-agent/
├── src/
│   ├── index.ts           # Entry point, config loading
│   ├── server.ts          # Fastify server, route registration
│   ├── auth.ts            # Bearer token middleware
│   ├── jsonl-reader.ts    # JSONL file reader (handles #XX| prefix format)
│   ├── oc-serve-proxy.ts  # HTTP proxy routes to oc-serve
│   ├── session-cache.ts   # SSE client + in-memory session cache
│   ├── session-store.ts   # SQLite persistence layer
│   └── types.ts           # Shared TypeScript interfaces
├── data/
│   └── session-cache.db   # SQLite DB (auto-created)
├── dist/                  # Compiled output (after npm run build)
├── .env.example           # Environment variable template
└── package.json
```
