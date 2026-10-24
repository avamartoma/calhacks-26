import { serveOfficeMcp } from '../server/office-mcp.mjs';

// Claude Code reports in over MCP and runs on its own Claude sign-in, so no API key is needed.
await serveOfficeMcp('claude-code');
