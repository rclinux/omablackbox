import test from "node:test"
import assert from "node:assert/strict"
import { Rules } from "./load.mjs"

// [message, rule id, class, severity, title fragment]
const POSITIVE = [
  ["NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.", "nvidia.xid", "gpu", "critical", "GPU fell off the bus"],
  ["NVRM: Xid (PCI:0000:01:00): 79, pid=1234, name=game, GPU has fallen off the bus.", "nvidia.xid", "gpu", "critical", "GPU fell off the bus"],
  ["NVRM: Xid (PCI:0000:01:00): 154, GPU recovery action changed from 0x0 (None) to 0x2 (Node Reboot Required)", "nvidia.xid", "gpu", "critical", "recovery action changed"],
  ["NVRM: Xid (PCI:0000:01:00): 13, pid=1234, name=game, Graphics Exception: ESR 0x404600=0x80000002", "nvidia.xid", "gpu", "warning", "Graphics engine exception"],
  ["NVRM: Xid (PCI:0000:03:00): 31, pid=88, name=app, Ch 00000010, MMU Fault", "nvidia.xid", "gpu", "warning", "page fault"],
  ["NVRM: Xid (PCI:0000:03:00): 999, something new", "nvidia.xid", "gpu", "warning", "Xid 999"],
  ["NVRM: GPU 0000:01:00.0: GPU has fallen off the bus.", "nvidia.fell-off", "gpu", "critical", "GPU fell off the bus"],
  ["NVRM: _threadNodeCheckTimeout: API_GPU_ATTACHED_SANITY_CHECK failed!", "nvidia.unreachable", "gpu", "critical", "GPU stopped responding"],
  ["NVRM: gpuHandleSanityCheckRegReadError_GHN: Possible bad register read: addr: 0x88000, regvalue: 0xbadf5040,  error code: 0x0", "nvidia.bad-register-read", "gpu", "critical", "registers unreadable"],
  ["amdgpu 0000:0c:00.0: amdgpu: ring gfx_0.0.0 timeout, signaled seq=100, emitted seq=102", "amdgpu.ring-timeout", "gpu", "warning", "ring timed out"],
  ["amdgpu 0000:0c:00.0: amdgpu: GPU reset begin!", "amdgpu.reset-begin", "gpu", "warning", "reset started"],
  ["amdgpu 0000:0c:00.0: amdgpu: GPU reset(3) succeeded!", "amdgpu.reset-ok", "gpu", "warning", "was reset"],
  ["amdgpu 0000:0c:00.0: amdgpu: GPU reset(3) failed", "amdgpu.reset-failed", "gpu", "critical", "reset failed"],
  ["amdgpu 0000:0c:00.0: amdgpu: [gfxhub] page fault (src_id:0 ring:24 vmid:8 pasid:32770)", "amdgpu.page-fault", "gpu", "warning", "page fault"],
  ["i915 0000:00:02.0: [drm] GPU HANG: ecode 12:1:85dffffb, in Xorg [1234]", "i915.hang", "gpu", "warning", "Intel GPU hang"],
  ["xe 0000:00:02.0: [drm] GT0: Timedout job: seqno=100, lrc_seqno=100, guc_id=5, flags=0x0", "xe.timeout", "gpu", "warning", "job timed out"],
  ["[drm:drm_atomic_helper_wait_for_flip_done [drm_kms_helper]] *ERROR* [CRTC:81:pipe A] flip_done timed out", "drm.flip-timeout", "gpu", "warning", "Display update timed out"],
  ["pcieport 0000:00:1c.0: PCIe Bus Error: severity=Corrected, type=Physical Layer, (Receiver ID)", "pcie.bus-error", "pcie", "notice", "corrected error"],
  ["nvme 0000:01:00.0: PCIe Bus Error: severity=Uncorrected (Non-Fatal), type=Transaction Layer, (Requester ID)", "pcie.bus-error", "pcie", "warning", "non-fatal"],
  ["pcieport 0000:00:01.1: PCIe Bus Error: severity=Uncorrected (Fatal), type=Data Link Layer, (Transmitter ID)", "pcie.bus-error", "pcie", "critical", "fatal"],
  ["pcieport 0000:00:1c.0: AER: Corrected error message received from 0000:00:1c.0", "pcie.aer", "pcie", "notice", "corrected error"],
  ["pcieport 0000:00:01.1: AER: Uncorrected (Fatal) error message received from 0000:00:01.1", "pcie.aer", "pcie", "critical", "fatal"],
  ["pcieport 0000:00:01.1: AER: Uncorrectable (Non-Fatal) error message received from 0000:01:00.0", "pcie.aer", "pcie", "warning", "non-fatal"],
  ["pci 0000:01:00.0: can't change power state from D3cold to D0 (config space inaccessible)", "pcie.inaccessible", "pcie", "critical", "stopped responding"],
  ["mce: [Hardware Error]: Machine check events logged", "cpu.mce", "cpu", "critical", "Machine-check"],
  ["EDAC MC0: 1 CE memory scrubbing error on CPU_SrcID#0_Ha#0_Chan#1_DIMM#0", "memory.ecc-ce", "memory", "warning", "Correctable memory"],
  ["EDAC MC0: 1 UE memory read error on CPU_SrcID#0_Ha#0_Chan#1_DIMM#0", "memory.ecc-ue", "memory", "critical", "Uncorrectable memory"],
  ["Memory failure: 0x1a2b3c: Killing firefox:4242 due to hardware memory corruption", "memory.hwpoison", "memory", "critical", "failing memory page"],
  ["Out of memory: Killed process 4242 (firefox) total-vm:1234kB, anon-rss:1kB", "memory.oom", "memory", "warning", "Out of memory"],
  ["oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0", "memory.oom", "memory", "warning", "Out of memory"],
  ["watchdog: Watchdog detected hard LOCKUP on cpu 3", "cpu.hard-lockup", "cpu", "critical", "hard lockup"],
  ["watchdog: BUG: soft lockup - CPU#2 stuck for 26s! [kworker/2:1:99]", "cpu.soft-lockup", "cpu", "warning", "soft lockup"],
  ["rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:", "cpu.rcu-stall", "cpu", "warning", "CPU stall"],
  ["rcu: INFO: rcu_sched self-detected stall on CPU", "cpu.rcu-stall", "cpu", "warning", "CPU stall"],
  ["INFO: task kworker/1:1:55 blocked for more than 120 seconds.", "kernel.hung-task", "kernel", "warning", "task hung"],
  ["Kernel panic - not syncing: Fatal exception in interrupt", "kernel.panic", "kernel", "critical", "Kernel panic"],
  ["Oops: 0002 [#1] PREEMPT SMP NOPTI", "kernel.oops", "kernel", "critical", "Kernel oops"],
  ["BUG: kernel NULL pointer dereference, address: 0000000000000008", "kernel.oops", "kernel", "critical", "Kernel oops"],
  ["general protection fault, probably for non-canonical address 0xdead000000000000: 0000 [#1] SMP", "kernel.oops", "kernel", "critical", "Kernel oops"],
  ["WARNING: CPU: 3 PID: 1234 at drivers/gpu/drm/foo.c:88 foo_bar+0x12/0x34 [amdgpu]", "kernel.warn", "kernel", "notice", "Kernel warning"],
  ["thermal thermal_zone0: critical temperature reached (105 C), shutting down", "thermal.critical", "thermal", "critical", "Critical temperature"],
  ["CPU0: Core temperature above threshold, cpu clock throttled (total events = 1)", "thermal.throttle", "thermal", "warning", "thermal throttling"],
  ["mce: CPU0: Package temperature above threshold, cpu clock throttled (total events = 4)", "thermal.throttle", "thermal", "warning", "thermal throttling"],
  ["nvme nvme0: controller is down; will reset: CSTS=0xffffffff, PCI_STATUS=0xffff", "nvme.dead", "nvme", "critical", "stopped responding"],
  ["nvme nvme0: Removing after probe failure status: -19", "nvme.dead", "nvme", "critical", "stopped responding"],
  ["nvme nvme0: I/O 258 (I/O Cmd) QID 4 timeout, aborting", "nvme.timeout", "nvme", "warning", "timed out"],
  ["nvme nvme1: I/O 12 QID 1 timeout, reset controller", "nvme.timeout", "nvme", "warning", "timed out"],
  ["ata1.00: exception Emask 0x0 SAct 0x40 SErr 0x0 action 0x6 frozen", "storage.ata", "storage", "warning", "SATA"],
  ["ata3: COMRESET failed (errno=-16)", "storage.ata", "storage", "warning", "SATA"],
  ["blk_update_request: I/O error, dev sda, sector 123456 op 0x0:(READ) flags 0x80700 phys_seg 4 prio class 2", "storage.io-error", "storage", "warning", "read/write error"],
  ["I/O error, dev nvme0n1, sector 2048 op 0x1:(WRITE) flags 0x800 phys_seg 1 prio class 2", "storage.io-error", "storage", "warning", "read/write error"],
  ["blk_update_request: critical medium error, dev sdb, sector 9999 op 0x0:(READ)", "storage.io-error", "storage", "warning", "read/write error"],
  ["Buffer I/O error on dev sda1, logical block 4096, async page read", "storage.buffer-io", "storage", "warning", "read/write error"],
  ["EXT4-fs error (device nvme0n1p2): ext4_lookup:1855: inode #2: comm foo: deleted inode referenced", "fs.ext4", "filesystem", "critical", "ext4"],
  ["EXT4-fs (nvme0n1p2): Remounting filesystem read-only", "fs.readonly", "filesystem", "critical", "read-only"],
  ["BTRFS info (device dm-0 state E): forced readonly", "fs.readonly", "filesystem", "critical", "read-only"],
  ["BTRFS error (device dm-0): parent transid verify failed on logical 123 wanted 5 found 4", "fs.btrfs", "filesystem", "critical", "Btrfs"],
  ["BTRFS warning (device dm-0): csum failed root 5 ino 257 off 0 csum 0x1 expected csum 0x2 mirror 1", "fs.btrfs", "filesystem", "critical", "Btrfs"],
  ["XFS (sda1): Corruption detected. Unmount and run xfs_repair", "fs.xfs", "filesystem", "critical", "XFS"],
  ["xhci_hcd 0000:00:14.0: xHCI host controller not responding, assume dead", "usb.host-dead", "usb", "critical", "USB host controller"],
  ["xhci_hcd 0000:00:14.0: HC died; cleaning up", "usb.host-dead", "usb", "critical", "USB host controller"],
  ["usb 1-4: device descriptor read/64, error -71", "usb.enumerate", "usb", "warning", "failed to connect"],
  ["usb 3-2.1: device not accepting address 7, error -71", "usb.enumerate", "usb", "warning", "failed to connect"],
  ["usb 1-1: Cannot enable. Maybe the USB cable is bad?", "usb.enumerate", "usb", "warning", "failed to connect"],
  ["NETDEV WATCHDOG: enp10s0 (r8169): transmit queue 0 timed out", "net.watchdog", "net", "warning", "adapter stalled"],
  ["iwlwifi 0000:00:14.3: Microcode SW error detected. Restarting 0x0.", "net.iwlwifi", "net", "warning", "Wi-Fi firmware"],
  ["iwlwifi 0000:00:14.3: Start IWL Error Log Dump:", "net.iwlwifi", "net", "warning", "Wi-Fi firmware"],
  ["Bluetooth: hci0: command 0x0c03 tx timeout", "bt.timeout", "bt", "notice", "Bluetooth"]
]

