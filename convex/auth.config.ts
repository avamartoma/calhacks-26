import type { AuthConfig } from "convex/server";

declare const process: { env: Record<string, string | undefined> };

/**
 * Verifies Auth0 ID tokens. `applicationID` is the Auth0 client id because that is the
 * token audience. A call with no token stays the offline local user.
 */
function auth0Provider(): AuthConfig["providers"] {
  const rawDomain = process.env.AUTH0_DOMAIN?.trim();
  const applicationID = process.env.AUTH0_CLIENT_ID?.trim();
  if (!rawDomain || !applicationID) return [];
  const domain = (rawDomain.startsWith("https://") ? rawDomain : `https://${rawDomain}`).replace(/\/$/, "");
  return [{ domain, applicationID }];
}

export default {
  providers: auth0Provider(),
} satisfies AuthConfig;
