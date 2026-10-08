/** The Help sections in reading order. The contents list and the page both use this, so they cannot drift apart. */
export const HELP_SECTIONS = [
  { id: "accuracy", title: "How accurate is this?" },
  { id: "copy-to-ice", title: "Copying entries into ICE's tool" },
  { id: "istructe", title: "IStructE (provisional)" },
  { id: "paste-link", title: "What happens when you paste a link" },
  { id: "keyboard", title: "Keyboard and accessibility" },
  { id: "getting-help", title: "Getting help" },
] as const;

export type HelpSectionId = (typeof HELP_SECTIONS)[number]["id"];

export function helpTitle(id: HelpSectionId): string {
  return HELP_SECTIONS.find((s) => s.id === id)?.title ?? "";
}
