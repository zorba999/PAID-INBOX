import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174, // the Sphere wallet takes 5173 when run locally
    strictPort: false,
  },
  preview: { port: 5174 },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
