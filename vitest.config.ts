import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts", "packages/electron-shell/**"],
    },
  },
  resolve: {
    alias: {
      "@theprogramminggiantpanda/shared":       new URL("packages/shared/src/index.ts",       import.meta.url).pathname,
      "@theprogramminggiantpanda/arm-emulator": new URL("packages/arm-emulator/src/index.ts", import.meta.url).pathname,
      "@theprogramminggiantpanda/risc-os":      new URL("packages/risc-os/src/index.ts",      import.meta.url).pathname,
    },
  },
});
