// Which of someone's GitHub repos start out checked when they add repos to their sky.

const RECENT_DAYS = 180;
const PRESELECT = 12;

type Repo = { id: number; added: boolean; fork: boolean; archived: boolean; pushedAt: string | null };

/** Repos worth adding by default: your own recent work, not forks or archived ones. */
export function preselect(repos: Repo[], now = Date.now()) {
  const recent = repos.filter(repo => !repo.added && !repo.fork && !repo.archived && repo.pushedAt && now - Date.parse(repo.pushedAt) < RECENT_DAYS * 86_400_000);
  return new Set(recent.slice(0, PRESELECT).map(repo => repo.id));
}

