import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  connected: boolean;
  reconnecting: boolean;
  machineCount: number;
}

const SHORTCUTS =
  '↑↓ navigate │ Enter detail │ 1-9 project │ a active │ / search │ q quit';

export function StatusBar({
  connected,
  reconnecting,
  machineCount,
}: StatusBarProps): React.JSX.Element {
  return (
    <Box justifyContent="space-between">
      <ConnectionStatus
        connected={connected}
        reconnecting={reconnecting}
        machineCount={machineCount}
      />
      <Text dimColor>{SHORTCUTS}</Text>
    </Box>
  );
}

interface ConnectionStatusProps {
  connected: boolean;
  reconnecting: boolean;
  machineCount: number;
}

function ConnectionStatus({
  connected,
  reconnecting,
  machineCount,
}: ConnectionStatusProps): React.JSX.Element {
  if (reconnecting) {
    return <Text color="yellow">↻ Reconnecting...</Text>;
  }
  if (connected) {
    return (
      <Text color="green">{`● Connected (${machineCount} machine${machineCount !== 1 ? 's' : ''})`}</Text>
    );
  }
  return <Text color="red">○ Disconnected</Text>;
}
