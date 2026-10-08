import { Check, Database, Minus, TriangleAlert } from "lucide-react";

/** What the page is told about the server. Only yes/no answers and numbers, never a key or secret. */
export interface FeatureStatus {
  ai: boolean;
  youtubeApi: boolean;
  sentry: boolean;
  mode: "supabase" | "local";
  /** Calls allowed per person per month. 0 means AI help is off. */
  aiMonthlyCap: number;
}

export interface AiUsageStatus {
  used: number;
  cap: number;
  /** "1 November". */
  resetsOn: string;
}

function OnOff({ on }: { on: boolean }) {
  return on ? (
    <span className="badge badge-info">
      <Check aria-hidden="true" size={14} strokeWidth={3} />
      On
    </span>
  ) : (
    <span className="badge badge-missing !bg-surface">
      <Minus aria-hidden="true" size={14} strokeWidth={3} />
      Off
    </span>
  );
}

function Row({ name, status, children }: { name: string; status: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl bg-surface-2 px-4 py-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:flex-col sm:items-start">
        <h3 className="!text-lg">{name}</h3>
        {status}
      </div>
      <div className="min-w-0 space-y-2 text-base">{children}</div>
    </li>
  );
}

function Allowance({ usage }: { usage: AiUsageStatus }) {
  const pct = usage.cap > 0 ? Math.min(100, Math.round((usage.used / usage.cap) * 100)) : 0;
  const used = usage.used >= usage.cap;
  return (
    <div className="rounded-xl bg-surface px-4 py-3">
      <p className="text-base">
        <span className="num font-bold">{usage.used}</span> of <span className="num font-bold">{usage.cap}</span> AI calls used this
        month.
      </p>
      <div className="progress-track mt-2" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-sm text-muted">
        {used
          ? `You have used this month's allowance. It resets on ${usage.resetsOn}. You can still write your own learning points.`
          : `The allowance resets on ${usage.resetsOn}. Each time the AI is asked to do something it counts as one call.`}
      </p>
    </div>
  );
}

/**
 * Read-only: which optional features this site has switched on, in plain words. Nothing here can be changed from the page,
 * because they are set by whoever runs the site.
 */
export function FeaturesList({ features, usage }: { features: FeatureStatus; usage: AiUsageStatus | null }) {
  const aiOn = features.ai && features.aiMonthlyCap > 0;
  return (
    <ul className="space-y-2" aria-label="Optional features">
      <Row name="AI help" status={<OnOff on={aiOn} />}>
        {aiOn ? (
          <>
            <p>
              "Expand my notes" drafts learning points and benefits from the notes you type, and screenshot import reads a picture of
              a CPD log into rows. You check and edit the result before anything is saved.
            </p>
            <p className="text-sm text-muted">
              When you use either one, your notes or the screenshot you upload are sent to Anthropic's Claude to do the work.
            </p>
            {usage ? (
              <Allowance usage={usage} />
            ) : (
              <p className="text-sm text-muted">
                Your allowance is {features.aiMonthlyCap} AI calls a month. We could not read how many you have used just now.
              </p>
            )}
          </>
        ) : (
          <p>
            AI help is switched off on this site, so "Expand my notes" and screenshot import are not offered. You can still write your own
            learning points and import a spreadsheet.
          </p>
        )}
      </Row>

      <Row name="YouTube lengths" status={<OnOff on={features.youtubeApi} />}>
        {features.youtubeApi ? (
          <p>The length of a YouTube video is filled in for you when you paste its link.</p>
        ) : (
          <p>
            YouTube titles are still read from the link, but without a key the length is not, so you enter how long you spent
            yourself.
          </p>
        )}
      </Row>

      <Row name="Error monitoring" status={<OnOff on={features.sentry} />}>
        {features.sentry ? (
          <p>
            Crashes and server errors are reported to whoever runs this site so they can fix them. Reports are stripped of request details,
            cookies and account details before they are sent.
          </p>
        ) : (
          <p>No error reports are sent anywhere. If something breaks, tell whoever runs this site.</p>
        )}
      </Row>

      <Row
        name="Storage"
        status={
          <span className={features.mode === "supabase" ? "badge badge-info" : "badge badge-warn"}>
            <Database aria-hidden="true" size={14} strokeWidth={3} />
            {features.mode === "supabase" ? "Supabase, London" : "Local demo mode"}
          </span>
        }
      >
        {features.mode === "supabase" ? (
          <p>Your entries and settings are stored in a Supabase database in London, and only you can see them when you are signed in.</p>
        ) : (
          <p className="notice notice-warn flex items-start gap-2">
            <TriangleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              <strong>Local demo mode is for trying the app.</strong> Entries are kept in a file on the server, and anyone who types an
              email address can sign in. Do not keep real records here.
            </span>
          </p>
        )}
      </Row>
    </ul>
  );
}
