import React from 'react';
import { Box, Text } from 'ink';

interface FilterBarProps {
  projectFilters: string[];
  activeOnly: boolean;
  searchQuery: string;
  totalCount: number;
  filteredCount: number;
}

export function FilterBar({
  projectFilters,
  activeOnly,
  searchQuery,
  totalCount,
  filteredCount,
}: FilterBarProps): React.JSX.Element {
  const hasFilters =
    projectFilters.length > 0 || activeOnly || searchQuery.length > 0;

  return (
    <Box flexDirection="row" gap={1}>
      {hasFilters && (
        <Box flexDirection="row" gap={1}>
          {projectFilters.map((name) => (
            <Text key={name} color="cyan">{`[Project: ${name}]`}</Text>
          ))}
          {activeOnly && <Text color="yellow">[Active Only]</Text>}
          {searchQuery.length > 0 && (
            <Text color="green">{`[Search: "${searchQuery}"]`}</Text>
          )}
        </Box>
      )}
      <Text dimColor>{`(${filteredCount}/${totalCount})`}</Text>
    </Box>
  );
}
