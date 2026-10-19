import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing'

// See https://wxt.dev/guide/essentials/unit-testing.html
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
