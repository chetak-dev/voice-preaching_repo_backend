/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        brand: ['Cinzel', 'Georgia', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa',
          500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95',
        },
      },
      backgroundImage: {
        voice: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 45%, #db2777 100%)',
        'voice-soft': 'linear-gradient(135deg, #eef2ff 0%, #f5f3ff 50%, #fdf2f8 100%)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
        pop: '0 10px 30px -10px rgba(15, 23, 42, 0.25)',
        glow: '0 8px 24px -6px rgba(124, 58, 237, 0.45)',
        nav: '0 -4px 20px -8px rgba(15, 23, 42, 0.15)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'none' } },
        'sheet-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'none' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'load-bar': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(250%)' } },
        breathe: { '0%, 100%': { transform: 'scale(1)', opacity: 1 }, '50%': { transform: 'scale(0.92)', opacity: 0.85 } },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out', 'sheet-up': 'sheet-up 220ms cubic-bezier(0.2, 0, 0, 1)',
        shimmer: 'shimmer 1.4s infinite', 'load-bar': 'load-bar 1.2s ease-in-out infinite', breathe: 'breathe 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
