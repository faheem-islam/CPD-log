"use client";

/**
 * The Add flow wizard. One primary action per screen, and "Fill in by hand" on every step.
 *
 *   link -> reading -> details -> hours -> takeaways -> save      (a page that could be read)
 *   link -> reading -> manual (with the API's message)            (a page that could not be read)
 *   link -> link (with a message)                                 (text that is not a web link)
 *   any step -> manual                                            ("Fill in by hand")
 *
 * One value (an EntryInput) is edited across all the steps, so going back or switching to the manual form
 * never loses anything. Hours are never confirmed for the person: the checkbox is theirs to tick.
 *
 * Each step is a browser history entry, so the Back button and a phone's back gesture go to the previous step.
 * The draft is also kept in sessionStorage (this tab only), so a reload or Forward brings it back. A fresh visit
 * to /add always starts empty.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_AI_STATE,
  type AiState,
  type EntryAi,
  type HoursHint,
} from "@/components/entry/entry-form";
import {
  FIELD_ORDER,
  MAX_HOURS,
  changeProfile,
  checkEntry,
  entryFieldId,
  firstErrorKey,
  prepareForSave,
  type EntryErrors,
} from "@/components/entry/entry-helpers";
import { softWarnings } from "@/components/entry/entry-warnings";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/api/client";
import type { EntryResponse } from "@/lib/api/types";
import { isProfileId, profileLabel } from "@/lib/profiles";
import type { EntryInput, ExtractResponse, ProfileId, UserSettings } from "@/lib/types";
import { draftForManual, draftFromExtract, hasTypedContent, linkForForm, linkToCarry, pickLink, withLink } from "./draft";
import { LinkStep } from "./link-step";
import { ManualStep, type ReadFailure } from "./manual-step";
import { ReadingStep } from "./reading-step";
import { NextPanel, SoFarPanel } from "./side-panel";
import { DetailsStep, HoursStep, SaveStep, TakeawaysStep, stepOfKey, type ReviewStep } from "./wizard-steps";

type Step = "link" | "reading" | "details" | "hours" | "takeaways" | "save" | "manual";
type PageInfo = { flags: { upcoming: boolean; recording: boolean }; notes: string[] };

const STEPS: readonly Step[] = ["link", "reading", "details", "hours", "takeaways", "save", "manual"];

export interface AddFlowProps {
  settings: Pick<UserSettings, "activeProfiles" | "customFields">;
  features: { ai: boolean; youtubeApi: boolean };
  /** Today in the UK, from the server (todayUk()). */
  todayIso: string;
  /** The person's other live entries, for the same-day hours warning. */
  others: { id: string; dateCompleted: string; hours: number }[];
  /** Who is signed in, so a draft kept in this tab is never shown to someone else. */
  owner: string;
  /** From ?url=. When present the page is read straight away. */
  initialUrl?: string;
  /** From ?manual=1. Opens the manual form. */
  startManual?: boolean;
}

const DETAIL_KEYS = ["title", "url", "dateCompleted", "dateEnd"];
const IDS = "entry";

function focusField(key: string | null) {
  if (!key) return;
  document.getElementById(entryFieldId(IDS, key))?.focus();
}

// ---------------------------------------------------------------------------------------------
// Browser history: one entry per step. Next.js keeps its own bookkeeping on the entry, so this only adds a key.

function isStep(s: unknown): s is Step {
  return typeof s === "string" && (STEPS as readonly string[]).includes(s);
}

function stepInHistory(): Step | null {
  try {
    const s = (window.history.state as { cpdAddStep?: unknown } | null)?.cpdAddStep;
    return isStep(s) ? s : null;
  } catch {
    return null;
  }
}

function writeHistory(step: Step, how: "push" | "replace") {
  try {
    // Keep what Next.js keeps on the entry (it marks the entries it can handle, and reloads the page on one it can't).
    // This runs before Next.js has patched the history calls, so it cannot rely on them to copy it.
    const current = window.history.state as Record<string, unknown> | null;
    const state = { ...(current && typeof current === "object" ? current : {}), cpdAddStep: step };
    if (how === "push") window.history.pushState(state, "");
    else window.history.replaceState(state, "");
  } catch {
    // History can be blocked in unusual embeds. The flow still works, just without Back between steps.
  }
}

