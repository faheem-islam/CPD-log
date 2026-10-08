"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Choice = "system" | "light" | "dark";

const OPTIONS: Array<{ value: Choice; label: string; Icon: typeof Sun }> = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** Same storage key and same attribute as the theme button in the page frame, so the two always agree. */
const KEY = "cpd-theme";

function readStored(): Choice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function readApplied(): Choice {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" || v === "dark" ? v : "system";
}

function apply(choice: Choice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage can be blocked. The theme still applies for this visit.
  }
}

/** Colour theme: System, Light or Dark. It applies at once and is remembered on this device. It is not part of "Save settings". */
export function Appearance() {
  const [choice, setChoice] = useState<Choice>("system");

  useEffect(() => {
    setChoice(readStored());
    // The theme button in the page frame changes the same attribute. Follow it so this group never shows a stale choice.
    const watcher = new MutationObserver(() => setChoice(readApplied()));
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watcher.disconnect();
  }, []);

  return (
    <fieldset className="min-w-0">
      <legend className="label">Colour theme</legend>
      <div className="flex flex-col gap-2 sm:flex-row">
        {OPTIONS.map(({ value, label, Icon }) => (
          <label
            key={value}
            className="flex min-h-tap min-w-0 cursor-pointer items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 has-[:checked]:bg-sign has-[:checked]:text-sign-ink sm:flex-1"
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={choice === value}
              onChange={() => {
                setChoice(value);
                apply(value);
              }}
              className="h-5 w-5 shrink-0 cursor-pointer accent-[rgb(var(--amber))]"
            />
            <Icon aria-hidden="true" size={20} className="shrink-0" />
            <span className="min-w-0 font-bold">{label}</span>
          </label>
        ))}
      </div>
      <p className="hint mt-2">System follows your device's light or dark setting. Your choice applies straight away and is remembered on this device.</p>
    </fieldset>
  );
}
