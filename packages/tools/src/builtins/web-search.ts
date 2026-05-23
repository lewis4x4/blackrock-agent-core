import type { Tool } from "../registry";

/**
 * Cross-runtime env reader. Supabase Edge Functions run on Deno; verify scripts
 * and local tests run on Bun/Node. Same shape as runtime/src/context.ts so the
 * two stay in sync.
 */
function readEnv(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  return g.Deno?.env.get(name) ?? g.process?.env?.[name];
}

interface WebSearchInput {
  query: string;
  count?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchOutput {
  query: string;
  results: SearchResult[];
}

const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;

/**
 * Built-in: Brave Search-backed web search. Reads the API key from
 * BRAVE_API_KEY (falls back to SEARCH_API_KEY for tenants that have the
 * key under that name). Returns the top N web results with title/url/snippet.
 *
 * The key is taken from the Edge Function env, not from tenant_credentials,
 * because v1 ships a single shared search-provider key for the project. If a
 * tenant ever needs their own search key, route it through tenant_credentials
 * with provider='search' and read it here instead.
 */
export const webSearch: Tool = {
  key: "web_search",
  description:
    "Search the public web. Input: { query: string, count?: number }. Returns up to `count` results with { title, url, snippet }.",
  async run(rawInput) {
    const input = rawInput as unknown as WebSearchInput;
    const query = String(input?.query ?? "").trim();
    if (!query) throw new Error("web_search requires a non-empty query");

    const requested = Number.isFinite(input?.count) ? Number(input.count) : DEFAULT_COUNT;
    const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(requested)));

    const apiKey = readEnv("BRAVE_API_KEY") ?? readEnv("SEARCH_API_KEY");
    if (!apiKey) {
      throw new Error(
        "web_search requires BRAVE_API_KEY (or SEARCH_API_KEY) to be set"
      );
    }

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          accept: "application/json",
          "x-subscription-token": apiKey,
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const name = (err as { name?: unknown })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error("web_search: request timed out");
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `web_search: search API returned ${res.status}: ${body.slice(0, 400)}`
      );
    }

    // Brave returns { web: { results: [{ title, url, description }, ...] }, ... }.
    // Treat the payload as `unknown` and narrow defensively — third-party shape.
    const payload: unknown = await res.json();
    const rawResults =
      (payload as { web?: { results?: unknown } })?.web?.results;
    const results: SearchResult[] = Array.isArray(rawResults)
      ? rawResults.slice(0, count).map((row) => {
          const r = row as { title?: unknown; url?: unknown; description?: unknown };
          return {
            title: typeof r.title === "string" ? r.title : "",
            url: typeof r.url === "string" ? r.url : "",
            snippet: typeof r.description === "string" ? r.description : "",
          };
        })
      : [];

    const output: WebSearchOutput = { query, results };
    return output;
  },
};
