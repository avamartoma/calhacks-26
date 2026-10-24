// An agent identity is the durable subject a run is attributed to. It is the Auth0
// account that signed in: `sub` comes from a verified ID token, never from the caller,
// so a published run is attributable rather than merely asserted.
const blankRecord = () => ({ started: 0, review: 0, blocked: 0, verified: 0 });

export function initIdentities(state) {
  state.identities ||= [];
  for (const identity of state.identities) identity.record ||= blankRecord();
  return state.identities;
}

/** Record the signed-in account, preserving the desk name and history it already earned. */
export function upsertIdentity(state, profile) {
  if (!profile?.sub) return null;
  const identities = initIdentities(state);
  const existing = identities.find(i => i.sub === profile.sub);
  if (existing) {
    existing.label = profile.name || existing.label;
    existing.email = profile.email || existing.email;
    existing.picture = profile.picture || existing.picture;
    existing.lastSeenAt = Date.now();
    return existing;
  }
  const identity = { sub: profile.sub, label: profile.name || profile.email || profile.sub, email: profile.email || '', picture: profile.picture || '', provider: 'auth0', createdAt: Date.now(), lastSeenAt: Date.now(), record: blankRecord() };
  identities.push(identity);
  return identity;
}

export function identityBySub(state, sub) { return sub ? initIdentities(state).find(i => i.sub === sub) || null : null; }

export function publicIdentity(identity) { return identity || null; }

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
