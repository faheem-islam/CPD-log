import { formatHours, formatLongDate } from "@/lib/dates";
import { profileLabel } from "@/lib/profiles";
import type { EntryInput } from "@/lib/types";

function host(url: string | null): string {
  const u = (url ?? "").trim();
  if (!u) return "";
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm font-bold text-muted">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Quiet context beside the form on wide screens: what happens next, before a link is read. */
export function NextPanel() {
  return (
    <div className="band-2">
      <h2 className="eyebrow">What happens next</h2>
      <ol className="mt-3 list-decimal space-y-3 pl-5">
        <li>
          <strong>We read the page.</strong> The title, provider, type and length, where the page shows them.
        </li>
        <li>
          <strong>You check it.</strong> Each detail says how it was found, and you can change any of it.
        </li>
        <li>
          <strong>You confirm your time.</strong> Hours are always your own figure.
        </li>
      </ol>
    </div>
  );
}

/** A live recap of the entry beside the review steps (wide screens only). */
export function SoFarPanel({ value }: { value: EntryInput }) {
  const title = value.title.trim();
  const link = host(value.url);
  const detail = value.profile === "ice" ? value.theme : value.profile === "istructe" ? value.category : null;
  return (
    <div className="band-2">
      <h2 className="eyebrow">Your entry so far</h2>
      <dl className="mt-3 space-y-3">
        <Row label="Log">{profileLabel(value.profile)}</Row>
        <Row label="Title">{title ? <span className="line-clamp-3">{title}</span> : <span className="text-muted">Not added yet</span>}</Row>
        {link && <Row label="Link">{link}</Row>}
        <Row label="Date completed">{formatLongDate(value.dateCompleted) || <span className="text-muted">Not chosen yet</span>}</Row>
        <Row label="Hours">
          {value.hours > 0 ? (
            <>
              <span className="num">{formatHours(value.hours)}</span> {value.hoursConfirmed ? "(confirmed by you)" : "(not confirmed yet)"}
            </>
          ) : (
            <span className="text-muted">Not added yet</span>
          )}
        </Row>
        {value.profile !== "custom" && (
          <Row label={value.profile === "ice" ? "ICE theme" : "IStructE category"}>{detail || <span className="text-muted">Not chosen yet</span>}</Row>
        )}
      </dl>
    </div>
  );
}
