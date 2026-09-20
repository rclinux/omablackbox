# Changelog

## 0.1.0 (unreleased)

First version.

- Bar widget: a single dot, hollow when quiet, filled in the severity colour with a count when something needs attention.
- Panel: a plain-English headline and a timeline of incidents grouped by day; expand one for its meaning, sequence and log lines.
- 40 detectors: NVIDIA Xid (22 codes described), AMD and Intel GPU hangs, PCIe errors, machine-check and ECC memory errors, NVMe and SATA failures, filesystem errors, USB and Wi-Fi firmware faults, thermal throttling, kernel panics, oopses and lockups.
- Detects a session that ended without systemd's shutdown sequence, and joins it to a critical fault just before it.
- Desktop notification for a new critical event and for a recent session that ended abruptly.
- Report export (copy or save) with identifiers masked.
- Shared service so several monitors never run duplicate journal followers.
- Flood protection, capped niced scans, and a cache of finished sessions.
- Preview mode (sample events, all quiet, can't read the log).
- Command line: `omarchy-shell omablackbox status|acknowledge|refresh|copy|save`.
