import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// https://vitejs.dev/config/
export default defineConfig({
  // Relative paths so JS/CSS load under Tauri's asset protocol (not /assets/...)
  base: "./",
  plugins: [svelte()],
  resolve: {
    // Svelte 5 default export is server-side; force browser entry for Tauri SPA.
    conditions: ["browser", "import", "module", "default"],
  },
  // Prevent vite from obscuring Rust errors
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
