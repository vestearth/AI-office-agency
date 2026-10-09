import { defineConfig, searchForWorkspaceRoot } from 'vite'
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
    // shared/ holds runtime code too (runCounts), not just types.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), path.resolve(__dirname, '../shared')]
    },
    proxy: {
      '/api': dashboardApiOrigin
    }
  },
})
