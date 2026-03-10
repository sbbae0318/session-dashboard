import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { DashboardSession } from '../types.js';
import { statusBadge, projectName, truncate, formatTime } from '../utils/format.js';

export interface SessionListProps {
  sessions: DashboardSession[];
  selectedIndex: number;
  onSelect?: (index: number) => void;
  expandedId?: string | null;
}

interface FlatRow {
  session: DashboardSession;
  flatIndex: number;
  isChild: boolean;
}

function buildFlatRows(sessions: DashboardSession[]): FlatRow[] {
  const sessionMap = new Map(sessions.map(s => [s.sessionId, s]));
  const rows: FlatRow[] = [];

  for (const session of sessions) {
    // Skip children — they'll be rendered under their parent
    if (session.parentSessionId && sessionMap.has(session.parentSessionId)) {
      continue;
    }

    rows.push({ session, flatIndex: rows.length, isChild: false });

    for (const childId of session.childSessionIds) {
      const child = sessionMap.get(childId);
      if (child) {
        rows.push({ session: child, flatIndex: rows.length, isChild: true });
      }
    }
  }

  return rows;
}

function badgeColor(apiStatus: string | null, waitingForInput?: boolean): string | undefined {
  if (waitingForInput) return 'magenta';
  if (apiStatus === 'busy') return 'blue';
  if (apiStatus === 'retry') return 'yellow';
  if (apiStatus === 'idle') return 'green';
  return undefined;
}

function SessionRow({
  session,
  flatIndex,
  isChild,
  selectedIndex,
}: FlatRow & { selectedIndex: number }) {
  const isSelected = flatIndex === selectedIndex;
  const cursor = isSelected ? '❯' : ' ';
  const treePrefix = isChild ? '  └─ ' : '     ';
  const badge = statusBadge(session.apiStatus, session.waitingForInput);
  const color = badgeColor(session.apiStatus, session.waitingForInput);
  const proj = projectName(session.projectCwd);
  const titleText = truncate(session.title ?? session.sessionId, 28);
  const time = formatTime(session.lastActivityTime);
  const dur = session.duration ?? '';
  const tool = session.currentTool ? truncate(session.currentTool, 12) : '';
  const rowColor = isSelected ? 'cyan' : undefined;

  return (
    <Box key={session.sessionId}>
      <Text color={rowColor} bold={isSelected}>{cursor}{treePrefix}</Text>
      <Text color={color} dimColor={color === undefined}>{badge} </Text>
      <Text color={rowColor} bold={isSelected}>
        {proj ? `${proj} ` : ''}{titleText}
        {dur ? ` ${dur}` : ''}
        {time ? ` ${time}` : ''}
        {tool ? ` [${tool}]` : ''}
      </Text>
    </Box>
  );
}

export function SessionList({ sessions, selectedIndex }: SessionListProps) {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const visibleSlots = Math.max(5, termRows - 6);

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No sessions</Text>
      </Box>
    );
  }

  const flatRows = buildFlatRows(sessions);

  let scrollOffset = 0;
  if (flatRows.length > visibleSlots) {
    scrollOffset = Math.max(0, Math.min(
      selectedIndex - Math.floor(visibleSlots / 2),
      flatRows.length - visibleSlots
    ));
  }

  const visibleRows = flatRows.slice(scrollOffset, scrollOffset + visibleSlots);

  return (
    <Box flexDirection="column">
      {visibleRows.map(row => (
        <SessionRow
          key={row.session.sessionId}
          session={row.session}
          flatIndex={row.flatIndex}
          isChild={row.isChild}
          selectedIndex={selectedIndex}
        />
      ))}
    </Box>
  );
}
