import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0a0a0a",
        card: "rgba(255,255,255,0.05)",
        // Brand-themable via CSS variables (defaults in globals.css :root,
        // per-client overrides injected by the root layout from brand env).
        "accent-red": "var(--accent-red)",
        silver: "var(--silver)",
        "silver-light": "var(--silver-light)",
        "text-primary": "#f5f5f5",
        "text-secondary": "#9ca3af",
      },
      backdropBlur: {
        xs: "2px",
      },
      borderRadius: {
        glass: "16px",
      },
    },
  },
  plugins: [],
};

export default config;
