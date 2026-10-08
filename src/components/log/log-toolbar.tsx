"use client";

import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import { PROFILES } from "@/lib/profiles";
import { PROFILE_IDS, SOURCE_TYPES, SOURCE_TYPE_LABELS, type ProfileId, type SourceType } from "@/lib/types";
import { NO_THEME, SORT_OPTIONS, entriesWord, sortValue, type LogQuery, type ThemeChoices } from "./log-filters";

function SelectField({ id, label, className = "", children, ...rest }: { id: string; label: string; className?: string; children: React.ReactNode } & React.ComponentProps<"select">) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select id={id} className="select" {...rest}>
        {children}
      </select>
    </div>
  );
}

/**
 * The search box, the four filters and (below the table breakpoint) the sort choice. On a phone the
 * filters fold away behind one button so the first entries are on screen sooner.
 */
export function LogToolbar({
  query,
  years,
  themes,
  filtersOpen,
  resultCount,
  onToggleFilters,
  onChange,
  searchRef,
}: {
  query: LogQuery;
  years: string[];
  themes: ThemeChoices;
  filtersOpen: boolean;
  /** How many entries the current filters leave, for the "Show N entries" button on phones. */
  resultCount: number;
  onToggleFilters: () => void;
  onChange: (patch: Partial<LogQuery>) => void;
  searchRef: React.Ref<HTMLInputElement>;
}) {
  const filterCount = [query.year, query.log, query.theme, query.type].filter(Boolean).length;
  return (
    <div role="search" aria-label="Search and filter your log" className="band space-y-3 !p-4 sm:!p-5">
      <div>
        <label htmlFor="log-search" className="label">
          Search your log
        </label>
        <div className="relative">
          <Search aria-hidden="true" size={20} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
          <input
            id="log-search"
            ref={searchRef}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="input !pl-12"
            placeholder="Title, provider or theme"
            value={query.q}
            maxLength={200}
            onChange={(e) => onChange({ q: e.target.value })}
          />
        </div>
      </div>

      <button
        type="button"
        className="btn btn-secondary w-full justify-between lg:hidden"
        aria-expanded={filtersOpen}
        aria-controls="log-filters"
        id="log-filters-toggle"
        onClick={onToggleFilters}
      >
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal aria-hidden="true" size={19} />
          Filter and sort
        </span>
        <span className="inline-flex items-center gap-2">
          {filterCount > 0 && <span className="badge badge-info">{filterCount} on</span>}
          <ChevronDown aria-hidden="true" size={19} className={filtersOpen ? "rotate-180" : ""} />
        </span>
      </button>

      <div id="log-filters" className={`${filtersOpen ? "grid" : "hidden"} grid-cols-2 gap-3 lg:flex lg:flex-wrap`}>
        <SelectField id="log-year" label="Year" className="lg:basis-[7.5rem]" value={query.year} onChange={(e) => onChange({ year: e.target.value })}>
          <option value="">All years</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </SelectField>

        <SelectField id="log-log" label="Log" className="lg:basis-[9.5rem]" value={query.log} onChange={(e) => onChange({ log: e.target.value as ProfileId | "" })}>
          <option value="">All logs</option>
          {PROFILE_IDS.map((id) => (
            <option key={id} value={id}>
              {PROFILES[id].label}
            </option>
          ))}
        </SelectField>

        <SelectField id="log-theme" label="Theme" className="col-span-2 lg:flex-1 lg:basis-[15rem]" value={query.theme} onChange={(e) => onChange({ theme: e.target.value })}>
          <option value="">All themes and categories</option>
          <optgroup label="ICE themes">
            {themes.ice.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
          <optgroup label="IStructE categories">
            {themes.istructe.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
          {themes.other.length > 0 && (
            <optgroup label="Other in your log">
              {themes.other.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </optgroup>
          )}
          <option value={NO_THEME}>No theme or category</option>
        </SelectField>

        <SelectField id="log-type" label="Source type" className="col-span-2 lg:col-span-1 lg:basis-[11rem]" value={query.type} onChange={(e) => onChange({ type: e.target.value as SourceType | "" })}>
          <option value="">All types</option>
          {SOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {SOURCE_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>

        {/* The table has its own sort buttons. Phones and tablets show cards, so they get a sort choice here. */}
        <SelectField id="log-sort" label="Sort by" className="col-span-2 lg:col-span-1 lg:basis-[13rem] xl:hidden" value={sortValue(query)} onChange={(e) => onChange(sortFromValue(e.target.value))}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>

        {/* Phones only: close the panel and go back to the list, so the result of a choice is easy to see. */}
        <button
          type="button"
          className="btn btn-primary col-span-2 mt-1 lg:hidden"
          onClick={() => {
            onToggleFilters();
            document.getElementById("log-filters-toggle")?.focus();
          }}
        >
          {resultCount > 0 ? `Show ${resultCount} ${entriesWord(resultCount)}` : "Close filters"}
        </button>
      </div>
    </div>
  );
}

function sortFromValue(value: string): Pick<LogQuery, "sort" | "dir"> {
  const [sort, dir] = value.split("-");
  return { sort: sort as LogQuery["sort"], dir: dir as LogQuery["dir"] };
}
