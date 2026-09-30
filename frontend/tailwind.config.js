/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      },
      colors: {
        paper: '#F7F6F3',
        pine: {
          50: '#EFF6F1',
          100: '#DCEBE2',
          200: '#B9D6C6',
          600: '#227356',
          700: '#1B5E43',
          800: '#164E38',
          900: '#123F2E'
        },
        clay: {
          600: '#C2610A',
          700: '#B45309'
        },
        signal: '#DC2626',
        hairline: '#E7E5E0'
      },
      boxShadow: {
        soft: '0 1px 2px rgba(28,25,23,0.05), 0 4px 16px rgba(28,25,23,0.06)',
        lift: '0 2px 6px rgba(28,25,23,0.08), 0 10px 28px rgba(28,25,23,0.10)'
      }
    }
  },
  plugins: []
};
