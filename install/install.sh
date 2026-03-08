#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ACTION=""
for arg in "$@"; do
  case "$arg" in
    --agent-only)  ACTION="agent-only" ;;
    --server-only) ACTION="server-only" ;;
    --dry-run)     ACTION="dry-run" ;;
    --help|-h)
      echo "Usage: $0 [--agent-only | --server-only | --dry-run | --help]"
      echo ""
      echo "Unified installer for session-dashboard (agent + server)."
      echo "Auto-detects OpenCode/Claude Code data sources and configures both."
      echo ""
      echo "Options:"
      echo "  (no args)       Full install: detect, configure, install agent + server"
      echo "  --agent-only    Install agent only (skip Docker server)"
      echo "  --server-only   Install server only (skip agent)"
      echo "  --dry-run       Show detection results, no changes"
      echo "  --help, -h      Show this help"
      exit 0
      ;;
  esac
done

echo "═══════════════════════════════════════════════════════════"
echo " Session Dashboard Unified Installer"
echo "═══════════════════════════════════════════════════════════"

detect_source() {
  local has_oc=false has_claude=false
  if [[ -f "$HOME/.opencode/history/cards.jsonl" ]] || \
     [[ -f "$HOME/.opencode/history/queries.jsonl" ]]; then
    has_oc=true
  fi
  if [[ -d "$HOME/.claude/projects" ]] || \
     [[ -f "$HOME/.claude/history.jsonl" ]]; then
    has_claude=true
  fi
  if $has_oc && $has_claude; then echo "both"
  elif $has_oc; then echo "opencode"
  elif $has_claude; then echo "claude-code"
  else echo "opencode"
  fi
}

generate_api_key() { openssl rand -hex 16; }

check_prerequisites() {
  if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js is required (18+)"; echo "   Install: https://nodejs.org"; exit 1
  fi
  local node_major
  node_major=$(node -v | sed 's/v//' | cut -d'.' -f1)
  if [[ "$node_major" -lt 18 ]]; then
    echo "❌ Node.js 18+ required (found v$(node -v | sed 's/v//'))"; exit 1
  fi
  echo "✓ Node.js $(node -v)"
  if ! command -v npm >/dev/null 2>&1; then
    echo "❌ npm is required"; exit 1
  fi
  echo "✓ npm $(npm -v)"
  if [[ "$ACTION" != "agent-only" ]]; then
    if ! command -v docker >/dev/null 2>&1; then
      echo "❌ Docker is required for server"
      echo "   Install: https://docs.docker.com/get-docker/"; exit 1
    fi
    echo "✓ Docker $(docker --version | cut -d' ' -f3)"
  fi
}

prepare_agent_config() {
  local source="$1" api_key="$2"
  local env_file="$REPO_ROOT/agent/.env"
  if [[ ! -f "$env_file" ]]; then
    cp "$REPO_ROOT/agent/.env.example" "$env_file"
    echo "✓ Created agent/.env from .env.example"
  else
    echo "✓ agent/.env already exists (preserved)"
  fi
  # API_KEY
  if grep -q '^API_KEY=' "$env_file"; then
    sed -i.bak "s|^API_KEY=.*|API_KEY=$api_key|" "$env_file" && rm -f "$env_file.bak"
  else
    echo "API_KEY=$api_key" >> "$env_file"
  fi
  # SOURCE (uncomment if commented)
  if grep -q '^# SOURCE=' "$env_file"; then
    sed -i.bak "s|^# SOURCE=.*|SOURCE=$source|" "$env_file" && rm -f "$env_file.bak"
  elif grep -q '^SOURCE=' "$env_file"; then
    sed -i.bak "s|^SOURCE=.*|SOURCE=$source|" "$env_file" && rm -f "$env_file.bak"
  else
    echo "SOURCE=$source" >> "$env_file"
  fi
  # HISTORY_DIR
  local history_dir="~/.opencode/history"
  [[ "$source" == "claude-code" ]] && history_dir="~/.claude"
  sed -i.bak "s|^HISTORY_DIR=.*|HISTORY_DIR=$history_dir|" "$env_file" && rm -f "$env_file.bak"
  echo "  API_KEY=$api_key | SOURCE=$source | HISTORY_DIR=$history_dir"
}

prepare_server_config() {
  local source="$1" api_key="$2"
  local yml_file="$REPO_ROOT/server/machines.yml"
  if [[ ! -f "$yml_file" ]]; then
    cat > "$yml_file" <<YAML
machines:
  - id: local
    alias: Local Machine
    host: host.docker.internal
    port: 3098
    apiKey: $api_key
    source: $source
YAML
    echo "✓ Created server/machines.yml with local agent"
  else
    echo "✓ server/machines.yml already exists (preserved)"
  fi
}

do_dry_run() {
  local source api_key history_dir
  source=$(detect_source)
  api_key=$(generate_api_key)
  history_dir="~/.opencode/history"
  [[ "$source" == "claude-code" ]] && history_dir="~/.claude"
  echo ""
  echo "Detected: SOURCE=$source"
  echo "Generated: API_KEY=$api_key"
  echo ""
  echo "agent/.env would contain:"
  echo "  PORT=3098 | API_KEY=$api_key | SOURCE=$source | HISTORY_DIR=$history_dir"
  echo ""
  echo "server/machines.yml would contain:"
  echo "  - id: local, host: host.docker.internal, port: 3098"
  echo "    apiKey: $api_key, source: $source"
  echo ""
  echo "No changes made (dry run)."
}

do_install() {
  echo ""
  echo "─── Step 1: Prerequisites ───"
  check_prerequisites
  echo ""
  echo "─── Step 2: Detect data source ───"
  local source api_key
  source=$(detect_source)
  local env_file="$REPO_ROOT/agent/.env"
  if [[ -f "$env_file" ]] && grep -q '^API_KEY=[^[:space:]]' "$env_file"; then
    api_key=$(grep '^API_KEY=' "$env_file" | cut -d'=' -f2)
    echo "Detected: SOURCE=$source"
    echo "Reusing:  API_KEY=$api_key (from existing agent/.env)"
  else
    api_key=$(generate_api_key)
    echo "Detected: SOURCE=$source"
    echo "Generated: API_KEY=$api_key"
  fi
  echo ""
  echo "─── Step 3: Configure ───"
  if [[ "$ACTION" != "server-only" ]]; then
    prepare_agent_config "$source" "$api_key"
  fi
  if [[ "$ACTION" != "agent-only" ]]; then
    prepare_server_config "$source" "$api_key"
  fi
  if [[ "$ACTION" != "server-only" ]]; then
    echo ""
    echo "─── Step 4: Install agent ───"
    bash "$SCRIPT_DIR/agent.sh"
  fi
  if [[ "$ACTION" != "agent-only" ]]; then
    echo ""
    echo "─── Step 5: Install server ───"
    bash "$SCRIPT_DIR/server.sh"
  fi
  echo ""
  echo "─── Summary ───"
  echo "  Source: $source | API Key: $api_key"
  if [[ "$ACTION" != "server-only" ]]; then echo "  Agent:  http://127.0.0.1:3098"; fi
  if [[ "$ACTION" != "agent-only" ]]; then echo "  Server: http://127.0.0.1:3097"; fi
}

# ── Main ──

case "$ACTION" in
  dry-run) do_dry_run ;;
  *)       do_install ;;
esac

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Session Dashboard Setup Complete"
echo "═══════════════════════════════════════════════════════════"
