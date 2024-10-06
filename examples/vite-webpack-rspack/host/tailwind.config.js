/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    '../remote/src/**/*.{js,jsx,ts,tsx}',
    '../dynamic-remote/src/**/*.{js,jsx,ts,tsx}',
    '../rspack/src/**/*.{js,jsx,ts,tsx}',
    '../webpack/src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
