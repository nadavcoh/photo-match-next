import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      borderRadius: { DEFAULT: '14px' },
    },
  },
}

export default config
