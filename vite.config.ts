/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages ではリポジトリ名配下で配信されるため、CI から BASE_PATH を渡す
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
