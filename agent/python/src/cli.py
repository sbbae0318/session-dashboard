"""CLI entry point for session summary generation.

Node agent가 spawn으로 호출. stdin으로 JSON 입력, stdout으로 JSON 출력.

Usage:
  echo '{"session_id":"abc", "new_prompts":[...], ...}' | python -m src.cli
"""

from __future__ import annotations

import json
import sys

from .db import SummaryDB
from .engine import SummaryService


def main() -> None:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        _error(f"Invalid JSON: {e}")
        return

    session_id = req.get("session_id", "")
    new_prompts = req.get("new_prompts", [])
    total_prompt_count = req.get("total_prompt_count", len(new_prompts))
    tool_names = req.get("tool_names", [])
    session_title = req.get("session_title")

    if not session_id or not new_prompts:
        _error("session_id and new_prompts required")
        return

    db = SummaryDB()
    try:
        service = SummaryService(db=db)
        result = service.generate(
            session_id=session_id,
            new_prompts=new_prompts,
            total_prompt_count=total_prompt_count,
            tool_names=tool_names,
            session_title=session_title,
        )

        if result:
            json.dump({
                "session_id": result.session_id,
                "one_line": result.one_line,
                "bullets": result.bullets,
                "summary": result.summary,
                "version": result.version,
                "prompt_count": result.prompt_count,
                "generated_at": result.generated_at,
            }, sys.stdout)
        else:
            _error("Generation failed")
    finally:
        db.close()


def _error(msg: str) -> None:
    json.dump({"error": msg}, sys.stdout)


if __name__ == "__main__":
    main()
