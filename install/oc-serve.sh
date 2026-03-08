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
      echo "Installs and manages oc-serve (OpenCode headless server)."
      echo ""
      echo "Options:"
      echo "  (no args)     Install: check opencode binary + start oc-serve"
      echo "  --status      Show oc-serve status (PID + health check)"
      echo "  --stop        Stop oc-serve process"
      echo "  --start       Start oc-serve process"
      echo "  --restart     Restart oc-serve process"
      echo "  --logs        Show recent logs (tail -50)"
      echo "  --uninstall   Stop oc-serve and clean up"
      exit 0
      ;;
  esac
done

echo "═══════════════════════════════════════════════════════════"
echo " oc-serve (OpenCode Headless) Manager"
echo "═══════════════════════════════════════════════════════════"

AGENT_DIR="$REPO_ROOT/agent"
DATA_DIR="$AGENT_DIR/data"
PID_FILE="$DATA_DIR/oc-serve.pid"
LOG_FILE="$DATA_DIR/oc-serve.log"

# ── Helper Functions ──

get_port() {
  # 1. Environment variable
  if [[ -n "${OC_SERVE_PORT:-}" ]]; then
    echo "$OC_SERVE_PORT"
    return
  fi
  # 2. agent/.env file
  if [[ -f "$AGENT_DIR/.env" ]]; then
    local port
    port=$(grep -E '^OC_SERVE_PORT=' "$AGENT_DIR/.env" 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]')
    if [[ -n "$port" ]]; then
      echo "$port"
      return
    fi
  fi
  # 3. Default
  echo "4096"
}

SERVE_PORT="$(get_port)"

check_prerequisites() {
  if ! command -v opencode >/dev/null 2>&1; then
    echo "❌ opencode CLI is required"
    echo "   Install: https://opencode.ai"
    exit 1
  fi
  echo "✓ opencode found: $(command -v opencode)"
}

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

get_pid() {
  if [[ -f "$PID_FILE" ]]; then
    cat "$PID_FILE"
  fi
}

start_oc_serve() {
  mkdir -p "$DATA_DIR"
  nohup bash -c "while true; do opencode serve --port ${SERVE_PORT} --print-logs --log-level INFO; echo '[oc-serve exited, restarting in 2s...]'; sleep 2; done" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
}

wait_for_health() {
  echo "Waiting for health check..."
  local i
  for i in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:${SERVE_PORT}/global/health" >/dev/null 2>&1; then
      echo "✓ oc-serve is running and healthy on port $SERVE_PORT"
      return 0
    fi
    sleep 1
  done
  echo "⚠ Health check timed out (oc-serve may still be starting)"
}

do_install() {
  check_prerequisites

  echo ""
  echo "───────────────────────────────────────────────────────────"
  echo " Step 1: Configuration"
  echo "───────────────────────────────────────────────────────────"
  echo "  Port: $SERVE_PORT (from ${OC_SERVE_PORT:+OC_SERVE_PORT env}${OC_SERVE_PORT:-default})"

  # Stop existing if running
  if is_running; then
    echo ""
    echo "Stopping existing oc-serve..."
    local pid
    pid=$(get_pid)
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    sleep 1
  fi

  # Start
  echo ""
  echo "───────────────────────────────────────────────────────────"
  echo " Step 2: Start oc-serve"
  echo "───────────────────────────────────────────────────────────"
  start_oc_serve
  wait_for_health
  echo ""
  echo "  Logs: $LOG_FILE"
}

do_status() {
  echo ""
  if is_running; then
    local pid
    pid=$(get_pid)
    echo "✓ oc-serve is running (PID: $pid)"
  else
    echo "✗ oc-serve is not running"
    if [[ -f "$PID_FILE" ]]; then
      echo "  Stale PID file found (cleaning up)"
      rm -f "$PID_FILE"
    fi
  fi
  echo ""
  if curl -sf "http://127.0.0.1:${SERVE_PORT}/global/health" 2>/dev/null; then
    echo ""
    echo "✓ Health check: OK (port $SERVE_PORT)"
  else
    echo "✗ Health check: FAILED (not responding on port $SERVE_PORT)"
  fi
}

do_stop() {
  if is_running; then
    local pid
    pid=$(get_pid)
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "✓ oc-serve stopped (PID: $pid)"
  else
    echo "✓ oc-serve is not running"
    if [[ -f "$PID_FILE" ]]; then
      rm -f "$PID_FILE"
      echo "  Cleaned up stale PID file"
    fi
  fi
}

do_start() {
  if is_running; then
    echo "⚠ oc-serve is already running (PID: $(get_pid))"
    return 0
  fi

  check_prerequisites
  start_oc_serve
  wait_for_health
}

do_restart() {
  do_stop
  echo ""
  do_start
}

do_logs() {
  echo ""
  if [[ -f "$LOG_FILE" ]]; then
    echo "Log file: $LOG_FILE"
    echo ""
    echo "─── Last 50 lines ───"
    tail -50 "$LOG_FILE"
  else
    echo "No log file found at: $LOG_FILE"
    echo "  oc-serve may not have been started yet."
  fi
}

do_uninstall() {
  # Stop if running
  if is_running; then
    do_stop
    echo ""
  fi

  # Remove PID file
  if [[ -f "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
    echo "✓ Removed PID file"
  fi

  # Remove log file
  if [[ -f "$LOG_FILE" ]]; then
    rm -f "$LOG_FILE"
    echo "✓ Removed log file"
  fi

  echo "✓ oc-serve uninstalled"
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
echo " oc-serve $([ "$ACTION" = "" ] && echo "Installation" || echo "${ACTION^}") Complete"
echo "═══════════════════════════════════════════════════════════"
