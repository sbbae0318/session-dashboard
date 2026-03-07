import type { MachineInfo } from '../../types';
import { fetchJSON } from '../api';

interface MachinesResponse {
  machines: MachineInfo[];
}

let machines = $state<MachineInfo[]>([]);
let selectedMachineId = $state<string | null>(null); // null = show all

export function getMachines(): MachineInfo[] {
  return machines;
}

export function setMachines(value: MachineInfo[]): void {
  machines = value;
}

export function getSelectedMachineId(): string | null {
  return selectedMachineId;
}

export function selectMachine(machineId: string | null): void {
  selectedMachineId = machineId;
}

export function shouldShowMachineFilter(): boolean {
  return machines.length > 1;
}

export async function fetchMachines(): Promise<void> {
  try {
    const data = await fetchJSON<MachinesResponse>('/api/machines');
    machines = data.machines ?? [];
  } catch (e) {
    console.error('Failed to fetch machines:', e);
  }
}
