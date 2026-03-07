import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface MachineConfig {
  readonly id: string;
  readonly alias: string;
  readonly host: string;
  readonly port: number;
  readonly apiKey: string;
  readonly source: "opencode" | "claude-code" | "both";
  readonly timeout?: number;
}

interface MachinesFileSchema {
  machines: Array<{
    id?: unknown;
    alias?: unknown;
    host?: unknown;
    port?: unknown;
    apiKey?: unknown;
    source?: unknown;
    timeout?: unknown;
  }>;
}

function parseTimeout(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const num = Number(raw);
  if (Number.isNaN(num) || num < 1000 || num > 60000) return undefined;
  return num;
}

export function loadMachinesConfig(filePath: string): readonly MachineConfig[] {
  // Read and parse YAML
  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content) as MachinesFileSchema;

  // Validate top-level structure
  if (!parsed || !Array.isArray(parsed.machines)) {
    throw new Error('machines.yml must contain a "machines" array');
  }

  if (parsed.machines.length === 0) {
    console.warn('[Config] machines.yml has 0 machines configured');
    return [];
  }

  // Validate each machine entry
  const configs: MachineConfig[] = [];
  const seenIds = new Set<string>();

  for (const [index, entry] of parsed.machines.entries()) {
    // Required fields validation
    const required = ['id', 'alias', 'host', 'port', 'apiKey'] as const;
    for (const field of required) {
      if (entry[field] === undefined || entry[field] === null || entry[field] === '') {
        throw new Error(`machines[${index}] missing required field: "${field}"`);
      }
    }

    const id = String(entry.id);
    const alias = String(entry.alias);
    const host = String(entry.host);
    const port = Number(entry.port);
    const apiKey = String(entry.apiKey);

    // ID format validation
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      throw new Error(`machines[${index}].id "${id}" must be alphanumeric + hyphens only`);
    }

    // Duplicate ID check
    if (seenIds.has(id)) {
      throw new Error(`Duplicate machine id: "${id}"`);
    }
    seenIds.add(id);

    // Port validation
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`machines[${index}].port must be integer 1-65535, got: ${entry.port}`);
    }

    // Source validation
    const rawSource = entry.source;
    let validSource: "opencode" | "claude-code" | "both" = "opencode";
    if (rawSource !== undefined && rawSource !== null) {
      if (rawSource === "opencode" || rawSource === "claude-code" || rawSource === "both") {
        validSource = rawSource;
      } else {
        console.warn(`[Config] machines[${index}].source "${rawSource}" is invalid, defaulting to "opencode"`);
      }
    }

    configs.push({ id, alias, host, port, apiKey, source: validSource, timeout: parseTimeout(entry.timeout) });
  }

  console.log(`[Config] Loaded ${configs.length} machine(s): ${configs.map(m => m.alias).join(', ')}`);
  return configs;
}
