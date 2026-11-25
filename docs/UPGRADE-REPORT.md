# Implementation report — feature/routines-calendar-brief

Not merged to `main` and not published to phones (awaiting approval).

## Completed
| Stage | What |
|---|---|
| A | Routine engine: Upon Alert / Once a Day / Once a Week / Custom (+ legacy kinds), time zones without Intl (DST tested), runs with honest status, locking, dedupe, timeouts/deadlines, retries, missed-run catch-up/skip, restart recovery; 8 routine tools; routine editor with live preview and history; permissions *Allow once / Always allow this type / Deny* for every bot, revocable per bot |
| — | web_fetch opens JavaScript-built pages in the phone's background browser (your mid-mission request) |
| B | Calendars across all connected Google accounts (alias, name, owner/can edit/read-only), explicit destination (never the default by guess), write test, duplicate check, verified creation, plain diagnostics; `calendar_list`, `calendar_create_event` |
| C | Morning Brief data: Staff Update via Drive title+content+date+type+week terms (link kept), sport-matrix tab normalisation (spaces/"Copy of"/duplicates/week & term numbers; missing week = warning, never last week's), Thursday rows by your name/code, structured CMW term dates (confirmed flags, no NSW assumptions), brief preferences confirmed vs assumed; `morning_brief_prepare`, `morning_brief_publish` |
| D | Briefing screen (📰): day, summary, warnings, schedule, Staff Update, sport, notices, calendar status, proposed events with Add/Dismiss, sources, history, refresh, settings incl. term-date editor; notification opens the full briefing |
| E | Weekly audit routine (Sun 07:52 Australia/Sydney, 5-min research cutoff enforced, 08:00 deadline), scoring /25 with safety hard gate (+ wording backstop), phases, dedupe, private-GitHub wiki filing with read-back, report from recorded data only, incomplete runs reported; `audit_begin/score/file_overflow/finish`, `skills_market_search` |
| Models | Per-bot model choice: Claude short names (opus, sonnet, haiku, fable) and numbered ids (claude-fable-5-2, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, earlier 4.x/3.x), ChatGPT default or typed models, API/local lists (refresh) or typed; any number of your own endpoints (phone, PC, API); “Check this model” test; working typed models remembered |
| F | `device_location` (fused provider, permission states, freshness, accuracy, stale marking, no fabricated coordinates, no history), 📍 indicator naming the requester, location settings; geofence kind modelled, refused until activation, events already drive Upon Alert routines |

## Partially completed / blocked
- **Wiki:** needs the private repo `DanGeo13/mausdroid-routine-wiki` to exist and a fine-grained GitHub token (Contents read/write on that repo) saved in Settings → Memory. MausDroid won't create it or write to a public repo. Notion fallback is not implemented.
- **Composio tool slugs/inputs** (Calendar, Drive, Sheets) are read from Composio at run time, but were tested only against a stand-in; first real run on the phone may need small adjustments.
- **CMW term dates** must be entered and confirmed by you (Morning Brief → Settings); none are assumed.
- **Geofence activation** intentionally off (see docs/GEOFENCE.md).
- **Your existing Morning Brief routine** was not modified; the new built-in "Morning Brief" routine is created only when you tap Refresh/Make today's brief.
- Not run on the POCO F8 yet; APK builds (not installed or published).

## New routine schedule options
Upon Alert (type/source/priority/contains, duplicate protection) · Once a Day (time, zone) · Once a Week (weekdays, time, zone, missed-run policy) · Custom (interval ≥15 min, specific dates, every N days at times/weekdays, window, conditions).

## New MCP / bot tools
routine_create, routine_list, routine_update*, routine_delete*, routine_run_now, routine_history, routine_pause, routine_resume, calendar_list, calendar_create_event*, morning_brief_prepare, morning_brief_publish, audit_begin, audit_score, audit_file_overflow, audit_finish, skills_market_search, device_location* (\* always asks; can be always-allowed per bot by type). Available to API bots and to Claude Code/Codex through MausDroid's MCP server.

## Permissions
New Android: ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION (asked only from Settings). Existing: RECORD_AUDIO etc. No background-location permission requested.

## Data changes (automatic, backward compatible)
New files in the engine data folder: routine-runs.json, calendar.json, brief.json, audits.json, location-uses.json. routines.json gains defaults (retry, timeout, nextKey); old schedules keep working. No signing keys changed.

## Tests
32 tests (31 pass, 1 relay test skipped without wrangler) on Node 18 with the phone's limits (no Intl/TextDecoder/WebAssembly): schedule maths incl. DST, routine engine (all four kinds, edit, pause/resume, run-now, retries, alerts, duplicates, missed runs, restart), web_fetch detection, calendar (multi-account, read-only, writable, duplicate, failed/verified write), Morning Brief rules and end-to-end, weekly audit rules and end-to-end, location and geofence events, per-bot models (each bot runs its own model, check, endpoints), plus the earlier smoke/subscription/attachment suites. Type-check: engine + UI pass. APK: builds.

## Commits
612605c, 2e9dfcb, 4b11c93, 6cffabd, c9a1d37, e9bfaa9 (+ this report).
