// Loopback stays the only host for a normal office. A sandbox preview is
// reached through an E2B hostname, and that exception exists only inside a
// sandbox that was launched with E2B_SANDBOX=1.
export function officeHostMiddleware({ port, sandbox }) {
  return (req, res, next) => {
    const allowed = officeHostAllowed({ host: req.headers.host, origin: req.headers.origin, port, sandbox });
    if (!allowed.ok) return res.status(403).json({ error: allowed.error });
    next();
  };
}

export function officeHostAllowed({ host, origin, port, sandbox }) {
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const e2b = sandbox === '1' && isE2bHost(host);
  if (typeof host !== 'string' || (!localHosts.includes(host) && !e2b)) {
    return { ok: false, error: 'Local access only' };
  }
  if (typeof origin === 'string' && origin.length > 0) {
    const localOrigin = localHosts.some(item => origin === `http://${item}`);
    const sandboxOrigin = e2b && origin === `https://${host}`;
    if (!localOrigin && !sandboxOrigin) return { ok: false, error: 'Origin not allowed' };
  }
  return { ok: true };
}

function isE2bHost(host) {
  if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host)) return false;
  const name = host.toLowerCase();
  if (!name.endsWith('.e2b.app') || name.includes('..')) return false;
  const labels = name.slice(0, -'.e2b.app'.length).split('.');
  return labels.length > 0 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
