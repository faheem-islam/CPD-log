# Test fixtures

These fixtures are hand-written to exercise the extraction logic. They are NOT captures of the live
sites and prove nothing about live accuracy.

- The HTML is written to look like ordinary page markup so the adapters have something realistic to
  read. It makes no claim to match what any real website serves today. Real pages change, and the
  selectors and wording the adapters look for have not been checked against them.
- All names, dates, titles, organisations' pages and document text in these files are invented for
  testing. Where a file uses a real organisation's name or web address pattern, that is only so the
  adapter that matches that host has something to run on.
- The JSON files are hand-written in the shape documented for the YouTube Data API v3 `videos.list`
  response and the YouTube oEmbed response. They are not real responses.
- A passing test here means the code does what the fixture asks of it. It does not mean the adapter
  is accurate on the live site. Check any detail you rely on.

Dates in the fixtures are compared against a fixed "now" of 2026-10-07 in the tests, so they do not
go stale.
