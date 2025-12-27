export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
      },
      colors: {
        brand: {
          navy: '#0F172A',
          indigo: '#6366f1',
          slate: '#94a3b8'
        }
      }
    },
  },
}