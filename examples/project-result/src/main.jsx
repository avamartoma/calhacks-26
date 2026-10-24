import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { projects } from './projects.js';
import { filterProjects, readFilters, saveFilters } from './projectFilters.js';
import './style.css';

function App() {
  const [filters, setFilters] = useState(() => readFilters(() => window.localStorage));
  const searchRef = useRef(null);
  const hasChangedFilters = useRef(false);
  const visibleProjects = filterProjects(projects, filters);

  useEffect(() => {
    if (hasChangedFilters.current) saveFilters(() => window.localStorage, filters);
  }, [filters]);

  function updateFilters(change) {
    hasChangedFilters.current = true;
    setFilters(current => ({ ...current, ...change }));
  }

  function clearSearch() {
    updateFilters({ query: '' });
    searchRef.current?.focus();
  }

  return (
    <main>
      <header><span>Workspace</span><h1>Projects</h1></header>
      <div className="filters">
        <div className="search-field">
          <label htmlFor="project-search">Search projects</label>
          <div className="search-controls">
            <input
              id="project-search"
              ref={searchRef}
              type="search"
              value={filters.query}
              onChange={event => updateFilters({ query: event.target.value })}
              placeholder="Search names and descriptions"
            />
            {filters.query && <button type="button" onClick={clearSearch}>Clear search</button>}
          </div>
        </div>
        <div className="status-field">
          <label htmlFor="project-status">Status</label>
          <select
            id="project-status"
            value={filters.status}
            onChange={event => updateFilters({ status: event.target.value })}
          >
            <option value="All">All</option>
            <option value="Active">Active</option>
          </select>
        </div>
      </div>
      <p className="result-count" role="status" aria-live="polite">
        {visibleProjects.length} {visibleProjects.length === 1 ? 'project' : 'projects'} found
      </p>
      {visibleProjects.length ? (
        <ul>{visibleProjects.map(project => (
          <li key={project.id}>
            <div><h2>{project.name}</h2><p>{project.detail}</p></div>
            <span>{project.status}</span>
          </li>
        ))}</ul>
      ) : <p className="empty-state">No projects match your filters.</p>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
