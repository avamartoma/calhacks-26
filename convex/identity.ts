import type { UserIdentity } from "convex/server";

/** Used when no Auth0 JWT is presented. The office keeps working with Convex unreachable or signed out. */
export const LOCAL_USER_ID = "local";

export type OfficeUser = {
  id: string;
  email: string | null;
  local: boolean;
};

type AuthCtx = {
  auth: {
    getUserIdentity: () => Promise<UserIdentity | null>;
  };
};

export function userFromIdentity(identity: UserIdentity | null): OfficeUser {
  const subject = identity?.subject?.trim();
  if (!subject) return { id: LOCAL_USER_ID, email: null, local: true };
  const email = typeof identity?.email === "string" ? identity.email.trim().toLowerCase() : "";
  return { id: subject, email: email.includes("@") ? email : null, local: false };
}

export async function currentUser(ctx: AuthCtx): Promise<OfficeUser> {
  return userFromIdentity(await ctx.auth.getUserIdentity());
}