// ---------------------------------------------------------------------------------------------
// The draft kept in this tab. Every read and write is wrapped: storage can be missing or full.

const DRAFT_KEY = "cpd-add-draft";
const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface Snapshot {
  v: 1;
  owner: string;
  savedAt: number;
  step: Step;
  link: string;
  value: EntryInput;
  hoursHint: HoursHint;
  page: PageInfo | null;
  failure: ReadFailure | null;
  ai: { reviewed: boolean; warnings: string[] };
}

function clearSnapshot() {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

function writeSnapshot(snap: Snapshot) {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(snap));
  } catch {
    // Private window or full storage: the draft just isn't kept.
  }
}

const isText = (x: unknown): x is string => typeof x === "string";
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Enough of a check that a damaged or old draft is ignored instead of crashing the form. */
function looksLikeEntry(v: unknown): v is EntryInput {
  if (!isObject(v)) return false;
  const b = v.benefits;
  return (
    isProfileId(v.profile) &&
    isText(v.title) &&
    isText(v.dateCompleted) &&
    typeof v.hours === "number" &&
    typeof v.hoursConfirmed === "boolean" &&
    isText(v.devPlanRef) &&
    isText(v.learningPoints) &&
    isText(v.developmentGained) &&
    isText(v.notes) &&
    typeof v.aiAssisted === "boolean" &&
    isObject(v.custom) &&
    isObject(v.confidence) &&
    isObject(b) &&
    isText(b.helped) &&
    isText(b.future) &&
    isText(b.nextYear)
  );
}

function readSnapshot(owner: string): Snapshot | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const snap: unknown = JSON.parse(raw);
    if (!isObject(snap) || snap.v !== 1 || snap.owner !== owner) return null;
    if (typeof snap.savedAt !== "number" || Date.now() - snap.savedAt > DRAFT_MAX_AGE_MS) return null;
    if (!isStep(snap.step) || snap.step === "reading" || !isText(snap.link) || !looksLikeEntry(snap.value)) return null;
    return snap as unknown as Snapshot;
  } catch {
    return null;
  }
}

