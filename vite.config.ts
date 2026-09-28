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
      entry: {
        "workflow-editor": path.resolve(__dirname, "frontend/workflow/index.tsx"),
        "synthesis-workspace": path.resolve(__dirname, "frontend/synthesis/index.tsx")
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`
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
