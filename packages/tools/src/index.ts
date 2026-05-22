import { httpRequest } from "./builtins/http-request";

export { ToolRegistry } from "./registry";
export type { Tool, ToolContext } from "./registry";
export { httpRequest } from "./builtins/http-request";

/** Tools registered by default. SPRINT 1 expands this catalogue. */
export const builtins = [httpRequest];
