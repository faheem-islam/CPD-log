"use client";

import { useEffect, useState } from "react";

export type LogLayout = "both" | "table" | "cards";

/**
 * Which list to draw. The server and the first browser pass draw both (CSS shows the right one, so
 * nothing jumps), then only the one that fits the window is kept, which halves the page for a long log.
 * 1280px is Tailwind's xl, where the table takes over from the cards.
 */
export function useLogLayout(): LogLayout {
  const [layout, setLayout] = useState<LogLayout>("both");
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const apply = () => setLayout(query.matches ? "table" : "cards");
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return layout;
}
