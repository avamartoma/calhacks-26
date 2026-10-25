"use client";

import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShareControls } from "@/components/ShareControls";
import { convexBrowser, convexMutation, convexQuery, errorMessage, isJwt, resumeProject, shareApi } from "@/lib/convex";
import {
  asEvents,
  asMembers,
  asSession,
  asShareInfo,
  canManageShare,
  type ProjectEvent,
  type SessionSnapshot,
  type ShareInfo,
  type ShareMember,
} from "@/lib/share";

type AuthHandle = {
  isLoading: boolean;
  isAuthenticated: boolean;
  email?: string;
  getIdToken: () => Promise<string | null>;
  login: () => void;
  logout: () => void;
};

function auth0Domain(value: string | undefined): string {
  return (value ?? "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function ProjectScreen({ slug }: { slug: string }) {
  const domain = auth0Domain(process.env.NEXT_PUBLIC_AUTH0_DOMAIN);
  const clientId = process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID?.trim() ?? "";
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !domain || !clientId) return <ProjectSession slug={slug} auth={null} />;
  const redirectUri = `${window.location.origin}/p/${encodeURIComponent(slug)}`;
  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      cacheLocation="localstorage"
      useRefreshTokens={false}
      authorizationParams={{ scope: "openid profile email", redirect_uri: redirectUri }}
      onRedirectCallback={(appState) => {
        const next = typeof appState?.returnTo === "string" ? appState.returnTo : `/p/${slug}`;
        window.history.replaceState({}, document.title, next);
      }}
    >
      <AuthedSession slug={slug} />
    </Auth0Provider>
  );
}

function AuthedSession({ slug }: { slug: string }) {
  const { isLoading, isAuthenticated, user, loginWithRedirect, logout, getIdTokenClaims, getAccessTokenSilently } = useAuth0();
  const auth = useMemo<AuthHandle>(() => ({
    isLoading,
    isAuthenticated,
    email: user?.email,
    async getIdToken() {
      const claims = await getIdTokenClaims();
      if (isJwt(claims?.__raw)) return claims.__raw;
      try {
        const detailed = await getAccessTokenSilently({ detailedResponse: true });
        if (detailed && isJwt(detailed.id_token)) return detailed.id_token;
      } catch {
        return null;
      }
      return null;
    },
    login() {
      const path = `${window.location.origin}${window.location.pathname}`;
      void loginWithRedirect({
        appState: { returnTo: window.location.pathname },
        authorizationParams: { redirect_uri: path, scope: "openid profile email" },
      });
    },
    logout() {
      void logout({ logoutParams: { returnTo: `${window.location.origin}${window.location.pathname}` } });
    },
  }), [getAccessTokenSilently, getIdTokenClaims, isAuthenticated, isLoading, loginWithRedirect, logout, user?.email]);
  return <ProjectSession slug={slug} auth={auth} />;
}

