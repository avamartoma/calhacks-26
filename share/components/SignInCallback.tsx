"use client";

import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { useEffect, useState } from "react";
import { auth0Settings, callbackPath } from "@/components/ProjectScreen";

/**
 * Finishes an Auth0 sign-in, then opens the page it started from. The session is kept in
 * localStorage for that page; the sign-in in progress is in a cookie (useCookiesForTransactions,
 * as on the pages that start it), so it survives a provider's app opening the login elsewhere.
 * If it can't finish, this says why instead of quietly going back to the sign-in screen.
 */
export function SignInCallback() {
  const { domain, clientId } = auth0Settings();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const message = <main className="share-app"><p className="banner">Signing you in…</p></main>;
  if (!mounted || !domain || !clientId) return message;
  // Auth0 sends errors back as ?error=…&error_description=… (a refused account, say).
  const query = new URLSearchParams(window.location.search);
  if (query.get("error")) return <Failed reason={query.get("error_description") || query.get("error") || ""} />;
  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      cacheLocation="localstorage"
      useRefreshTokens={false}
      useCookiesForTransactions
      authorizationParams={{ scope: "openid profile email", redirect_uri: `${window.location.origin}${callbackPath}` }}
      onRedirectCallback={(appState) => {
        const next = typeof appState?.returnTo === "string" && appState.returnTo.startsWith("/") && !appState.returnTo.startsWith("//") ? appState.returnTo : "/";
        window.location.replace(next);
      }}
    >
      <Waiting />
    </Auth0Provider>
  );
}

function Waiting() {
  const { error } = useAuth0();
  if (error) return <Failed reason={error.message} />;
  return <main className="share-app"><p className="banner">Signing you in…</p></main>;
}

function Failed({ reason }: { reason: string }) {
  const lost = /invalid state|state/i.test(reason);
  return (
    <main className="share-app">
      <p className="banner">
        Sign-in didn&apos;t finish: {reason || "the sign-in service didn't say why"}.
        {lost ? " Your browser lost track of the sign-in, which happens when it opens in another app or tab. Try again, and stay in this browser." : ""}
      </p>
      <p className="banner"><a href="/">Try signing in again</a></p>
    </main>
  );
}
