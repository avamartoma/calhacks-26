export const projects = [
  { name: 'Customer portal', detail: 'React · dashboard and account tools' },
  { name: 'Search service', detail: 'API · project discovery' },
  { name: 'Release console', detail: 'Operations · deployment overview' },
];
export function searchProjects(items, query) {
  const term = query.trim().toLocaleLowerCase();
  return items.filter(item => `${item.name} ${item.detail}`.toLocaleLowerCase().includes(term));
}
