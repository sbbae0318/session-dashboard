import React, { useState, useEffect, useMemo } from 'react';
import { Box, useInput, useStdout } from 'ink';
import type { DashboardSession, QueryEntry, MachineInfo } from './types.js';
import { DashboardClient } from './api/client.js';
import { useSse } from './api/sse.js';
import { applyFilters, extractProjects } from './utils/filter.js';
import { SessionList } from './components/SessionList.js';
import { SessionDetail } from './components/SessionDetail.js';
import { QueryList } from './components/QueryList.js';
import { FilterBar } from './components/FilterBar.js';
import { StatusBar } from './components/StatusBar.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;
const QUERY_LIST_HEIGHT = 6;

// ── Types ──────────────────────────────────────────────────────────────────────

interface AppProps {
  baseUrl: string;
}

/** Subset of ink's Key used by keyboard handlers. */
interface InputKey {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

interface KeyboardActions {
  setSearchMode: (v: boolean) => void;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setExpandedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveSection: React.Dispatch<React.SetStateAction<'sessions' | 'queries'>>;
  setProjectFilter: React.Dispatch<React.SetStateAction<Set<string>>>;
  setActiveOnly: React.Dispatch<React.SetStateAction<boolean>>;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function toggleSetItem(set: Set<string>, item: string): Set<string> {
  const next = new Set(set);
  if (next.has(item)) {
    next.delete(item);
  } else {
    next.add(item);
  }
  return next;
}

async function fetchAllData(client: DashboardClient): Promise<{
  sessions: DashboardSession[];
  queries: QueryEntry[];
  machines: MachineInfo[];
}> {
  const [sessions, queries, machines] = await Promise.all([
    client.fetchSessions(),
    client.fetchQueries(),
    client.fetchMachines(),
  ]);
  return { sessions, queries, machines };
}

// ── Keyboard handler functions (each ≤ 50 lines) ──────────────────────────────

function handleSearchModeKeys(
  input: string,
  key: InputKey,
  actions: Pick<KeyboardActions, 'setSearchMode' | 'setSearchQuery'>,
): void {
  if (key.escape) {
    actions.setSearchMode(false);
    actions.setSearchQuery('');
    return;
  }
  if (key.return) {
    actions.setSearchMode(false);
    return;
  }
  if (key.backspace || key.delete) {
    actions.setSearchQuery(prev => prev.slice(0, -1));
    return;
  }
  if (input.length === 1 && !key.ctrl && !key.meta) {
    actions.setSearchQuery(prev => prev + input);
  }
}

function handleFilterKeys(
  input: string,
  actions: Pick<KeyboardActions, 'setProjectFilter' | 'setActiveOnly'>,
  projects: readonly string[],
): void {
  if (input === '0') {
    actions.setProjectFilter(new Set());
    return;
  }
  if (input === 'a') {
    actions.setActiveOnly(prev => !prev);
    return;
  }
  const num = parseInt(input, 10);
  if (num >= 1 && num <= 9) {
    const project = projects[num - 1];
    if (project !== undefined) {
      actions.setProjectFilter(prev => toggleSetItem(prev, project));
    }
  }
}

function handleNormalModeKeys(
  input: string,
  key: InputKey,
  selectedIndex: number,
  filteredSessions: readonly DashboardSession[],
  projects: readonly string[],
  actions: KeyboardActions,
): void {
  if (key.upArrow || input === 'k') {
    actions.setSelectedIndex(prev => Math.max(0, prev - 1));
    return;
  }
  if (key.downArrow || input === 'j') {
    actions.setSelectedIndex(prev =>
      Math.max(0, Math.min(filteredSessions.length - 1, prev + 1)),
    );
    return;
  }
  if (key.return) {
    const session = filteredSessions[selectedIndex];
    if (session) {
      const id = session.sessionId;
      actions.setExpandedSessionId(prev => (prev === id ? null : id));
    }
    return;
  }
  if (key.tab) {
    actions.setActiveSection(prev =>
      prev === 'sessions' ? 'queries' : 'sessions',
    );
    return;
  }
  if (input === '/') {
    actions.setSearchMode(true);
    return;
  }
  if (input === 'q') {
    process.exit(0);
  }
  handleFilterKeys(input, actions, projects);
}

// ── Custom hook: keyboard input ────────────────────────────────────────────────

function useKeyboardHandler(
  searchMode: boolean,
  selectedIndex: number,
  filteredSessions: readonly DashboardSession[],
  projects: readonly string[],
  actions: KeyboardActions,
): void {
  useInput((input, key) => {
    if (searchMode) {
      handleSearchModeKeys(input, key, actions);
      return;
    }
    handleNormalModeKeys(
      input, key, selectedIndex, filteredSessions, projects, actions,
    );
  });
}

// ── Helper: apply fetched data to state ────────────────────────────────────────

function applyFetchedData(
  data: { sessions: DashboardSession[]; queries: QueryEntry[]; machines: MachineInfo[] },
  setSessions: React.Dispatch<React.SetStateAction<DashboardSession[]>>,
  setQueries: React.Dispatch<React.SetStateAction<QueryEntry[]>>,
  setMachines: React.Dispatch<React.SetStateAction<MachineInfo[]>>,
): void {
  setSessions(data.sessions);
  setQueries(data.queries);
  setMachines(data.machines);
}

// ── Custom hook: data fetching & SSE ─────────────────────────────────────────

interface AppData {
  sessions: DashboardSession[];
  queries: QueryEntry[];
  machines: MachineInfo[];
  setSessions: React.Dispatch<React.SetStateAction<DashboardSession[]>>;
  setQueries: React.Dispatch<React.SetStateAction<QueryEntry[]>>;
  setMachines: React.Dispatch<React.SetStateAction<MachineInfo[]>>;
  connected: boolean;
  reconnecting: boolean;
}

function useAppData(baseUrl: string): AppData {
  const [sessions, setSessions] = useState<DashboardSession[]>([]);
  const [queries, setQueries] = useState<QueryEntry[]>([]);
  const [machines, setMachines] = useState<MachineInfo[]>([]);

  const client = useMemo(() => new DashboardClient(baseUrl), [baseUrl]);

  // Initial fetch
  useEffect(() => {
    void fetchAllData(client).then(data => {
      applyFetchedData(data, setSessions, setQueries, setMachines);
    });
  }, [client]);

  // SSE live updates
  const sseCallbacks = useMemo(() => ({
    onSessionUpdate: (s: DashboardSession[]) => setSessions(s),
    onQueryNew: (q: QueryEntry) => setQueries(prev => [...prev, q]),
    onMachineStatus: (m: MachineInfo[]) => setMachines(m),
  }), []);

  const { connected, reconnecting } = useSse(baseUrl, sseCallbacks);

  // Polling fallback (30s)
  useEffect(() => {
    const timer = setInterval(() => {
      void fetchAllData(client).then(data => {
        applyFetchedData(data, setSessions, setQueries, setMachines);
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client]);

  return { sessions, queries, machines, setSessions, setQueries, setMachines, connected, reconnecting };
}

// ── Custom hook: derived state ────────────────────────────────────────────────

interface DerivedState {
  projects: readonly string[];
  filteredSessions: DashboardSession[];
  expandedSession: DashboardSession | null;
}

function useDerivedState(
  sessions: DashboardSession[],
  projectFilter: Set<string>,
  activeOnly: boolean,
  searchQuery: string,
  expandedSessionId: string | null,
  selectedIndex: number,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>,
): DerivedState {
  const projects = useMemo(() => extractProjects(sessions), [sessions]);

  const filteredSessions = useMemo(
    () => applyFilters(sessions, { projects: projectFilter, activeOnly, searchQuery }),
    [sessions, projectFilter, activeOnly, searchQuery],
  );

  // Clamp cursor when filtered list shrinks
  useEffect(() => {
    if (selectedIndex >= filteredSessions.length && filteredSessions.length > 0) {
      setSelectedIndex(filteredSessions.length - 1);
    }
  }, [filteredSessions.length, selectedIndex, setSelectedIndex]);

  const expandedSession = useMemo(
    () => filteredSessions.find(s => s.sessionId === expandedSessionId) ?? null,
    [filteredSessions, expandedSessionId],
  );

  return { projects, filteredSessions, expandedSession };
}

// ── App component ──────────────────────────────────────────────────────────────

export function App({ baseUrl }: AppProps): React.JSX.Element {
  const { sessions, queries, machines, connected, reconnecting } = useAppData(baseUrl);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'sessions' | 'queries'>('sessions');
  const [projectFilter, setProjectFilter] = useState<Set<string>>(new Set());
  const [activeOnly, setActiveOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const { stdout } = useStdout();

  const { projects, filteredSessions, expandedSession } = useDerivedState(
    sessions, projectFilter, activeOnly, searchQuery, expandedSessionId, selectedIndex, setSelectedIndex,
  );
  const actions: KeyboardActions = useMemo(() => ({
    setSearchMode, setSearchQuery, setSelectedIndex, setExpandedSessionId,
    setActiveSection, setProjectFilter, setActiveOnly,
  }), []);
  useKeyboardHandler(searchMode, selectedIndex, filteredSessions, projects, actions);

  return (
    <Box flexDirection="column" height={stdout?.rows ?? 24}>
      <FilterBar
        projectFilters={Array.from(projectFilter)}
        activeOnly={activeOnly}
        searchQuery={searchQuery}
        totalCount={sessions.length}
        filteredCount={filteredSessions.length}
      />
      <Box flexGrow={1} flexDirection="column">
        <SessionList
          sessions={filteredSessions}
          selectedIndex={selectedIndex}
          expandedId={expandedSessionId}
        />
      </Box>
      {expandedSession !== null && (
        <SessionDetail session={expandedSession} queries={queries} />
      )}
      <Box height={QUERY_LIST_HEIGHT}>
        <QueryList queries={queries} maxVisible={QUERY_LIST_HEIGHT} />
      </Box>
      <StatusBar
        connected={connected}
        reconnecting={reconnecting}
        machineCount={machines.length}
      />
    </Box>
  );
}
