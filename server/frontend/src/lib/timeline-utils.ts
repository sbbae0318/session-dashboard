export interface TimeRange {
  from: number;
  to: number;
}

export function timeToX(
  timestamp: number,
  viewStart: number,
  viewEnd: number,
  svgWidth: number,
): number {
  const ratio = (timestamp - viewStart) / (viewEnd - viewStart);
  return Math.max(0, Math.min(svgWidth, ratio * svgWidth));
}

export function sessionToY(
  index: number,
  laneHeight: number,
  paddingTop: number = 0,
): number {
  return paddingTop + index * laneHeight;
}

export function formatTimeAxis(
  from: number,
  to: number,
  tickCount: number = 6,
): Array<{ x: number; label: string; timestamp: number }> {
  const duration = to - from;
  const interval = duration / tickCount;
  const ticks = [];

  for (let i = 0; i <= tickCount; i++) {
    const ts = from + i * interval;
    const date = new Date(ts);

    let label: string;
    // 24시간 이하: HH:MM, 초과: MM/DD HH:00
    if (duration <= 24 * 60 * 60 * 1000) {
      label = date.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } else {
      label = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:00`;
    }

    ticks.push({ x: i / tickCount, label, timestamp: ts });
  }

  return ticks;
}

export type TimeRangePreset = '1h' | '6h' | '24h' | '7d';

export function getTimeRange(preset: TimeRangePreset): TimeRange {
  const now = Date.now();
  const presets: Record<TimeRangePreset, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  return { from: now - presets[preset], to: now };
}
