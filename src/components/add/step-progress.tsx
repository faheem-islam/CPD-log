import { Check } from "lucide-react";

export type WizardStep = "details" | "hours" | "takeaways" | "save";

export const WIZARD_STEPS: readonly { id: WizardStep; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "hours", label: "Time spent" },
  { id: "takeaways", label: "Takeaways" },
  { id: "save", label: "Save" },
];

/** Where the person is in the four review steps. Text and numbers carry the state, not colour alone. */
export function StepProgress({ current }: { current: WizardStep }) {
  const index = WIZARD_STEPS.findIndex((s) => s.id === current);
  const label = WIZARD_STEPS[index]?.label ?? "";
  return (
    <div>
      <p className="text-sm font-bold text-muted sm:hidden">
        Step <span className="num">{index + 1}</span> of <span className="num">{WIZARD_STEPS.length}</span>: {label}
      </p>
      <ol className="hidden flex-wrap gap-2 sm:flex" aria-label="Steps">
        {WIZARD_STEPS.map((s, i) => {
          const state = i < index ? "done" : i === index ? "current" : "todo";
          return (
            <li
              key={s.id}
              aria-current={state === "current" ? "step" : undefined}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${
                state === "current" ? "bg-sign text-sign-ink" : state === "done" ? "bg-surface-2 text-ink" : "text-muted"
              }`}
            >
              {state === "done" ? <Check aria-hidden="true" size={14} strokeWidth={3} /> : <span className="num" aria-hidden="true">{i + 1}</span>}
              <span>
                {s.label}
                {state === "done" && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