export function AddFlow({ settings, features, todayIso, others, owner, initialUrl, startManual }: AddFlowProps) {
  const router = useRouter();
  const { toast } = useToast();
  const defaultProfile: ProfileId = settings.activeProfiles[0] ?? "ice";
  const firstStep: Step = initialUrl ? "reading" : startManual ? "manual" : "link";

  const [step, setStep] = useState<Step>(firstStep);
  const [link, setLink] = useState(initialUrl ?? "");
  const [readingUrl, setReadingUrl] = useState(initialUrl ?? "");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [value, setValue] = useState<EntryInput>(() => draftForManual({ profile: defaultProfile, todayIso, link: null }).value);
  const [hoursHint, setHoursHint] = useState<HoursHint>({});
  const [page, setPage] = useState<PageInfo | null>(null);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [aiState, setAiState] = useState<AiState>(EMPTY_AI_STATE);
  const [errors, setErrors] = useState<EntryErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [askLeave, setAskLeave] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const started = useRef(false);
  const arrived = useRef(false);
  const persistArmed = useRef(false);
  const saved = useRef(false);
  const prevStep = useRef<Step>(step);
  const stepRef = useRef<Step>(step);
  const savingRef = useRef(false);
  const profileRef = useRef<ProfileId>(defaultProfile);
  const pendingFocus = useRef<string | null>(null);
  /** Always the newest entry, for code that runs after an await. */
  const valueRef = useRef(value);
  /** Changes whenever a different entry replaces the one on screen (a new link was read). */
  const draftRef = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Set the entry. `fresh` marks it as a different entry, so an AI answer still on its way is not mixed into it. */
  const commitValue = useCallback((next: EntryInput, fresh = false) => {
    valueRef.current = next;
    if (fresh) draftRef.current += 1;
    setValue(next);
  }, []);

  /** Show a step. "push" adds a history entry (Back returns here), "replace" swaps the current one, "none" only shows it. */
  const showStep = useCallback((next: Step, how: "push" | "replace" | "none" = "push") => {
    stepRef.current = next;
    setStep(next);
    if (how === "none") return;
    if (how === "push" && stepInHistory() === next) return;
    writeHistory(next, how);
  }, []);

  // Move focus to the new step's heading (or the paste box, or the first field that needs fixing) when the step
  // changes, never on first load.
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    const key = pendingFocus.current;
    pendingFocus.current = null;
    if (key && document.getElementById(entryFieldId(IDS, key))) focusField(key);
    else if (step === "link") linkRef.current?.focus();
    else headingRef.current?.focus();
  }, [step]);

  // On arrival: bring back this tab's draft if the person got here with Back, Forward or a reload, otherwise start
  // clean. A fresh visit has no step on its history entry, so it never picks up an old draft.
  useEffect(() => {
    if (arrived.current) return; // React's dev double-mount must not run this twice
    arrived.current = true;
    const inHistory = stepInHistory();
    const snap = inHistory ? readSnapshot(owner) : null;
    if (snap && snap.step === inHistory) {
      started.current = true; // do not read ?url= again over the restored draft
      const profile = settings.activeProfiles.includes(snap.value.profile) ? snap.value.profile : defaultProfile;
      profileRef.current = profile;
      commitValue(changeProfile(snap.value, profile));
      stepRef.current = snap.step;
      setStep(snap.step);
      setLink(snap.link);
      setHoursHint(isObject(snap.hoursHint) ? snap.hoursHint : {});
      setPage(isObject(snap.page) ? snap.page : null);
      setFailure(isObject(snap.failure) ? snap.failure : null);
      setAiState({ reviewed: Boolean(snap.ai?.reviewed), warnings: Array.isArray(snap.ai?.warnings) ? snap.ai.warnings.filter(isText) : [] });
    } else {
      clearSnapshot();
      writeHistory(firstStep, "replace");
    }
    // Runs once on arrival. The values it reads are the first render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the draft in this tab while the person works, and drop it once there is nothing in it.
  useEffect(() => {
    // Not on the first run: the draft being restored must not be cleared by the blank form that is on screen before it lands.
    if (!persistArmed.current) {
      persistArmed.current = true;
      return;
    }
    if (saved.current || step === "reading") return;
    if (step === "link" && link.trim() === "" && !hasTypedContent(value, todayIso)) {
      clearSnapshot();
      return;
    }
    writeSnapshot({
      v: 1,
      owner,
      savedAt: Date.now(),
      step,
      link,
      value,
      hoursHint,
      page,
      failure,
      ai: { reviewed: aiState.reviewed, warnings: aiState.warnings },
    });
  }, [step, link, value, hoursHint, page, failure, aiState.reviewed, aiState.warnings, owner, todayIso]);

  // Back and Forward move between the steps already visited.
  useEffect(() => {
    function onPop(e: PopStateEvent) {
      const s = (e.state as { cpdAddStep?: unknown } | null)?.cpdAddStep;
      if (!isStep(s)) return;
      abortRef.current?.abort();
      setErrors({});
      setSaveError(null);
      setAskLeave(false);
      // A reading screen has nothing behind it once its request has gone.
      showStep(s === "reading" ? "link" : s, "none");
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [showStep]);

  const read = useCallback(
    async (raw: string) => {
      const picked = pickLink(raw);
      if (picked.error) {
        setLinkError(picked.error);
        showStep("link", "replace");
        linkRef.current?.focus();
        return;
      }
      const url = picked.link;
      setLink(url);
      setLinkError(null);
      setReadingUrl(url);
      showStep("reading", "replace");
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await api<ExtractResponse>("/api/extract", { json: { url }, signal: ac.signal });
        if (ac.signal.aborted || !mounted.current) return;
        setErrors({});
        setSaveError(null);
        setAiState(EMPTY_AI_STATE);
        if (res.status === "ok" && res.result) {
          const d = draftFromExtract(res, res.result, { profile: profileRef.current, todayIso, typedLink: linkForForm(url) ?? "" });
          commitValue(d.value, true);
          setHoursHint(d.hoursHint);
          setPage({ flags: d.flags, notes: d.notes });
          setFailure(null);
          showStep("details", "replace");
        } else if (res.status === "unsafe_url") {
          // The text isn't something we can read as a web link. That is the person's input, not the site: stay on the
          // paste step, keep what they typed, and say what to change.
          setLinkError(res.message || "That doesn't look like a web link. Paste the full address of the page, for example https://www.example.com/article.");
          showStep("link", "replace");
        } else {
          const kept = linkForForm(res.url || url);
          const previous = valueRef.current;
          if (hasTypedContent(previous, todayIso)) {
            // Something has been typed already, so keep it and just add the link.
            commitValue(withLink(previous, kept));
          } else {
            const d = draftForManual({ profile: profileRef.current, todayIso, link: kept });
            commitValue(d.value, true);
            setHoursHint({});
            setPage(null);
          }
          setFailure({ message: res.message || "This page could not be read.", url: kept ?? url });
          showStep("manual", "replace");
        }
      } catch (err) {
        if (ac.signal.aborted || !mounted.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLinkError(err instanceof ApiClientError ? err.message : "Something went wrong while reading the link. Try again, or fill it in by hand.");
        showStep("link", "replace");
      }
    },
    [todayIso, commitValue, showStep],
  );

  // ?url=... starts reading straight away. The ref keeps React's dev double-mount from reading twice.
  useEffect(() => {
    if (initialUrl && !started.current) {
      started.current = true;
      void read(initialUrl);
    }
  }, [initialUrl, read]);

  function cancelReading() {
    abortRef.current?.abort();
    showStep("link", "replace");
  }

  function goManual() {
    abortRef.current?.abort();
    const from = stepRef.current;
    if (from === "link" || from === "reading") {
      const carried = linkToCarry(from === "reading" ? readingUrl : link);
      const previous = valueRef.current;
      if (hasTypedContent(previous, todayIso)) {
        // The form already holds the person's work (they came back to the paste step from it). Keep all of it.
        commitValue(withLink(previous, carried));
      } else {
        const d = draftForManual({ profile: profileRef.current, todayIso, link: carried });
        commitValue(d.value, true);
        setHoursHint({});
        setPage(null);
      }
    }
    setFailure(null);
    setErrors({});
    setSaveError(null);
    showStep("manual", "push");
  }

  function readAnother() {
    // The paste step keeps the form's work until a link is actually read, but say so before leaving it.
    if (hasTypedContent(valueRef.current, todayIso)) {
      setAskLeave(true);
      return;
    }
    leaveToLink();
  }

  function leaveToLink() {
    abortRef.current?.abort();
    setAskLeave(false);
    setErrors({});
    setSaveError(null);
    setLinkError(null);
    showStep("link", "push");
  }

  function onProfile(p: ProfileId) {
    profileRef.current = p;
    commitValue(changeProfile(valueRef.current, p));
  }

  function goTo(next: Step) {
    setErrors({});
    setSaveError(null);
    showStep(next, "push");
  }

  /** From the list of things to fix: open the step that owns the first problem and put the cursor in that field. */
  function fixStep(target: ReviewStep) {
    const subset: EntryErrors = {};
    for (const [k, m] of Object.entries(errors)) if (stepOfKey(k) === target) subset[k] = m;
    pendingFocus.current = firstErrorKey(subset, FIELD_ORDER);
    setErrors(subset);
    setSaveError(null);
    showStep(target, "push");
  }

  function nextFromDetails() {
    const all = checkEntry(value, settings);
    const here: EntryErrors = {};
    for (const [k, m] of Object.entries(all)) if (DETAIL_KEYS.includes(k) || k.startsWith("custom.")) here[k] = m;
    setErrors(here);
    if (Object.keys(here).length > 0) {
      focusField(firstErrorKey(here, FIELD_ORDER));
      return;
    }
    showStep("hours", "push");
  }

  function nextFromHours() {
    // Empty hours are allowed here (the last step explains), but a figure that can never be saved is caught now.
    if (value.hours > MAX_HOURS) {
      setErrors({ hours: `Hours can't be more than ${MAX_HOURS}.` });
      focusField("hours");
      return;
    }
    goTo("takeaways");
  }

  async function submit() {
    if (savingRef.current) return;
    const prepared = prepareForSave(value, settings);
    const found = checkEntry(prepared, settings);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setSaveError(null);
      if (step === "manual") focusField(firstErrorKey(found, FIELD_ORDER));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setErrors({});
    try {
      await api<EntryResponse>("/api/entries", {
        json: { entry: prepared, aiReviewed: prepared.aiAssisted ? aiState.reviewed : undefined },
      });
      saved.current = true;
      clearSnapshot();
      toast({ message: `Saved to your ${profileLabel(prepared.profile)} log`, tone: "ok" });
      router.push("/dashboard");
    } catch (err) {
      setSaveError(err instanceof ApiClientError ? err.message : "We couldn't save this entry. Check your connection and try again.");
      savingRef.current = false;
      setSaving(false);
    }
  }

  /** Edits clear the errors they fix. Errors never appear on their own, only after Continue or Save. */
  function changeValue(next: EntryInput) {
    commitValue(next);
    if (Object.keys(errors).length === 0) return;
    const fresh = checkEntry(next, settings);
    setErrors(Object.fromEntries(Object.entries(fresh).filter(([k]) => k in errors)));
  }

  const latest = useCallback(() => ({ value: valueRef.current, draft: draftRef.current }), []);
  const ai: EntryAi = useMemo(
    () => ({ available: features.ai, state: aiState, onStateChange: setAiState, latest }),
    [features.ai, aiState, latest],
  );

  const warnings = useMemo(
    () => (step === "save" || step === "manual" ? softWarnings(prepareForSave(value, settings), { others, todayIso }) : []),
    [step, value, settings, others, todayIso],
  );

  const stepProps = { headingRef, settings, value, onChange: changeValue, errors, onManual: goManual } as const;

  const leaveDialog = (
    <Dialog open={askLeave} onClose={() => setAskLeave(false)} title="Read a link instead?">
      <div className="space-y-5">
        <p>
          What you&rsquo;ve typed stays here until a link is read. Once it is, the details we find on the page replace it.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button type="button" className="btn btn-primary" onClick={leaveToLink}>
            Read a link
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setAskLeave(false)}>
            Keep filling this in
          </button>
        </div>
      </div>
    </Dialog>
  );

  let main: React.ReactNode;
  let side: React.ReactNode = <SoFarPanel value={value} />;
  switch (step) {
    case "link":
      side = <NextPanel />;
      main = <LinkStep link={link} onLinkChange={setLink} onSubmit={() => void read(link)} error={linkError} inputRef={linkRef} onManual={goManual} />;
      break;
    case "reading":
      side = <NextPanel />;
      main = <ReadingStep url={readingUrl} headingRef={headingRef} onCancel={cancelReading} onManual={goManual} />;
      break;
    case "details":
      main = (
        <DetailsStep
          {...stepProps}
          flags={page?.flags ?? { upcoming: false, recording: false }}
          notes={page?.notes ?? []}
          onProfile={onProfile}
          onNext={nextFromDetails}
        />
      );
      break;
    case "hours":
      main = <HoursStep {...stepProps} hint={hoursHint} onBack={() => goTo("details")} onNext={nextFromHours} />;
      break;
    case "takeaways":
      main = <TakeawaysStep {...stepProps} ai={ai} onBack={() => goTo("hours")} onNext={() => goTo("save")} />;
      break;
    case "save":
      main = (
        <SaveStep
          {...stepProps}
          ai={ai}
          warnings={warnings}
          saving={saving}
          saveError={saveError}
          onBack={() => goTo("takeaways")}
          onSave={() => void submit()}
          onGoTo={(s) => goTo(s)}
          onFix={fixStep}
        />
      );
      break;
    case "manual":
      main = (
        <ManualStep
          headingRef={headingRef}
          settings={settings}
          value={value}
          onChange={changeValue}
          errors={errors}
          failure={failure}
          ai={ai}
          hoursHint={hoursHint}
          warnings={warnings}
          saving={saving}
          saveError={saveError}
          onProfile={onProfile}
          onSave={() => void submit()}
          onReadLink={readAnother}
        />
      );
      break;
  }
  return (
    <Frame side={side}>
      {main}
      {leaveDialog}
    </Frame>
  );
}

/**
 * The page frame: the card rises into the blue header band, with a quiet recap on the right on wide screens.
 * The two direct children are stable across steps, so the staggered reveal plays once, on page load.
 */
function Frame({ children, side }: { children: React.ReactNode; side: React.ReactNode }) {
  return (
    <div className="relative mx-auto -mt-5 max-w-page px-4 pb-8 sm:px-8">
      <div className="reveal grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0">{children}</div>
        <div className="hidden min-w-0 lg:block lg:pt-9">
          <div className="lg:sticky lg:top-6">{side}</div>
        </div>
      </div>
    </div>
  );
}
