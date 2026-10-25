import { useEffect, useRef, useState } from 'react';
import type { OfficeIdentity } from './types';
import './account-badge.css';

const initials = (name: string) => name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?';

/** The signed-in account in the top right corner: the profile picture, or initials without one. Opens a menu to sign out. */
export function AccountBadge({ account, onSignOut }: { account: OfficeIdentity; onSignOut?: () => void }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => setBroken(false), [account.picture]);
  const picture = account.picture && !broken;
  return <div className="account-badge" ref={root} onPointerDown={event => event.stopPropagation()}>
    <button className="account-avatar" aria-label={`Signed in as ${account.label}`} title={account.email || account.label} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {picture ? <img src={account.picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : initials(account.label)}
    </button>
    {open && <div className="account-menu" role="menu">
      <b>{account.label}</b>
      {account.email && account.email !== account.label && <small>{account.email}</small>}
      <button role="menuitem" onClick={() => onSignOut ? onSignOut() : void fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })}>Sign out</button>
    </div>}
  </div>;
}
