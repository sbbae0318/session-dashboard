#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ACTION=""
for arg in "$@"; do
  case "$arg" in
    --status) ACTION="status" ;;
    --stop) ACTION="stop" ;;
    --start) ACTION="start" ;;
    --restart) ACTION="restart" ;;
    --logs) ACTION="logs" ;;
    --uninstall) ACTION="uninstall" ;;
    --help|-h)
      echo "Usage: $0 [--status | --stop | --start | --restart | --logs | --uninstall]"
      echo ""
      echo "Installs and manages dashboard-agent (Node.js HTTP agent)."
      echo ""
      echo "Options:"
      echo "  (no args)     Install: npm install + build + start agent"
      echo "  --status      Show agent status and health"
      echo "  --stop        Stop agent process"
      echo "  --start       Start agent process"
      echo "  --restart     Restart agent process"
      echo "  --logs        Show log info and dev mode suggestion"
      echo "  --uninstall   Stop agent, remove data/ and node_modules/"
      exit 0
      ;;
  esac
done

echo "═══════════════════════════════════════════════════════════"
echo " Session Dashboard Agent Installer"
echo "═══════════════════════════════════════════════════════════"

AGENT_DIR="$REPO_ROOT/agent"

if [[ ! -d "$AGENT_DIR" ]]; then
  echo "❌ Dashboard agent not found: $AGENT_DIR"
  exit 1
fi

# ── Helper Functions ──

get_port() {
  if [[ -f "$AGENT_DIR/.env" ]]; then
    local port
    port=$(grep -E '^PORT=' "$AGENT_DIR/.env" 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]')
    if [[ -n "$port" ]]; then
      echo "$port"
      return
    fi
  fi
  echo "3098"
}

AGENT_PORT="$(get_port)"

check_prerequisites() {
  # Node.js 18+
  if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js is required (18+)"
    echo "   Install Node.js and run this script again"
    exit 1
  fi
  local node_major
  node_major=$(node -v | sed 's/v//' | cut -d'.' -f1)
  if [[ "$node_major" -lt 18 ]]; then
    echo "❌ Node.js 18+ required (found v$(node -v | sed 's/v//'))"
    exit 1
  fi
  echo "✓ Node.js $(node -v)"

  # npm
  if ! command -v npm >/dev/null 2>&1; then
    echo "❌ npm is required"
    echo "   Install npm and run this script again"
    exit 1
  fi
  echo "✓ npm $(npm -v)"
}

