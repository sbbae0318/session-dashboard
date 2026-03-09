#!/usr/bin/env bash
set -euo pipefail

# session-dashboard 개발용 opencode attach 스크립트
# Usage: ./scripts/oc-attach.sh [opencode args...]
#
# oc-serve가 실행 중이면 바로 attach, 아니면 시작 후 attach.
# tmux 환경에서 실행하는 것을 권장합니다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVE_PORT="${OPENCODE_SERVE_PORT:-4096}"
SERVE_TMUX_WINDOW="oc-serve"

port_in_use() {
  lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

wait_for_serve() {
  local max_wait="${1:-10}"
  local i
  for i in $(seq 1 "$((max_wait * 2))"); do
    if curl -sf "http://127.0.0.1:${SERVE_PORT}/global/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Error: opencode serve failed to start within ${max_wait}s" >&2
  return 1
}

ensure_serve() {
  if port_in_use "$SERVE_PORT"; then
    return 0
  fi

  if [ -z "${TMUX-}" ]; then
    echo "Error: oc-serve is not running and not in tmux — cannot auto-start." >&2
    echo "Start oc-serve manually: opencode serve --port ${SERVE_PORT}" >&2
    exit 1
  fi

  local session
  session="$(tmux display-message -p '#{session_name}')"

  # 기존 serve 윈도우 정리
  if tmux list-windows -t "${session}:" -F '#{window_name}' 2>/dev/null | grep -q "^${SERVE_TMUX_WINDOW}$"; then
    tmux kill-window -t "${session}:${SERVE_TMUX_WINDOW}" 2>/dev/null
  fi

  local serve_cmd="while true; do opencode serve --port ${SERVE_PORT} --print-logs --log-level INFO; echo '[serve exited, restarting in 2s...]'; sleep 2; done"
  tmux new-window -d -t "${session}:" -n "$SERVE_TMUX_WINDOW" "bash" "-lc" "$serve_cmd"

  # serve pane 입력 비활성화
  local serve_pane
  serve_pane="$(tmux list-panes -t "${session}:${SERVE_TMUX_WINDOW}" -F '#{pane_id}' 2>/dev/null | head -1)"
  if [ -n "$serve_pane" ]; then
    tmux select-pane -t "$serve_pane" -d
  fi

  if ! wait_for_serve; then
    echo "Warning: serve may not be ready" >&2
  fi
}

ensure_serve
exec opencode attach "http://127.0.0.1:${SERVE_PORT}" --dir "$PROJECT_DIR" "$@"
