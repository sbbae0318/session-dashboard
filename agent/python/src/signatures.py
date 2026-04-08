"""DSPy Signatures for session summarization."""

import dspy


class SummarizeSession(dspy.Signature):
    """코딩 세션의 프롬프트와 도구 사용 내역을 구조화된 요약으로 변환.

    출력 형식:
    - one_line: 세션이 무엇을 하는 세션인지 한 문장
    - bullets: 주요 활동 불렛 포인트 (각각 성공/실패/진행중 결과 포함)
    """

    prompts: list[str] = dspy.InputField(desc="시간순 사용자 프롬프트 ([HH:MM] 형식)")
    tool_names: list[str] = dspy.InputField(desc="사용된 도구 이름 목록")
    previous_summary: str = dspy.InputField(
        desc="기존 누적 요약. 빈 문자열이면 최초 생성."
    )
    one_line: str = dspy.OutputField(
        desc="세션 목적 한 문장 (예: '대시보드 정렬 로직을 개선하는 세션')"
    )
    bullets: list[str] = dspy.OutputField(
        desc="주요 활동 불렛 포인트. 각 항목은 '• 작업 → 결과' 형식. 최대 8개."
    )
