import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

// Offline-runtime constraint: do not add font family overrides that reference
// remote URLs (e.g. Google Fonts). Bundle locally via @fontsource/* if needed.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // 시맨틱 디자인 토큰 (ADR-0043). accent = 앱 액센트(indigo). neutral(slate)·
      // semantic(amber/red/green)은 Tailwind 기본을 직접 사용(별칭 불필요).
      colors: { accent: colors.indigo },
    },
  },
  plugins: [],
} satisfies Config;
