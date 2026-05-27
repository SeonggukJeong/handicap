import type { Config } from "tailwindcss";

// Offline-runtime constraint: do not add font family overrides that reference
// remote URLs (e.g. Google Fonts). Bundle locally via @fontsource/* if needed.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
