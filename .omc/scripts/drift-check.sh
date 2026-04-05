#!/bin/bash
# drift-check.sh — Invariant 검증 스크립트
# CLAUDE.md의 P1-P5 불변 원칙을 grep 기반으로 검증한다.
# 프로젝트에 맞게 각 P 원칙을 수정할 것.

set -e

echo "=== Drift Check ==="
echo ""

# P1: [예시 원칙 — 프로젝트에 맞게 수정]
# 예: "ai_pipeline/ 모듈에는 DB 의존성이 없어야 한다"
echo "[P1] {{P1_DESCRIPTION}}"
VIOLATIONS=$(grep -rn "{{P1_PATTERN}}" {{P1_DIR}}/ --include="*.{{EXT}}" 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "⚠️  P1 violations:"
  echo "$VIOLATIONS"
  echo ""
fi

# P2: [프로젝트별 원칙]
echo "[P2] {{P2_DESCRIPTION}}"
# TODO: grep command

# P3: [프로젝트별 원칙]
echo "[P3] {{P3_DESCRIPTION}}"
# TODO: grep command

# P4: [프로젝트별 원칙]
echo "[P4] {{P4_DESCRIPTION}}"
# TODO: grep command

# P5: [프로젝트별 원칙]
echo "[P5] {{P5_DESCRIPTION}}"
# TODO: grep command

echo ""
echo "=== Done ==="
