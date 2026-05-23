import { test, expect, describe, mock, afterEach } from "bun:test";

process.env.BRAVE_API_KEY = "test-key";

import { webSearch } from "../web-search";

const ctx = { tenantId: "00000000-0000-0000-0000-000000000001" };

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
interface WebSearchOutput {
  query: string;
  results: SearchResult[];
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.BRAVE_API_KEY = "test-key";
  delete process.env.SEARCH_API_KEY;
});

describe("web_search", () => {
  test("throws when query is empty", async () => {
    await expect(webSearch.run({ query: "" }, ctx)).rejects.toThrow();
    await expect(webSearch.run({ query: "   " }, ctx)).rejects.toThrow();
  });

  test("throws when neither BRAVE_API_KEY nor SEARCH_API_KEY is set", async () => {
    const savedBrave = process.env.BRAVE_API_KEY;
    const savedSearch = process.env.SEARCH_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.SEARCH_API_KEY;
    try {
      await expect(webSearch.run({ query: "hello" }, ctx)).rejects.toThrow();
    } finally {
      if (savedBrave !== undefined) process.env.BRAVE_API_KEY = savedBrave;
      if (savedSearch !== undefined) process.env.SEARCH_API_KEY = savedSearch;
    }
  });

  test("parses a well-formed Brave response", async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Example",
                url: "https://example.com",
                description: "A snippet",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = (await webSearch.run(
      { query: "hello world" },
      ctx
    )) as WebSearchOutput;
    expect(out.results.length).toBe(1);
    const first = out.results[0]!;
    expect(first.title).toBe("Example");
    expect(first.url).toBe("https://example.com");
    expect(first.snippet).toBe("A snippet");
  });

  test("caps count at 20", async () => {
    const fetchMock = mock(async (_url: URL | string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await webSearch.run({ query: "q", count: 999 }, ctx);

    const callUrl = fetchMock.mock.calls[0]![0] as URL | string;
    expect(callUrl.toString()).toContain("count=20");
  });

  test("handles missing/malformed payload gracefully", async () => {
    const fetchMock = mock(async () => {
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = (await webSearch.run(
      { query: "anything" },
      ctx
    )) as WebSearchOutput;
    expect(out.results).toEqual([]);
  });

  test("surfaces non-OK responses", async () => {
    const fetchMock = mock(async () => {
      return new Response("boom", { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(webSearch.run({ query: "x" }, ctx)).rejects.toThrow(/500/);
  });
});
