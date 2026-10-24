import type { Agent } from './types';

/** A Cursor, Claude Code or Codex CLI session that reports in over MCP: the office observes it but cannot drive or stop it. */
export const selfReported = (a?: Pick<Agent, 'provider'> | null) => a?.provider === 'cursor' || a?.provider === 'claude-code' || a?.provider === 'codex-cli';
/** The tool a self-reported session runs in, for "managed in …" copy. */
export const reporterName = (a?: Pick<Agent, 'provider'> | null) => a?.provider === 'claude-code' ? 'Claude Code' : a?.provider === 'codex-cli' ? 'Codex CLI' : 'Cursor';
/** Who a self-reported receipt came from, or null for evidence the office observed or recorded itself. */
export const receiptReporter = (source?: string) => ({ 'cursor-reported': 'Cursor', 'claude-reported': 'Claude Code', 'codex-reported': 'Codex CLI' } as Record<string, string>)[source || ''] || null;
