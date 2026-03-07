import React from 'react';
import { Box, Text } from 'ink';
import type { QueryEntry } from '../types.js';
import { formatTime, truncate } from '../utils/format.js';

export interface QueryListProps {
  queries: QueryEntry[];
  maxVisible?: number;
}

interface QueryRowProps {
  entry: QueryEntry;
  showMachine: boolean;
}

const QUERY_WIDTH = 80;

function QueryRow({ entry, showMachine }: QueryRowProps) {
  const time = formatTime(entry.timestamp);
  const title = truncate(entry.sessionTitle ?? 'untitled', 20);
  const queryClean = entry.query.replace(/\s+/g, ' ').trim();
  const machinePart = showMachine ? ` ${entry.machineAlias}` : '';
  const prefix = `${time}${machinePart} [${title}] `;
  const queryTruncated = truncate(queryClean, Math.max(20, QUERY_WIDTH - prefix.length));

  if (entry.isBackground) {
    return (
      <Box>
        <Text dimColor>{`${time}${machinePart} [${title}] ${queryTruncated}`}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>{time}</Text>
      {showMachine && <Text color="cyan">{` ${entry.machineAlias}`}</Text>}
      <Text dimColor>{` [${title}] `}</Text>
      <Text>{queryTruncated}</Text>
    </Box>
  );
}

export function QueryList({ queries, maxVisible = 15 }: QueryListProps) {
  if (queries.length === 0) {
    return (
      <Box>
        <Text dimColor>Waiting for queries...</Text>
      </Box>
    );
  }

  const uniqueAliases = new Set(queries.map(q => q.machineAlias));
  const isMultiMachine = uniqueAliases.size > 1;
  const visible = queries.slice(-maxVisible);

  return (
    <Box flexDirection="column">
      {visible.map((entry, idx) => (
        <QueryRow
          key={`${entry.sessionId}-${entry.timestamp}-${idx}`}
          entry={entry}
          showMachine={isMultiMachine}
        />
      ))}
    </Box>
  );
}
