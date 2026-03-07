import React from 'react';
import { Box, Text } from 'ink';
import type { DashboardSession, QueryEntry } from '../types.js';
import { statusBadge, projectName, truncate, formatTime } from '../utils/format.js';

interface Props {
  session: DashboardSession;
  queries?: QueryEntry[];
}

function statusColor(apiStatus: string | null): string {
  switch (apiStatus) {
    case 'busy': return 'yellow';
    case 'idle': return 'green';
    case 'retry': return 'magenta';
    default: return 'gray';
  }
}

function PromptSection({ lastPrompt }: { lastPrompt: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>Prompt: {truncate(lastPrompt, 60)}</Text>
      {lastPrompt.length > 60 ? (
        <Text dimColor>  {truncate(lastPrompt.slice(57), 60)}</Text>
      ) : null}
    </Box>
  );
}

function ChildrenSection({ childSessionIds }: { childSessionIds: readonly string[] }): React.JSX.Element {
  return (
    <Text dimColor>
      Children ({childSessionIds.length}):{' '}
      {childSessionIds.slice(0, 3).map((id) => id.slice(0, 8)).join(', ')}
      {childSessionIds.length > 3 ? ` +${childSessionIds.length - 3}` : ''}
    </Text>
  );
}

export function SessionDetail({ session }: Props): React.JSX.Element {
  const title = session.title ?? session.sessionId;
  const project = projectName(session.projectCwd);
  const badge = statusBadge(session.apiStatus);
  const badgeColor = statusColor(session.apiStatus);
  const duration = session.duration ?? formatTime(session.startTime);
  const machine = `${session.machineAlias} @ ${session.machineHost}`;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
    >
      <Text bold color="white">{truncate(title, 60)}</Text>
      {project ? <Text color="cyan">Project: {project}</Text> : null}
      <Text color={badgeColor}>Status: {badge}</Text>
      <Text color="yellow">Duration: {duration}</Text>
      {session.currentTool ? <Text color="green">Tool: {session.currentTool}</Text> : null}
      {session.lastPrompt ? <PromptSection lastPrompt={session.lastPrompt} /> : null}
      <Text dimColor>Machine: {machine}</Text>
      {session.childSessionIds.length > 0 ? (
        <ChildrenSection childSessionIds={session.childSessionIds} />
      ) : null}
    </Box>
  );
}
