import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api/databricks': {
          target: env.VITE_DATABRICKS_HOST,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/databricks/, ''),
        },
      },
    },
  }
})
