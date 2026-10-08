import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node18",
  platform: "node",
  // Optional deps, lazily required at runtime: ioredis (hosted MCP server's Redis store) and
  // @napi-rs/keyring (OS keychain credential storage). Keep them external so the bundle — and
  // plain CLI installs on platforms without a keychain — never hard-require them.
  external: ["ioredis", "@napi-rs/keyring"],
  // Don't wipe dist/ — the compiled native binaries live in dist/bin/ and would be
  // deleted by a clean. tsup overwrites index.js/index.js.map each build anyway.
  clean: false,
  splitting: false,
  sourcemap: true,
  dts: false,
  // The bin entrypoint needs a shebang so it runs directly.
  banner: { js: "#!/usr/bin/env node" },
});
