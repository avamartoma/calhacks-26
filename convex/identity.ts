import type { UserIdentity } from "convex/server";

/** Used when no Auth0 JWT is presented. The office keeps working with Convex unreachable or signed out. */
export const LOCAL_USER_ID = "local";

export type OfficeUser = {
  id: string;
  email: string | null;
  name: string | null;
  local: boolean;
};

type AuthCtx = {
  auth: {
    getUserIdentity: () => Promise<UserIdentity | null>;
  };
};

export function userFromIdentity(identity: UserIdentity | null): OfficeUser {
  const subject = identity?.subject?.trim();
  if (!subject) return { id: LOCAL_USER_ID, email: null, name: null, local: true };
  const email = typeof identity?.email === "string" ? identity.email.trim().toLowerCase() : "";
  const name = typeof identity?.name === "string" && identity.name.trim() ? identity.name.trim() : null;
  return { id: subject, email: email.includes("@") ? email : null, name, local: false };
}

export async function currentUser(ctx: AuthCtx): Promise<OfficeUser> {
  return userFromIdentity(await ctx.auth.getUserIdentity());
}
