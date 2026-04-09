"""DSPy Signatures for incremental session summarization."""

import dspy


class InitialSummary(dspy.Signature):
    """코딩 세션의 첫 요약을 생성. 프롬프트와 도구 사용 내역으로부터 세션 목적과 활동을 추출."""

    prompts: list[str] = dspy.InputField(desc="시간순 사용자 프롬프트 ([HH:MM] 형식)")
    tool_names: list[str] = dspy.InputField(desc="사용된 도구 이름 목록")
    one_line: str = dspy.OutputField(
        desc="세션 목적 한 문장 (예: '대시보드 정렬 로직을 개선하는 세션')"
    )
    new_bullets: list[str] = dspy.OutputField(
        desc="주요 활동 불렛. 각 항목은 '• 작업 → 결과(성공/실패/진행중)' 형식. 최대 5개."
    )


class IncrementalUpdate(dspy.Signature):
    """기존 요약에 새 활동 delta만 추가. 기존 불렛은 건드리지 않고 새 불렛만 생성."""

    existing_one_line: str = dspy.InputField(desc="현재 세션 한줄 설명")
    existing_bullets: list[str] = dspy.InputField(desc="현재 누적된 불렛 포인트 목록")
    new_prompts: list[str] = dspy.InputField(desc="마지막 요약 이후 새로 발생한 프롬프트만")
    new_tool_names: list[str] = dspy.InputField(desc="새 프롬프트에서 사용된 도구 이름")
    updated_one_line: str = dspy.OutputField(
        desc="세션 한줄 설명. 범위가 변하지 않았으면 기존 그대로, 확장되었으면 갱신."
    )
    new_bullets: list[str] = dspy.OutputField(
        desc="새 활동에 대한 불렛만 (기존 불렛 반복 금지). 최대 3개. '• 작업 → 결과' 형식."
    )
