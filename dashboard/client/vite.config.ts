import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const dashboardApiOrigin = process.env.DASHBOARD_API_ORIGIN || 'http://localhost:4310'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  server: {
    port: 3000,
    proxy: {
      '/api': dashboardApiOrigin
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        intake: path.resolve(__dirname, 'intake.html')
      }
    }
  }
})
