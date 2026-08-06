import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // The scope vocabulary, shared with the API rather than copied. The file
      // it points at is a leaf with no imports, so nothing server-side follows
      // it into the browser bundle.
      '@shared': path.resolve(__dirname, './server/src/shared'),
    },
  },
})
