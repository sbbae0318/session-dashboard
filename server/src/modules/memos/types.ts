export interface Memo {
  readonly id: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly machineId: string;
  readonly title: string;
  readonly date: string;
  readonly filePath: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoWithContent extends Memo {
  readonly content: string;
}

export interface MemoWithSnippet extends Memo {
  readonly snippet: string;
}

export interface CreateMemoRequest {
  readonly projectId: string;
  readonly content: string;
  readonly machineId?: string;
  readonly title?: string;
  readonly date?: string;
}

export interface UpdateMemoRequest {
  readonly content?: string;
  readonly title?: string;
}

export interface MemoListQuery {
  readonly projectId?: string;
  readonly machineId?: string;
  readonly date?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MemoFeedQuery {
  readonly limit?: number;
  readonly machineId?: string;
}

export interface MemoProject {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly memoCount: number;
  readonly latestDate: string;
}

export interface MemoRow {
  id: string;
  project_id: string;
  project_slug: string;
  machine_id: string;
  title: string;
  date: string;
  file_path: string;
  created_at: number;
  updated_at: number;
}
