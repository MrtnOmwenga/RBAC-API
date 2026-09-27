import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :3000; everything that isn't the web app goes there.
const API = ['/demo', '/documents', '/sections', '/members', '/audit-events', '/me', '/health'];

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      ...Object.fromEntries(API.map((path) => [path, 'http://localhost:3000'])),
      '/collab': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
