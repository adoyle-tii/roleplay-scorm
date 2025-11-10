import { defineConfig } from "vite";

export default defineConfig({
  base: "./",                    // good for SCORM zips
  build: {
    cssCodeSplit: false,         // single CSS file
    rollupOptions: {
      input: "index.html",
      output: {
        manualChunks: undefined,             // disables code-splitting
        entryFileNames: "assets/index.js",   // fixed JS name
        chunkFileNames: "assets/[name].js",  // harmless (no chunks created)
        assetFileNames: "assets/[name][extname]" // fixed CSS => assets/index.css
      }
    }
  }
});
