import type { Agent } from './types';

/** A Cursor or Claude Code session that reports in over MCP: the office observes it but cannot drive or stop it. */
export const selfReported = (a?: Pick<Agent, 'provider'> | null) => a?.provider === 'cursor' || a?.provider === 'claude-code';
/** The tool a self-reported session runs in, for "managed in …" copy. */
export const reporterName = (a?: Pick<Agent, 'provider'> | null) => a?.provider === 'claude-code' ? 'Claude Code' : 'Cursor';
