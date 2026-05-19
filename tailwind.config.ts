import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#137fec',
        'background-light': '#f6f6f8',
        'background-dark': '#101922',
        workspace: {
          shell: '#101922',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px',
      },
      fontFamily: {
        display: ['Inter', 'sans-serif'],
      },
      backgroundImage: {
        'workspace-desktop-wallpaper': 'linear-gradient(180deg,#dbeafe 0%,#bfdbfe 40%,#93c5fd 100%)',
        'workspace-desktop-overlay': 'radial-gradient(circle_at_top_left,rgba(255,255,255,0.55),transparent_22%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.3),transparent_28%),linear-gradient(135deg,rgba(255,255,255,0.15),transparent_42%)',
        'workspace-mobile-wallpaper': 'radial-gradient(circle_at_center,rgba(26,42,58,0.92)_0%,rgba(16,25,34,0.98)_68%),radial-gradient(circle_at_top_right,rgba(19,127,236,0.18),transparent_26%),radial-gradient(circle_at_bottom_left,rgba(70,160,245,0.12),transparent_30%)',
      },
    },
  },
  plugins: [],
}

export default config
