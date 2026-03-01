import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        bitcoin: "#f7931a",
        accent: "#f7931a",
        bg: {
          primary: "#0a0a0a",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
