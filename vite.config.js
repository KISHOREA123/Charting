import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  build: { rollupOptions: { input: {
    chart: fileURLToPath(new URL('./index.html', import.meta.url)),
    scanner: fileURLToPath(new URL('./scanner.html', import.meta.url)),
    journal: fileURLToPath(new URL('./journal.html', import.meta.url)),
  } } },
  server: { host: '0.0.0.0', port: 3000, strictPort: true },
});
