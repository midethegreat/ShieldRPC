/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        donazo: {
          // Emerald palette from the reference mockup
          50: '#f1faf5',
          100: '#dff3e7',
          200: '#bfe7d0',
          300: '#90d4ac',
          400: '#5dbb82',
          500: '#3ba464',
          600: '#28864e',
          700: '#1f6b40',
          800: '#195535',
          900: '#14462c',
          950: '#0b2819',
        },
        surface: {
          page: '#f4f7f5',
          card: '#ffffff',
          sidebar: '#ffffff',
          muted: '#f8faf9',
          border: '#e6ece9',
        },
      },
      fontFamily: {
        sans: [
          "'Inter'",
          "'SF Pro Display'",
          "'Segoe UI'",
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 83 52 / 0.04), 0 8px 24px -12px rgb(15 83 52 / 0.08)',
        pop: '0 12px 36px -16px rgb(40 134 78 / 0.35)',
      },
      borderRadius: {
        xl2: '1.25rem',
        xl3: '1.5rem',
      },
    },
  },
  plugins: [],
};
