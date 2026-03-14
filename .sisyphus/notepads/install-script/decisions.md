# Decisions — install-script

## 2026-03-08

- **install.sh는 thin orchestrator**: 기존 agent.sh/server.sh 호출만. 자체 install 로직 없음.
- **API_KEY**: openssl rand -hex 16 자동 생성. agent .env + server machines.yml 양쪽 동시 주입.
- **OpenCode E2E scope**: file-based pipeline만 (cards.jsonl, queries.jsonl). oc-serve 불필요.
- **oc-serve down → 502**: /api/sessions 502 반환이 정상. E2E에서 이를 assert.
- **Idempotent**: .env, machines.yml 이미 있으면 보존. --dry-run으로 미리 확인 가능.
- **macOS+Linux**: OS별 패키지 관리자 분기 없음. 공통 명령어(command -v, lsof, curl)만 사용.
