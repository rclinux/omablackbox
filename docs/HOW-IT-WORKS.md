# How OmaBlackbox works

This note explains the design and the measurements behind a few decisions that
look odd at first glance. The measurements were taken on one desktop (a 19-session
journal, one boot of which logged about 2.2 million kernel lines while an NVIDIA
GPU was failing), so read the numbers as orders of magnitude.

## Shape

```
                 ┌─────────────────────── omarchy-shell (one process) ───────────────────────┐
journalctl -f ──▶│ Service.qml ──▶ Incidents.js ──▶ rows ──▶ BarWidget.qml (dot, one/monitor) │
journalctl scans │  engine, one       group lines       │                                      │
                 │  shared instance   into incidents    └──▶ Panel.qml (timeline)             │
state.json  ◀──▶ │                                                                            │
                 └────────────────────────────────────────────────────────────────────────────┘
```

- **`Service.qml`** is the manifest's `service` kind, so the shell keeps exactly
  one, however many monitors there are. It runs the follower, the history scans
  and the notifications. If the host cannot hand the widget the service (an older
  shell), the widget falls back to a private engine.
- **`lib/*.js`** holds all logic as plain functions with no QML dependency, so it
  is unit tested under Node: `Rules` (detectors), `Incidents` (grouping),
  `Journal` (journalctl arguments, parsers, flood guard), `Redact`, `Report`,
  `Format`, `Preview`.
- **`BarWidget.qml` / `Panel.qml` / `IncidentRow.qml`** draw the result. Colours
  come from the active Omarchy theme (`Tones.qml`).

## Detection

Each detector matches one family of kernel messages and decodes it into a title,
severity and explanation. Incidents are built by grouping lines by a key (for
example one NVIDIA GPU, one disk, one PCIe device) that arrive within 60 seconds.
An incident takes the worst severity and the most specific title seen, and keeps
the ordered sequence of steps plus the first 30 and latest 10 raw lines.

## Session ended without a clean shutdown

For each earlier session, OmaBlackbox asks whether *systemd itself* (PID 1) logged
its shutdown sequence, such as `Stopped target Local File Systems.`. If not, the
session ended abruptly. Two details matter:

- The marker must come from PID 1. `Reached target Shutdown` and "shutting down"
  are also logged by the per-user manager and by ordinary applications at plain
  logout, so they cannot vouch for the system. An earlier version used them and
  wrongly called every crashed session clean.
- Restricting the search to PID 1 also makes it fast: about 45 ms for 18 sessions,
  against 3.5 s searching every entry.

## Keeping the desktop responsive

A driver in trouble can write an enormous amount. One boot on the development
machine contained 2,184,079 lines of the same `NVRM: gpuHandleSanityCheck…`
message. Three things keep that harmless:

1. **The journalctl prefilter is anchored to the start of the message.** Unanchored,
   PCRE tried every alternative at every character and scanning that one boot took
   69 s. Anchored, the same scan takes 20 s uncapped and 0.19 s with the cap below.
2. **Scans are capped at 20,000 events** and run under `nice -n 19`. A capped
   incident is marked (`20,000+ lines`) so its counts are never presented as exact.
3. **The live follower is rate limited** with a token bucket (300 lines per second
   sustained). Lines shed during a flood are credited to the incident they belong
   to, so the count stays honest.

Finished sessions never change, so their results are cached in
`~/.local/state/omablackbox/state.json` and only new sessions are scanned on
later starts. A missing, corrupt or hostile state file is ignored and rebuilt
from the journal.

## Privacy

Everything shown or exported passes through `lib/Redact.js`. PCI addresses, error
codes, driver versions and timestamps are kept on purpose: they are what makes a
report useful. Identifiers are masked; there is a test that builds a report from
lines full of synthetic identifiers and asserts none survive.

## What is not here

No network access, no telemetry, no root, no writes outside the plugin's own
state folder, and no value read from the journal ever placed in a command line
(the only `sh -c` wrappers receive their inputs as separate arguments).
