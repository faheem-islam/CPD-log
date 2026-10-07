import type { Config } from "tailwindcss";

const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        ink: token("ink"),
        muted: token("muted"),
        sign: token("sign"),
        "sign-ink": token("sign-ink"),
        link: token("link"),
        route: token("route"),
        "on-route": token("on-route"),
        amber: token("amber"),
        "amber-ink": token("amber-ink"),
        danger: token("danger"),
        "on-danger": token("on-danger"),
        focus: token("focus"),
      },
      fontFamily: {
        sans: ["Barlow", "ui-sans-serif", "sans-serif"],
        display: ["Barlow Condensed", "Barlow", "ui-sans-serif", "sans-serif"],
      },
      fontSize: {
        xs: ["0.8125rem", { lineHeight: "1.25rem" }],
        sm: ["0.9375rem", { lineHeight: "1.4rem" }],
        base: ["1.0625rem", { lineHeight: "1.65rem" }],
        lg: ["1.25rem", { lineHeight: "1.75rem" }],
        xl: ["1.5rem", { lineHeight: "1.9rem" }],
        "2xl": ["2rem", { lineHeight: "2.25rem" }],
        "3xl": ["2.75rem", { lineHeight: "2.9rem" }],
        "4xl": ["3.75rem", { lineHeight: "3.75rem" }],
      },
      borderRadius: { plate: "1.25rem" },
      minHeight: { tap: "2.75rem" },
      minWidth: { tap: "2.75rem" },
      maxWidth: { page: "72rem" },
    },
  },
  plugins: [],
};

export default config;
