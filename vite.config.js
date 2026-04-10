import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    }
  }
});
