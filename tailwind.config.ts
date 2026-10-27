import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        'background-light': 'var(--workspace-bg-950)',
        'background-dark': '#070b10',
        workspace: {
          shell: 'var(--workspace-bg-950)',
          content: 'var(--workspace-content-bg)',
          nav: {
            DEFAULT: 'var(--workspace-nav-foreground)',
            active: 'var(--workspace-nav-active-text)',
          },
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
        'workspace-desktop-wallpaper': 'linear-gradient(180deg, var(--workspace-bg-950) 0%, var(--workspace-bg-900) 42%, var(--workspace-bg-850) 100%)',
        'workspace-desktop-overlay': 'radial-gradient(circle at top left, var(--workspace-accent-muted), transparent 24%), radial-gradient(circle at bottom right, var(--workspace-surface-900), transparent 36%), linear-gradient(135deg, var(--workspace-surface-panel), transparent 45%)',
        'workspace-mobile-wallpaper': 'radial-gradient(circle at center, var(--workspace-bg-850) 0%, var(--workspace-bg-950) 68%), radial-gradient(circle at top right, var(--workspace-accent-muted), transparent 28%), radial-gradient(circle at bottom left, var(--workspace-accent-soft), transparent 32%)',
      },
    },
  },
  plugins: [],
}

export default config
