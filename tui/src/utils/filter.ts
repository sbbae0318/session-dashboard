import type { DashboardSession } from '../types.js';
import { fuzzyMatch } from './fuzzy-search.js';
import * as path from 'path';

export interface FilterOptions {
  projects: Set<string>;
  activeOnly: boolean;
  searchQuery: string;
}

/**
 * Filter sessions by project names.
 * If projects set is empty, return all sessions.
 * Otherwise filter by projectCwd basename containing project name.
 */
export function filterByProject(
  sessions: DashboardSession[],
  projects: Set<string>
): DashboardSession[] {
  if (projects.size === 0) {
    return sessions;
  }

  return sessions.filter(session => {
    if (!session.projectCwd) return false;
    const basename = path.basename(session.projectCwd);
    return projects.has(basename);
  });
}

/**
 * Filter sessions by active status.
 * If activeOnly=true, return only sessions with status === 'active' or apiStatus === 'busy'.
 */
export function filterByStatus(
  sessions: DashboardSession[],
  activeOnly: boolean
): DashboardSession[] {
  if (!activeOnly) {
    return sessions;
  }

  return sessions.filter(
    session => session.status === 'active' || session.apiStatus === 'busy'
  );
}

/**
 * Extract unique project names from sessions' projectCwd (basename), sorted alphabetically.
 */
export function extractProjects(sessions: DashboardSession[]): string[] {
  const projectSet = new Set<string>();

  for (const session of sessions) {
    if (session.projectCwd) {
      projectSet.add(path.basename(session.projectCwd));
    }
  }

  return Array.from(projectSet).sort();
}

/**
 * Apply all filters: projects, activeOnly, and searchQuery (fuzzy match on title/sessionId/projectCwd).
 */
export function applyFilters(
  sessions: DashboardSession[],
  opts: FilterOptions
): DashboardSession[] {
  let result = filterByProject(sessions, opts.projects);
  result = filterByStatus(result, opts.activeOnly);

  if (opts.searchQuery.trim() !== '') {
    result = result.filter(session => {
      const searchTargets = [
        session.title ?? '',
        session.sessionId,
        session.projectCwd ?? '',
      ];
      return searchTargets.some(target => fuzzyMatch(opts.searchQuery, target));
    });
  }

  return result;
}
