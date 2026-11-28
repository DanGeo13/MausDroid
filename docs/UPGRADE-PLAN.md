# DanDroid upgrade plan: routines, calendar, Morning Brief, audit, location

Branch: `feature/routines-calendar-brief` (not merged to `main` until approved).

## Baseline (before changes)
- Type-check (engine + UI): pass. Engine tests on Node 18 with phone limits (no Intl /
  TextDecoder / WebAssembly): 3/3 pass. APK 0.3.1 builds; engine 0.3.2 published.
- Phone Node has no Intl. Time zones are handled by temporarily setting `TZ` (Bionic/glibc
  tz database): verified on Node 18 without Intl, including Sydney DST start/end.

## Existing primitives reused
| Need | Existing piece |
|---|---|
| Scheduling | `routines.ts` + `scheduler.ts` (extended, not replaced; old once/interval/daily/weekly kept) |
| Running a routine | `agent.sendToBot` (now tagged so runs get their real result) |
| Approvals | `approvals.ts` cards + notification Allow/Deny (extended with permission *types*) |
| Tools for API bots and Claude Code/Codex | `tools/index.ts` + `mcp-server.ts` (new tools appear in both) |
| Connected apps | `composio.ts` (adds direct tool execution for Calendar/Drive/Sheets) |
| Memory / alerts | `memory.ts`, `notify.ts` (alerts now also feed "Upon Alert" routines) |
| Phone features | Android bridge (adds location) |

## Stages and acceptance criteria
- **A. Routines.** Unified schedule model with 4 options (Upon Alert, Once a Day, Once a Week,
  Custom) + legacy kinds; persistent runs with status (queued/running/succeeded/failed/
  timed_out/missed/skipped), locking, dedupe by occurrence key, retries, timeouts, missed-run
  policy, restart recovery; 8 routine tools with ownership and approvals. *Accept:* tests for all
  schedule types, DST, pause/resume, run-now, missed runs, duplicates, restart.
- **B. Calendar.** Discover calendars across connected Google accounts (Composio), show alias +
  name + access role, explicit destination, write test, duplicate check, verified creation.
  *Accept:* tests with a stand-in Composio: multi-account, read-only, writable, duplicate,
  failed write, verified write.
- **C. Morning Brief data.** Drive Staff Update discovery (title/content/date/type/week terms),
  sport-matrix worksheet normalisation (spaces, duplicates, "Copy of", week numbers, missing
  week = warning, never last week's), structured term dates (only user-confirmed), brief
  preferences (confirmed vs assumed). *Accept:* unit tests for each case.
- **D. Briefing view.** Dedicated screen: schedule, events, Staff Update, sport, notices,
  warnings, sources, calendar status, history, refresh, approve proposed events; notification
  opens it.
- **E. Weekly audit.** Sunday 07:52 Australia/Sydney routine, 5-min research cutoff enforced by
  the engine, 08:00 hard deadline, scoring /25 with safety hard gate, phases, dedupe, wiki
  filing to a *private* GitHub repo (verified read-back), report, memory + notification;
  incomplete runs reported as incomplete. *Accept:* tests for cutoff, scoring, safety, dedupe,
  filing, counts, notification, memory.
- **F. Location + geofence-ready.** `device_location` (Android fused provider, runtime
  permission, freshness, accuracy, never fabricated), visible indicator naming the requester;
  geofence schedule kind modelled + validated + approval-gated, activation left off.
- **Permissions (all bots).** Approval cards offer *Allow once* and *Always allow this type*
  (per bot, revocable in the bot editor), plus Deny.
