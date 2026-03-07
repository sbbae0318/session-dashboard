import type {
  DashboardSession,
  QueryEntry,
  HistoryCard,
  MachineInfo,
} from '../types.js';

export interface HealthInfo {
  status: string;
  uptime: number;
  connectedMachines: number;
  totalMachines: number;
}

export class DashboardClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:3097') {
    this.baseUrl = baseUrl;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  async fetchSessions(): Promise<DashboardSession[]> {
    try {
      const data = await this.fetchJson<{ sessions: DashboardSession[] }>('/api/sessions');
      return data.sessions;
    } catch (error) {
      console.error('[DashboardTUI]', error);
      return [];
    }
  }

  async fetchQueries(limit = 30): Promise<QueryEntry[]> {
    try {
      const data = await this.fetchJson<{ queries: QueryEntry[] }>(`/api/queries?limit=${limit}`);
      return data.queries;
    } catch (error) {
      console.error('[DashboardTUI]', error);
      return [];
    }
  }

  async fetchHistory(limit = 50): Promise<HistoryCard[]> {
    try {
      const data = await this.fetchJson<{ cards: HistoryCard[] }>(`/api/history?limit=${limit}`);
      return data.cards;
    } catch (error) {
      console.error('[DashboardTUI]', error);
      return [];
    }
  }

  async fetchMachines(): Promise<MachineInfo[]> {
    try {
      const data = await this.fetchJson<{ machines: MachineInfo[] }>('/api/machines');
      return data.machines;
    } catch (error) {
      console.error('[DashboardTUI]', error);
      return [];
    }
  }

  async fetchHealth(): Promise<HealthInfo | null> {
    try {
      return await this.fetchJson<HealthInfo>('/health');
    } catch (error) {
      console.error('[DashboardTUI]', error);
      return null;
    }
  }
}
