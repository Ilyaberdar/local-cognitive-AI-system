import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production")
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "frontend/workflow/index.tsx"),
      formats: ["es"],
      fileName: () => "workflow-editor.js"
    },
    outDir: path.resolve(__dirname, "public/assets"),
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith(".css") ? "workflow-editor.css" : "[name][extname]"
      }
    }
  }
});
