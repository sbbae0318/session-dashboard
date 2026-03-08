# Session Dashboard

**English** | [한국어](README.ko.md)

Multi-machine session monitoring dashboard for OpenCode and Claude Code.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Clients (Browser / TUI)                │
│                                                         │
│  Svelte SPA (:3097)          Terminal UI (Ink/React)    │
│       │                            │                    │
│       └────── SSE /api/events ─────┘                    │
│               + REST API polling                        │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │   Dashboard Server        │
         │   (Docker, Fastify :3097) │
         │                           │
         │  ┌─ ActiveSessions ────┐  │
         │  ├─ SessionCards ──────┤  │  ← Backend modules (poll every 2s)
         │  └─ RecentPrompts ─────┘  │
         │                           │
         └─────┬──────────┬──────────┘
               │          │
      HTTP poll│          │HTTP poll
   (Bearer auth)          │(Bearer auth)
               │          │
        ┌──────┴──┐  ┌────┴─────┐
        │ Agent A │  │ Agent B  │    ← One per machine
        │ (:3098) │  │ (:3098)  │
        └────┬────┘  └────┬─────┘
             │             │
     ┌───────┴───────┐    │
     │               │    │
  OpenCode        Claude Code
  ├─ cards.jsonl     └─ history.jsonl
  ├─ queries.jsonl
  └─ oc-serve (:4096)
     ├─ REST API proxy
     └─ SSE event subscription
```

The **server** polls each **agent** for session data and presents a unified web UI.
Each **agent** runs on its machine, exposing local session history via authenticated HTTP API.
The **TUI** connects to the dashboard server from the terminal for real-time session display.

### Key Data Flows

1. **Server → Agent**: HTTP polling every 2s (Bearer token auth)
2. **Agent → OpenCode**: Reads `cards.jsonl`, `queries.jsonl` + proxies oc-serve REST/SSE
3. **Agent → Claude Code**: Reads `history.jsonl`
4. **Server → Client**: Real-time updates via SSE (`/api/events`)
5. **Agent internal cache**: Subscribes to oc-serve SSE → stores session state in SQLite

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| Node.js | 18+ |
| npm | (bundled with Node.js) |
| Docker | Required for server only |
| Bun | TUI only (optional) |

## Quick Start

### Option A: Unified Install (Recommended)

```bash
./install/install.sh
```

The installer auto-detects your data source (`~/.opencode/history` or `~/.claude/projects`),
generates an API key, configures `agent/.env` and `server/machines.yml`, then installs both
agent and server in one shot. Re-running preserves your existing API key.

```bash
./install/install.sh --agent-only    # Agent only (no Docker server)
./install/install.sh --server-only   # Server only (skip agent)
./install/install.sh --dry-run       # Preview detection results, no changes
```

After install, open: `http://localhost:3097`

For remote machines, edit `server/machines.yml` manually to add additional agents.

### Option B: Manual Setup

See [Advanced Setup](#advanced-setup) below.

## Repository Structure

```
session-dashboard/
├── server/          # Dashboard web server (Docker, Svelte 5 + Fastify)
├── agent/           # Data collection agent (Fastify + SQLite)
├── tui/             # Terminal UI client (Bun, Ink 5 + React)
├── install/
│   ├── install.sh   # Unified installer (auto-detect + configure + install)
│   ├── server.sh    # Server install/manage (Docker Compose)
│   └── agent.sh     # Agent install/manage (nohup)
├── docs/            # Architecture & ops documentation
└── README.md
```

## Configuration

### machines.yml

Register each agent in `server/machines.yml`:

```yaml
machines:
  - id: macbook
    alias: MacBook Pro
    host: 192.168.0.63        # Agent's IP or hostname
    port: 3101                # Agent's PORT
    apiKey: your-key          # Must match agent's API_KEY
    source: both              # opencode | claude-code | both
```

> **Note**: When running the server in Docker on the same host as the agent, use `host.docker.internal` as the host.

### Agent .env

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3098` | Agent HTTP port |
| `API_KEY` | (required) | Shared secret for Bearer auth |
| `OC_SERVE_PORT` | `4096` | Local oc-serve port |
| `HISTORY_DIR` | `~/.opencode/history` | Path to OpenCode history |
| `CLAUDE_HISTORY_DIR` | `~/.claude` | Claude Code history path |
| `SOURCE` | `opencode` | Data source: `opencode` \| `claude-code` \| `both` |

### Server .env

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3097` | Dashboard web UI port |
| `MACHINES_CONFIG` | `/app/machines.yml` | Path to machines config (Docker internal) |

## Management

### Server

```bash
./install/server.sh              # Install (build + start)
./install/server.sh --status     # Show status
./install/server.sh --test       # Test health + machine connectivity
./install/server.sh --start      # Start container
./install/server.sh --logs       # Tail logs
./install/server.sh --restart    # Restart
./install/server.sh --stop       # Stop
./install/server.sh --uninstall  # Remove
```

### Agent

```bash
./install/agent.sh               # Install (npm install + build + start)
./install/agent.sh --status      # Show status
./install/agent.sh --start       # Start agent
./install/agent.sh --logs        # Show log info
./install/agent.sh --restart     # Restart
./install/agent.sh --stop        # Stop
./install/agent.sh --uninstall   # Remove
```

## Advanced Setup

Manual per-component setup, run from repo root:

### Agent (on each machine)

```bash
cp agent/.env.example agent/.env
# Edit agent/.env: set API_KEY, SOURCE, HISTORY_DIR

./install/agent.sh
```

### Server (on the monitoring host)

```bash
cp server/.env.example server/.env
cp server/machines.yml.example server/machines.yml
# Edit server/machines.yml: configure your machines

./install/server.sh
```

## Development

### Server

```bash
cd server
npm install
npm run dev     # Backend dev mode
cd frontend && npm run dev   # Frontend dev mode (Vite)
npm test        # Run tests
```

### Agent

```bash
cd agent
npm install
npm run dev     # Dev mode (tsx watch)
npm test        # Run tests
```

### TUI

```bash
cd tui
bun install
bun run src/index.tsx -- --url http://localhost:3097
bun test
```

## Docker Notes

The server runs in Docker. On Linux (native Docker), containers can access the host
network directly. The `docker-compose.yml` includes `extra_hosts` for `host.docker.internal`
to ensure the container can reach agents running on the same host.

For agents on remote machines, use their LAN IP directly in `machines.yml`.

## License

MIT License. See [LICENSE](LICENSE).
