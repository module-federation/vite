import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    open: false,
    port: 4175,
  },
  preview: {
    port: 4175,
  },
});
