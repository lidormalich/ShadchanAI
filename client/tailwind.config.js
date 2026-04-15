/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#f7f7f8',
          subtle: '#fafafb',
          card: '#ffffff',
          hover: '#f2f2f4',
        },
        border: {
          DEFAULT: '#e5e7eb',
          strong: '#d4d4d8',
        },
        ink: {
          DEFAULT: '#18181b',
          muted: '#52525b',
          subtle: '#71717a',
          faint: '#a1a1aa',
        },
        brand: {
          DEFAULT: '#4f46e5',
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
        success: '#16a34a',
        warning: '#d97706',
        danger: '#dc2626',
        info: '#0284c7',
      },
      fontFamily: {
        sans: ['Inter', 'Assistant', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.02)',
        rise: '0 8px 24px rgba(0,0,0,0.08)',
      },
    },
  },
  plugins: [],
};
