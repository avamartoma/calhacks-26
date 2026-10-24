import React from 'react';
import { createRoot } from 'react-dom/client';
import { projects } from './projects.js';
import './style.css';

function App() {
  return <main><header><span>Workspace</span><h1>Projects</h1></header><ul>{projects.map(project => <li key={project.id}><div><h2>{project.name}</h2><p>{project.detail}</p></div><span>{project.status}</span></li>)}</ul></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
