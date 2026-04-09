"""SQLite persistence for session summaries."""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "summaries.db"


@dataclass
class SessionSummary:
    session_id: str
    summary: str
    one_line: str
    bullets: list[str]
    prompt_count: int
    version: int
    generated_at: int  # ms


class SummaryDB:
    def __init__(self, db_path: str | Path = DEFAULT_DB_PATH) -> None:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS session_summaries (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id   TEXT NOT NULL,
                one_line     TEXT NOT NULL,
                bullets      TEXT NOT NULL,
                summary      TEXT NOT NULL,
                prompt_count INTEGER NOT NULL,
                version      INTEGER NOT NULL DEFAULT 1,
                generated_at INTEGER NOT NULL
            )
        """)
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_ss_session
            ON session_summaries(session_id, version DESC)
        """)
        self.conn.commit()

    def get_latest(self, session_id: str) -> SessionSummary | None:
        row = self.conn.execute(
            "SELECT * FROM session_summaries WHERE session_id = ? ORDER BY version DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        return _row_to_summary(row) if row else None

    def get_history(self, session_id: str) -> list[SessionSummary]:
        rows = self.conn.execute(
            "SELECT * FROM session_summaries WHERE session_id = ? ORDER BY version ASC",
            (session_id,),
        ).fetchall()
        return [_row_to_summary(r) for r in rows]

    def get_all_latest(self) -> list[SessionSummary]:
        rows = self.conn.execute("""
            SELECT * FROM session_summaries
            WHERE id IN (SELECT MAX(id) FROM session_summaries GROUP BY session_id)
            ORDER BY generated_at DESC
        """).fetchall()
        return [_row_to_summary(r) for r in rows]

    def insert(
        self,
        session_id: str,
        one_line: str,
        bullets: list[str],
        prompt_count: int,
    ) -> SessionSummary:
        latest = self.get_latest(session_id)
        version = (latest.version + 1) if latest else 1
        now_ms = int(time.time() * 1000)
        bullets_text = "\n".join(bullets)
        summary = f"{one_line}\n{bullets_text}"

        self.conn.execute(
            """INSERT INTO session_summaries
               (session_id, one_line, bullets, summary, prompt_count, version, generated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (session_id, one_line, bullets_text, summary, prompt_count, version, now_ms),
        )
        self.conn.commit()

        return SessionSummary(
            session_id=session_id,
            summary=summary,
            one_line=one_line,
            bullets=bullets,
            prompt_count=prompt_count,
            version=version,
            generated_at=now_ms,
        )

    def close(self) -> None:
        self.conn.close()


def _row_to_summary(row: tuple) -> SessionSummary:
    # id, session_id, one_line, bullets, summary, prompt_count, version, generated_at
    return SessionSummary(
        session_id=row[1],
        one_line=row[2],
        bullets=row[3].split("\n") if row[3] else [],
        summary=row[4],
        prompt_count=row[5],
        version=row[6],
        generated_at=row[7],
    )