function ProjectSession({ slug, auth }: { slug: string; auth: AuthHandle | null }) {
  const tokenRef = useRef<string | null>(null);
  const bootRef = useRef<"idle" | "pending" | "open" | "failed">("idle");
  const retryRef = useRef(false);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const [authTick, setAuthTick] = useState(0);

  useEffect(() => {
    const client = convexBrowser();
    let cancelled = false;

    async function openProject() {
      if (tokenRef.current) client.setAuth(tokenRef.current);
      bootRef.current = "pending";
      try {
        const shareValue = asShareInfo(await convexQuery(client, shareApi.sharingGet, { slug }));
        if (tokenRef.current) client.setAuth(tokenRef.current);
        if (!shareValue?.projectId) {
          bootRef.current = "failed";
          if (!cancelled) setError("This link does not match a project.");
          return;
        }
        if (!cancelled) setShare(shareValue);
        const id = await resumeProject(client, shareValue.projectId);
        if (!cancelled) {
          setSessionId(id);
          setError("");
        }
        bootRef.current = "open";
      } catch (err) {
        bootRef.current = "failed";
        if (!cancelled) setError(errorMessage(err));
      }
      if (!cancelled && retryRef.current && tokenRef.current && bootRef.current !== "open") {
        retryRef.current = false;
        await openProject();
      }
    }

    void openProject();
    return () => {
      cancelled = true;
    };
  }, [slug, authTick]);

  useEffect(() => {
    if (!auth || auth.isLoading) return;
    let cancelled = false;
    void (async () => {
      if (!auth.isAuthenticated) {
        tokenRef.current = null;
        if (!cancelled) setSignedIn(false);
        return;
      }
      const token = await auth.getIdToken();
      if (cancelled || !token) return;
      tokenRef.current = token;
      convexBrowser().setAuth(token);
      if (!cancelled) setSignedIn(true);
      if (bootRef.current === "open") return;
      if (bootRef.current === "pending") {
        retryRef.current = true;
        return;
      }
      if (bootRef.current === "failed") setAuthTick((value) => value + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [auth]);

  useEffect(() => {
    if (!sessionId || !share?.projectId) return;
    const client = convexBrowser();
    const projectId = share.projectId;
    let cancelled = false;
    async function poll() {
      try {
        const [sessionValue, eventValue] = await Promise.all([
          convexQuery(client, shareApi.sessionsGet, { sessionId: sessionId! }),
          convexQuery(client, shareApi.eventsByProject, { projectId }),
        ]);
        if (cancelled) return;
        setSession(asSession(sessionValue));
        setEvents(asEvents(eventValue));
        setPollError("");
      } catch (err) {
        if (!cancelled) setPollError(errorMessage(err));
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, share?.projectId]);

  const manage = canManageShare(share?.role ?? "", signedIn);

  useEffect(() => {
    if (!manage || !share?.projectId) return;
    const client = convexBrowser();
    const projectId = share.projectId;
    let cancelled = false;
    void (async () => {
      try {
        const value = await convexQuery(client, shareApi.sharingList, { projectId });
        if (!cancelled) setMembers(asMembers(value));
      } catch (err) {
        if (!cancelled) setNotice(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manage, share?.projectId, listVersion]);

  async function mutate(run: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setNotice("");
    try {
      await run();
      setNotice(ok);
      setListVersion((value) => value + 1);
      const latest = asShareInfo(await convexQuery(convexBrowser(), shareApi.sharingGet, { slug }));
      if (latest) setShare(latest);
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const previewStatus = session ? session.previewStatus : share?.previewStatus;
  const previewUrl = session ? session.previewUrl : share?.previewUrl;
  const snapshotUrl = session?.snapshotUrl || share?.snapshotUrl;
  const live = previewStatus === "live" && !!previewUrl;
  const name = share?.name || "Opening project";

  return (
    <main className="share-app">
      <header className="share-top">
        <div>
          <p className="eyebrow">Iteration1</p>
          <h1>{name}</h1>
        </div>
        <div className="share-auth">
          {share && <span className={`visibility visibility-${share.visibility}`}>{share.visibility}</span>}
          {auth && (signedIn
            ? <button type="button" onClick={auth.logout}>Sign out{auth.email ? ` ${auth.email}` : ""}</button>
            : <button type="button" className="primary" onClick={auth.login} disabled={auth.isLoading}>Sign in</button>)}
        </div>
      </header>
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="share-grid">
        <section className="preview-stage" aria-label="Project preview">
          <header>
            <b>Preview</b>
            <span>{live ? "Live" : session?.status || previewStatus || "Waiting"}</span>
          </header>
          {live && previewUrl
            ? <iframe key={previewUrl} title={`${name} preview`} src={previewUrl} />
            : snapshotUrl
              ? <img src={snapshotUrl} alt="Last snapshot" />
              : <p>The last snapshot shows here until the preview is live.</p>}
        </section>
        <div className="share-side">
        {manage && share && (
          <ShareControls
            projectId={share.projectId}
            shareSlug={share.shareSlug || slug}
            visibility={share.visibility}
            members={members}
            busy={busy}
            notice={notice}
            onVisibility={(visibility) => void mutate(
              () => convexMutation(convexBrowser(), shareApi.sharingSetVisibility, { projectId: share.projectId, visibility }),
              `Visibility is ${visibility}.`,
            )}
            onInvite={(email, role) => void mutate(
              () => convexMutation(convexBrowser(), shareApi.sharingInvite, { projectId: share.projectId, email, role }),
              `Invited ${email} as ${role}.`,
            )}
            onRemove={(email) => void mutate(
              () => convexMutation(convexBrowser(), shareApi.sharingRemove, { projectId: share.projectId, email }),
              `Removed ${email}.`,
            )}
          />
        )}
        <section className="activity-feed" aria-label="Activity">
          <h2>Activity</h2>
          {pollError && <p className="quiet">{pollError}</p>}
          <ul>
            {events.map((event) => (
              <li key={event.id}>
                <b>{event.kind}</b>
                <span>{event.detail}</span>
                {event.at && <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
              </li>
            ))}
            {!events.length && <li className="empty">File changes, commands, and who is connected show up here.</li>}
          </ul>
        </section>
        </div>
      </div>
    </main>
  );
}
