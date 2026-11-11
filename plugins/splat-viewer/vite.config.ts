import { defineConfig } from "vite";

export default defineConfig({
  // Kago serves the plugin under a folder of its own whose name it makes up, so every file is found relative to the page.
  base: "./",
  build: {
    // Nothing older could run the viewer, and the frame can load nothing but these files.
    target: "es2022",
    chunkSizeWarningLimit: 4096
  }
});
