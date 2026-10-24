import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// An agent identity is the durable subject a run is attributed to. The office issues
// the token once; only its hash is stored. Auth0 replaces issue/verify later without
// changing `credentialSub`, which is the field every attributed report is keyed on.
const PREFIX = 'iteration1_agent_';
const digest = token => createHash('sha256').update(String(token)).digest();
export const agentToken = z.string().trim().min(PREFIX.length + 16).max(200);
const blankRecord = () => ({ started: 0, review: 0, blocked: 0, verified: 0 });

export function initIdentities(state) {
  state.identities ||= [];
  for (const identity of state.identities) identity.record ||= blankRecord();
  return state.identities;
}

export function issueAgentIdentity(state, body) {
  const { label, provider } = z.object({ label: z.string().trim().min(1).max(60), provider: z.enum(['cursor']).default('cursor') }).strict().parse(body);
  const identities = initIdentities(state);
  if (identities.length >= 50) throw new Error('Identity limit reached. Revoke an unused agent identity first.');
  const token = PREFIX + randomBytes(32).toString('base64url');
  const identity = { sub: `${provider}|${randomUUID()}`, label, provider, hash: digest(token).toString('hex'), createdAt: Date.now(), record: blankRecord() };
  identities.push(identity);
  return { token, identity };
}

export function verifyAgentToken(state, token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  const presented = digest(token);
  for (const identity of initIdentities(state)) {
    const stored = Buffer.from(identity.hash, 'hex');
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) return identity;
  }
  return null;
}

export function revokeIdentity(state, sub) {
  const identities = initIdentities(state);
  const index = identities.findIndex(i => i.sub === sub);
  if (index < 0) throw new Error('Unknown agent identity.');
  return identities.splice(index, 1)[0];
}

export function identityBySub(state, sub) { return sub ? initIdentities(state).find(i => i.sub === sub) || null : null; }

/** Safe to broadcast: the token hash never leaves the server. */
export function publicIdentity({ hash, ...identity }) { return identity; }

/** Display name, title and colour persist across sessions so a profile accrues a history. */
export function claimDisplay(identity, worker) {
  if (!identity) return worker;
  if (identity.name && identity.title) { worker.name = identity.name; worker.title = identity.title; worker.color = identity.color || worker.color; }
  return worker;
}

export function rememberDisplay(identity, worker) {
  if (!identity || identity.name) return;
  identity.name = worker.name; identity.title = worker.title; identity.color = worker.color;
}

export function creditRun(identity, outcome) {
  if (!identity) return;
  identity.record ||= blankRecord();
  if (identity.record[outcome] !== undefined) identity.record[outcome] += 1;
  identity.lastRunAt = Date.now();
}