// Real-world benign lines that mention the same subsystems but are not faults.
const NEGATIVE = [
  "thermal_sys: Registered thermal governor 'fair_share'",
  "EDAC MC: Ver: 3.0.0",
  "BTRFS warning (device dm-0): block groups with swapfile extents will not be scrubbed or balanced",
  "BTRFS info (device dm-0): using crc32c (crc32c-intel) checksum algorithm",
  "[UFW BLOCK] IN=eth0 OUT= MAC=aa:bb:cc:dd:ee:ff:11:22:33:44:55:66:08:00 SRC=192.0.2.10 DST=198.51.100.7 LEN=328 PROTO=UDP",
  "usb 1-1: new high-speed USB device number 4 using xhci_hcd",
  "usb 1-1: USB disconnect, device number 4",
  "usb 1-1: reset high-speed USB device number 4 using xhci_hcd",
  "xhci_hcd 0000:00:14.0: xHCI Host Controller",
  "nvme nvme0: pci function 0000:01:00.0",
  "nvme nvme0: 16/0/0 default/read/poll queues",
  "nvme nvme0: Shutdown timeout set to 10 seconds",
  "NVRM: krcRcAndNotifyAllChannels_IMPL: RC all channels for critical error 79.",
  "NVRM: mmuWalkUnmap: TLB invalidate failed",
  "NVRM: GPU at PCI:0000:01:00: GPU-00000000-0000-0000-0000-000000000000",
  "NVRM: GPU Board Serial Number: 0",
  "NVRM: loading NVIDIA UNIX Open Kernel Module for x86_64  610.57.04  Release Build  (root@archiso)",
  "nvidia-modeset: Loading NVIDIA Kernel Mode Setting Driver for UNIX platforms  610.57.04",
  "amdgpu 0000:0c:00.0: amdgpu: SMU is initialized successfully!",
  "amdgpu 0000:0c:00.0: amdgpu: ring gfx_0.0.0 uses VM inv eng 0 on hub 0",
  "i915 0000:00:02.0: [drm] VT-d active for gfx access",
  "ata1: SATA link up 6.0 Gbps (SStatus 133 SControl 300)",
  "ata1.00: ATA-11: Example SSD 1TB, ABC123, max UDMA/133",
  "ata1: SATA max UDMA/133 abar m4096@0xf7d00000 port 0xf7d00100 irq 34",
  "pcieport 0000:00:1c.0: PME: Signaling with IRQ 121",
  "pci 0000:00:1c.0: PCI bridge to [bus 01]",
  "EXT4-fs (nvme0n1p2): mounted filesystem with ordered data mode. Quota mode: none.",
  "XFS (sda1): Mounting V5 Filesystem",
  "Bluetooth: hci0: Firmware timestamp 2023.40 buildtype 1 build 12345",
  "iwlwifi 0000:00:14.3: Loaded firmware version: 83.e8f84e6e.0 ty-a0-gf-a0-83.ucode",
  "Out of the way: nothing to see",
  "Memory: 32768000K/33554432K available",
  "mce: [Firmware Bug]: Your BIOS does not seem to have configured this correctly",
  "serial8250: ttyS0 at I/O 0x3f8 (irq = 4, base_baud = 115200) is a 16550A",
  "watchdog: Watchdog detected in 30s",
  "ACPI: PM: Preparing to enter system sleep state S3",
  "",
  "   "
]

