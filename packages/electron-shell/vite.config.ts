import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  root: path.join(__dirname, "src/renderer"),
  base: "./",
  build: {
    outDir: path.join(__dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(__dirname, "src/renderer/index.html"),
    },
  },
  resolve: {
    alias: {
      "@acorn/shared": path.join(__dirname, "../shared/src/index.ts"),
    },
  },
});
