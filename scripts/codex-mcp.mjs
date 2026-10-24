import { serveOfficeMcp } from '../server/office-mcp.mjs';

// A Codex CLI session reports in over MCP and runs on its own ChatGPT sign-in, separate from the office's Codex profile.
await serveOfficeMcp('codex-cli');
