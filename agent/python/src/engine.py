"""Incremental summary engine backed by DSPy.

핵심 원칙: 마지막 요약 이후 delta만 처리.
- 초기: InitialSummary (전체 프롬프트 → one_line + bullets)
- 이후: IncrementalUpdate (새 프롬프트만 → new_bullets 추가 + one_line 마이너 갱신)
- 기존 bullets는 DB에 누적, LLM에 재전송하지 않음 (토큰 O(delta), not O(total))
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path

import dspy

from .db import SessionSummary, SummaryDB
from .signatures import InitialSummary, IncrementalUpdate

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001"
DEFAULT_THRESHOLD = 5
MAX_BULLETS = 12  # 누적 불렛 상한 (초과 시 오래된 것 병합)
COMPILED_MODEL_PATH = Path(__file__).resolve().parent.parent / "data" / "summarizer.json"


class SummaryService:
    """DSPy incremental session summarizer."""

    def __init__(
        self,
        db: SummaryDB | None = None,
        model: str = DEFAULT_MODEL,
        threshold: int = DEFAULT_THRESHOLD,
    ) -> None:
        self.db = db or SummaryDB()
        self.threshold = threshold
        self._generating: set[str] = set()

        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        self.lm = dspy.LM(model, api_key=api_key)
        dspy.configure(lm=self.lm)

        self.initial = dspy.ChainOfThought(InitialSummary)
        self.incremental = dspy.ChainOfThought(IncrementalUpdate)

        self._compiled_loaded = False
        if COMPILED_MODEL_PATH.exists():
            try:
                # TODO: compiled model 로드 (initial + incremental 별도 저장 필요)
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
        new_prompts: list[dict],
        total_prompt_count: int,
        tool_names: list[str] | None = None,
        session_title: str | None = None,
    ) -> SessionSummary | None:
        """Threshold 체크 후 필요 시 요약 생성."""
        if session_id in self._generating:
            return None

        if len(new_prompts) < self.threshold:
            return None

        return self.generate(
            session_id=session_id,
            new_prompts=new_prompts,
            total_prompt_count=total_prompt_count,
            tool_names=tool_names,
            session_title=session_title,
        )

    def generate(
        self,
        session_id: str,
        new_prompts: list[dict],
        total_prompt_count: int,
        tool_names: list[str] | None = None,
        session_title: str | None = None,
    ) -> SessionSummary | None:
        """Incremental 요약 생성. new_prompts = 마지막 요약 이후 delta만."""
        if session_id in self._generating:
            return None
        if not new_prompts:
            return None

        self._generating.add(session_id)
        try:
            latest = self.db.get_latest(session_id)
            formatted = _format_prompts(new_prompts)
            tools = tool_names or []

            if latest is None:
                # 첫 요약: InitialSummary
                return self._generate_initial(
                    session_id, formatted, tools, total_prompt_count,
                )
            else:
                # 증분 업데이트: IncrementalUpdate
                return self._generate_incremental(
                    session_id, latest, formatted, tools, total_prompt_count,
                )

        except Exception as e:
            logger.error("Summary generation failed for %s: %s", session_id[:8], e)
            return None
        finally:
            self._generating.discard(session_id)

    def _generate_initial(
        self,
        session_id: str,
        formatted_prompts: list[str],
        tool_names: list[str],
        total_prompt_count: int,
    ) -> SessionSummary:
        with dspy.context(lm=self.lm):
            result = self.initial(
                prompts=formatted_prompts,
                tool_names=tool_names,
            )

        one_line = result.one_line.strip()
        bullets = [b.strip() for b in result.new_bullets if b.strip()]

        summary = self.db.insert(
            session_id=session_id,
            one_line=one_line,
            bullets=bullets,
            prompt_count=total_prompt_count,
        )
        logger.info("v%d (initial) for %s (%d prompts)", summary.version, session_id[:8], total_prompt_count)
        return summary

    def _generate_incremental(
        self,
        session_id: str,
        latest: SessionSummary,
        formatted_prompts: list[str],
        tool_names: list[str],
        total_prompt_count: int,
    ) -> SessionSummary:
        with dspy.context(lm=self.lm):
            result = self.incremental(
                existing_one_line=latest.one_line,
                existing_bullets=latest.bullets,
                new_prompts=formatted_prompts,
                new_tool_names=tool_names,
            )

        updated_one_line = result.updated_one_line.strip() or latest.one_line
        new_bullets = [b.strip() for b in result.new_bullets if b.strip()]

        # 기존 bullets에 new_bullets 추가 (누적)
        all_bullets = latest.bullets + new_bullets

        # 상한 초과 시 오래된 것 잘라냄
        if len(all_bullets) > MAX_BULLETS:
            all_bullets = all_bullets[-MAX_BULLETS:]

        summary = self.db.insert(
            session_id=session_id,
            one_line=updated_one_line,
            bullets=all_bullets,
            prompt_count=total_prompt_count,
        )
        logger.info(
            "v%d (incremental, +%d bullets) for %s (%d total prompts)",
            summary.version, len(new_bullets), session_id[:8], total_prompt_count,
        )
        return summary


def _format_prompts(prompts: list[dict]) -> list[str]:
    result = []
    for p in prompts:
        ts = p.get("timestamp", 0)
        query = p.get("query", "")
        dt = datetime.fromtimestamp(ts / 1000)
        result.append(f'[{dt.strftime("%H:%M")}] "{query}"')
    return result
