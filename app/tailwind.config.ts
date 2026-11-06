import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // TIMON signal palette (warm)
        salmon: {
          DEFAULT: 'hsl(var(--salmon))',
          2: 'hsl(var(--salmon-2))',
          3: 'hsl(var(--salmon-3))',
          soft: 'hsl(var(--salmon-soft))',
        },
        // Raw elevation scale (see globals.css). Use it only when no
        // semantic token fits — otherwise prefer card / muted / popover /
        // secondary, which already point at it.
        surface: {
          0: 'hsl(var(--surface-0))',
          1: 'hsl(var(--surface-1))',
          2: 'hsl(var(--surface-2))',
          3: 'hsl(var(--surface-3))',
          4: 'hsl(var(--surface-4))',
        },
        // The frame (topbar + rail), borderless: its own colour is its edge.
        chrome: 'hsl(var(--chrome))',
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        info: 'hsl(var(--info))',
      },
      boxShadow: {
        'elev-1': 'var(--shadow-1)',
        'elev-2': 'var(--shadow-2)',
        'elev-3': 'var(--shadow-3)',
      },
      borderRadius: {
        // Scale from the theme without a fixed offset: Graphite's zero
        // must remain square for containers, controls and directional corners.
        DEFAULT: 'calc(var(--radius) * 0.4)',
        sm: 'calc(var(--radius) * 0.6)',
        md: 'calc(var(--radius) * 0.8)',
        lg: 'var(--radius)',
        xl: 'min(16px, calc(var(--radius) * 1.2))',
        '2xl': 'min(16px, calc(var(--radius) * 1.4))',
        '3xl': 'min(16px, calc(var(--radius) * 1.4))',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'var(--font-cjk)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        'dotted-dark':
          'radial-gradient(circle at 1px 1px, rgba(255,255,255,.03) 1px, transparent 0)',
        'dotted-light':
          'radial-gradient(circle at 1px 1px, rgba(0,0,0,.06) 1px, transparent 0)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        // Indeterminate progress: a segment sweeping the track. The duration
        // of a handover is unknowable (it depends on a summary produced by a
        // CLI), so nothing honest can fill a bar from 0 to 100 %.
        'progress-sweep': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'progress-sweep': 'progress-sweep 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [animate],
};

export default config;
