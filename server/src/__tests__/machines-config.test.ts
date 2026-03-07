import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadMachinesConfig } from '../config/machines.js';

// ── Mock node:fs ──
const mockReadFileSync = vi.fn();
vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

describe('loadMachinesConfig()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should parse valid YAML and return MachineConfig[]', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: mac-studio
    alias: Mac Studio
    host: 192.168.1.10
    port: 3100
    apiKey: secret-key-1
  - id: mac-mini
    alias: Mac Mini
    host: 192.168.1.11
    port: 3100
    apiKey: secret-key-2
`);

    const configs = loadMachinesConfig('/path/to/machines.yml');

    expect(configs).toHaveLength(2);
    expect(configs[0]).toEqual({
      id: 'mac-studio',
      alias: 'Mac Studio',
      host: '192.168.1.10',
      port: 3100,
      apiKey: 'secret-key-1',
      source: 'opencode',
      timeout: undefined,
    });
    expect(configs[1]).toEqual({
      id: 'mac-mini',
      alias: 'Mac Mini',
      host: '192.168.1.11',
      port: 3100,
      apiKey: 'secret-key-2',
      source: 'opencode',
      timeout: undefined,
    });
  });

  it('should throw when file does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    expect(() => loadMachinesConfig('/nonexistent.yml')).toThrow('ENOENT');
  });

  it('should throw on invalid YAML syntax', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: valid
    alias: Test
    host: localhost
    port: invalid_yaml: broken: [
`);

    expect(() => loadMachinesConfig('/bad.yml')).toThrow();
  });

  it('should throw when top-level machines key is missing', () => {
    mockReadFileSync.mockReturnValue(`
something_else:
  - id: test
`);

    expect(() => loadMachinesConfig('/no-machines.yml')).toThrow(
      'machines.yml must contain a "machines" array',
    );
  });

  it('should throw when required fields are missing', () => {
    // Missing apiKey
    mockReadFileSync.mockReturnValue(`
machines:
  - id: test
    alias: Test
    host: localhost
    port: 3100
`);

    expect(() => loadMachinesConfig('/missing-field.yml')).toThrow(
      'missing required field: "apiKey"',
    );
  });

  it('should throw on missing id field', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - alias: Test
    host: localhost
    port: 3100
    apiKey: key
`);

    expect(() => loadMachinesConfig('/missing-id.yml')).toThrow(
      'missing required field: "id"',
    );
  });

  it('should throw on duplicate machine IDs', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: same-id
    alias: Machine A
    host: host-a
    port: 3100
    apiKey: key-a
  - id: same-id
    alias: Machine B
    host: host-b
    port: 3100
    apiKey: key-b
`);

    expect(() => loadMachinesConfig('/dup.yml')).toThrow('Duplicate machine id: "same-id"');
  });

  it('should return empty array for empty machines list', () => {
    mockReadFileSync.mockReturnValue(`
machines: []
`);

    const configs = loadMachinesConfig('/empty.yml');
    expect(configs).toEqual([]);
  });

  it('should throw on invalid ID format (special characters)', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: "bad id!"
    alias: Test
    host: localhost
    port: 3100
    apiKey: key
`);

    expect(() => loadMachinesConfig('/bad-id.yml')).toThrow('must be alphanumeric + hyphens only');
  });

  it('should throw on invalid port (out of range)', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: test
    alias: Test
    host: localhost
    port: 99999
    apiKey: key
`);

    expect(() => loadMachinesConfig('/bad-port.yml')).toThrow('port must be integer 1-65535');
  });

  it('should throw on invalid port (zero)', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: test
    alias: Test
    host: localhost
    port: 0
    apiKey: key
`);

    expect(() => loadMachinesConfig('/zero-port.yml')).toThrow('port must be integer 1-65535');
  });

  it('should throw when machines is not an array', () => {
    mockReadFileSync.mockReturnValue(`
machines: "not an array"
`);

    expect(() => loadMachinesConfig('/not-array.yml')).toThrow(
      'machines.yml must contain a "machines" array',
    );
  });

  it('should throw on empty string fields', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: ""
    alias: Test
    host: localhost
    port: 3100
    apiKey: key
`);

    expect(() => loadMachinesConfig('/empty-id.yml')).toThrow('missing required field: "id"');
  });

  it('should parse optional timeout field', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: workstation
    alias: Workstation
    host: 192.168.0.2
    port: 3100
    apiKey: key-ws
    timeout: 10000
`);

    const configs = loadMachinesConfig('/timeout.yml');

    expect(configs).toHaveLength(1);
    expect(configs[0].timeout).toBe(10000);
  });

  it('should default timeout to undefined when not specified', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: test
    alias: Test
    host: localhost
    port: 3100
    apiKey: key
`);

    const configs = loadMachinesConfig('/no-timeout.yml');

    expect(configs[0].timeout).toBeUndefined();
  });

  it('should ignore invalid timeout values (too low, too high, NaN)', () => {
    mockReadFileSync.mockReturnValue(`
machines:
  - id: low
    alias: Low
    host: localhost
    port: 3100
    apiKey: key
    timeout: 500
  - id: high
    alias: High
    host: localhost
    port: 3101
    apiKey: key2
    timeout: 99999
  - id: nan
    alias: NaN
    host: localhost
    port: 3102
    apiKey: key3
    timeout: notanumber
`);

    const configs = loadMachinesConfig('/bad-timeout.yml');

    expect(configs[0].timeout).toBeUndefined();
    expect(configs[1].timeout).toBeUndefined();
    expect(configs[2].timeout).toBeUndefined();
  });
});
