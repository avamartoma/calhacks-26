"use client";

import { useEffect, useState } from "react";
import type { ShareMember } from "@/lib/share";

export function ShareControls({
  projectId,
  shareSlug,
  visibility,
  members,
  busy,
  notice,
  onVisibility,
  onInvite,
  onRemove,
}: {
  projectId: string;
  shareSlug: string;
  visibility: string;
  members: ShareMember[];
  busy: boolean;
  notice: string;
  onVisibility: (visibility: "private" | "public") => void;
  onInvite: (email: string, role: "viewer" | "editor") => void;
  onRemove: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLink(shareSlug ? `${window.location.origin}/p/${shareSlug}` : "");
  }, [shareSlug]);

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="owner-share" aria-label="Share settings">
      <h2>Share</h2>
      <div className="share-row">
        <span>Visibility</span>
        <button type="button" className={visibility === "private" ? "on" : ""} disabled={busy} aria-pressed={visibility === "private"} onClick={() => onVisibility("private")}>Private</button>
        <button type="button" className={visibility === "public" ? "on" : ""} disabled={busy} aria-pressed={visibility === "public"} onClick={() => onVisibility("public")}>Public</button>
      </div>
      {shareSlug ? <p className="slug-line">Slug <code>{shareSlug}</code></p> : <p>The hosted link appears after the share app is deployed.</p>}
      {link && (
        <div className="share-row">
          <input readOnly value={link} aria-label="Share link" />
          <button type="button" className="primary" onClick={() => void copyLink()}>{copied ? "Copied" : "Copy link"}</button>
        </div>
      )}
      <form
        className="share-row"
        onSubmit={(event) => {
          event.preventDefault();
          const next = email.trim();
          if (!next.includes("@")) return;
          onInvite(next, role);
          setEmail("");
        }}
      >
        <label>
          Email
          <input type="email" value={email} required placeholder="name@example.com" onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(event) => setRole(event.target.value === "editor" ? "editor" : "viewer")}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
          </select>
        </label>
        <button type="submit" className="primary" disabled={busy || !projectId}>Invite</button>
      </form>
      <ul className="member-list">
        {members.map((member) => (
          <li key={member.email}>
            <span>{member.email}</span>
            <span>{member.role || "member"}</span>
            <button type="button" disabled={busy} onClick={() => onRemove(member.email)}>Remove</button>
          </li>
        ))}
        {!members.length && <li className="empty">No invites yet.</li>}
      </ul>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