is_running() {
  local pid_file="$AGENT_DIR/data/agent.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

get_pid() {
  local pid_file="$AGENT_DIR/data/agent.pid"
  if [[ -f "$pid_file" ]]; then
    cat "$pid_file"
  fi
}

start_agent() {
  mkdir -p "$AGENT_DIR/data"
  cd "$AGENT_DIR"
  # Source .env to load PORT, API_KEY, etc.
  if [[ -f .env ]]; then
    set -a
    source .env
    set +a
  fi
  nohup node dist/index.js > /dev/null 2>&1 &
  echo $! > "$AGENT_DIR/data/agent.pid"
  cd - > /dev/null
}

wait_for_health() {
  echo "Waiting for health check..."
  local i
  for i in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null 2>&1; then
      echo "✓ Dashboard agent is running and healthy on port $AGENT_PORT"
      return 0
    fi
    sleep 1
  done
  echo "⚠ Health check timed out (agent may still be starting)"
}

do_install() {
  check_prerequisites

  # Setup .env
  echo ""
  echo "───────────────────────────────────────────────────────────"
  echo " Step 1: Environment configuration"
  echo "───────────────────────────────────────────────────────────"
  if [[ ! -f "$AGENT_DIR/.env" ]]; then
    if [[ -f "$AGENT_DIR/.env.example" ]]; then
      cp "$AGENT_DIR/.env.example" "$AGENT_DIR/.env"
      echo "✓ Created .env from .env.example"
      echo "  ⚠ Edit $AGENT_DIR/.env and set API_KEY before production use"
    else
      echo "⚠ .env.example not found, skipping"
    fi
  else
    echo "✓ .env already exists (preserved)"
  fi

  # Re-read port after .env might have been created
  AGENT_PORT="$(get_port)"

  # npm install
  echo ""
  echo "───────────────────────────────────────────────────────────"
  echo " Step 2: Install dependencies"
  echo "───────────────────────────────────────────────────────────"
  cd "$AGENT_DIR"
  npm install
  echo "✓ Dependencies installed"

  # Build
  echo ""
  echo "───────────────────────────────────────────────────────────"
  echo " Step 3: Build"
  echo "───────────────────────────────────────────────────────────"
  npm run build
  echo "✓ Build complete"
  cd - > /dev/null

  # Stop existing if running
  if is_running; then
    echo ""
    echo "Stopping existing agent..."
    local pid
    pid=$(get_pid)
    kill "$pid" 2>/dev/null || true
    rm -f "$AGENT_DIR/data/agent.pid"
    sleep 1
  fi

  # Start
  echo ""
  echo "───────────────────────────────────────────────────────────"
  echo " Step 4: Start agent"
  echo "───────────────────────────────────────────────────────────"
  start_agent
  wait_for_health
  echo ""
  echo "  Claude Code: Set SOURCE=both in .env to enable"
}

do_status() {
  echo ""
  if is_running; then
    local pid
    pid=$(get_pid)
    echo "✓ Agent is running (PID: $pid)"
  else
    echo "✗ Agent is not running"
    if [[ -f "$AGENT_DIR/data/agent.pid" ]]; then
      echo "  Stale PID file found (cleaning up)"
      rm -f "$AGENT_DIR/data/agent.pid"
    fi
  fi
  echo ""
  if curl -sf "http://127.0.0.1:${AGENT_PORT}/health" 2>/dev/null; then
    echo ""
    echo "✓ Health check: OK"
  else
    echo "✗ Health check: FAILED (not responding on port $AGENT_PORT)"
  fi
}

do_stop() {
  if is_running; then
    local pid
    pid=$(get_pid)
    kill "$pid" 2>/dev/null || true
    rm -f "$AGENT_DIR/data/agent.pid"
    echo "✓ Agent stopped (PID: $pid)"
  else
    echo "✓ Agent is not running"
    if [[ -f "$AGENT_DIR/data/agent.pid" ]]; then
      rm -f "$AGENT_DIR/data/agent.pid"
      echo "  Cleaned up stale PID file"
    fi
  fi
}

do_start() {
  if is_running; then
    echo "⚠ Agent is already running (PID: $(get_pid))"
    return 0
  fi

  if [[ ! -f "$AGENT_DIR/dist/index.js" ]]; then
    echo "❌ dist/index.js not found. Run install first: $0"
    exit 1
  fi

  start_agent
  wait_for_health
}

do_restart() {
  do_stop
  echo ""
  do_start
}

do_logs() {
  echo ""
  echo "Dashboard agent runs in background (stdout redirected to /dev/null)."
  echo ""
  echo "For development with live logs, use:"
  echo "  cd $AGENT_DIR && npm run dev"
  echo ""
  echo "To check current status:"
  echo "  $0 --status"
}

do_uninstall() {
  # Stop if running
  if is_running; then
    do_stop
    echo ""
  fi

  # Remove data directory
  if [[ -d "$AGENT_DIR/data" ]]; then
    rm -rf "$AGENT_DIR/data"
    echo "✓ Removed data/ directory"
  fi

  # Remove node_modules
  if [[ -d "$AGENT_DIR/node_modules" ]]; then
    rm -rf "$AGENT_DIR/node_modules"
    echo "✓ Removed node_modules/"
  fi

  # Remove dist
  if [[ -d "$AGENT_DIR/dist" ]]; then
    rm -rf "$AGENT_DIR/dist"
    echo "✓ Removed dist/"
  fi

  echo "✓ Dashboard agent uninstalled"
  echo "  Note: .env preserved (delete manually if desired)"
}

# ── Main ──

case "$ACTION" in
  status)    do_status ;;
  stop)      do_stop ;;
  start)     do_start ;;
  restart)   do_restart ;;
  logs)      do_logs ;;
  uninstall) do_uninstall ;;
  "")        do_install ;;
esac

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Dashboard Agent $([ "$ACTION" = "" ] && echo "Installation" || echo "${ACTION^}") Complete"
echo "═══════════════════════════════════════════════════════════"
