import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node18",
  platform: "node",
  // ioredis is an optional dependency, lazily imported only by the hosted MCP server's Redis
  // store. Keep it external so the bundle (and plain CLI installs) don't require it.
  external: ["ioredis"],
  // Don't wipe dist/ — the compiled native binaries live in dist/bin/ and would be
  // deleted by a clean. tsup overwrites index.js/index.js.map each build anyway.
  clean: false,
  splitting: false,
  sourcemap: true,
  dts: false,
  // The bin entrypoint needs a shebang so it runs directly.
  banner: { js: "#!/usr/bin/env node" },
});
