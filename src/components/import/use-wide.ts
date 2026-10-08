"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * True when the element is at least `minWidth` pixels wide. The review list is a table when there is room for it
 * and stacked cards when there is not. It measures the list itself rather than the screen, because the sidebar
 * takes a quarter of a laptop screen. Only one of table and cards is ever in the page.
 */
export function useWideContainer(minWidth: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWide(el.clientWidth >= minWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [minWidth]);
  return { ref, wide };
}
