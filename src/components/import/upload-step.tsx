"use client";

import { CircleX, Info } from "lucide-react";
import { useEffect, useRef } from "react";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { PROFILES } from "@/lib/profiles";
import type { CustomFieldDef, ProfileId } from "@/lib/types";
import { AI_OFF_MESSAGE, HEADER_SCAN_ROWS, MAX_FILE_MB, MAX_ROWS, SCREENSHOT_ACCEPT, SPREADSHEET_ACCEPT } from "./helpers";

export interface ImportLog {
  id: ProfileId;
  label: string;
  fullName: string;
  provisional: boolean;
}

interface UploadProps {
  logs: ImportLog[];
  profile: ProfileId;
  onProfile: (id: ProfileId) => void;
  aiEnabled: boolean;
  customFields: CustomFieldDef[];
  /** Name of the file being read, or null when nothing is. */
  reading: string | null;
  error: { fileName: string; message: string } | null;
  /** Resolves true when the file was taken on to the review screen. */
  onFile: (file: File) => Promise<boolean>;
  focusFile: boolean;
}

/** What the importer looks for, in the person's own terms, for the log they chose. */
function columnsFor(profile: ProfileId, customFields: CustomFieldDef[]): { needed: string; also: string } {
  const needed = "A date, an activity title, and hours (or minutes).";
  if (profile === "ice") return { needed, also: "ICE theme, development plan ref, learning points and benefits." };
  if (profile === "istructe") return { needed, also: "Category, structural safety (Y/N), sustainability (Y/N) and development gained." };
  const own = customFields.map((f) => f.label);
  return { needed, also: own.length > 0 ? `Your own fields from Settings, by column name: ${own.join(", ")}.` : "Nothing else. Add your own fields in Settings to read more columns." };
}

export function UploadStep({ logs, profile, onProfile, aiEnabled, customFields, reading, error, onFile, focusFile }: UploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const latestChoice = useRef(0);
  const logLabel = PROFILES[profile].label;
  const cols = columnsFor(profile, customFields);

  useEffect(() => {
    if (focusFile) inputRef.current?.focus();
  }, [focusFile]);

  const accept = aiEnabled ? `${SPREADSHEET_ACCEPT},${SCREENSHOT_ACCEPT}` : SPREADSHEET_ACCEPT;
  const hint = aiEnabled
    ? `Excel (.xlsx) or CSV, up to ${MAX_FILE_MB} MB, or a screenshot (PNG, JPG, WebP or GIF).`
    : `Excel (.xlsx) or CSV, up to ${MAX_FILE_MB} MB.`;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
      <section aria-labelledby="add-file-heading" className="band min-w-0 space-y-6">
        <div>
          <h2 id="add-file-heading">Add your file</h2>
          <p className="mt-1 text-base text-muted">
            You will see every row before anything is saved. Nothing is stored until you press the import button.
          </p>
        </div>

        {logs.length > 1 ? (
          <fieldset className="min-w-0" disabled={reading !== null}>
            <legend className="label">Which log should the rows go into?</legend>
            <div className="flex flex-col gap-2">
              {logs.map((l) => (
                <label
                  key={l.id}
                  className="group grid min-h-tap min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 rounded-xl bg-surface-2 px-4 py-2 has-[:checked]:bg-sign has-[:checked]:text-sign-ink"
                >
                  <input
                    type="radio"
                    name="import-log"
                    value={l.id}
                    checked={profile === l.id}
                    onChange={() => onProfile(l.id)}
                    className="h-5 w-5 cursor-pointer accent-[rgb(var(--amber))]"
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-bold">{l.label}</span>
                      {l.provisional && (
                        <span className="badge badge-warn group-has-[:checked]:!bg-amber group-has-[:checked]:!text-[#14202b]">Provisional layout</span>
                      )}
                    </span>
                    <span className="block text-sm">{l.fullName}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="hint mt-2">One log at a time. To fill another, import again afterwards.</p>
          </fieldset>
        ) : (
          <p className="text-base">
            The rows will go into your <strong>{logLabel}</strong> log.
          </p>
        )}

        <div className="min-w-0">
          <label htmlFor="import-file" className="label">
            Choose a file
          </label>
          <input
            ref={inputRef}
            id="import-file"
            name="file"
            type="file"
            accept={accept}
            className="input !p-0 cursor-pointer overflow-hidden file:mr-4 file:min-h-tap file:cursor-pointer file:border-0 file:bg-sign file:px-5 file:py-2 file:text-base file:font-bold file:text-sign-ink"
            aria-describedby={error ? "import-file-hint import-file-error" : "import-file-hint"}
            aria-invalid={error ? true : undefined}
            onChange={async (e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              const turn = ++latestChoice.current;
              const taken = await onFile(file);
              // A file that was refused is cleared, so choosing the same file again (after fixing it) still counts.
              // But not when a newer choice has replaced this one: that one is still being read, and the box shows it.
              if (!taken && turn === latestChoice.current) input.value = "";
            }}
          />
          <p id="import-file-hint" className="hint mt-1">
            {hint} We upload it only to read it, and we don't keep it.
          </p>
        </div>

        {error && (
          <div id="import-file-error" className="notice notice-error flex items-start gap-3" role="alert">
            <CircleX aria-hidden="true" size={22} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="font-bold [overflow-wrap:anywhere]">{error.fileName}</p>
              <p>{error.message}</p>
            </div>
          </div>
        )}

        {reading !== null && (
          <LoadingRegion label={`Reading ${reading}`}>
            <p className="mb-3 text-base font-bold [overflow-wrap:anywhere]">Reading {reading}…</p>
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </LoadingRegion>
        )}
      </section>

      <section aria-labelledby="read-heading" className="band-2 min-w-0 space-y-4">
        <div>
          <h2 id="read-heading" className="text-lg">
            What we read
          </h2>
          <p className="mt-1 text-base text-muted">
            Column names don't have to match exactly, and the row of headings can sit anywhere in the first {HEADER_SCAN_ROWS} rows, below a name block.
          </p>
        </div>
        <dl className="space-y-3 text-base">
          <div>
            <dt className="font-bold">Every row needs</dt>
            <dd>{cols.needed}</dd>
          </div>
          <div>
            <dt className="font-bold">Also read for {logLabel}</dt>
            <dd>{cols.also}</dd>
          </div>
          <div>
            <dt className="font-bold">Limits</dt>
            <dd>
              <span className="num">{MAX_FILE_MB}</span> MB and <span className="num">{MAX_ROWS.toLocaleString("en-GB")}</span> rows at a time.
            </dd>
          </div>
        </dl>

        <div>
          <h3 className="text-base">Screenshots</h3>
          {aiEnabled ? (
            <p className="mt-1 text-base">
              You can choose a screenshot of your record. The image is sent to an AI service to read the text, and we don't keep it. Every row is marked to check.
            </p>
          ) : (
            <p id="import-ai-off" className="notice notice-info mt-1 flex items-start gap-2">
              <Info aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-link" />
              <span className="min-w-0">{AI_OFF_MESSAGE}</span>
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
