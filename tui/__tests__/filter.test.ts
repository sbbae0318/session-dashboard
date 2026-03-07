import { describe, test, expect } from 'bun:test';
import {
  filterByProject,
  filterByStatus,
  extractProjects,
  applyFilters,
} from '../src/utils/filter.js';
import type { DashboardSession } from '../src/types.js';

function mockSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    sessionId: 'ses_test',
    parentSessionId: null,
    childSessionIds: [],
    title: 'Test Session',
    projectCwd: '/Users/test/project/my-app',
    status: 'active',
    startTime: Date.now() - 60000,
    lastActivityTime: Date.now(),
    currentTool: null,
    duration: null,
    summary: null,
    apiStatus: 'idle',
    lastPrompt: null,
    machineId: 'm1',
    machineHost: 'localhost',
    machineAlias: 'local',
    ...overrides,
  };
}

describe('filterByProject()', () => {
  test('empty set returns all sessions', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', projectCwd: '/home/user/project-a' }),
      mockSession({ sessionId: 'ses_002', projectCwd: '/home/user/project-b' }),
    ];

    const result = filterByProject(sessions, new Set());
    expect(result).toHaveLength(2);
  });

  test('filters by specific project basename', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', projectCwd: '/home/user/project-a' }),
      mockSession({ sessionId: 'ses_002', projectCwd: '/home/user/project-b' }),
      mockSession({ sessionId: 'ses_003', projectCwd: '/home/user/project-a' }),
    ];

    const result = filterByProject(sessions, new Set(['project-a']));
    expect(result).toHaveLength(2);
    expect(result.every(s => s.projectCwd?.endsWith('project-a'))).toBe(true);
  });

  test('excludes sessions with null projectCwd when filter is active', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', projectCwd: '/home/user/project-a' }),
      mockSession({ sessionId: 'ses_002', projectCwd: null }),
    ];

    const result = filterByProject(sessions, new Set(['project-a']));
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('ses_001');
  });

  test('returns empty array when no sessions match', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', projectCwd: '/home/user/project-a' }),
    ];

    const result = filterByProject(sessions, new Set(['project-z']));
    expect(result).toHaveLength(0);
  });
});

describe('filterByStatus()', () => {
  test('activeOnly=false returns all sessions', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', status: 'active', apiStatus: 'idle' }),
      mockSession({ sessionId: 'ses_002', status: 'completed', apiStatus: 'idle' }),
      mockSession({ sessionId: 'ses_003', status: 'orphaned', apiStatus: null }),
    ];

    const result = filterByStatus(sessions, false);
    expect(result).toHaveLength(3);
  });

  test('activeOnly=true returns only active status sessions', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', status: 'active', apiStatus: 'idle' }),
      mockSession({ sessionId: 'ses_002', status: 'completed', apiStatus: 'idle' }),
      mockSession({ sessionId: 'ses_003', status: 'orphaned', apiStatus: null }),
    ];

    const result = filterByStatus(sessions, true);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('ses_001');
  });

  test('activeOnly=true returns sessions with apiStatus=busy', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', status: 'completed', apiStatus: 'busy' }),
      mockSession({ sessionId: 'ses_002', status: 'completed', apiStatus: 'idle' }),
    ];

    const result = filterByStatus(sessions, true);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('ses_001');
  });

  test('activeOnly=true returns both active status and busy apiStatus', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', status: 'active', apiStatus: 'idle' }),
      mockSession({ sessionId: 'ses_002', status: 'completed', apiStatus: 'busy' }),
      mockSession({ sessionId: 'ses_003', status: 'completed', apiStatus: 'idle' }),
    ];

    const result = filterByStatus(sessions, true);
    expect(result).toHaveLength(2);
    const ids = result.map(s => s.sessionId);
    expect(ids).toContain('ses_001');
    expect(ids).toContain('ses_002');
  });
});

describe('extractProjects()', () => {
  test('returns sorted unique project names', () => {
    const sessions = [
      mockSession({ projectCwd: '/home/user/zebra-project' }),
      mockSession({ projectCwd: '/home/user/alpha-project' }),
      mockSession({ projectCwd: '/home/user/zebra-project' }),
      mockSession({ projectCwd: '/home/user/beta-project' }),
    ];

    const result = extractProjects(sessions);
    expect(result).toEqual(['alpha-project', 'beta-project', 'zebra-project']);
  });

  test('ignores sessions with null projectCwd', () => {
    const sessions = [
      mockSession({ projectCwd: '/home/user/my-project' }),
      mockSession({ projectCwd: null }),
    ];

    const result = extractProjects(sessions);
    expect(result).toEqual(['my-project']);
  });

  test('returns empty array for empty sessions', () => {
    const result = extractProjects([]);
    expect(result).toEqual([]);
  });
});

describe('applyFilters()', () => {
  test('applies project and status filters together', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', projectCwd: '/home/user/project-a', status: 'active', apiStatus: 'idle' }),
      mockSession({ sessionId: 'ses_002', projectCwd: '/home/user/project-a', status: 'completed', apiStatus: 'idle' }),
      mockSession({ sessionId: 'ses_003', projectCwd: '/home/user/project-b', status: 'active', apiStatus: 'idle' }),
    ];

    const result = applyFilters(sessions, {
      projects: new Set(['project-a']),
      activeOnly: true,
      searchQuery: '',
    });

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('ses_001');
  });

  test('applies search query fuzzy filter', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001', title: 'Fix authentication bug' }),
      mockSession({ sessionId: 'ses_002', title: 'Add new feature' }),
      mockSession({ sessionId: 'ses_003', title: 'Refactor auth module' }),
    ];

    const result = applyFilters(sessions, {
      projects: new Set(),
      activeOnly: false,
      searchQuery: 'auth',
    });

    expect(result).toHaveLength(2);
    const ids = result.map(s => s.sessionId);
    expect(ids).toContain('ses_001');
    expect(ids).toContain('ses_003');
  });

  test('empty filters returns all sessions', () => {
    const sessions = [
      mockSession({ sessionId: 'ses_001' }),
      mockSession({ sessionId: 'ses_002' }),
      mockSession({ sessionId: 'ses_003' }),
    ];

    const result = applyFilters(sessions, {
      projects: new Set(),
      activeOnly: false,
      searchQuery: '',
    });

    expect(result).toHaveLength(3);
  });
});
