/**
 * One band of the Settings page. The heading and a line of explanation sit on the left; the controls sit on the
 * right (2fr), so the page reads as a list of short chapters rather than one long form. On a phone they stack.
 */
export function SettingsSection({
  id,
  title,
  intro,
  tone = "band",
  children,
}: {
  id: string;
  title: string;
  intro?: React.ReactNode;
  tone?: "band" | "band-2";
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className={`${tone} grid scroll-mt-6 grid-cols-1 gap-x-10 gap-y-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]`}
    >
      <div className="min-w-0">
        <h2 id={`${id}-heading`}>{title}</h2>
        {intro && <div className="mt-1 max-w-sm text-base text-muted">{intro}</div>}
      </div>
      <div className="min-w-0 space-y-5">{children}</div>
    </section>
  );
}
