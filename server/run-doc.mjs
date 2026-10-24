import { z } from 'zod';
import { uid } from './domain.mjs';
import { completionGaps } from './orchestration.mjs';
import { identifyEvidence, isTestCommand } from './evidence.mjs';

// A run doc is a projection, not a second copy of the work. Blocks borrow the receipt
// ids `identifyEvidence` already assigns, so a comment anchored to a block stays
// anchored as evidence is trimmed, and every block carries how far its claim is trusted.
export const commentFields = z.object({ blockId: z.string().trim().min(1).max(100), author: z.string().trim().min(1).max(60), text: z.string().trim().min(1).max(4000) }).strict();

export function attributionOf(receipt, item) {
  if (receipt.source === 'user-recovery') return 'operator';
  if (['cursor-reported', 'claude-reported', 'codex-reported'].includes(receipt.source)) return 'self-reported';
  if (receipt.source !== 'observed-command') return 'office-recorded';
  if (receipt.kind !== 'test') return 'observed';
  const current = receipt.passed === true && receipt.stableWorkspace === true && receipt.cwdVerified === true && !!item.reviewState?.version && receipt.workspaceVersion === item.reviewState.version;
  return current ? 'verified' : 'observed';
}

function brief(item) {
  return { id: `${item.id}:brief`, kind: 'brief', text: item.description, criteria: item.acceptanceCriteria || [], time: item.createdAt };
}

function outcome(item, gaps) {
  if (!['review', 'blocked', 'done'].includes(item.status)) return null;
  const text = item.status === 'blocked' ? item.blocker || 'Run stopped before completion.' : item.status === 'done' ? 'Accepted after review.' : 'Execution reported finished. Awaiting verification.';
  return { id: `${item.id}:outcome`, kind: 'outcome', status: item.status, text, gaps, time: item.updatedAt };
}

export function runDoc(room, item) {
  identifyEvidence(room);
  const owner = room.agents.find(a => a.id === item.agentId);
  const gaps = completionGaps(room, item);
  const blocks = [brief(item),
    ...item.evidence.map(receipt => ({ id: receipt.id, kind: receipt.kind, text: receipt.text, attribution: attributionOf(receipt, item), source: receipt.source || 'office-recorded', time: receipt.time,
      ...(receipt.command ? { command: receipt.command, passed: receipt.passed === true, isCheck: isTestCommand(receipt.command) } : {}) })),
    outcome(item, gaps)].filter(Boolean);
  return {
    id: item.id, roomId: room.id, title: item.title, status: item.status, archived: !!item.archived, previewUrl: item.previewUrl, updatedAt: item.updatedAt,
    agent: owner ? { id: owner.id, name: owner.name, title: owner.title, provider: owner.provider || 'codex', model: owner.effectiveModel || owner.model, modelSource: owner.modelSource || 'office-selected', credentialSub: owner.credentialSub || null } : null,
    verification: { verified: item.status === 'done' && !gaps.length, label: item.reviewState?.label || (room.demo ? 'Simulated office' : 'No checks recorded'), gaps },
    blocks, comments: item.comments || []
  };
}

export function addComment(room, item, body) {
  const input = commentFields.parse(body);
  const doc = runDoc(room, item);
  if (!doc.blocks.some(block => block.id === input.blockId)) throw new Error('That block is no longer part of this run. Reload the run doc and comment again.');
  item.comments ||= [];
  if (item.comments.length >= 200) throw new Error('Comment limit reached for this run.');
  const comment = { id: uid(), ...input, time: Date.now() };
  item.comments.push(comment);
  return comment;
}

/** Reverse-chronological runs across live offices: the feed's server-side shape. */
export function runFeed(state, { limit = 30 } = {}) {
  return state.rooms.filter(room => !room.demo)
    .flatMap(room => room.workItems.filter(item => !item.archived).map(item => ({ room, item })))
    .sort((a, b) => b.item.updatedAt - a.item.updatedAt).slice(0, limit)
    .map(({ room, item }) => { const { blocks, comments, ...entry } = runDoc(room, item); return { ...entry, office: room.name, blockCount: blocks.length, commentCount: comments.length }; });
}
