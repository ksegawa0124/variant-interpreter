/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages ではリポジトリ名配下で配信されるため、CI から BASE_PATH を渡す
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  // レポートに記録するアプリ版（再現性のため）。CI では GITHUB_SHA でコミットを特定する
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? 'unknown'),
    __APP_COMMIT__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'local'),
  },
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
