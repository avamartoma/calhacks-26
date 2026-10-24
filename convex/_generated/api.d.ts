/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as contributions from "../contributions.js";
import type * as crons from "../crons.js";
import type * as events from "../events.js";
import type * as handoffs from "../handoffs.js";
import type * as leases from "../leases.js";
import type * as lib_previewCommand from "../lib/previewCommand.js";
import type * as lib_sandbox from "../lib/sandbox.js";
import type * as lib_workspacePath from "../lib/workspacePath.js";
import type * as projects from "../projects.js";
import type * as sessionSandbox from "../sessionSandbox.js";
import type * as sessions from "../sessions.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  contributions: typeof contributions;
  crons: typeof crons;
  events: typeof events;
  handoffs: typeof handoffs;
  leases: typeof leases;
  "lib/previewCommand": typeof lib_previewCommand;
  "lib/sandbox": typeof lib_sandbox;
  "lib/workspacePath": typeof lib_workspacePath;
  projects: typeof projects;
  sessionSandbox: typeof sessionSandbox;
  sessions: typeof sessions;
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
