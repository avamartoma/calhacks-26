import { useEffect, useState } from 'react';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import { ConvexReactClient } from 'convex/react';
import { ConvexProviderWithAuth0 } from 'convex/react-auth0';
import { LoaderCircle } from 'lucide-react';
import hosted from '../../hosted.json';
import { localHour, paletteAt } from '../sky/time-of-day';
import { WebSky } from './WebSky';
import { WebProject } from './WebProject';
import { JoinLink } from './ShareLinks';
import '@fontsource/urbanist/400.css';
import '@fontsource/urbanist/500.css';
import '@fontsource/urbanist/600.css';
import '@fontsource/urbanist/700.css';
import '@fontsource/urbanist/800.css';
import '../style.css';
import '../quiet-office.css';
import '../workspace.css';
import '../sign-in.css';
import './web.css';

const convex = new ConvexReactClient((import.meta.env.VITE_CONVEX_URL as string | undefined) || hosted.convexUrl);
const callback = () => `${window.location.origin}/callback`;
const rgb = (color: number[]) => `rgb(${color.map(value => Math.round(value * 255)).join(',')})`;

/** Paths in the web office: `/` is the sky, `/project/<id>` is one project's office. */
export function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { const sync = () => setPath(window.location.pathname); window.addEventListener('popstate', sync); return () => window.removeEventListener('popstate', sync); }, []);
  const go = (next: string) => { if (next !== window.location.pathname) window.history.pushState(null, '', next); setPath(next); };
  return { path, go };
}

/**
 * opencloud on the web. People sign in with Auth0; Convex holds their projects, and agents run
 * in each project's cloud sandbox on the person's own Anthropic key.
 */
export default function WebApp() {
  return <Auth0Provider
    domain={hosted.auth0.domain}
    clientId={hosted.auth0.clientId}
    cacheLocation="localstorage"
    useRefreshTokens={false}
    // Keep a sign-in in progress in a cookie, not this tab's sessionStorage, so it survives GitHub
    // or Google opening in their own app and coming back in another tab. /callback and the share
    // pages use the same setting.
    useCookiesForTransactions
    authorizationParams={{ redirect_uri: callback(), scope: 'openid profile email' }}
    onRedirectCallback={appState => {
      const next = typeof appState?.returnTo === 'string' && appState.returnTo.startsWith('/') && !appState.returnTo.startsWith('//') ? appState.returnTo : '/';
      window.history.replaceState(null, '', next);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }}
  >
    <ConvexProviderWithAuth0 client={convex}><Gate /></ConvexProviderWithAuth0>
  </Auth0Provider>;
}

function Gate() {
  const { isLoading, isAuthenticated, error, loginWithRedirect } = useAuth0();
  // Development builds can look around as the unsigned test user, who sees only unsigned projects.
  const [guest, setGuest] = useState(() => import.meta.env.DEV && sessionStorage.getItem('opencloud-guest') === '1');
  const route = useRoute();
  if (isLoading) return <main className="loading"><LoaderCircle className="spin" size={20} /></main>;
  if (isAuthenticated || guest) return route.path.startsWith('/join/')
    ? <JoinLink token={decodeURIComponent(route.path.slice('/join/'.length))} go={route.go} />
    : route.path.startsWith('/project/')
    ? <WebProject id={decodeURIComponent(route.path.slice('/project/'.length))} go={route.go} />
    : <WebSky go={route.go} />;
  const palette = paletteAt(localHour());
  return <main className="sign-in" style={{ background: `linear-gradient(${rgb(palette.zenith)}, ${rgb(palette.horizon)})` }}>
    <section className="sign-in-card" aria-labelledby="sign-in-title">
      <span className="brand-mark">oc</span>
      <h1 id="sign-in-title">Sign in to opencloud</h1>
      <button className="primary full" onClick={() => void loginWithRedirect({ appState: { returnTo: window.location.pathname }, authorizationParams: { redirect_uri: callback() } })}>Sign in</button>
      {error && <p className="sign-in-error" role="alert">{error.message}</p>}
      {import.meta.env.DEV && <button className="text-button" onClick={() => { sessionStorage.setItem('opencloud-guest', '1'); setGuest(true); }}>Continue as the test user (development only)</button>}
    </section>
  </main>;
}
