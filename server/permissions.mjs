import { z } from 'zod';

export const permissionMode = z.enum(['project-write', 'read-only']);
export function permissionsFor(room, agent) {
  const canWrite = !!agent.manager && room.permissionMode !== 'read-only';
  return {
    sandbox: canWrite ? 'workspace-write' : 'read-only',
    approvalPolicy: room.permissionMode === 'read-only' ? 'never' : 'on-request',
    canWrite,
  };
}
export function permissionKey(room, agent) {
  const policy = permissionsFor(room, agent);
  return `${policy.sandbox}:${policy.approvalPolicy}`;
}
