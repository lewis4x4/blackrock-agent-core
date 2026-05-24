import { defineConfig } from "tsup";

// Standard ESM entry for Node/Bun consumers (Supabase CLI scripts, verify-*
// scripts, tests, etc). Externalizes every dependency — consumers resolve them
// from their own node_modules.
//
// The Deno-targeted self-contained bundle is produced separately by
// `tsup.edge.config.ts`; the npm `build` script runs both in sequence.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
});
