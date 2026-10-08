"use client";

import { Info } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "@/lib/api/client";
import type { ImportResult } from "@/lib/import/types";
import { PROFILES } from "@/lib/profiles";
import type { CustomFieldDef, ProfileId } from "@/lib/types";
import { AI_OFF_MESSAGE, MAX_FILE_BYTES, MAX_FILE_MB, isImageFile } from "./helpers";
import { ReviewStep } from "./review-step";
import { UploadStep, type ImportLog } from "./upload-step";

export type { ImportLog };

/**
 * The one stable root of the page. The page-load reveal animates it once. When that finishes the animation is dropped,
 * because a finished "fill forwards" animation keeps the whole element on its own layer and makes every keystroke in a
 * long list of rows cost twice as much to paint. The end state of the animation is the same as no animation.
 */
function Root({ children }: { children: React.ReactNode }) {
  return (
    <div
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.animation = "none";
      }}
    >
      {children}
    </div>
  );
}

interface Session {
  result: ImportResult;
  fileName: string;
  profile: ProfileId;
  key: number;
}

/**
 * The import page's one client component: pick a log and a file, read it on the server, then review every row.
 * Nothing is stored until the commit on the review screen.
 */
export function ImportFlow({ logs, aiEnabled, customFields }: { logs: ImportLog[]; aiEnabled: boolean; customFields: CustomFieldDef[] }) {
  const [profile, setProfile] = useState<ProfileId>(logs[0]?.id ?? "ice");
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<{ fileName: string; message: string } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [focusFile, setFocusFile] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const onFile = useCallback(
    async (file: File): Promise<boolean> => {
      setError(null);
      setFocusFile(false);
      // These three are checked here, before anything is sent, with the same words the server uses.
      if (isImageFile(file) && !aiEnabled) {
        setError({ fileName: file.name, message: AI_OFF_MESSAGE });
        return false;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError({ fileName: file.name, message: `That file is larger than ${MAX_FILE_MB} MB. Remove unused rows or sheets and try again.` });
        return false;
      }
      if (file.size === 0) {
        setError({ fileName: file.name, message: "That file is empty. Choose the file that holds your CPD record." });
        return false;
      }

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setReading(file.name);
      try {
        const form = new FormData();
        form.set("file", file);
        form.set("profile", profile);
        const result = await api<ImportResult>("/api/import/parse", { form, signal: ctrl.signal });
        if (!result || !Array.isArray(result.rows) || result.rows.length === 0) {
          setError({ fileName: file.name, message: "No rows were found in that file. Check that it has your CPD entries under a row of headings, then try again." });
          return false;
        }
        setSession({ result, fileName: file.name, profile, key: Date.now() });
        return true;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return false;
        setError({
          fileName: file.name,
          message: err instanceof ApiClientError ? err.message : "We couldn't read that file. Try again, or export your record to Excel or CSV and import that.",
        });
        return false;
      } finally {
        if (abortRef.current === ctrl) setReading(null);
      }
    },
    [aiEnabled, profile],
  );

  if (logs.length === 0) {
    return (
      <Root>
        <div className="band flex items-start gap-3">
          <Info aria-hidden="true" size={22} className="mt-0.5 shrink-0 text-link" />
          <div>
            <h2>Switch on a log first</h2>
            <p className="mt-1 text-base">
              Import adds rows to one of your logs, and none is switched on. Turn one on in <Link href="/settings">Settings</Link>, then come back.
            </p>
          </div>
        </div>
      </Root>
    );
  }

  // One stable root: the page-load reveal animates this element once, and never again when the step changes.
  if (session) {
    return (
      <Root>
        <ReviewStep
          key={session.key}
          profile={session.profile}
          logLabel={PROFILES[session.profile].label}
          provisional={PROFILES[session.profile].provisional}
          fileName={session.fileName}
          result={session.result}
          customFields={customFields}
          onRestart={() => {
            setSession(null);
            setError(null);
            setFocusFile(true);
          }}
        />
      </Root>
    );
  }

  return (
    <Root>
      <UploadStep
        logs={logs}
        profile={profile}
        onProfile={setProfile}
        aiEnabled={aiEnabled}
        customFields={customFields}
        reading={reading}
        error={error}
        onFile={onFile}
        focusFile={focusFile}
      />
    </Root>
  );
}
