export const FILTER_STORAGE_KEY = 'project-workbench-filters';
export const DEFAULT_FILTERS = Object.freeze({ query: '', status: 'All' });

export function filterProjects(projects, { query, status }) {
  const search = query.trim().toLocaleLowerCase();
  return projects.filter(project =>
    (status !== 'Active' || project.status === 'Active') &&
    (project.name.toLocaleLowerCase().includes(search) ||
      project.detail.toLocaleLowerCase().includes(search))
  );
}

export function readFilters(storage) {
  try {
    const store = typeof storage === 'function' ? storage() : storage;
    const saved = JSON.parse(store?.getItem(FILTER_STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...DEFAULT_FILTERS };
    return {
      query: typeof saved.query === 'string' ? saved.query : DEFAULT_FILTERS.query,
      status: saved.status === 'Active' ? 'Active' : DEFAULT_FILTERS.status,
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function saveFilters(storage, filters) {
  try {
    const store = typeof storage === 'function' ? storage() : storage;
    store?.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Filtering remains available when browser storage is blocked or full.
  }
}
