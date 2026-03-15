<script lang="ts">
  import { onMount } from 'svelte';
  import {
    projectsData,
    fetchProjectsData,
    type MergedProjectSummary,
  } from '../../lib/stores/enrichment';
  import {
    getMemos,
    isLoading,
    getCurrentMemo,
    getEditingContent,
    getEditingTitle,
    setEditingContent,
    setEditingTitle,
    clearCurrentMemo,
    fetchMemos,
    fetchMemo,
    createMemo,
    updateMemo,
    deleteMemo,
    isSaving,
    fetchFeed,
    getFeedMemos,
    fetchMemoProjects,
    getMemoProjects,
  } from '../../lib/stores/memos.svelte';
  import {
    getSelectedMachineId,
    onMachineChange,
    getMachines,
    shouldShowMachineFilter,
  } from '../../lib/stores/machine.svelte';
  import { relativeTime } from '../../lib/utils';
  import type { Memo, MemoWithSnippet } from '../../types';

  let selectedProjectId = $state<string | null>(null);
  let isCreating = $state(false);
  let deleteConfirmId = $state<string | null>(null);
  let newMemoTitle = $state('');
  let newMemoContent = $state('');
  let isFeedLoading = $state(false);

  interface DropdownProject {
    projectId: string;
    slug: string;
    machineId: string | undefined;
    memoCount: number;
  }

  let mergedProjects = $derived.by((): DropdownProject[] => {
    const map = new Map<string, DropdownProject>();

    // 메모 프로젝트 추가
    for (const mp of getMemoProjects()) {
      map.set(mp.projectId, {
        projectId: mp.projectId,
        slug: formatProjectSlug(mp.projectSlug),
        machineId: mp.machineId,
        memoCount: mp.memoCount,
      });
    }

    // enrichment 프로젝트 병합 (없는 것만 추가)
    for (const ep of ($projectsData ?? [])) {
      if (!map.has(ep.id)) {
        map.set(ep.id, {
          projectId: ep.id,
          slug: shortPath(ep.worktree),
          machineId: 'machineId' in ep ? (ep as MergedProjectSummary).machineId : undefined,
          memoCount: 0,
        });
      }
    }

    // 정렬: 메모 개수 내림차순 → 이름순
    return [...map.values()].sort((a, b) => {
      if (b.memoCount !== a.memoCount) return b.memoCount - a.memoCount;
      return a.slug.localeCompare(b.slug);
    });
  });

  let memosByDate = $derived.by(() => {
    const list = getMemos();
    const groups: Record<string, Memo[]> = {};
    for (const memo of list) {
      if (!groups[memo.date]) groups[memo.date] = [];
      groups[memo.date].push(memo);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  });

  async function loadFeed(): Promise<void> {
    isFeedLoading = true;
    try {
      await fetchFeed(20, getSelectedMachineId() ?? undefined);
    } finally {
      isFeedLoading = false;
    }
  }

  function getMachineAlias(machineId: string): string {
    const machine = getMachines().find(m => m.id === machineId);
    return machine?.alias ?? machineId;
  }

  function projectLabel(p: DropdownProject): string {
    const countStr = `메모 ${p.memoCount}개`;
    if (shouldShowMachineFilter() && p.machineId) {
      return `[${getMachineAlias(p.machineId)}] ${p.slug} (${countStr})`;
    }
    return `${p.slug} (${countStr})`;
  }

  function formatProjectSlug(slug: string): string {
    const parts = slug.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? slug;
  }

  async function handleFeedItemClick(memo: MemoWithSnippet): Promise<void> {
    selectedProjectId = memo.projectId;
    clearCurrentMemo();
    isCreating = false;
    deleteConfirmId = null;
    // $effect가 fetchMemos(selectedProjectId) 자동 호출
    await fetchMemo(memo.id);
  }

  onMount(() => {
    fetchProjectsData();
    void fetchMemoProjects(getSelectedMachineId() ?? undefined);
    void loadFeed();
    const unsubscribe = onMachineChange(() => {
      void fetchMemoProjects(getSelectedMachineId() ?? undefined);
      fetchProjectsData();
      void loadFeed();
    });
    return unsubscribe;
  });

  $effect(() => {
    if (selectedProjectId) {
      void fetchMemos(selectedProjectId);
    }
  });

  function shortPath(dir: string): string {
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }

  function formatDate(dateStr: string): string {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[0]}년 ${parseInt(parts[1])}월 ${parseInt(parts[2])}일`;
  }

  function handleProjectChange(e: Event) {
    const val = (e.target as HTMLSelectElement).value;
    if (!val) {
      selectedProjectId = null;
      clearCurrentMemo();
      isCreating = false;
      deleteConfirmId = null;
      return;
    }
    if (selectedProjectId === val) return;
    selectedProjectId = val;
    clearCurrentMemo();
    isCreating = false;
    deleteConfirmId = null;
  }

  function handleNewMemo() {
    isCreating = true;
    clearCurrentMemo();
    newMemoTitle = '';
    newMemoContent = '';
    deleteConfirmId = null;
  }

  async function handleSaveNew() {
    if (!selectedProjectId || !newMemoContent.trim()) return;
    const memo = await createMemo(
      selectedProjectId,
      newMemoContent,
      newMemoTitle.trim() || undefined,
    );
    if (memo) {
      isCreating = false;
      newMemoTitle = '';
      newMemoContent = '';
      await fetchMemo(memo.id);
    }
  }

  function handleCancelNew() {
    isCreating = false;
    newMemoTitle = '';
    newMemoContent = '';
  }

  async function handleSelectMemo(memo: Memo) {
    isCreating = false;
    deleteConfirmId = null;
    await fetchMemo(memo.id);
  }

  async function handleSaveEdit() {
    const current = getCurrentMemo();
    if (!current) return;
    await updateMemo(current.id, getEditingContent(), getEditingTitle());
  }

  function handleCancelEdit() {
    clearCurrentMemo();
  }

  function requestDelete(id: string) {
    deleteConfirmId = id;
  }

  function cancelDelete() {
    deleteConfirmId = null;
  }

  async function handleDeleteMemo(id: string) {
    await deleteMemo(id);
    deleteConfirmId = null;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey)) return;

    if (e.key === 'n') {
      if (!selectedProjectId) return;
      e.preventDefault();
      handleNewMemo();
      return;
    }

    if (e.key === 's') {
      e.preventDefault();
      if (isSaving()) return;
      if (isCreating) {
        void handleSaveNew();
      } else if (getCurrentMemo()) {
        void handleSaveEdit();
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="page-container" data-testid="page-memos">
  <div class="page-header">
    <h2 class="page-title">메모</h2>
  </div>

  <div class="memos-layout">
    <aside class="memos-sidebar" data-testid="memos-sidebar">
      <div class="sidebar-header">
        <select
          class="project-select"
          data-testid="project-select"
          value={selectedProjectId ?? ''}
          onchange={handleProjectChange}
        >
          <option value="">프로젝트 선택</option>
          {#each mergedProjects as project (project.projectId)}
            <option value={project.projectId}>{projectLabel(project)}</option>
          {/each}
        </select>

        {#if selectedProjectId}
          <button
            class="new-memo-btn"
            data-testid="new-memo-btn"
            onclick={handleNewMemo}
          >
            새 메모
          </button>
        {/if}
      </div>

      {#if !selectedProjectId}
        <div class="sidebar-empty" data-testid="no-project-hint"></div>
      {:else if isLoading()}
        <div class="sidebar-loading" data-testid="memos-loading">
          로딩 중…
        </div>
      {:else if getMemos().length === 0}
        <div class="sidebar-empty" data-testid="memos-empty">
          <p>메모가 없습니다</p>
          <p class="hint-sub">새 메모 버튼을 눌러 작성하세요</p>
        </div>
      {:else}
        <div class="memo-list" data-testid="memo-list">
          {#each memosByDate as [date, memos] (date)}
            <div class="date-group" data-testid="date-group">
              <div class="date-label">{formatDate(date)}</div>
              {#each memos as memo (memo.id)}
                {@const isActive = getCurrentMemo()?.id === memo.id && !isCreating}
                <button
                  class="memo-item"
                  class:active={isActive}
                  data-testid="memo-item"
                  onclick={() => handleSelectMemo(memo)}
                >
                  <div class="memo-item-top">
                    <span class="memo-title-text">
                      {memo.title || '(제목 없음)'}
                    </span>
                    <span class="memo-time">{relativeTime(memo.updatedAt)}</span>
                  </div>
                  {#if (memo as MemoWithSnippet).snippet}
                    <div class="memo-snippet">{(memo as MemoWithSnippet).snippet}</div>
                  {/if}
                </button>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
    </aside>

    <main class="memos-main" data-testid="memos-main">
      {#if !selectedProjectId}
        {#if isFeedLoading}
          <div class="main-empty" data-testid="feed-loading">
            <p class="empty-sub">로딩 중…</p>
          </div>
        {:else if getFeedMemos().length === 0}
          <div class="main-empty" data-testid="feed-empty">
            <p class="empty-primary">아직 작성된 메모가 없습니다.</p>
            <p class="empty-sub">프로젝트를 선택하고 새 메모를 작성하세요.</p>
          </div>
        {:else}
          <div class="feed-container" data-testid="memo-feed">
            {#each getFeedMemos() as memo (memo.id)}
              <button
                class="feed-item"
                data-testid="feed-item"
                onclick={() => handleFeedItemClick(memo)}
              >
                <div class="feed-meta">
                  <span class="feed-project">{formatProjectSlug(memo.projectSlug)}</span>
                  <span class="feed-dot">·</span>
                  <span class="feed-machine">{getMachineAlias(memo.machineId)}</span>
                  <span class="feed-dot">·</span>
                  <span class="feed-date">{relativeTime(memo.updatedAt)}</span>
                </div>
                <div class="feed-title">{memo.title || '(제목 없음)'}</div>
                {#if memo.snippet}
                  <div class="feed-snippet">{memo.snippet}</div>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      {:else if isCreating}
        <div class="editor-panel" data-testid="new-memo-editor">
          <div class="editor-header">
            <span class="editor-label">새 메모</span>
            <div class="editor-actions">
              <button
                class="btn-save"
                data-testid="save-new-btn"
                onclick={handleSaveNew}
                disabled={isSaving() || !newMemoContent.trim()}
              >
                {isSaving() ? '저장 중…' : '저장'}
              </button>
              <button
                class="btn-cancel"
                data-testid="cancel-new-btn"
                onclick={handleCancelNew}
                disabled={isSaving()}
              >
                취소
              </button>
            </div>
          </div>

          <input
            class="title-input"
            data-testid="new-memo-title"
            type="text"
            placeholder="제목 (선택사항)"
            bind:value={newMemoTitle}
          />
          <textarea
            class="content-textarea"
            data-testid="new-memo-content"
            placeholder="메모 내용을 입력하세요…"
            bind:value={newMemoContent}
          ></textarea>
        </div>
      {:else if getCurrentMemo()}
        {@const current = getCurrentMemo()!}
        <div class="editor-panel" data-testid="memo-editor">
          <div class="editor-header">
            <span class="editor-meta">
              {formatDate(current.date)} · {relativeTime(current.updatedAt)}
            </span>
            <div class="editor-actions">
              <button
                class="btn-save"
                data-testid="save-edit-btn"
                onclick={handleSaveEdit}
                disabled={isSaving()}
              >
                {isSaving() ? '저장 중…' : '저장'}
              </button>
              {#if deleteConfirmId === current.id}
                <button
                  class="btn-delete-confirm"
                  data-testid="confirm-delete-btn"
                  onclick={() => handleDeleteMemo(current.id)}
                >
                  삭제 확인
                </button>
                <button
                  class="btn-cancel"
                  data-testid="cancel-delete-btn"
                  onclick={cancelDelete}
                >
                  취소
                </button>
              {:else}
                <button
                  class="btn-delete"
                  data-testid="delete-memo-btn"
                  onclick={() => requestDelete(current.id)}
                  disabled={isSaving()}
                >
                  삭제
                </button>
                <button
                  class="btn-cancel"
                  data-testid="close-edit-btn"
                  onclick={handleCancelEdit}
                  disabled={isSaving()}
                >
                  닫기
                </button>
              {/if}
            </div>
          </div>

          <input
            class="title-input"
            data-testid="edit-memo-title"
            type="text"
            placeholder="제목 (선택사항)"
            value={getEditingTitle()}
            oninput={(e) => setEditingTitle((e.target as HTMLInputElement).value)}
          />
          <textarea
            class="content-textarea"
            data-testid="edit-memo-content"
            placeholder="메모 내용을 입력하세요…"
            value={getEditingContent()}
            oninput={(e) => setEditingContent((e.target as HTMLTextAreaElement).value)}
          ></textarea>
        </div>
      {:else}
        <div class="main-empty" data-testid="no-memo-selected">
          <p class="empty-primary">메모를 선택하거나 새 메모를 작성하세요</p>
          <p class="empty-sub">
            목록에서 메모를 선택하거나 새 메모 버튼을 눌러주세요
          </p>
        </div>
      {/if}
    </main>
  </div>
</div>

<style>
  .page-container {
    padding: 1.5rem;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .page-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .memos-layout {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 1rem;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .memos-sidebar {
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    min-height: 0;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .project-select {
    flex: 1;
    min-width: 0;
    font-size: 0.8rem;
    font-family: inherit;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.3rem 0.5rem;
    cursor: pointer;
    outline: none;
  }

  .project-select:focus {
    border-color: var(--accent);
  }

  .new-memo-btn {
    flex-shrink: 0;
    font-size: 0.78rem;
    font-family: inherit;
    font-weight: 600;
    background: var(--accent);
    color: #0d1117;
    border: none;
    border-radius: var(--radius-sm);
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s ease;
  }

  .new-memo-btn:hover {
    opacity: 0.85;
  }

  .sidebar-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 1.5rem;
    color: var(--text-secondary);
    font-size: 0.78rem;
    text-align: center;
    gap: 0.35rem;
  }

  .sidebar-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 1.5rem;
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  .hint-sub {
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .memo-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 0;
  }

  .date-group {
    margin-bottom: 0.25rem;
  }

  .date-label {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-secondary);
    padding: 0.4rem 0.75rem 0.2rem;
    letter-spacing: 0.03em;
  }

  .memo-item {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    width: 100%;
    background: none;
    border: none;
    border-left: 2px solid transparent;
    cursor: pointer;
    padding: 0.4rem 0.75rem;
    text-align: left;
    font-family: inherit;
    color: inherit;
    transition: background 0.15s ease;
  }

  .memo-item-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .memo-item:hover {
    background: var(--bg-tertiary);
  }

  .memo-item.active {
    background: rgba(88, 166, 255, 0.1);
    border-left-color: var(--accent);
  }

  .memo-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .memo-title-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-size: 0.8rem;
  }

  .memo-time {
    flex-shrink: 0;
    font-size: 0.72rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .memo-snippet {
    font-size: 0.72rem;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.4;
    opacity: 0.8;
  }

  .memos-main {
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    min-height: 0;
  }

  .main-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 0.5rem;
    padding: 2rem;
    text-align: center;
  }

  .empty-primary {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text-primary);
  }

  .empty-sub {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .editor-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .editor-label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .editor-meta {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .editor-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .btn-save,
  .btn-cancel,
  .btn-delete,
  .btn-delete-confirm {
    font-size: 0.78rem;
    font-family: inherit;
    font-weight: 500;
    border-radius: var(--radius-sm);
    padding: 0.3rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  }

  .btn-save {
    background: var(--accent);
    color: #0d1117;
    border: none;
  }

  .btn-save:hover:not(:disabled) {
    opacity: 0.85;
  }

  .btn-save:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-cancel {
    background: none;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .btn-cancel:hover:not(:disabled) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .btn-cancel:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-delete {
    background: none;
    color: var(--error);
    border: 1px solid var(--border);
  }

  .btn-delete:hover:not(:disabled) {
    background: rgba(248, 81, 73, 0.1);
    border-color: var(--error);
  }

  .btn-delete:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-delete-confirm {
    background: var(--error);
    color: #fff;
    border: none;
  }

  .btn-delete-confirm:hover {
    opacity: 0.85;
  }

  .title-input {
    flex-shrink: 0;
    font-size: 0.9rem;
    font-family: inherit;
    font-weight: 600;
    background: transparent;
    color: var(--text-primary);
    border: none;
    border-bottom: 1px solid var(--border);
    outline: none;
    padding: 0.75rem 1rem;
    transition: border-color 0.15s ease;
  }

  .title-input:focus {
    border-bottom-color: var(--accent);
  }

  .title-input::placeholder {
    color: var(--text-secondary);
    font-weight: 400;
  }

  .content-textarea {
    flex: 1;
    min-height: 0;
    font-size: 0.9rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    background: transparent;
    color: var(--text-primary);
    border: none;
    outline: none;
    padding: 1rem;
    resize: none;
  }

  .content-textarea::placeholder {
    color: var(--text-secondary);
  }

  /* ── Feed ── */
  .feed-container {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .feed-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.65rem 0.875rem;
    text-align: left;
    font-family: inherit;
    color: inherit;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .feed-item:hover {
    border-color: var(--accent);
    background: rgba(88, 166, 255, 0.05);
  }

  .feed-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .feed-meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .feed-project {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--accent);
    white-space: nowrap;
  }

  .feed-machine {
    font-size: 0.72rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .feed-date {
    font-size: 0.72rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .feed-dot {
    font-size: 0.72rem;
    color: var(--text-secondary);
    opacity: 0.5;
    flex-shrink: 0;
  }

  .feed-title {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .feed-snippet {
    font-size: 0.78rem;
    color: var(--text-secondary);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  @media (max-width: 599px) {
    .memos-layout {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }

    .memos-sidebar {
      max-height: 40vh;
    }
  }
</style>
