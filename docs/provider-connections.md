# Browser account connections

Iteration1 can create its own provider credentials through the browser. The person using the app does not need to copy credentials from a local Codex, Claude Code, or Cursor installation. The machine running Iteration1 still needs the provider runtimes used to execute agents.

## Try the connections

Build the app and start its production server. The default address is `http://127.0.0.1:4314`.

For Codex, open **Connections → Codex** and click **Sign in with ChatGPT** and finish the ChatGPT login. When the browser and server run on the same machine, the callback can complete automatically. When they run on different machines, copy the full localhost callback URL from the address bar, paste it into **Callback URL**, and click **Complete sign-in**. A browser connection error on that localhost page is expected in the latter case.

For Claude, open **Connections → Claude**. Click **Sign in with Claude**, authorize on Claude's website, and paste the displayed authorization code including `#state`, or the complete callback URL. Click **Complete sign-in**. The **Launch Claude from the office** section then uses that profile. An explicitly configured `ANTHROPIC_API_KEY` takes precedence over the browser profile.

For Cursor, open **Connections → Cursor** and click **Sign in with Cursor**. Finish signing in on Cursor's website. Iteration1 updates automatically after the SDK creates a dedicated API key named **Iteration1**. An explicitly configured `CURSOR_API_KEY` takes precedence over the saved browser login.

To check execution, create a live project pointing to a disposable repository. Ask an agent to list its files and summarize the project without editing anything. An account connection alone does not verify that a model or sandbox can execute a task.

Refresh the page to check that the connection persists. Test **Cancel sign-in** before authorizing a new attempt, then start another attempt. A callback from a cancelled, expired, or replaced attempt must be rejected. **Disconnect … from Iteration1** removes the app's saved credentials. Stop active agents before changing their account.

## Storage and refresh

Codex keeps the grant in its existing app profile, `~/.iteration1/codex`, or `OFFICE_CODEX_HOME`. A pasted callback is validated against the current attempt and relayed only to the callback address supplied by the native Codex process. That process exchanges the code and owns token refresh.

Claude keeps its grant in `.credentials.json` inside `~/.iteration1/claude`, or `OFFICE_CLAUDE_HOME`. The Claude runtime reads and refreshes that native profile in place. Iteration1 does not maintain or refresh a second copy of the tokens. Changing the account is blocked while Claude agents are running.

Cursor's SDK exchanges the browser login for a dedicated, expiring API key. Iteration1 saves that key under `OFFICE_DATA_DIR/provider-auth/cursor.json`, or `OFFICE_CURSOR_AUTH_FILE`. The SDK's broader login tokens are not saved by Iteration1. Reconnect when the app key expires. Disconnecting removes the saved key locally. Revoke it in Cursor's dashboard to invalidate it at the provider.

New credential files use owner-only permissions and atomic replacement. Provider API responses contain connection metadata and login links, not access tokens, refresh tokens, API keys, or PKCE verifiers. Callback input is kept only in memory and sent in the completion request body.

## Deployment boundary

This remains a single-operator app. Auth0 identity does not partition provider credentials, project access, or execution. Each separately hosted operator needs an isolated instance and provider profiles. The execution API retains its existing loopback binding and host/origin checks. Account linking alone does not turn the server into a public, multi-user service.

These connections authorize future work. They do not import conversation history or attach to an already running CLI session. Existing Cursor and Claude Code sessions can still report through MCP.

The callback-paste interaction was informed by [OmniRoute's provider connection UI](https://github.com/cheaper-inference/OmniRoute/blob/edab7c3a59bf7d6f040d581dbda3a46adbee0d57/src/shared/components/OAuthModal.tsx). Cursor uses its [documented SDK browser login](https://prod.cursor.com/docs/sdk/typescript#cursor-auth).
