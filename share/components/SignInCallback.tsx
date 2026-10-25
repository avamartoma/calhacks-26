"use client";

import { Auth0Provider } from "@auth0/auth0-react";
import { useEffect, useState } from "react";
import { auth0Settings, callbackPath } from "@/components/ProjectScreen";

/** Finishes an Auth0 sign-in, then opens the page it started from. The session is kept in localStorage for that page. */
export function SignInCallback() {
  const { domain, clientId } = auth0Settings();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const message = <main className="share-app"><p className="banner">Signing you in…</p></main>;
  if (!mounted || !domain || !clientId) return message;
  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      cacheLocation="localstorage"
      useRefreshTokens={false}
      authorizationParams={{ scope: "openid profile email", redirect_uri: `${window.location.origin}${callbackPath}` }}
      onRedirectCallback={(appState) => {
        const next = typeof appState?.returnTo === "string" && appState.returnTo.startsWith("/") && !appState.returnTo.startsWith("//") ? appState.returnTo : "/";
        window.location.replace(next);
      }}
    >
      {message}
    </Auth0Provider>
  );
}
