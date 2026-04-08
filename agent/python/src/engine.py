"""Summary generation engine backed by DSPy."""

from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path

import dspy

from .db import SessionSummary, SummaryDB
from .signatures import SummarizeSession

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001"
DEFAULT_THRESHOLD = 5
COMPILED_MODEL_PATH = Path(__file__).resolve().parent.parent / "data" / "summarizer.json"


class SummaryService:
    """DSPy-powered progressive session summarizer."""

    def __init__(
        self,
        db: SummaryDB | None = None,
        model: str = DEFAULT_MODEL,
        threshold: int = DEFAULT_THRESHOLD,
    ) -> None:
        self.db = db or SummaryDB()
        self.threshold = threshold
        self._generating: set[str] = set()

        # DSPy LM 설정
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        self.lm = dspy.LM(model, api_key=api_key)
        dspy.configure(lm=self.lm)

        # 모듈: ChainOfThought로 reasoning 후 structured output
        self.summarizer = dspy.ChainOfThought(SummarizeSession)

        # Compiled model 로드 (있으면)
        self._compiled_loaded = False
        if COMPILED_MODEL_PATH.exists():
            try:
                self.summarizer.load(str(COMPILED_MODEL_PATH))
                self._compiled_loaded = True
                logger.info("Loaded compiled model from %s", COMPILED_MODEL_PATH)
            except Exception as e:
                logger.warning("Failed to load compiled model: %s", e)

    @property
    def compiled_model_loaded(self) -> bool:
        return self._compiled_loaded

    def check_and_generate(
        self,
        session_id: str,
        prompts: list[dict],
        tool_names: list[str] | None = None,
        session_title: str | None = None,
    ) -> SessionSummary | None:
        """Threshold 체크 후 필요 시 요약 생성. None이면 threshold 미달."""
        if session_id in self._generating:
            return None

        latest = self.db.get_latest(session_id)
        last_count = latest.prompt_count if latest else 0
        new_count = len(prompts) - last_count

        if new_count < self.threshold:
            return None

        return self.generate(
            session_id=session_id,
            prompts=prompts,
            tool_names=tool_names,
            session_title=session_title,
        )

    def generate(
        self,
        session_id: str,
        prompts: list[dict],
        tool_names: list[str] | None = None,
        session_title: str | None = None,
        force: bool = False,
    ) -> SessionSummary | None:
        """요약 생성 (force=True면 threshold 무시)."""
        if session_id in self._generating:
            return None
        if not prompts:
            return None

        self._generating.add(session_id)
        try:
            latest = self.db.get_latest(session_id)

            # 프롬프트 포매팅
            formatted = _format_prompts(prompts)
            tools = tool_names or []
            prev_summary = latest.summary if latest else ""

            # DSPy 호출
            with dspy.context(lm=self.lm):
                result = self.summarizer(
                    prompts=formatted,
                    tool_names=tools,
                    previous_summary=prev_summary,
                )

            one_line = result.one_line.strip()
            bullets = [b.strip() for b in result.bullets if b.strip()]

            # DB 저장
            summary = self.db.insert(
                session_id=session_id,
                one_line=one_line,
                bullets=bullets,
                prompt_count=len(prompts),
            )

            logger.info(
                "v%d generated for %s (%d prompts)",
                summary.version,
                session_id[:8],
                len(prompts),
            )
            return summary

        except Exception as e:
            logger.error("Summary generation failed for %s: %s", session_id[:8], e)
            return None
        finally:
            self._generating.discard(session_id)


def _format_prompts(prompts: list[dict]) -> list[str]:
    """프롬프트 딕셔너리 목록을 [HH:MM] "query" 형식으로 변환."""
    result = []
    for p in prompts:
        ts = p.get("timestamp", 0)
        query = p.get("query", "")
        dt = datetime.fromtimestamp(ts / 1000)
        result.append(f'[{dt.strftime("%H:%M")}] "{query}"')
    return result
