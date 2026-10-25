// The email someone gets when a project is shared with them.

declare const process: { env: Record<string, string | undefined> };

const SITE = () => (process.env.SITE_URL ?? "https://calhacks-26.vercel.app").replace(/\/$/, "");
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function inviteMessage(input: { inviter: string; project: string; projectId: string; email: string; role: "viewer" | "editor" }) {
  const link = `${SITE()}/project/${input.projectId}`;
  const can = input.role === "editor" ? "view it and start agents on it" : "view it and watch its agents";
  const subject = `${input.inviter} shared "${input.project}" with you on opencloud`;
  const text = `${input.inviter} shared the project "${input.project}" with you on opencloud. You can ${can}.\n\nOpen it: ${link}\n\nSign in with this email address (${input.email}) to see it. It'll also be on your sky from now on.`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#24304a;max-width:520px">
<p><b>${escape(input.inviter)}</b> shared the project <b>${escape(input.project)}</b> with you on opencloud. You can ${can}.</p>
<p><a href="${link}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#26324a;color:#fff;text-decoration:none;font-weight:600">Open ${escape(input.project)}</a></p>
<p style="color:#5b6680;font-size:13px">Sign in with this email address (${escape(input.email)}) to see it. It'll also be on your sky from now on.</p>
</div>`;
  return { subject, text, html, link };
}