test("every positive fixture is classified as documented", () => {
  for (const [msg, id, cls, sev, titlePart] of POSITIVE) {
    const c = Rules.classify(msg)
    assert.ok(c, `should classify: ${msg}`)
    assert.equal(c.rule, id, `rule id for: ${msg}`)
    assert.equal(c.cls, cls, `class for: ${msg}`)
    assert.equal(c.sev, sev, `severity for: ${msg}`)
    if (titlePart) assert.ok(c.title.toLowerCase().includes(titlePart.toLowerCase()), `title "${c.title}" should include "${titlePart}" for: ${msg}`)
  }
})

test("benign look-alike lines are never classified", () => {
  for (const msg of NEGATIVE) {
    const c = Rules.classify(msg)
    assert.equal(c, null, `should ignore: ${JSON.stringify(msg)} (got ${c && c.rule})`)
  }
})

test("every rule is exercised by at least one positive fixture", () => {
  const hit = new Set(POSITIVE.map((p) => p[1]))
  for (const id of Rules.ruleIds()) assert.ok(hit.has(id), `rule ${id} has no test fixture`)
})

test("the journalctl prefilter matches every line a rule can classify", () => {
  const re = new RegExp(Rules.prefilter(), "i")
  for (const [msg] of POSITIVE) assert.ok(re.test(msg), `prefilter misses: ${msg}`)
})

