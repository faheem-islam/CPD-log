const STEPS = [
  {
    title: "Paste a link",
    body: "Paste the address of a video, webinar, article or document into the box above and press Read link.",
  },
  {
    title: "Check the details and confirm your time",
    body: "We fill in what we can find. You check each detail and confirm the time you actually spent learning.",
  },
  {
    title: "Export to Excel for your records",
    body: "Download your log as an Excel file whenever you need it, to keep or to copy across by hand.",
  },
] as const;

/** Shown only to someone with no entries yet. A plain guide, no pretend content. */
export function FirstSteps() {
  return (
    <section aria-labelledby="first-steps-heading" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10">
      <div className="min-w-0">
        <h2 id="first-steps-heading">Your log is empty</h2>
        <p className="mt-2 max-w-sm text-base text-muted">
          Add your first entry in three steps. Everything you add stays in your log, and you can change or delete it later.
        </p>
      </div>
      <ol role="list" className="min-w-0 space-y-2">
        {STEPS.map((s, i) => (
          <li key={s.title} className="band-2 grid grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-x-4 !py-4">
            <span aria-hidden="true" className="big-num text-4xl text-link">
              {i + 1}
            </span>
            <div className="min-w-0">
              <h3>{s.title}</h3>
              <p className="mt-1 text-base text-muted">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
