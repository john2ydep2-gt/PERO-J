import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_COMMIT_SHA": JSON.stringify(
      process.env.VITE_COMMIT_SHA || "local",
    ),
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(
      process.env.VITE_APP_VERSION || "dev",
    ),
  },
  server: {
    proxy: { "/api": process.env.VITE_API_PROXY || "http://localhost:3001" },
  },
});
