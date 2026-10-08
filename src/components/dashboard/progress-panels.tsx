import { Check, Circle, Construction, Info } from "lucide-react";
import Link from "next/link";
import type { IceProgress, IstructeProgress, Target } from "@/lib/compliance";
import { formatHours } from "@/lib/dates";

/** "2024–2026", with an en dash, for a run of years. Kept on one line: a break after the dash reads as two numbers. */
function Years({ years }: { years: number[] }) {
  const first = years[0];
  const last = years[years.length - 1];
  const text = first === undefined || last === undefined || first === last ? String(last ?? "") : `${first}–${last}`;
  return <span className="whitespace-nowrap">{text}</span>;
}

/** Hours this year as the big number. The unit is spoken as well as shown. */
export function HoursStat({
  hours,
  year,
  logLabel,
  children,
}: {
  hours: number;
  year: number;
  logLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="band min-w-0">
      <p className="eyebrow">Hours this year</p>
      <p className="mt-2 flex items-baseline gap-2">
        <span className="big-num text-5xl sm:text-6xl">{formatHours(hours)}</span>
        <span className="font-display text-2xl font-bold text-muted">
          <span aria-hidden="true">h</span>
          <span className="sr-only">hours</span>
        </span>
      </p>
      <p className="mt-2 text-sm text-muted">
        {logLabel} · {year}
      </p>
      {children}
    </div>
  );
}

/** One yes/no state, always an icon plus words. */
function State({ recorded, children }: { recorded: boolean; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-sm font-bold">
      {recorded ? (
        <Check aria-hidden="true" size={20} strokeWidth={3} className="shrink-0 text-route" />
      ) : (
        <Circle aria-hidden="true" size={20} strokeWidth={2.5} className="shrink-0 text-muted" />
      )}
      <span className={`min-w-0 ${recorded ? "text-ink" : "text-muted"}`}>{children}</span>
    </span>
  );
}

export function IcePanel({ progress }: { progress: IceProgress }) {
  const total = progress.themes.length;
  const windowText = <Years years={progress.windowYears} />;
  return (
    <div className="band min-w-0">
      <h3>Mandatory themes recorded</h3>

      <dl className="mt-4 grid grid-cols-2 items-end gap-x-6 gap-y-4 sm:flex sm:gap-x-12">
        <div>
          <dt className="text-sm font-bold text-muted">In {progress.year}</dt>
          <dd className="mt-1 flex items-baseline gap-2">
            <span className="big-num">{progress.mandatoryRecordedThisYear}</span>
            <span className="text-base text-muted">of {total}</span>
          </dd>
        </div>
        <div>
          <dt className="text-sm font-bold text-muted">Rolling three years, {windowText}</dt>
          <dd className="mt-1 flex items-baseline gap-2">
            <span className="big-num">{progress.mandatoryRecordedInWindow}</span>
            <span className="text-base text-muted">of {total}</span>
          </dd>
        </div>
      </dl>

      {!progress.anyMandatoryThisYear && (
        <p className="notice notice-info mt-5 flex items-start gap-2 text-base">
          <Info aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
          <span className="min-w-0">No mandatory theme recorded in {progress.year} yet.</span>
        </p>
      )}

      <ul className="mt-5 space-y-2" aria-label="Mandatory themes">
        {progress.themes.map((t) => (
          <li key={t.theme} className="rounded-xl bg-surface-2 px-4 py-3">
            <p className="min-w-0 font-bold">{t.theme}</p>
            <div className="mt-1 flex flex-col gap-x-8 gap-y-1 sm:flex-row sm:flex-wrap">
              <State recorded={t.recordedThisYear}>
                {t.recordedThisYear ? "Recorded" : "Not recorded"} in {progress.year}
              </State>
              <State recorded={t.recordedInWindow}>
                {t.recordedInWindow ? "Recorded" : "Not recorded"} in {windowText}
              </State>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-5 max-w-prose text-sm text-muted">
        ICE asks for at least one mandatory theme each year, and all three over a rolling three years.
      </p>
    </div>
  );
}

/** The hours note that sits under the big number for ICE. */
export function IceHoursNote({ progress }: { progress: IceProgress }) {
  return (
    <div className="mt-4 space-y-2 text-sm text-muted">
      <p>
        <span className="num font-bold text-ink">{formatHours(progress.hoursInWindow)}</span> hours over <Years years={progress.windowYears} />
      </p>
      <p>Hours are shown for information only: ICE sets no hours target for qualified members.</p>
    </div>
  );
}

function TargetRow({ label, target }: { label: React.ReactNode; target: Target }) {
  const percent = Math.round(target.fraction * 100);
  return (
    <li className="rounded-xl bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="min-w-0 font-bold">{label}</span>
        <span className="num text-base">
          <strong>{formatHours(target.hours)}</strong> of {target.target} hours
          {target.met && (
            <span className="ml-3 inline-flex items-center gap-1 text-sm font-bold text-route">
              <Check aria-hidden="true" size={16} strokeWidth={3} />
              Target reached
            </span>
          )}
        </span>
      </div>
      {/* The bar only repeats the numbers above, so it is hidden from assistive technology. */}
      <div className="progress-track mt-2 !bg-bg" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </li>
  );
}

export function IstructePanel({ progress }: { progress: IstructeProgress }) {
  return (
    <div className="band min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3>IStructE targets</h3>
        <span className="badge badge-warn">
          <Construction aria-hidden="true" size={14} strokeWidth={2.5} />
          Provisional
        </span>
      </div>
      <p className="mt-2 max-w-prose text-base">
        These targets are our best reading of IStructE's rules. Check them against your own IStructE account.
      </p>

      <ul className="mt-5 space-y-2" aria-label="IStructE targets">
        <TargetRow label={`Hours in ${progress.year}`} target={progress.annual} />
        <TargetRow label={`Structural safety in ${progress.year}`} target={progress.structuralSafety} />
        <TargetRow label={`Sustainability in ${progress.year}`} target={progress.sustainability} />
        <TargetRow
          label={
            <>
              Rolling three years, <Years years={progress.windowYears} />
            </>
          }
          target={progress.rolling}
        />
      </ul>
    </div>
  );
}

/** For people who only use the Custom log: no rules to track, so a short pointer instead of a panel. */
export function CustomNote() {
  return (
    <div className="band min-w-0">
      <h3>No targets to track</h3>
      <p className="mt-2 max-w-prose text-base text-muted">
        The Custom log has no hours or theme targets of its own, so your hours and latest entries are all that is shown here. The
        fields it uses are set in <Link href="/settings">Settings</Link>.
      </p>
    </div>
  );
}
