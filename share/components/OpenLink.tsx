"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** The slug from a pasted share link (…/p/<slug>) or a bare slug. */
export function slugFrom(value: string): string {
  const text = value.trim();
  const fromLink = text.match(/\/p\/([^/?#\s]+)/);
  const slug = fromLink ? decodeURIComponent(fromLink[1]) : text;
  return /^[a-z0-9][a-z0-9-]{0,120}$/i.test(slug) ? slug : "";
}

export function OpenLink() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="open-link"
      onSubmit={(event) => {
        event.preventDefault();
        const slug = slugFrom(value);
        if (!slug) {
          setError("Paste the share link you were sent, like https://…/p/my-project-ab12cd.");
          return;
        }
        router.push(`/p/${encodeURIComponent(slug)}`);
      }}
    >
      <label htmlFor="share-link">Share link</label>
      <div>
        <input
          id="share-link"
          value={value}
          placeholder="Paste a share link"
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
          }}
        />
        <button type="submit" className="primary" disabled={!value.trim()}>Open</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
