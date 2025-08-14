import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        extensionBackground: "src/extensionBackground.js",
        extensionContent: "src/extensionContent.js",
      },
      output: {
        // ensure our entry files aren’t hashed so manifest.json matches
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
        manualChunks: undefined,
      },
    },
    target: ["es2022", "chrome88"],
    modulePreload: false,
  },
  define: {
    global: "globalThis",
  },
  worker: {
    format: "es",
  },
  plugins: [react()],
});
