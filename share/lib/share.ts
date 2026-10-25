export type PreviewStatus = "starting" | "live" | "error";

export type ShareInfo = {
  projectId: string;
  name: string;
  visibility: string;
  shareSlug: string;
  role: string;
  previewUrl: string | null;
  previewStatus: PreviewStatus | null;
  snapshotUrl: string | null;
};

export type SessionSnapshot = {
  previewUrl: string | null;
  previewStatus: PreviewStatus | null;
  snapshotUrl: string | null;
  status: string;
};

export type ProjectEvent = {
  id: string;
  kind: string;
  detail: string;
  at: number | null;
};

export type ShareMember = {
  email: string;
  role: string;
};

function previewStatus(value: unknown): PreviewStatus | null {
  if (value === "starting" || value === "live" || value === "error") return value;
  return null;
}

export function asShareInfo(value: unknown): ShareInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.projectId !== "string" || !record.projectId) return null;
  return {
    projectId: record.projectId,
    name: typeof record.name === "string" ? record.name : "Project",
    visibility: typeof record.visibility === "string" ? record.visibility : "private",
    shareSlug: typeof record.shareSlug === "string" ? record.shareSlug : "",
    role: typeof record.role === "string" ? record.role : "",
    previewUrl: typeof record.previewUrl === "string" ? record.previewUrl : null,
    previewStatus: previewStatus(record.previewStatus),
    snapshotUrl: typeof record.snapshotUrl === "string" ? record.snapshotUrl : null,
  };
}

export function asSession(value: unknown): SessionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    previewUrl: typeof record.previewUrl === "string" ? record.previewUrl : null,
    previewStatus: previewStatus(record.previewStatus),
    snapshotUrl: typeof record.snapshotUrl === "string" ? record.snapshotUrl : null,
    status: typeof record.status === "string" ? record.status : "",
  };
}

export function asEvents(value: unknown): ProjectEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "event";
    const detail = typeof record.detail === "string" ? record.detail : "";
    const at = typeof record._creationTime === "number" ? record._creationTime : null;
    const id = typeof record._id === "string" ? record._id : `${kind}:${at ?? index}:${detail}`;
    return [{ id, kind, detail, at }];
  });
}

export function asMembers(value: unknown): ShareMember[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { members?: unknown }).members)
      ? (value as { members: unknown[] }).members
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const email = typeof record.email === "string" ? record.email : "";
    const role = typeof record.role === "string" ? record.role : "";
    if (!email) return [];
    return [{ email, role }];
  });
}

export function canManageShare(role: string, _signedIn = false): boolean {
  // The unsigned office user is the owner of local projects, so editor/owner
  // is enough. A public visitor only gets viewer and does not see this.
  return role === "editor" || role === "owner";
}
