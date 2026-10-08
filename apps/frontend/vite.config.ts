import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { output: { manualChunks(id) {
    if (id.includes('/node_modules/@azure/')) return 'authentication';
    if (id.includes('/node_modules/@mui/') || id.includes('/node_modules/@emotion/')) return 'ui';
  } } } },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: {
    '/api': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000',
  } },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
