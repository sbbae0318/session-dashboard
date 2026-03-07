import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseAttachDir, detectActiveDirectoriesUncached, resetCache, detectActiveDirectories } from '../active-directories.js';

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

describe('active-directories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
  });

  afterEach(() => {
    resetCache();
  });

  describe('parseAttachDir', () => {
    it('should extract --dir from opencode attach line', () => {
      const line = 'sbbae 81264 7.5 1.8 485474128 296192 s007 S+ 수12AM 210:57.16 opencode attach http://127.0.0.1:4096 --dir /Users/sbbae/project/vibescrolling';
      expect(parseAttachDir(line)).toBe('/Users/sbbae/project/vibescrolling');
    });

    it('should extract --dir from minimal attach line', () => {
      const line = 'opencode attach http://127.0.0.1:4096 --dir /home/user/project';
      expect(parseAttachDir(line)).toBe('/home/user/project');
    });

    it('should return null for non-attach processes', () => {
      expect(parseAttachDir('opencode serve --port 4096')).toBeNull();
      expect(parseAttachDir('node dist/index.js')).toBeNull();
      expect(parseAttachDir('grep opencode')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(parseAttachDir('')).toBeNull();
    });

    it('should handle opencode run processes (not attach)', () => {
      const line = '/Users/sbbae/.opencode/bin/opencode run /path/to/server.js --stdio';
      expect(parseAttachDir(line)).toBeNull();
    });
  });

  describe('detectActiveDirectoriesUncached', () => {
    it('should return unique directories from ps output', async () => {
      const psOutput = [
        'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND',
        'sbbae 81264 7.5 1.8 485474128 296192 s007 S+ 수12AM 210:57.16 opencode attach http://127.0.0.1:4096 --dir /Users/sbbae/project/vibescrolling',
        'sbbae 61267 24.5 3.4 486851904 567744 s014 S+ 수03AM 544:56.31 opencode attach http://127.0.0.1:4096 --dir /Users/sbbae/project/bae-settings',
        'sbbae 88309 12.1 2.6 485834672 428416 s018 S+ 토10AM 239:58.20 opencode attach http://127.0.0.1:4096 --dir /Users/sbbae/mule',
        'sbbae 61239 39.1 5.0 487108224 837504 s006 S+ 수03AM 150:14.76 opencode serve --port 4096',
        'sbbae 19072 0.0 1.1 485061456 176464 s038 S+ 8:13AM 0:03.77 claude --dangerously-skip-permissions',
      ].join('\n');

      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, psOutput, '');
      });

      const dirs = await detectActiveDirectoriesUncached();
      expect(dirs).toEqual([
        '/Users/sbbae/mule',
        '/Users/sbbae/project/bae-settings',
        '/Users/sbbae/project/vibescrolling',
      ]);
    });

    it('should deduplicate same directory from multiple processes', async () => {
      const psOutput = [
        'opencode attach http://127.0.0.1:4096 --dir /Users/sbbae/project/foo',
        'opencode attach http://127.0.0.1:4096 --dir /Users/sbbae/project/foo',
      ].join('\n');

      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, psOutput, '');
      });

      const dirs = await detectActiveDirectoriesUncached();
      expect(dirs).toEqual(['/Users/sbbae/project/foo']);
    });

    it('should filter out root directory', async () => {
      const psOutput = 'opencode attach http://127.0.0.1:4096 --dir /\n';

      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, psOutput, '');
      });

      const dirs = await detectActiveDirectoriesUncached();
      expect(dirs).toEqual([]);
    });

    it('should return empty array on ps error', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('ps failed'), '', '');
      });

      const dirs = await detectActiveDirectoriesUncached();
      expect(dirs).toEqual([]);
    });

    it('should return empty array on empty output', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '', '');
      });

      const dirs = await detectActiveDirectoriesUncached();
      expect(dirs).toEqual([]);
    });
  });

  describe('detectActiveDirectories (cached)', () => {
    it('should cache results for subsequent calls', async () => {
      const psOutput = 'opencode attach http://127.0.0.1:4096 --dir /home/user/proj\n';

      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, psOutput, '');
      });

      const first = await detectActiveDirectories();
      const second = await detectActiveDirectories();

      expect(first).toEqual(['/home/user/proj']);
      expect(second).toEqual(['/home/user/proj']);
      // execFile called only once due to cache
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('should refresh after cache reset', async () => {
      const psOutput = 'opencode attach http://127.0.0.1:4096 --dir /home/user/proj\n';

      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, psOutput, '');
      });

      await detectActiveDirectories();
      resetCache();
      await detectActiveDirectories();

      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });
});
