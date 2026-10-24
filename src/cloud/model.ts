// The shared data model for cloud workspaces. The placeholder data in seed.json follows these
// types exactly, so the UI, the workspace and permission backend, and search can all build
// against it now and swap in real data later without changing shape.
//
// Work runs locally: each person's own agent (Codex, Claude or Cursor, on their own account)
// works on their own computer, and the results are uploaded to the workspace. The cloud stores
// and shares projects; it does not run agents.

/** What one person may do with one project, lowest to highest. */
export type AccessLevel =
  | 'none'          // Not shown anywhere: not on the canvas, not in search, share links refuse.
  | 'viewer'        // Name, description and agents.
  | 'commenter'     // Viewer, plus comments.
  | 'collaborator'  // Commenter, plus running agents and uploading work. Both switches are always on.
  | 'owner';        // Everything, plus sharing and transferring ownership.

export const accessLevels: AccessLevel[] = ['none', 'viewer', 'commenter', 'collaborator', 'owner'];
const rank = (level: AccessLevel) => accessLevels.indexOf(level);

/**
 * A level plus two switches. Viewers and commenters get code and agent copying only when they
 * are switched on; collaborators and owners always have both.
 */
export interface Access {
  level: AccessLevel;
  /** See the project's code and history. */
  code: boolean;
  /** Copy the project's agents into your own projects. */
  copyAgents: boolean;
}

/** Applies the fixed rules: nothing for none, everything for collaborators and owners. */
export function normalize(access: Access): Access {
  if (access.level === 'none') return { level: 'none', code: false, copyAgents: false };
  if (rank(access.level) >= rank('collaborator')) return { level: access.level, code: true, copyAgents: true };
  return access;
}

/** Everything both allow: the higher level, with each switch on if either has it on. */
export function combine(a: Access, b: Access): Access {
  return normalize({ level: rank(a.level) >= rank(b.level) ? a.level : b.level, code: a.code || b.code, copyAgents: a.copyAgents || b.copyAgents });
}

export interface User { id: string; name: string; email: string; color: string }

export type WorkspaceRole = 'admin' | 'member';
export interface Workspace {
  id: string;
  name: string;
  /** company: invite or company email only. public: anyone can join. */
  kind: 'company' | 'public';
  joinPolicy: 'invite' | 'email-domain' | 'open';
  emailDomain?: string;
  description: string;
  members: { userId: string; role: WorkspaceRole }[];
}

export type Engine = 'codex' | 'claude' | 'cursor';

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  ownerId: string;
  /** Active projects sit in front on your home view; archived ones step back. */
  status: 'active' | 'archived';
  /** Like "anyone in this workspace can …" in Google Docs. Grants below can add to it for one person. */
  generalAccess: Access;
  grants: ({ userId: string } & Access)[];
  /** The share link is /p/<shareSlug>. It opens the project only for people with access. */
  shareSlug: string;
  repo: { url: string; branch: string } | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus = 'working' | 'idle' | 'waiting' | 'done' | 'error';

/**
 * An agent definition. Copying an agent copies these fields (name, role, instructions,
 * skills, tools, engine, model) and never its history or the project's code.
 */
export interface Agent {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  role: string;
  instructions: string;
  skills: string[];
  tools: string[];
  engine: Engine;
  model: string;
  status: AgentStatus;
  /** A sentence on what it is doing now; shown on the project document. */
  summary: string;
  copiedFromAgentId?: string;
  updatedAt: string;
}

/** History: uploaded work. Visible with the code switch on. */
export interface Activity {
  id: string;
  projectId: string;
  agentId: string | null;
  userId: string;
  kind: 'upload' | 'run' | 'commit' | 'handoff';
  text: string;
  files?: string[];
  time: string;
}

export interface Comment { id: string; projectId: string; userId: string; text: string; time: string }

export interface CloudData {
  /** The signed-in user for placeholder data. */
  currentUserId: string;
  users: User[];
  workspaces: Workspace[];
  projects: Project[];
  agents: Agent[];
  activity: Activity[];
  comments: Comment[];
}

/**
 * The access a user has to a project. The backend must make this decision and filter what it
 * sends; the UI uses the same rule with placeholder data. Workspaces never mix: a non-member
 * gets nothing, whatever the project says.
 */
export function accessFor(data: CloudData, project: Project, userId: string): Access {
  const workspace = data.workspaces.find(w => w.id === project.workspaceId);
  if (!workspace?.members.some(m => m.userId === userId)) return normalize({ level: 'none', code: false, copyAgents: false });
  if (project.ownerId === userId) return normalize({ level: 'owner', code: true, copyAgents: true });
  const general = normalize(project.generalAccess);
  const grant = project.grants.find(g => g.userId === userId);
  return grant ? combine(general, { level: grant.level, code: grant.code, copyAgents: grant.copyAgents }) : general;
}

export const can = {
  see: (a: Access) => rank(a.level) >= rank('viewer'),
  comment: (a: Access) => rank(a.level) >= rank('commenter'),
  seeCode: (a: Access) => a.code,
  copyAgents: (a: Access) => a.copyAgents,
  work: (a: Access) => rank(a.level) >= rank('collaborator'),
  manage: (a: Access) => a.level === 'owner'
};
