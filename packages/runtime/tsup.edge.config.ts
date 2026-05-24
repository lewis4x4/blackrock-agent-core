import { defineConfig } from "tsup";

// Self-contained ESM bundle for Deno-based Supabase Edge Functions.
//
// Deno's bundler cannot resolve `npm:@blackrock-ai/*` (no auth to GitHub
// Packages) or bare `@supabase/supabase-js` (not on the Deno graph), so we
// inline every dependency into a single file.
//
// The installer copies this file next to the generated
// `supabase/functions/agent/index.ts` and imports it via a relative path
// (see `cli/install.sh` step 8).
export default defineConfig({
  entry: { edge: "src/index.ts" },
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: false,
  noExternal: [/.*/],
  target: "es2022",
  platform: "neutral",
});
