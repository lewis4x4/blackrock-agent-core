import type { Tool } from "../registry";

/** Built-in: fetch a URL and return status + a bounded text body. */
export const httpRequest: Tool = {
  key: "http_request",
  description:
    "Fetch a URL. Input: { url: string, method?: string }. Returns { status, body }.",
  async run(input) {
    const url = String((input as any).url ?? "");
    const method = String((input as any).method ?? "GET");
    if (!url) throw new Error("http_request requires a url");
    const res = await fetch(url, { method });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 8000) };
  },
};
