# CPD Logger

A website for UK civil and highways engineers. Paste a link to a video, webinar, article or guidance page and CPD Logger reads the public page, drafts a CPD log entry with a badge on every field saying how it was found, and asks **you** to confirm the details and the time you actually spent. You add a line or two of takeaways, save the entry, see your dashboard update, and export your log to Excel in the layout of ICE or IStructE.

- **Logs:** ICE (header block plus the seven-column table), IStructE (**provisional**, see below) and Custom (your own fields).
- **Import:** bring in an existing record from Excel or CSV (and, with the AI feature on, from a screenshot), after reviewing every row.
- **Your data:** download everything, or delete your account, from Settings.
- **No billing and no payments.** Nothing is submitted to ICE or IStructE on your behalf, and there is no integration with either. Their CPD tools have no import feature, so the Excel file is for your own records, to attach, or to copy across by hand.

## Contents

1. [Run it with no keys](#run-it-with-no-keys)
2. [What the optional keys switch on](#what-the-optional-keys-switch-on)
3. [Going live: Supabase (London) and Vercel](#going-live)
4. [How accurate is this?](#how-accurate-is-this)
5. [The evaluation script](#the-evaluation-script)
6. [IStructE is provisional](#istructe-is-provisional)
7. [Tests and checks](#tests-and-checks)
8. [Safety and privacy design](#safety-and-privacy-design)
9. [Where things live](#where-things-live)
10. [Known limits](#known-limits)

## Run it with no keys

You need Node 22.19 or newer.

```bash
npm install
npm run dev          # http://localhost:3000
```

With no environment file at all the app runs in **local demo mode**: the database is a JSON file at `.data/local-db.json` (change it with `CPD_LOCAL_DB`) and sign-in is email-only with no password. That is for trying the app. Anyone who types an email address gets in, nothing proves who they are, and the file is not a hosted database. The sign-in page and the sidebar say so.

Local demo mode is allowed when `NODE_ENV` is not `production`, or when `CPD_LOCAL_MODE=true`. A production build without Supabase and without `CPD_LOCAL_MODE=true` refuses to start with a clear message.

Everything works with **no optional keys**:

| Without this | What happens instead |
|---|---|
| `YOUTUBE_API_KEY` | YouTube titles and channels come from YouTube's key-free oEmbed endpoint. It gives no length, so the length is marked **Not found** and you type it in. |
| `ANTHROPIC_API_KEY` | The "Expand my notes" button and screenshot import are hidden, with a plain explanation. You type your learning points and benefits yourself. |
| `SENTRY_DSN` | No error monitoring. |

All other readers use public pages and need no keys. The Settings page shows which optional features are on.

### Environment variables

Copy `.env.example` to `.env.local` and fill in only what you need. **Never put keys in chat, in code, or in a commit.** `.env.local` is git-ignored. Blank values count as "not set". Variables are validated with Zod at startup and the error messages never print values.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Switch from local demo mode to Supabase. Set both or neither. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Lets "Delete my account" remove the sign-in record too. |
| `ANTHROPIC_API_KEY` | Enables "Expand my notes" and screenshot import. Server only. |
| `LLM_MODEL` | Model name for those features. Default `claude-haiku-4-5-20251001`. |
| `AI_MONTHLY_CAP` | AI calls per user per month. Default 100. Protects your API bill; it is not billing. |
| `YOUTUBE_API_KEY` | Enables YouTube length and publish date. Sent in a header, never in a URL. |
| `SENTRY_DSN` | Enables error monitoring (server side only, with request data stripped). |
| `CPD_BOT_CONTACT` | A URL or email you are happy to publish, shown in the reader's User-Agent so site owners can contact you. |
| `EXTRACT_RATE_LIMIT_PER_HOUR` | Link reads per user per hour. Default 30. **Per server instance** (see Known limits). |
| `CPD_LOCAL_MODE`, `CPD_LOCAL_DB` | Local demo mode switches. |

Keys never reach the browser, logs, error reports or the database. Server code that holds a key is never imported by client code, error messages are scrubbed for key-shaped strings, and Sentry events have request data removed.

## What the optional keys switch on

- **Anthropic key.** Two features, both server side and both metered per user per month: *Expand my notes* turns your one or two lines into the learning-points and benefits fields (UK English, strictly within your notes), and *screenshot import* transcribes the text of a screenshot of an existing CPD record, which our own code then parses into rows. Only the title, provider, source type, theme and **your own notes** (or the screenshot you upload) are sent. Text copied from web pages is never sent. The reply must pass a schema check, is scanned for numbers and names that are not in your notes (shown as a warning), is labelled "AI-assisted, please review", and cannot be saved until you tick that you have read it.
- **YouTube key.** Length and publish date through the YouTube Data API.
- **Sentry.** Server-side error monitoring only.

## Going live

This section is written from the product's documentation and the migration's own tests. **It has not been run against a real Supabase project** (see Known limits), so expect to check each step.

### 1. Create the Supabase project (London)

1. Sign in at supabase.com and choose **New project**.
2. **Region: "West Europe (London)"** (`eu-west-2`). This keeps your colleagues' data in the UK.
3. Set a strong database password and keep it in your password manager. The app never needs it.

### 2. Copy three values into `.env.local`

In the dashboard open **Project Settings → API** (the page may be called **API Keys**):

| Copy this | Into this variable |
|---|---|
| Project URL (`https://xxxx.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` key, or the newer **publishable** key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` key, or the newer **secret** key (keep private) | `SUPABASE_SERVICE_ROLE_KEY` |

The service-role key is optional but needed for "Delete my account" to remove the sign-in record. Without it, deletion removes all entries and settings and tells the person to ask you to remove the sign-in record.

### 3. Create the tables

Open **SQL Editor**, paste the contents of `supabase/migrations/0001_init.sql`, and run it. (Or use the Supabase CLI: `supabase link` then `supabase db push`.)

It creates organisations, org members, user settings, CPD entries (with soft delete), AI usage, the `increment_ai_usage` function, and the `org_member_summary` function that gives an organisation admin **hours per member without exposing any entries**. Row-level security is on for every table, so each person sees only their own rows. The file's header explains one assumption to check: the role that runs migrations should be able to bypass RLS. Check it with:

```sql
select rolbypassrls from pg_roles where rolname = 'postgres';
```

There is **no seed script and no sample data**: the app never creates fake entries. Organisations are created by you in the SQL editor for now (the team screens are Phase 2).

### 4. Turn on email sign-in

**Authentication → Providers:** keep **Email** enabled. **Authentication → URL Configuration:**

- **Site URL:** your production address.
- **Redirect URLs:** add `https://YOUR-DOMAIN/auth/callback` and, for local work, `http://localhost:3000/auth/callback`.

Sign-in is by emailed one-time link. Supabase's built-in email sender is heavily rate limited, so for about ten colleagues set up **custom SMTP** under **Authentication → SMTP Settings**. Google sign-in is not built yet.

### 5. Deploy to Vercel

1. Import the repository in Vercel. `vercel.json` pins functions to London (`lhr1`).
2. Add the environment variables above in **Project Settings → Environment Variables** (not in the repository).
3. Deploy. A production build without Supabase will refuse to start, by design.

## How accurate is this?

Honestly: **it is not known.** What exists:

- Hand-written HTML fixtures prove that each reader's *logic* works on the markup we imagined. They are not captures of the live sites, so they say nothing about how often a real page is read correctly.
- Nothing here has been measured against the live sites. The evaluation script below is how you measure it, on pages you have checked yourself.
- Badges describe how a value was found, **not that it is right**: **High** is read from a clear label or machine-readable data; **Check** is a guess; **Estimate** is calculated (for example reading time from word count, which is not learning time); **Not found** means nothing reliable was found. None of them means "verified". You confirm every entry.
- On the ICE Knowledge Hub, only the exact web-address slug `safety-risk` is treated as a High-confidence theme. Other slugs are guesses marked Check, and the theme names should be confirmed against ICE's framework page.
- Time spent is always your own figure and is never saved until you tick the confirmation box.
- The in-app Help page says the same.

## The evaluation script

```bash
npm run eval
```

It reads `eval/urls.csv` (columns `url,title,provider,sourceType,durationMinutes,publishedAt,eventDate,theme`; a blank cell means "don't score"), runs the **real reader live** over each URL one at a time with a pause between them, and writes `eval/report.md` with, per field, how many values were correct, wrong or not found, and how often a **High** badge was right.

- **Where your inputs go:** put the five YouTube links and your own checked pages in `eval/urls.csv`, with the expected values you have checked by hand. The file already lists the six first evaluation URLs with blank expectations.
- Add `YOUTUBE_API_KEY` to `.env.local` to include the YouTube Data API in the run.
- It respects robots.txt and never tries to get around a block, so a blocked site shows up as "not read".
- The reader does its own DNS lookups to guard against private addresses, and does not use `HTTP_PROXY` settings. On a machine that can only reach the internet through a proxy every URL will report "couldn't find a website". That is what happened in the sandbox the app was built in, so **no live results exist yet**.

## IStructE is provisional

The IStructE profile is built from published guidance about the 2026 mandatory reporting, **not from the real My Account form**. Fields: Date, Activity title, Category (Work-based learning, Self-directed study, Courses, events and seminars, Horizon broadening), Hours, Structural safety (Y/N), Sustainability (Y/N), Development gained. Targets: 30 hours a year including 6 structural safety and 6 sustainability, and 90 over a rolling three years.

It is marked **provisional** in the app, on the dashboard panel, on the export preview and on the IStructE sheet in the file. **Please compare it with a screenshot of the real form.** To change it, edit `src/config/profiles.json` (the `istructe` section: `columns`, `categories`, `rules`); layouts are config, not code. A user can only log an entry to one log at a time; there is no "log to both ICE and IStructE" option yet.

ICE's themes are also config: mandatory themes are *Ethical and professional behaviours*, *Safety and risk management* and *Sustainable development*; additional themes are *Delivery excellence*, *Energy*, *Transport* and *Water*. The names are to be confirmed against ICE's framework page. The dashboard shows "themes recorded" (at least one mandatory theme each year, all three over a rolling three years) and never says "compliant". ICE sets no hours target for qualified members, so hours are information only.

## Tests and checks

```bash
npm run lint
npm run typecheck
npm test            # Vitest unit tests
npm run build
npm run e2e         # Playwright against a production build in local mode
```

`npm run e2e` expects a production build (`npm run build`) first. To use a system Chromium set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; otherwise run `npx playwright install chromium` once. CI (`.github/workflows/ci.yml`) runs install, lint, typecheck, unit tests, build and Playwright.

The unit tests cover dates, network safety (IP ranges, redirects, robots.txt), every reader against fixtures, import parsing, export (read back with exceljs), compliance, the stores, and the AI layer (with a fake provider and a mocked `fetch`, never the real API). The end-to-end test and the accessibility checks (axe, WCAG 2.1 A/AA) run against the real built app.

## Safety and privacy design

- **Fetched pages are untrusted data.** They are parsed for metadata only and never reach an LLM.
- **SSRF protection.** http/https only, no embedded credentials, ports 80/443 only, blocked hostnames and suffixes, literal IPs checked, every resolved address checked, connections pinned to the checked address, redirects followed by hand and re-validated on every hop (maximum 5), 8-second timeout, 2 MB body cap, no cookies.
- **Polite.** Identifiable User-Agent `CPDLoggerBot/1.0 (+contact)`, robots.txt obeyed (a missing file means allow; a server error means "we couldn't confirm the site allows automated reading", not "the site says no"), results cached briefly. Sites that block bots, need a login or show a bot challenge are not circumvented: you see "Couldn't read this site automatically", the link is kept, and the manual form opens.
- **Stores only** metadata and your own text, never page text or transcripts.
- **UK GDPR.** Per-user isolation by row-level security, account data export and deletion in Settings, `/privacy` and `/terms` pages, no analytics or advertising tracking. **The privacy and terms pages are templates with bracketed placeholders for you to complete and have checked. They are not legal advice.**
- **Same-origin checks** on every route that changes data; per-user rate limit on link reading (in memory, per instance).

## Where things live

```
src/app/                 pages and API routes (App Router)
src/config/profiles.json ICE, IStructE and Custom layouts, themes, targets
src/lib/adapters/        the readers: YouTube, ICE Knowledge Hub, event pages, gov documents, generic
src/lib/net/             SSRF guard, polite fetch, robots.txt, bot-challenge detection
src/lib/extract.ts       URL -> draft entry with per-field confidence
src/lib/import, export/  spreadsheet import and Excel export
src/lib/llm/             provider-agnostic AI layer, metering, claim scan
src/lib/store/           one Store interface: local JSON file or Supabase
supabase/migrations/     database schema and row-level security
eval/urls.csv            your URLs and expected values; report goes to eval/report.md
tests/                   unit tests, hand-written fixtures, Playwright journey
```

## Known limits

- **Live accuracy is unmeasured.** The fixtures are hand-written, not captures of real pages.
- **ICE theme slugs** other than `safety-risk` are guesses, and ICE's theme names are to be confirmed against its framework page.
- **IStructE is provisional** until compared with the real form.
- **AI features are untested against the real Anthropic API.** They are tested with a fake provider and a mocked `fetch`.
- **Supabase mode is untested against a real project.** The migration was run on a local PostgreSQL 16 with a stand-in for Supabase's auth schema; the store was tested against fakes.
- **The rate limit is per server instance.** On serverless hosting each instance counts separately, so it is a cost guard, not a hard limit. The extraction cache and robots.txt cache are per instance too.
- **Local demo mode** proves nothing about who someone is, and its JSON file protects against concurrent writes within one process only.
- **Excel files have not been opened in real Excel, LibreOffice or Google Sheets**; they are read back with exceljs in the tests.
- **Phase 2 is not built:** the team workspace screens (the schema and the aggregate function exist), Google sign-in, and the final IStructE fields.
- No "log to both ICE and IStructE" option.
