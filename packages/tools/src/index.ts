import { httpRequest } from "./builtins/http-request";
import { webSearch } from "./builtins/web-search";
import { docGenerate } from "./builtins/doc-generate";
import { dataQuery } from "./builtins/data-query";
import { hubspotQuery } from "./builtins/hubspot-query";
import { m365Mail } from "./builtins/m365-mail";

export { ToolRegistry } from "./registry";
export type { Tool, ToolContext } from "./registry";

export { httpRequest } from "./builtins/http-request";
export { webSearch } from "./builtins/web-search";
export { docGenerate } from "./builtins/doc-generate";
export { dataQuery } from "./builtins/data-query";
export { hubspotQuery } from "./builtins/hubspot-query";
export { m365Mail } from "./builtins/m365-mail";

/**
 * Tools registered by default. SPRINT 4 adds hubspot_query and m365_mail —
 * OAuth-backed connected tools that read tokens from `tenant_connections`.
 * A tenant must still be opted in via the `tenant_tools` table AND have a
 * row in `tenant_connections` for the relevant provider; registering a tool
 * here does NOT grant access.
 */
export const builtins = [
  httpRequest,
  webSearch,
  docGenerate,
  dataQuery,
  hubspotQuery,
  m365Mail,
];
