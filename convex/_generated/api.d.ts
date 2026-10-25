/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as agentRunner from "../agentRunner.js";
import type * as agentRuns from "../agentRuns.js";
import type * as agentTokens from "../agentTokens.js";
import type * as contributions from "../contributions.js";
import type * as crons from "../crons.js";
import type * as events from "../events.js";
import type * as fetchAgents from "../fetchAgents.js";
import type * as fileChanges from "../fileChanges.js";
import type * as github from "../github.js";
import type * as handoffs from "../handoffs.js";
import type * as http from "../http.js";
import type * as identity from "../identity.js";
import type * as inviteEmail from "../inviteEmail.js";
import type * as keyStore from "../keyStore.js";
import type * as keys from "../keys.js";
import type * as leases from "../leases.js";
import type * as lib_claudeCode from "../lib/claudeCode.js";
import type * as lib_keyCrypto from "../lib/keyCrypto.js";
import type * as lib_numstat from "../lib/numstat.js";
import type * as lib_previewCommand from "../lib/previewCommand.js";
import type * as lib_previewShot from "../lib/previewShot.js";
import type * as lib_runStream from "../lib/runStream.js";
import type * as lib_sandbox from "../lib/sandbox.js";
import type * as lib_workspacePath from "../lib/workspacePath.js";
import type * as loginRunner from "../loginRunner.js";
import type * as logins from "../logins.js";
import type * as projects from "../projects.js";
import type * as runChanges from "../runChanges.js";
import type * as runChangesStore from "../runChangesStore.js";
import type * as sessionSandbox from "../sessionSandbox.js";
import type * as workspaces from "../workspaces.js";
import type * as sessions from "../sessions.js";
import type * as sharing from "../sharing.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  agentRunner: typeof agentRunner;
  agentRuns: typeof agentRuns;
  agentTokens: typeof agentTokens;
  contributions: typeof contributions;
  crons: typeof crons;
  events: typeof events;
  fetchAgents: typeof fetchAgents;
  fileChanges: typeof fileChanges;
  github: typeof github;
  handoffs: typeof handoffs;
  http: typeof http;
  identity: typeof identity;
  inviteEmail: typeof inviteEmail;
  keyStore: typeof keyStore;
  keys: typeof keys;
  leases: typeof leases;
  "lib/claudeCode": typeof lib_claudeCode;
  "lib/keyCrypto": typeof lib_keyCrypto;
  "lib/numstat": typeof lib_numstat;
  "lib/previewCommand": typeof lib_previewCommand;
  "lib/previewShot": typeof lib_previewShot;
  "lib/runStream": typeof lib_runStream;
  "lib/sandbox": typeof lib_sandbox;
  "lib/workspacePath": typeof lib_workspacePath;
  loginRunner: typeof loginRunner;
  logins: typeof logins;
  projects: typeof projects;
  runChanges: typeof runChanges;
  runChangesStore: typeof runChangesStore;
  sessionSandbox: typeof sessionSandbox;
  workspaces: typeof workspaces;
  sessions: typeof sessions;
  sharing: typeof sharing;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
