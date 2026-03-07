#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ACTION=""
for arg in "$@"; do
  case "$arg" in
    --status) ACTION="status" ;;
    --test) ACTION="test" ;;
    --stop) ACTION="stop" ;;
    --start) ACTION="start" ;;
    --restart) ACTION="restart" ;;
    --logs) ACTION="logs" ;;
    --uninstall) ACTION="uninstall" ;;
    --help|-h)
      echo "Usage: $0 [--status | --test | --stop | --start | --restart | --logs | --uninstall]"
      echo ""
      echo "Installs and manages session-dashboard Docker container."
      echo ""
      echo "Options:"
      echo "  (no args)     Install: Docker build + compose up + machines.yml init"
      echo "  --status      Show container status and health"
      echo "  --test        Test health endpoint + machine connectivity"
      echo "  --stop        Stop dashboard container"
      echo "  --start       Start dashboard container"
      echo "  --restart     Restart dashboard container"
      echo "  --logs        Tail container logs (Ctrl+C to stop)"
      echo "  --uninstall   Stop container, remove image"
      exit 0
      ;;
  esac
done

echo "═══════════════════════════════════════════════════════════"
echo " Session Dashboard Server Installer"
echo "═══════════════════════════════════════════════════════════"

DASHBOARD_DIR="$REPO_ROOT/server"
DASHBOARD_PORT="${SESSION_DASHBOARD_PORT:-3097}"

if [[ ! -d "$DASHBOARD_DIR" ]]; then
  echo "❌ Session dashboard not found: $DASHBOARD_DIR"
  exit 1
fi

# ── Helper Functions ──

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "❌ Docker is required for session-dashboard"
    echo "   Install Docker and run this script again"
    exit 1
  fi
  echo "✓ Docker $(docker --version | cut -d' ' -f3)"
}

check_port() {
  if command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:$DASHBOARD_PORT -sTCP:LISTEN >/dev/null 2>&1; then
      echo "⚠ Port $DASHBOARD_PORT is already in use"
      return 1
    fi
  fi
  return 0
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$DASHBOARD_DIR/docker-compose.yml" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$DASHBOARD_DIR/docker-compose.yml" "$@"
  else
    echo "❌ docker compose not found"
    exit 1
  fi
}

do_install() {
  check_docker

  # Copy machines.yml.example if machines.yml doesn't exist
  if [[ ! -f "$DASHBOARD_DIR/machines.yml" ]]; then
    if [[ -f "$DASHBOARD_DIR/machines.yml.example" ]]; then
      cp "$DASHBOARD_DIR/machines.yml.example" "$DASHBOARD_DIR/machines.yml"
      echo "✓ Created machines.yml from example (edit with your machine configs)"
    else
      echo "⚠ machines.yml.example not found, skipping"
    fi
  else
    echo "✓ machines.yml already exists (preserved)"
  fi

  # Check port availability
  check_port || echo "  Will attempt to start anyway..."

  # Build and start
  echo ""
  echo "Building and starting session-dashboard..."
  compose_cmd up -d --build

  # Wait for health
  echo "Waiting for health check..."
  local i
  for i in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/health" >/dev/null 2>&1; then
      echo "✓ Session dashboard is running and healthy on port $DASHBOARD_PORT"
      echo "  Open http://127.0.0.1:${DASHBOARD_PORT} in your browser"
      return 0
    fi
    sleep 1
  done
  echo "⚠ Health check timed out (container may still be starting)"
}

do_status() {
  check_docker
  echo ""
  compose_cmd ps
  echo ""
  if curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/health" 2>/dev/null; then
    echo ""
    echo "✓ Health check: OK"
  else
    echo "✗ Health check: FAILED (not responding on port $DASHBOARD_PORT)"
  fi
}

do_test() {
  echo "Testing session-dashboard..."
  echo ""

  # Health check
  local health
  health=$(curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/health" 2>/dev/null) || {
    echo "✗ Health endpoint not responding on port $DASHBOARD_PORT"
    exit 1
  }
  echo "✓ Health: $health"

  # Machines check
  local machines
  machines=$(curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/api/machines" 2>/dev/null) || {
    echo "⚠ /api/machines not responding"
    return 0
  }
  echo "✓ Machines: $machines"
}

do_stop() {
  check_docker
  compose_cmd stop
  echo "✓ Dashboard stopped"
}

do_start() {
  check_docker
  compose_cmd start
  echo "✓ Dashboard started"
  echo "  Waiting for health..."
  sleep 3
  if curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/health" >/dev/null 2>&1; then
    echo "✓ Healthy"
  else
    echo "⚠ Not yet healthy (may still be starting)"
  fi
}

do_restart() {
  check_docker
  compose_cmd restart
  echo "✓ Dashboard restarted"
}

do_logs() {
  check_docker
  compose_cmd logs -f
}

do_uninstall() {
  check_docker
  echo "Stopping and removing dashboard container..."
  compose_cmd down --rmi local 2>/dev/null || compose_cmd down
  echo "✓ Dashboard uninstalled"
  echo "  Note: machines.yml preserved (delete manually if desired)"
}

# ── Main ──

case "$ACTION" in
  status)    do_status ;;
  test)      do_test ;;
  stop)      do_stop ;;
  start)     do_start ;;
  restart)   do_restart ;;
  logs)      do_logs ;;
  uninstall) do_uninstall ;;
  "")        do_install ;;
esac

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Session Dashboard $([ "$ACTION" = "" ] && echo "Installation" || echo "${ACTION^}") Complete"
echo "═══════════════════════════════════════════════════════════"
