"use client";

import { PROFILES } from "@/lib/profiles";
import type { ProfileId } from "@/lib/types";

/** Which log the entry goes in. Hidden when the person only has one active log. */
export function ProfilePicker({
  profiles,
  value,
  onChange,
}: {
  profiles: readonly ProfileId[];
  value: ProfileId;
  onChange: (profile: ProfileId) => void;
}) {
  if (profiles.length < 2) return null;
  return (
    <fieldset className="min-w-0">
      <legend className="label">Which log is this for?</legend>
      <div className="flex flex-col gap-2">
        {profiles.map((id) => {
          const p = PROFILES[id];
          return (
            <label
              key={id}
              className="group grid min-h-tap min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 rounded-xl bg-surface-2 px-4 py-2 has-[:checked]:bg-sign has-[:checked]:text-sign-ink"
            >
              <input
                type="radio"
                name="add-profile"
                value={id}
                checked={value === id}
                onChange={() => onChange(id)}
                className="h-5 w-5 cursor-pointer accent-[rgb(var(--amber))]"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-bold">{p.label}</span>
                  {id === "istructe" && (
                    <span className="badge badge-warn group-has-[:checked]:!bg-amber group-has-[:checked]:!text-[#14202b]">Provisional layout</span>
                  )}
                </span>
                <span className="block text-sm">{p.fullName}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
