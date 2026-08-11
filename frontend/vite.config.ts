import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174, // the Sphere wallet takes 5173 when run locally
    strictPort: false,
    /* On Vercel the API is served from /api on the same origin, so the dApp
     * needs no base URL at all. Proxying here gives dev the same shape, which
     * keeps VITE_API_BASE out of the picture and removes the CORS hop. */
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  preview: { port: 5174 },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
