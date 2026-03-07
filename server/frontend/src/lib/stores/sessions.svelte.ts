import type { DashboardSession } from "../../types";
import { fetchJSON } from "../api";

interface SessionsResponse {
  sessions: DashboardSession[];
}

let sessions = $state<DashboardSession[]>([]);

export function getSessions(): DashboardSession[] {
  return sessions;
}

export function setSessions(value: DashboardSession[]): void {
  sessions = value;
}

export async function fetchSessions(): Promise<void> {
  try {
    const data = await fetchJSON<SessionsResponse>("/api/sessions");
    sessions = data.sessions ?? [];
  } catch (e) {
    console.error("Failed to fetch sessions:", e);
  }
}
