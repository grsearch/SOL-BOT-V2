/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0d12',
        panel: '#13161e',
        panel2: '#1a1d27',
        border: '#262936',
        text: '#e6e8ee',
        muted: '#8c93a8',
        accent: '#7c5cff',
        green: '#22c55e',
        red: '#ef4444',
        yellow: '#eab308',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
