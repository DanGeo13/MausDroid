# Place-based (geofence) routines — prepared, not switched on

## What exists now
- **Schedule model:** `kind: "geofence"` with `geofence: { lat, lng, radiusM (100 m–50 km), on: "enter" | "exit" }`
  (`engine/src/schedule.ts`), validated and described ("When you arrive at a place…").
- **Creation is refused** with "prepared but not switched on" (`routines.ts → check()`), so no routine
  can silently depend on it.
- **Event path works today:** a geofence event arriving as an alert
  (`POST /api/alerts/incoming { type: "geofence", id, title: "Entered home" }`) starts matching
  *Upon Alert* routines once (duplicate events ignored). This is how Android geofence transitions will
  be delivered, so routines don't need redesigning.
- **Location permission + indicator** (`device_location`, 📍 banner, use log without coordinates).

## Switching it on later (one release)
1. Android: register each fence with `LocationManager.addProximityAlert` (no Google Play Services
   dependency) or Play Services `GeofencingClient` if that dependency is approved — both are
   OS-managed and battery-efficient; **no continuous GPS polling**.
2. A `BroadcastReceiver` turns enter/exit transitions into `/api/alerts/incoming` with
   `type: "geofence"` and an event id (`<fenceId>:<enter|exit>:<minute>`) for duplicate protection.
3. Fences are stored in the engine and re-registered at boot (`BootReceiver`) and after app updates.
4. Turning a fence on uses the approval framework (`permission` type `geofence`) and shows an
   "active places" indicator in Settings → Phone → Location.
5. Needs "Allow all the time" location (Android shows this option for the app); if the person keeps
   "only while using the app", MausDroid explains that fences can't fire in the background and offers
   time-based routines instead.

## Known Android limits
- HyperOS can delay background broadcasts unless Autostart + "No restrictions" battery are set
  (already part of Settings → Phone).
- Proximity alerts fire on the OS's schedule (typically within a few minutes), not instantly.
