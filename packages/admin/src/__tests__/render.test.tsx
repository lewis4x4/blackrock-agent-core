import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { Settings } from "../pages/Settings";

describe("Settings page", () => {
  it("renders read-only sections", () => {
    const html = renderToString(<Settings />);
    expect(html.includes("Default rate limits")).toBe(true);
  });
});
