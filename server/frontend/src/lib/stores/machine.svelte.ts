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

type MachineChangeCallback = (machineId: string | null) => void;
const machineChangeCallbacks: MachineChangeCallback[] = [];

export function selectMachine(machineId: string | null): void {
  selectedMachineId = machineId;
  for (const cb of machineChangeCallbacks) {
    cb(machineId);
  }
}

export function onMachineChange(cb: MachineChangeCallback): () => void {
  machineChangeCallbacks.push(cb);
  return () => {
    const idx = machineChangeCallbacks.indexOf(cb);
    if (idx >= 0) machineChangeCallbacks.splice(idx, 1);
  };
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
