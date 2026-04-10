import { defineConfig } from 'vite';

export default {
  server: {
    host: true,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    }
  }
}
