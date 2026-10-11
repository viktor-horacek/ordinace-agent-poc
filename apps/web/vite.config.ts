import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // /api/* z prohlížeče přepošle na Fastify, takže není potřeba CORS
    proxy: { '/api': 'http://localhost:3000' },
  },
})
