/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#0A0B0D', 900: '#0F1013', 850: '#15161A', 800: '#1A1B20', 700: '#24262C', 600: '#33363E', 500: '#4A4E58', 400: '#6B707C', 300: '#8D929E', 200: '#B9BDC6', 50: '#F4F5F7' },
        signal: '#C8FF4D',
        cost: '#FF7A52',
        warn: '#FFC24D',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
