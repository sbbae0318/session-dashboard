#!/usr/bin/env bash
# Fire-and-forget POST to local session-dashboard agent.
# Always exits 0 so a down/crashed agent never surfaces errors to Claude Code.
PAYLOAD=$(cat)
( curl -sf -m 0.5 -X POST \
       -H 'Content-Type: application/json' \
       --data-raw "$PAYLOAD" \
       http://127.0.0.1:3098/hooks/event >/dev/null 2>&1 ) &
disown
exit 0
