// The email someone gets when a project is shared with them.

declare const process: { env: Record<string, string | undefined> };

const SITE = () => (process.env.SITE_URL ?? "https://calhacks-26.vercel.app").replace(/\/$/, "");
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * With a `token`, the link is the invite's own one-time link (/join/<token>), which gives the
 * invited role to whichever account opens it. Without one, it opens the project for whoever
 * signs in with the invited address.
 */
export function inviteMessage(input: { inviter: string; project: string; projectId: string; email: string; role: "viewer" | "editor"; token?: string }) {
  const link = input.token ? `${SITE()}/join/${input.token}` : `${SITE()}/project/${input.projectId}`;
  const can = input.role === "editor" ? "view it and start agents on it" : "view it and watch its agents";
  const subject = `${input.inviter} shared "${input.project}" with you on opencloud`;
  const signIn = input.token
    ? "Sign in with any account to accept it. The link works once, for you, and the project stays on your sky after that."
    : `Sign in with this email address (${input.email}) to see it. It'll also be on your sky from now on.`;
  const text = `${input.inviter} shared the project "${input.project}" with you on opencloud. You can ${can}.\n\nOpen it: ${link}\n\n${signIn}`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#24304a;max-width:520px">
<p><b>${escape(input.inviter)}</b> shared the project <b>${escape(input.project)}</b> with you on opencloud. You can ${can}.</p>
<p><a href="${link}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#26324a;color:#fff;text-decoration:none;font-weight:600">Open ${escape(input.project)}</a></p>
<p style="color:#5b6680;font-size:13px">${escape(signIn)}</p>
</div>`;
  return { subject, text, html, link };
}
