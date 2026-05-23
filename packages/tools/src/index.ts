import { httpRequest } from "./builtins/http-request";
import { webSearch } from "./builtins/web-search";
import { docGenerate } from "./builtins/doc-generate";
import { dataQuery } from "./builtins/data-query";

export { ToolRegistry } from "./registry";
export type { Tool, ToolContext } from "./registry";

export { httpRequest } from "./builtins/http-request";
export { webSearch } from "./builtins/web-search";
export { docGenerate } from "./builtins/doc-generate";
export { dataQuery } from "./builtins/data-query";

/**
 * Tools registered by default. SPRINT 2 expands the catalog with web_search,
 * doc_generate, and data_query. A tenant must still be opted in via the
 * `tenant_tools` table — registering a tool here does NOT grant access.
 */
export const builtins = [httpRequest, webSearch, docGenerate, dataQuery];
