"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Choice = "system" | "light" | "dark";
const ORDER: Choice[] = ["system", "light", "dark"];
const LABEL: Record<Choice, string> = { system: "the system setting", light: "light", dark: "dark" };

function read(): Choice {
  try {
    const v = localStorage.getItem("cpd-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(choice: Choice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem("cpd-theme");
    else localStorage.setItem("cpd-theme", choice);
  } catch {
    // Storage can be blocked. The theme still applies for this visit.
  }
}

/** Cycles system, light, dark. Follows the system setting until the user picks one. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [choice, setChoice] = useState<Choice>("system");
  useEffect(() => setChoice(read()), []);
  const Icon = choice === "system" ? Monitor : choice === "light" ? Sun : Moon;
  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? "system";
  return (
    <button
      type="button"
      className={`btn btn-quiet !px-0 ${className}`}
      onClick={() => {
        setChoice(next);
        apply(next);
      }}
      aria-label={`Colour theme: ${LABEL[choice]}. Switch to ${LABEL[next]}.`}
      title={`Theme: ${LABEL[choice]}`}
    >
      <Icon aria-hidden="true" size={22} />
    </button>
  );
}
