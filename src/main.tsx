import React from 'react';
import { createRoot } from 'react-dom/client';
// The web build (VITE_WEB=1, on Vercel) is opencloud online; otherwise this is the local office.
const Root = React.lazy(() => import.meta.env.VITE_WEB === '1' ? import('./web/WebApp') : import('./App'));

// A trackpad pinch arrives as Ctrl+scroll (Safari also sends gesture events). The sky and the
// office use pinch for their own zoom; without this, a pinch that carries on as a project opens
// zooms the whole page instead. Keyboard page zoom (Cmd + / Cmd −) still works.
window.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, e => e.preventDefault());

createRoot(document.getElementById('root')!).render(<React.StrictMode><React.Suspense fallback={null}><Root /></React.Suspense></React.StrictMode>);
