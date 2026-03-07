import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MachineManager } from '../machines/machine-manager.js';
import type { MachineConfig } from '../config/machines.js';

// ── Mock node:http ──
const mockHttpGet = vi.fn();
vi.mock('node:http', () => ({
  get: (...args: unknown[]) => mockHttpGet(...args),
}));

function makeOcMachine(): MachineConfig {
  return { id: 'mac', alias: 'MacBook', host: '10.0.0.1', port: 3101, apiKey: 'key', source: 'opencode' };
}

function setupUrlRouter(routes: Record<string, string>, errors?: Record<string, string>): void {
  mockHttpGet.mockImplementation(
    (url: string, _opts: unknown, callback: (res: unknown) => void) => {
      if (errors) {
        for (const [pattern, errorMsg] of Object.entries(errors)) {
          if (url.includes(pattern)) {
            return {
              on: vi.fn((event: string, handler: (err: Error) => void) => {
                if (event === 'error') handler(new Error(errorMsg));
              }),
            };
          }
        }
      }

      for (const [pattern, body] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          const response = {
            statusCode: 200,
            statusMessage: 'OK',
            on: vi.fn((event: string, handler: (chunk?: unknown) => void) => {
              if (event === 'data') handler(Buffer.from(body));
              if (event === 'end') handler();
            }),
          };
          callback(response);
          return { on: vi.fn() };
        }
      }

      return {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') handler(new Error(`No mock for URL: ${url}`));
        }),
      };
    },
  );
}

describe('MachineManager — active directories merge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should discover sessions from unregistered directories via active-directories', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      // oc-serve returns only 1 registered project
      '/proxy/projects': JSON.stringify([{ id: 'p1', worktree: '/project/bae-settings' }]),
      // active-directories returns an extra unregistered directory
      '/proxy/active-directories': JSON.stringify({ directories: ['/project/bae-settings', '/project/vibescrolling'] }),
      // sessions for registered project
      'directory=%2Fproject%2Fbae-settings': JSON.stringify([{ id: 'ses-1', title: 'Session 1' }]),
      // sessions for unregistered project (vibescrolling)
      'directory=%2Fproject%2Fvibescrolling': JSON.stringify([{ id: 'ses-vibe', title: 'Vibecoding 앱화' }]),
      // statuses
      '/proxy/session/status': JSON.stringify({}),
    });

    const result = await manager.pollAllSessions();

    const ids = result.sessions.map(s => s.id);
    expect(ids).toContain('ses-1');
    expect(ids).toContain('ses-vibe');
    expect(result.sessions).toHaveLength(2);
  });

  it('should not duplicate sessions when active-directories overlaps with projects', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      '/proxy/projects': JSON.stringify([{ id: 'p1', worktree: '/project/foo' }]),
      '/proxy/active-directories': JSON.stringify({ directories: ['/project/foo'] }),
      'directory=%2Fproject%2Ffoo': JSON.stringify([{ id: 'ses-foo', title: 'Foo' }]),
      '/proxy/session/status': JSON.stringify({}),
    });

    const result = await manager.pollAllSessions();

    // /project/foo is already in projects — should not query twice
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('ses-foo');
  });

  it('should gracefully handle active-directories endpoint failure', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      '/proxy/projects': JSON.stringify([{ id: 'p1', worktree: '/project/bar' }]),
      'directory=%2Fproject%2Fbar': JSON.stringify([{ id: 'ses-bar', title: 'Bar' }]),
      '/proxy/session/status': JSON.stringify({}),
    }, {
      '/proxy/active-directories': 'ECONNREFUSED',
    });

    const result = await manager.pollAllSessions();

    // Should still get sessions from registered projects
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('ses-bar');
  });

  it('should handle empty active-directories response', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      '/proxy/projects': JSON.stringify([{ id: 'p1', worktree: '/project/baz' }]),
      '/proxy/active-directories': JSON.stringify({ directories: [] }),
      'directory=%2Fproject%2Fbaz': JSON.stringify([{ id: 'ses-baz', title: 'Baz' }]),
      '/proxy/session/status': JSON.stringify({}),
    });

    const result = await manager.pollAllSessions();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('ses-baz');
  });

  it('should filter root directory from active-directories', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      '/proxy/projects': JSON.stringify([]),
      '/proxy/active-directories': JSON.stringify({ directories: ['/', '/project/real'] }),
      'directory=%2Fproject%2Freal': JSON.stringify([{ id: 'ses-real', title: 'Real' }]),
      '/proxy/session/status': JSON.stringify({}),
    });

    const result = await manager.pollAllSessions();

    // Root "/" should be filtered out; only /project/real polled
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('ses-real');
  });

  it('should tag sessions from active directories with machine info', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      '/proxy/projects': JSON.stringify([]),
      '/proxy/active-directories': JSON.stringify({ directories: ['/project/extra'] }),
      'directory=%2Fproject%2Fextra': JSON.stringify([{ id: 'ses-extra', title: 'Extra' }]),
      '/proxy/session/status': JSON.stringify({}),
    });

    const result = await manager.pollAllSessions();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].machineId).toBe('mac');
    expect(result.sessions[0].machineAlias).toBe('MacBook');
  });
});