test("the prefilter does not pass driver cascade noise or identifying lines", () => {
  const re = new RegExp(Rules.prefilter(), "i")
  for (const spam of [
    "NVRM: krcRcAndNotifyAllChannels_IMPL: RC all channels for critical error 79.",
    "NVRM: GPU at PCI:0000:01:00: GPU-00000000-0000-0000-0000-000000000000",
    "NVRM: GPU serial number is 0."
  ]) assert.ok(!re.test(spam), `prefilter must not pass: ${spam}`)
})

test("the prefilter is valid PCRE-safe syntax (no lookbehind, no named groups)", () => {
  const p = Rules.prefilter()
  assert.ok(!/\(\?<[=!]/.test(p) && !/\(\?<\w+>/.test(p))
})

test("xid decoding: known codes get specific titles, unknown ones a generic one", () => {
  const c79 = Rules.classify("NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.")
  assert.equal(c79.device, "NVIDIA GPU 01:00")
  assert.equal(Rules.classify("NVRM: GPU 0000:01:00.0: GPU has fallen off the bus.").device, "NVIDIA GPU 01:00", "same device string from either line")
  assert.equal(Rules.classify("NVRM: _threadNodeCheckTimeout: API_GPU_ATTACHED_SANITY_CHECK failed!").device, "")
  assert.ok(c79.prio >= 90)
  assert.equal(c79.key, "gpu|nvidia")
  const unk = Rules.classify("NVRM: Xid (PCI:0000:03:00): 999, hi")
  assert.equal(unk.title, "NVIDIA driver reported Xid 999")
  assert.equal(unk.sev, "warning")
})

test("PCIe severities map Corrected/Non-Fatal/Fatal correctly", () => {
  const sev = (s) => Rules.classify(`pcieport 0000:00:1c.0: PCIe Bus Error: severity=${s}, type=Physical Layer`).sev
  assert.equal(sev("Corrected"), "notice")
  assert.equal(sev("Uncorrected (Non-Fatal)"), "warning")
  assert.equal(sev("Uncorrected (Fatal)"), "critical")
})

test("partitions and their disk share one incident key", () => {
  const a = Rules.classify("Buffer I/O error on dev sda1, logical block 1, async page read")
  const b = Rules.classify("blk_update_request: I/O error, dev sda, sector 5 op 0x0:(READ)")
  const c = Rules.classify("Buffer I/O error on dev nvme0n1p3, logical block 1, async page read")
  assert.equal(a.key, b.key)
  assert.equal(c.device, "nvme0n1")
})

test("classify tolerates hostile input without throwing", () => {
  for (const bad of [undefined, null, 0, 5, {}, [], "\u0000\u0000", "x".repeat(50000)]) {
    assert.doesNotThrow(() => Rules.classify(bad))
  }
})

test("classification stays fast on adversarial lines", () => {
  const nasty = ["NVRM: Xid (PCI:" + "0".repeat(1900), "amdgpu " + "0:".repeat(900), "usb " + "1-".repeat(900) + ": ", "a".repeat(2000) + " error, dev "]
  const start = Date.now()
  for (let i = 0; i < 200; i++) for (const n of nasty) Rules.classify(n)
  assert.ok(Date.now() - start < 1500, "800 adversarial classifications should finish in well under 1.5 s")
})

test("every rule produces a non-empty title, meaning and key", () => {
  const sample = new Map(POSITIVE.map((p) => [p[1], p[0]]))
  for (const [id, msg] of sample) {
    const c = Rules.classify(msg)
    assert.ok(c.title.length > 3, `${id} title`)
    assert.ok(c.meaning.length > 20, `${id} meaning`)
    assert.ok(c.key.length > 0, `${id} key`)
  }
})

test("the prefilter is anchored to the start of the message (unanchored it made a 2M-line scan take a minute)", () => {
  const p = Rules.prefilter()
  assert.ok(p.startsWith("^(?:") && p.endsWith(")"))
  const re = new RegExp(p, "i")
  assert.ok(!re.test("something before NVRM: Xid (PCI:0000:01:00): 79"), "a match in the middle of a line is not a fault line")
})

test("the prefilter rejects ordinary boot chatter", () => {
  const re = new RegExp(Rules.prefilter(), "i")
  for (const msg of NEGATIVE) {
    if (msg.trim() === "") continue
    // A few negatives (e.g. "BTRFS warning ... swapfile") legitimately pass the cheap prefilter
    // and are rejected by the precise rule; what matters is that classify() says null.
    assert.equal(Rules.classify(msg), null, msg)
  }
  for (const msg of ["usb 1-1: new high-speed USB device number 4 using xhci_hcd", "EDAC MC: Ver: 3.0.0", "Freeing unused kernel image (initmem) memory: 3200K", "audit: type=1400 audit(1.2:3): apparmor=\"STATUS\""]) {
    assert.ok(!re.test(msg), `prefilter should reject: ${msg}`)
  }
})
