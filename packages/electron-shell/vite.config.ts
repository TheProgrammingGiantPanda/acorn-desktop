import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  root: path.join(__dirname, "src/renderer"),
  base: "./",
  build: {
    outDir: path.join(__dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index:           path.join(__dirname, "src/renderer/index.html"),
        window:          path.join(__dirname, "src/renderer/window.html"),
        iconbar:         path.join(__dirname, "src/renderer/iconbar.html"),
        programsBrowser: path.join(__dirname, "src/renderer/programs-browser.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@theprogramminggiantpanda/shared": path.join(__dirname, "../shared/src/index.ts"),
    },
  },
});
