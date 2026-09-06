import { defineConfig } from 'vite';

// Plain static frontend — no framework build step required. Vite is used
// purely as a fast dev server (with live reload) and an optional production
// bundler/minifier via `npm run build`.
export default defineConfig({
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
  },
});
