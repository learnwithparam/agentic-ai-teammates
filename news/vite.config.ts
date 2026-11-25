import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// GitHub Pages serves the site from a folder named after the repo, so every path is relative.
export default defineConfig({ base: "./", plugins: [react(), tailwindcss()] });
