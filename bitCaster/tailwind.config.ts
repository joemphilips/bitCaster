import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bitcoin: "#f7931a",
      },
    },
  },
  plugins: [],
} satisfies Config;
