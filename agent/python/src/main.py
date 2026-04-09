"""FastAPI sidecar service for DSPy-powered incremental session summaries."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .db import SummaryDB
from .engine import SummaryService

logger = logging.getLogger(__name__)

service: SummaryService | None = None
db: SummaryDB | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global service, db
    db = SummaryDB()
    service = SummaryService(db=db)
    logger.info("Summary service started (compiled=%s)", service.compiled_model_loaded)
    yield
    if db:
        db.close()


app = FastAPI(title="Session Summary Service", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Request/Response models
# ---------------------------------------------------------------------------


class PromptItem(BaseModel):
    timestamp: int
    query: str


class SummarizeRequest(BaseModel):
    session_id: str
    session_title: str | None = None
    new_prompts: list[PromptItem]       # delta만 (마지막 요약 이후)
    total_prompt_count: int             # 세션 전체 프롬프트 수
    tool_names: list[str] = []
    force: bool = False


class SummaryResponse(BaseModel):
    session_id: str = ""
    one_line: str = ""
    bullets: list[str] = []
    summary: str = ""
    version: int = 0
    prompt_count: int = 0
    generated_at: int = 0


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": service.lm.model if service else "not initialized",
        "compiled_model_loaded": service.compiled_model_loaded if service else False,
        "total_summaries": len(db.get_all_latest()) if db else 0,
    }


@app.post("/api/summarize", response_model=SummaryResponse)
def summarize(req: SummarizeRequest) -> SummaryResponse:
    if not service or not db:
        raise HTTPException(503, "Service not initialized")

    prompts_dicts = [{"timestamp": p.timestamp, "query": p.query} for p in req.new_prompts]

    if req.force:
        result = service.generate(
            session_id=req.session_id,
            new_prompts=prompts_dicts,
            total_prompt_count=req.total_prompt_count,
            tool_names=req.tool_names or None,
            session_title=req.session_title,
        )
    else:
        result = service.check_and_generate(
            session_id=req.session_id,
            new_prompts=prompts_dicts,
            total_prompt_count=req.total_prompt_count,
            tool_names=req.tool_names or None,
            session_title=req.session_title,
        )

    if not result:
        latest = db.get_latest(req.session_id)
        if latest:
            return SummaryResponse(**asdict(latest))
        return SummaryResponse(session_id=req.session_id)

    return SummaryResponse(**asdict(result))


@app.get("/api/summaries/{session_id}")
def get_session_summary(session_id: str) -> dict[str, Any]:
    if not db:
        raise HTTPException(503, "Service not initialized")
    latest = db.get_latest(session_id)
    history = db.get_history(session_id)
    return {
        "latest": asdict(latest) if latest else None,
        "history": [asdict(h) for h in history],
    }


@app.get("/api/summaries")
def get_all_summaries() -> dict[str, Any]:
    if not db:
        raise HTTPException(503, "Service not initialized")
    summaries = db.get_all_latest()
    return {"summaries": [asdict(s) for s in summaries]}
