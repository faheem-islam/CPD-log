/** A plain note on what the file is for, and what this site does not do. Always shown, so nobody assumes more. */
export function AboutFile() {
  return (
    <section aria-labelledby="about-heading" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <h2 id="about-heading">About this file</h2>
      <div className="band-2 min-w-0 space-y-3 text-base">
        <p>
          ICE's CPD tool has no import feature, so this file is for your own records, to attach, or to copy across by hand. ICE and
          IStructE both accept CPD records in other formats, as long as the content is complete.
        </p>
        <p>
          CPD Logger does not connect to ICE or IStructE, and it does not send anything to either of them for you. You decide what to
          attach or copy across.
        </p>
        <p className="text-muted">Entries you have deleted are left out of the file.</p>
      </div>
    </section>
  );
}
