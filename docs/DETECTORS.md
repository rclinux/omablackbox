# What OmaBlackbox detects

Generated from `lib/Rules.js` by `scripts/gen-detectors-doc.mjs`. Detectors are deliberately conservative: a line only counts if it is a fault, never because it merely mentions a subsystem. A missed benign line costs nothing; a false alarm costs trust.

Severity: **critical** means data or a device is likely lost, **warning** means something failed but the system carried on, **notice** means usually harmless (hidden by default).

| Area | Event | Severity | Rule id |
|---|---|---|---|
| GPU | GPU fell off the bus | critical | `nvidia.fell-off` |
| GPU | GPU stopped responding | critical | `nvidia.unreachable` |
| GPU | GPU registers unreadable | critical | `nvidia.bad-register-read` |
| GPU | GPU reset failed | critical | `amdgpu.reset-failed` |
| GPU | GPU hung and was reset | warning | `amdgpu.reset-ok` |
| GPU | GPU command ring timed out | warning | `amdgpu.ring-timeout` |
| GPU | GPU reset started | warning | `amdgpu.reset-begin` |
| GPU | GPU memory page fault | warning | `amdgpu.page-fault` |
| GPU | Intel GPU hang | warning | `i915.hang` |
| GPU | Intel GPU job timed out | warning | `xe.timeout` |
| GPU | Display update timed out | warning | `drm.flip-timeout` |
| PCIe | PCIe device stopped responding | critical | `pcie.inaccessible` |
| Memory | Uncorrectable memory error (ECC) | critical | `memory.ecc-ue` |
| Memory | Correctable memory error (ECC) | warning | `memory.ecc-ce` |
| Memory | Kernel isolated a failing memory page | critical | `memory.hwpoison` |
| Memory | Out of memory: a process was killed | warning | `memory.oom` |
| CPU | Machine-check hardware error | critical | `cpu.mce` |
| CPU | CPU hard lockup | critical | `cpu.hard-lockup` |
| CPU | CPU soft lockup | warning | `cpu.soft-lockup` |
| CPU | CPU stall detected | warning | `cpu.rcu-stall` |
| Thermal | Critical temperature reached | critical | `thermal.critical` |
| Thermal | CPU thermal throttling | warning | `thermal.throttle` |
| NVMe | NVMe drive stopped responding | critical | `nvme.dead` |
| NVMe | NVMe command timed out | warning | `nvme.timeout` |
| Storage | SATA link or drive error | warning | `storage.ata` |
| Storage | Disk read/write error | warning | `storage.io-error` |
| Storage | Disk read/write error | warning | `storage.buffer-io` |
| Filesystem | Filesystem went read-only | critical | `fs.readonly` |
| Filesystem | Filesystem error (ext4) | critical | `fs.ext4` |
| Filesystem | Filesystem error (Btrfs) | critical | `fs.btrfs` |
| Filesystem | Filesystem error (XFS) | critical | `fs.xfs` |
| USB | USB host controller failed | critical | `usb.host-dead` |
| USB | USB device failed to connect | warning | `usb.enumerate` |
| Network | Network adapter stalled | warning | `net.watchdog` |
| Network | Wi-Fi firmware error (Intel) | warning | `net.iwlwifi` |
| Bluetooth | Bluetooth adapter timed out | notice | `bt.timeout` |
| Kernel | A task hung | warning | `kernel.hung-task` |
| Kernel | Kernel panic | critical | `kernel.panic` |
| Kernel | Kernel oops | critical | `kernel.oops` |
| Kernel | Kernel warning | notice | `kernel.warn` |

### PCIe errors (severity follows the error class)

| Reported by the kernel | Shown as | Severity |
|---|---|---|
| `severity=Corrected` / AER *Corrected* | PCIe corrected error | notice |
| `Uncorrected (Non-Fatal)` | PCIe uncorrected error (non-fatal) | warning |
| `Uncorrected (Fatal)` | PCIe uncorrected error (fatal) | critical |

### NVIDIA Xid codes with a specific description

Any other Xid is shown as *NVIDIA driver reported Xid N* (warning). An Xid says what the driver saw, not why.

| Xid | Shown as | Severity |
|---|---|---|
| 13 | Graphics engine exception | warning |
| 31 | GPU memory page fault | warning |
| 32 | Corrupted GPU command stream | warning |
| 43 | GPU stopped processing | warning |
| 45 | GPU cleaned up after earlier errors | warning |
| 48 | GPU memory double-bit error | critical |
| 56 | Display engine error | warning |
| 61 | GPU microcontroller warning | warning |
| 62 | GPU microcontroller halted | critical |
| 63 | GPU memory page retirement recorded | notice |
| 64 | GPU memory page retirement failed | warning |
| 68 | Video decoder exception | warning |
| 69 | Graphics engine class error | warning |
| 74 | NVLink error | warning |
| 79 | GPU fell off the bus | critical |
| 92 | High rate of correctable GPU memory errors | warning |
| 94 | Contained GPU memory error | warning |
| 95 | Uncontained GPU memory error | critical |
| 119 | GPU system processor timed out | critical |
| 120 | GPU system processor error | critical |
| 121 | GPU chip-to-chip link error | warning |
| 154 | GPU recovery action changed | critical |

## Session ended without a clean shutdown

Separately from the log lines, OmaBlackbox notices when an earlier session's log stops without systemd's shutdown sequence (power loss, hard reset, freeze or crash). When a critical fault occurred in the last three minutes of that session, the two are shown as one event.
