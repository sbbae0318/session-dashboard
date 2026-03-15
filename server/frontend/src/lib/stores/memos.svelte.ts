import type { Memo, MemoWithContent, MemoWithSnippet, MemoProject } from '../../types';
import { fetchJSON } from '../api';
import { getSelectedMachineId, getMachines } from './machine.svelte';

let memos = $state<Memo[]>([]);
let loading = $state(false);
let currentMemo = $state<MemoWithContent | null>(null);
let editingContent = $state('');
let editingTitle = $state('');
let saving = $state(false);
let feedMemos = $state<MemoWithSnippet[]>([]);
let memoProjects = $state<MemoProject[]>([]);

export function getMemos(): Memo[] { return memos; }
export function isLoading(): boolean { return loading; }
export function getCurrentMemo(): MemoWithContent | null { return currentMemo; }
export function getEditingContent(): string { return editingContent; }
export function getEditingTitle(): string { return editingTitle; }
export function isSaving(): boolean { return saving; }
export function getFeedMemos(): MemoWithSnippet[] { return feedMemos; }
export function getMemoProjects(): MemoProject[] { return memoProjects; }

export function setEditingContent(v: string): void { editingContent = v; }
export function setEditingTitle(v: string): void { editingTitle = v; }

export function clearCurrentMemo(): void {
  currentMemo = null;
  editingContent = '';
  editingTitle = '';
}

export async function fetchMemos(projectId?: string, date?: string, machineId?: string): Promise<void> {
  loading = true;
  try {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (date) params.set('date', date);
    if (machineId) params.set('machineId', machineId);
    const qs = params.toString();
    const url = `/api/memos${qs ? '?' + qs : ''}`;
    const data = await fetchJSON<{ memos: Memo[] }>(url);
    memos = data.memos ?? [];
  } catch (e) {
    console.error('Failed to fetch memos:', e);
  } finally {
    loading = false;
  }
}

export async function fetchMemo(id: string): Promise<void> {
  try {
    const data = await fetchJSON<MemoWithContent>(`/api/memos/${id}`);
    currentMemo = data;
    editingContent = data.content;
    editingTitle = data.title;
  } catch (e) {
    console.error('Failed to fetch memo:', e);
  }
}

export async function createMemo(projectId: string, content: string, title?: string, date?: string, machineId?: string): Promise<Memo | null> {
  saving = true;
  try {
    const resolvedMachineId = machineId ?? getSelectedMachineId() ?? getMachines()[0]?.id ?? '';
    const body: Record<string, string> = { projectId, content, machineId: resolvedMachineId };
    if (title) body.title = title;
    if (date) body.date = date;
    const memo = await fetchJSON<Memo>('/api/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    memos = [memo, ...memos];
    return memo;
  } catch (e) {
    console.error('Failed to create memo:', e);
    return null;
  } finally {
    saving = false;
  }
}

export async function updateMemo(id: string, content?: string, title?: string): Promise<boolean> {
  saving = true;
  try {
    const body: Record<string, string> = {};
    if (content !== undefined) body.content = content;
    if (title !== undefined) body.title = title;
    const updated = await fetchJSON<Memo>(`/api/memos/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    memos = memos.map(m => m.id === id ? updated : m);
    if (currentMemo?.id === id) {
      currentMemo = { ...updated, content: content ?? currentMemo.content };
    }
    return true;
  } catch (e) {
    console.error('Failed to update memo:', e);
    return false;
  } finally {
    saving = false;
  }
}

export async function deleteMemo(id: string): Promise<boolean> {
  try {
    await fetchJSON<{ deleted: boolean }>(`/api/memos/${id}`, { method: 'DELETE' });
    memos = memos.filter(m => m.id !== id);
    if (currentMemo?.id === id) {
      clearCurrentMemo();
    }
    return true;
  } catch (e) {
    console.error('Failed to delete memo:', e);
    return false;
  }
}

export async function fetchFeed(limit?: number, machineId?: string): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (machineId) params.set('machineId', machineId);
    const qs = params.toString();
    const url = `/api/memos/feed${qs ? '?' + qs : ''}`;
    const data = await fetchJSON<{ memos: MemoWithSnippet[] }>(url);
    feedMemos = data.memos ?? [];
  } catch (e) {
    console.error('Failed to fetch feed:', e);
  }
}

export async function fetchMemoProjects(machineId?: string): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (machineId) params.set('machineId', machineId);
    const qs = params.toString();
    const url = `/api/memos/projects${qs ? '?' + qs : ''}`;
    const data = await fetchJSON<{ projects: MemoProject[] }>(url);
    memoProjects = data.projects ?? [];
  } catch (e) {
    console.error('Failed to fetch memo projects:', e);
  }
}