describe('MachineManager — global project session discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should discover sessions from oc-serve global project via unfiltered fetch', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      // oc-serve has a global project (worktree="/") and a registered project
      '/proxy/projects': JSON.stringify([
        { id: 'global', worktree: '/' },
        { id: 'p1', worktree: '/project/bae-settings' },
      ]),
      '/proxy/active-directories': JSON.stringify({ directories: ['/project/bae-settings'] }),
      // Per-project query for bae-settings returns 1 session
      'directory=%2Fproject%2Fbae-settings': JSON.stringify([{ id: 'ses-bae', title: 'BAE Session' }]),
      // Unfiltered /proxy/session (no directory param) returns global sessions + the bae session
      '/proxy/session?limit=': JSON.stringify([
        { id: 'ses-bae', title: 'BAE Session' },
        { id: 'ses-global-1', title: 'Biome LSP 서버 여러 개 실행 확인' },
        { id: 'ses-global-2', title: 'Vibecoding 앱화 프로젝트 기획' },
      ]),
      '/proxy/session/status': JSON.stringify({}),
    });

    const result = await manager.pollAllSessions();

    const ids = result.sessions.map(s => s.id);
    // Should find all 3: bae from per-project, global ones from unfiltered fetch
    expect(ids).toContain('ses-bae');
    expect(ids).toContain('ses-global-1');
    expect(ids).toContain('ses-global-2');
    expect(result.sessions).toHaveLength(3);
  });

  it('should deduplicate sessions between per-project and unfiltered fetch', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      '/proxy/projects': JSON.stringify([
        { id: 'global', worktree: '/' },
        { id: 'p1', worktree: '/project/foo' },
      ]),
      '/proxy/active-directories': JSON.stringify({ directories: [] }),
      'directory=%2Fproject%2Ffoo': JSON.stringify([{ id: 'ses-foo', title: 'Foo Session' }]),
      // Unfiltered returns the same session + extra
      '/proxy/session?limit=': JSON.stringify([
        { id: 'ses-foo', title: 'Foo Session' },
        { id: 'ses-orphan', title: 'Orphan in global' },
      ]),
      '/proxy/session/status': JSON.stringify({}),
    });

    const result = await manager.pollAllSessions();

    const ids = result.sessions.map(s => s.id);
    expect(ids).toContain('ses-foo');
    expect(ids).toContain('ses-orphan');
    // ses-foo should NOT be duplicated
    expect(result.sessions).toHaveLength(2);
  });

  it('should handle unfiltered session fetch failure gracefully', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      '/proxy/projects': JSON.stringify([
        { id: 'global', worktree: '/' },
        { id: 'p1', worktree: '/project/bar' },
      ]),
      '/proxy/active-directories': JSON.stringify({ directories: [] }),
      'directory=%2Fproject%2Fbar': JSON.stringify([{ id: 'ses-bar', title: 'Bar' }]),
      '/proxy/session/status': JSON.stringify({}),
    }, {
      '/proxy/session?limit=': 'Network error',
    });

    const result = await manager.pollAllSessions();

    // Per-project sessions still returned despite unfiltered fetch failure
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('ses-bar');
  });

  it('should skip unfiltered fetch when no global project exists', async () => {
    const manager = new MachineManager([makeOcMachine()]);

    setupUrlRouter({
      // No global project — only normal projects
      '/proxy/projects': JSON.stringify([
        { id: 'p1', worktree: '/project/alpha' },
        { id: 'p2', worktree: '/project/beta' },
      ]),
      '/proxy/active-directories': JSON.stringify({ directories: [] }),
      'directory=%2Fproject%2Falpha': JSON.stringify([{ id: 'ses-a', title: 'Alpha' }]),
      'directory=%2Fproject%2Fbeta': JSON.stringify([{ id: 'ses-b', title: 'Beta' }]),
      '/proxy/session/status': JSON.stringify({}),
    });

    const result = await manager.pollAllSessions();

    expect(result.sessions).toHaveLength(2);
    const ids = result.sessions.map(s => s.id);
    expect(ids).toContain('ses-a');
    expect(ids).toContain('ses-b');
  });
});
