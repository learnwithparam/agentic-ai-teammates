import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One build, one entry per page. Each app serves dist/client/<page>/index.html, and they share
// dist/client/assets, so a component used by two pages is downloaded once.
const PAGES = ["mission-control"];
const pages = path.resolve(import.meta.dirname, "src/client/pages");

export default defineConfig({
  root: pages,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src/client") } },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/client"),
    emptyOutDir: true,
    // assistant-ui is one 540 kB file. Cutting it smaller broke the order its modules start in
    // (a TypeError on load), so the warning sits just above it. Every other file stays far below.
    chunkSizeWarningLimit: 560,
    rolldownOptions: {
      input: Object.fromEntries(PAGES.map((page) => [page, path.join(pages, page, "index.html")])),
      // The big libraries each get their own file, so a page downloads them once and caches them.
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "charts", test: /node_modules[\\/](recharts|d3-[a-z]+|victory-vendor|es-toolkit|immer|@reduxjs|reselect|redux)/ },
            { name: "chat", test: /node_modules[\\/](@assistant-ui|assistant-stream)/ },
            { name: "markdown", test: /node_modules[\\/](react-markdown|remark-|micromark|mdast-|hast-|unified|vfile|property-information|unist-)/ },
            { name: "ui", test: /node_modules[\\/](radix-ui|@radix-ui|lucide-react|zod)/ },
          ],
        },
      },
    },
  },
});
