import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/platform',
  cacheDir: '../../node_modules/.vite-desktop',
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: '../../dist-native', emptyOutDir: true },
});
