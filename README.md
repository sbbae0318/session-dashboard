# Session Dashboard

Multi-machine session monitoring dashboard for OpenCode and Claude Code.

## Architecture

```
session-dashboard server (Docker, :3097)
    │
    │ polls via HTTP (Bearer auth, every 2s)
    │
    ├──→ dashboard-agent (MacBook, 192.168.0.63:3101)
    │       ├── reads cards.jsonl, queries.jsonl
    │       └── proxies → oc-serve :4096
    │
    └──→ dashboard-agent (Workstation, localhost:3100)
            ├── reads cards.jsonl, queries.jsonl
            └── proxies → oc-serve :4096
```

The **server** polls each **agent** for session data and presents a unified web UI.
Each **agent** runs on its machine, exposing local session history via authenticated HTTP API.

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| Node.js | 18+ |
| npm | (bundled with Node.js) |
| Docker | Required for server only |

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
├── server/          # Dashboard web server (Docker, Svelte + Node.js)
├── agent/           # Data collection agent (Node.js, Fastify)
├── tui/             # Terminal UI client (Bun, Ink/React)
├── install/
│   ├── install.sh   # Unified installer (auto-detect + configure + install)
│   ├── server.sh    # Server install/manage (Docker compose)
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
    host: 192.168.0.63      # Agent's IP or hostname
    port: 3101               # Agent's PORT
    apiKey: your-key          # Must match agent's API_KEY
    source: both              # opencode | claude-code | both
```

### Agent .env

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3098` | Agent HTTP port |
| `API_KEY` | (required) | Shared secret for Bearer auth |
| `OC_SERVE_PORT` | `4096` | Local oc-serve port |
| `HISTORY_DIR` | `~/.opencode/history` | Path to OpenCode history |
| `CLAUDE_HISTORY_DIR` | `~/.claude` | Claude Code history path (when SOURCE=claude-code) |
| `SOURCE` | `opencode` | Data source: opencode, claude-code, both |

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

Private repository.
