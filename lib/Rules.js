.pragma library

// OmaBlackbox detection rules.
//
// Each rule recognises one family of kernel messages that indicate a hardware
// or low-level fault, and decodes it into a short title, a severity, and a
// plain-English explanation. Rules are deliberately conservative: a rule only
// matches a message that is a fault, never one that merely mentions a subsystem
// (for example "EDAC MC: Ver: 3.0.0" or "thermal_sys: Registered thermal
// governor" are ignored). A missed benign line costs nothing; a false alarm
// costs the user's trust.
//
// This file is pure JavaScript with no QML or Quickshell dependency so that it
// can be unit tested under Node. Keep it ES5-style.

var RANK = { notice: 1, warning: 2, critical: 3 }

function rank(sev) { return RANK[sev] || 0 }
function maxSev(a, b) { return rank(a) >= rank(b) ? a : b }

var CLASS_LABEL = {
  gpu: "GPU", pcie: "PCIe", memory: "Memory", cpu: "CPU", thermal: "Thermal",
  nvme: "NVMe", storage: "Storage", filesystem: "Filesystem", usb: "USB",
  net: "Network", bt: "Bluetooth", kernel: "Kernel", boot: "Session"
}

function classLabel(cls) { return CLASS_LABEL[cls] || "System" }

var MAX_MESSAGE = 2000

// ---- helpers ---------------------------------------------------------------

var PCI_RE = /\b([0-9a-f]{4,5}:[0-9a-f]{2}:[0-9a-f]{2}\.\d)\b/i

// "0000:01:00.0" | "0000:01:00" | "01:00.0"  ->  "01:00"
function pciKey(addr) {
  return String(addr || "").toLowerCase().replace(/^0000:/, "").replace(/\.\d$/, "")
}

// "0000:01:00.0" -> "01:00.0" (readable, keeps the function number)
function pciShort(addr) {
  return String(addr || "").toLowerCase().replace(/^0000:/, "")
}

function findPci(msg) {
  var m = PCI_RE.exec(msg)
  return m ? m[1] : ""
}

// "nvme0n1p2" -> "nvme0n1", "sda1" -> "sda": faults on a partition are faults
// on the disk, and should land in the same incident.
function baseDisk(name) {
  var n = String(name || "")
  var m = /^(nvme\d+n\d+)p\d+$/.exec(n) || /^(mmcblk\d+)p\d+$/.exec(n)
    || /^((?:sd|vd|xvd|hd)[a-z]+)\d+$/.exec(n)
  return m ? m[1] : n
}

function clip(text, max) {
  var t = String(text || "").replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}

// ---- NVIDIA Xid catalogue --------------------------------------------------
// [title, severity, priority, meaning]. Only codes whose meaning is documented
// by NVIDIA are listed; anything else falls through to a generic entry. The
// wording is intentionally hedged: an Xid says what the driver saw, not why.

var XID = {
  13: ["Graphics engine exception", "warning", 60,
    "The GPU's graphics engine hit an exception. Usually an application or driver bug; occasionally unstable hardware."],
  31: ["GPU memory page fault", "warning", 60,
    "A program made the GPU touch memory it should not have. Usually an application or driver bug."],
  32: ["Corrupted GPU command stream", "warning", 60,
    "The driver received an invalid or corrupted command buffer for the GPU."],
  43: ["GPU stopped processing", "warning", 60,
    "A GPU task stopped making progress and was reset. Usually caused by an application."],
  45: ["GPU cleaned up after earlier errors", "warning", 55,
    "The driver removed work from the GPU as a result of earlier errors. Look for the first error in this incident."],
  48: ["GPU memory double-bit error", "critical", 80,
    "The GPU memory reported an uncorrectable ECC error. This can indicate failing GPU memory."],
  56: ["Display engine error", "warning", 60,
    "The GPU's display engine reported an error, which can cause flicker or a blank output."],
  61: ["GPU microcontroller warning", "warning", 60,
    "An internal GPU microcontroller reported a breakpoint or warning."],
  62: ["GPU microcontroller halted", "critical", 75,
    "An internal GPU microcontroller halted. The GPU usually needs a reset or a reboot afterwards."],
  63: ["GPU memory page retirement recorded", "notice", 40,
    "The GPU recorded a memory page retirement or row remap. One is routine; a steady stream is not."],
  64: ["GPU memory page retirement failed", "warning", 60,
    "The GPU could not record a memory page retirement or row remap."],
  68: ["Video decoder exception", "warning", 60,
    "The GPU's video decoder (NVDEC) hit an exception."],
  69: ["Graphics engine class error", "warning", 60,
    "The GPU's graphics engine rejected a command class."],
  74: ["NVLink error", "warning", 60,
    "An NVLink connection between GPUs reported an error."],
  79: ["GPU fell off the bus", "critical", 90,
    "The GPU stopped answering on the PCIe bus and the driver lost it. The screen usually goes black and a full power cycle is needed to recover. Reported causes range from hardware, power or PCIe faults to driver and firmware bugs; the log alone cannot say which."],
  92: ["High rate of correctable GPU memory errors", "warning", 60,
    "The GPU memory is producing many correctable single-bit ECC errors."],
  94: ["Contained GPU memory error", "warning", 65,
    "The GPU detected an uncorrectable memory error and contained it to one process."],
  95: ["Uncontained GPU memory error", "critical", 80,
    "The GPU detected an uncorrectable memory error that could not be contained. A GPU reset is normally required."],
  119: ["GPU system processor timed out", "critical", 75,
    "The GPU's firmware processor (GSP) did not answer the driver in time. The GPU is usually unusable until reset."],
  120: ["GPU system processor error", "critical", 75,
    "The GPU's firmware processor (GSP) reported an error. The GPU is usually unusable until reset."],
  121: ["GPU chip-to-chip link error", "warning", 60,
    "A chip-to-chip (C2C) link error was reported."],
  154: ["GPU recovery action changed", "critical", 70,
    "The driver changed the recovery it needs from the GPU (for example a reset or a node reboot). See the log lines for the action requested."]
}

function xidInfo(code) {
  var e = XID[code]
  if (e) return { title: e[0], sev: e[1], prio: e[2], meaning: e[3], known: true }
  return {
    title: "NVIDIA driver reported Xid " + code, sev: "warning", prio: 45, known: false,
    meaning: "The NVIDIA driver logged an Xid error this plugin does not have a description for. NVIDIA's Xid catalogue explains each code."
  }
}

// ---- rule table ------------------------------------------------------------
// Fields: id, cls, re, sev, prio, title, meaning, key(m,msg), device(m,msg),
//         detail(m,msg).
// `pre` is a lowercase regular-expression fragment, anchored (by prefilter())
// to the start of the message, shared with journalctl's --grep prefilter. It
// must match every message the rule can classify: a test enforces that.

var RULES = []
var PREFILTER = []

function rule(r) {
  RULES.push(r)
  if (r.pre) PREFILTER.push(r.pre)
}

function pciDevice(label) {
  return function (m, msg) {
    var a = findPci(msg)
    return a ? label + " " + pciShort(a) : label
  }
}

// -- NVIDIA --

rule({
  id: "nvidia.xid", cls: "gpu", pre: "nvrm: xid \\(pci:",
  re: /NVRM: Xid \(PCI:([0-9a-f:.]+)\): (\d+)(?:, (.*))?$/i,
  key: function () { return "gpu|nvidia" },
  device: function (m) { return "NVIDIA GPU " + pciKey(m[1]) },
  info: function (m) { return xidInfo(parseInt(m[2], 10)) },
  detail: function (m) {
    var rest = clip(m[3] || "", 140)
    return "Xid " + m[2] + (rest ? " · " + rest : "")
  }
})

rule({
  id: "nvidia.fell-off", cls: "gpu", sev: "critical", prio: 88, pre: "nvrm: gpu [0-9a-f]{4,5}:",
  re: /NVRM: GPU ([0-9a-f:.]+): GPU has fallen off the bus/i,
  title: "GPU fell off the bus",
  meaning: XID[79][3],
  key: function () { return "gpu|nvidia" },
  device: function (m) { return "NVIDIA GPU " + pciKey(m[1]) }
})

rule({
  id: "nvidia.unreachable", cls: "gpu", sev: "critical", prio: 50, pre: "nvrm: _threadnodechecktimeout",
  re: /NVRM: _threadNodeCheckTimeout: API_GPU_ATTACHED_SANITY_CHECK failed/i,
  title: "GPU stopped responding",
  meaning: "The driver's periodic check that the GPU is still attached failed. This usually precedes or accompanies the GPU falling off the bus.",
  key: function () { return "gpu|nvidia" },
  device: function () { return "" }
})

rule({
  id: "nvidia.bad-register-read", cls: "gpu", sev: "critical", prio: 70, pre: "nvrm: gpuhandlesanitycheckregreaderror",
  re: /NVRM: gpuHandleSanityCheckRegReadError_\w+: Possible bad register read/i,
  title: "GPU registers unreadable",
  meaning: "The driver read garbage from the GPU's registers, which normally means the GPU has stopped responding, for example after falling off the PCIe bus. The kernel can log millions of these lines in a few minutes.",
  key: function () { return "gpu|nvidia" },
  device: function () { return "" }
})

// -- AMD --

rule({
  id: "amdgpu.reset-failed", cls: "gpu", sev: "critical", prio: 85, pre: "amdgpu [0-9a-f]{4,5}:",
  re: /amdgpu ([0-9a-f:.]+): amdgpu: GPU reset\(\d+\) failed/i,
  title: "GPU reset failed",
  meaning: "The AMD GPU hung and the driver could not recover it. The desktop is usually frozen or unusable until a reboot.",
  key: function (m) { return "gpu|amdgpu|" + pciKey(m[1]) },
  device: function (m) { return "AMD GPU " + pciShort(m[1]) }
})

rule({
  id: "amdgpu.reset-ok", cls: "gpu", sev: "warning", prio: 65, pre: "amdgpu [0-9a-f]{4,5}:",
  re: /amdgpu ([0-9a-f:.]+): amdgpu: GPU reset\(\d+\) succeeded/i,
  title: "GPU hung and was reset",
  meaning: "The AMD GPU stopped responding and the driver reset it successfully. Applications using the GPU may have been closed or glitched.",
  key: function (m) { return "gpu|amdgpu|" + pciKey(m[1]) },
  device: function (m) { return "AMD GPU " + pciShort(m[1]) }
})

rule({
  id: "amdgpu.ring-timeout", cls: "gpu", sev: "warning", prio: 60, pre: "amdgpu [0-9a-f]{4,5}:",
  re: /amdgpu ([0-9a-f:.]+): amdgpu: (?:\[drm\] )?ring (\S+) timeout/i,
  title: "GPU command ring timed out",
  meaning: "A command sent to the AMD GPU did not finish in time. This is how a GPU hang first shows up; a reset normally follows.",
  key: function (m) { return "gpu|amdgpu|" + pciKey(m[1]) },
  device: function (m) { return "AMD GPU " + pciShort(m[1]) },
  detail: function (m) { return "ring " + m[2] }
})

rule({
  id: "amdgpu.reset-begin", cls: "gpu", sev: "warning", prio: 55, pre: "amdgpu [0-9a-f]{4,5}:",
  re: /amdgpu ([0-9a-f:.]+): amdgpu: GPU reset begin/i,
  title: "GPU reset started",
  meaning: "The AMD driver began resetting the GPU, normally after detecting a hang.",
  key: function (m) { return "gpu|amdgpu|" + pciKey(m[1]) },
  device: function (m) { return "AMD GPU " + pciShort(m[1]) }
})

rule({
  id: "amdgpu.page-fault", cls: "gpu", sev: "warning", prio: 55, pre: "amdgpu [0-9a-f]{4,5}:",
  re: /amdgpu ([0-9a-f:.]+): amdgpu: \[(gfxhub|mmhub\d*)\] page fault/i,
  title: "GPU memory page fault",
  meaning: "A program made the AMD GPU touch memory it should not have. Usually an application or driver bug.",
  key: function (m) { return "gpu|amdgpu|" + pciKey(m[1]) },
  device: function (m) { return "AMD GPU " + pciShort(m[1]) }
})

// -- Intel --

rule({
  id: "i915.hang", cls: "gpu", sev: "warning", prio: 60, pre: "i915 [0-9a-f]{4,5}:",
  re: /i915 ([0-9a-f:.]+): (?:\[drm\] )?GPU HANG/i,
  title: "Intel GPU hang",
  meaning: "The Intel graphics driver detected a GPU hang and is resetting the engine. Applications may have glitched or been closed.",
  key: function (m) { return "gpu|i915|" + pciKey(m[1]) },
  device: function (m) { return "Intel GPU " + pciShort(m[1]) },
  detail: function (m, msg) {
    var e = /ecode ([0-9a-f:]+)/i.exec(msg)
    return e ? "ecode " + e[1] : ""
  }
})

rule({
  id: "xe.timeout", cls: "gpu", sev: "warning", prio: 60, pre: "xe [0-9a-f]{4,5}:",
  re: /^xe ([0-9a-f:.]+): \[drm\] .*Timedout job/i,
  title: "Intel GPU job timed out",
  meaning: "The Intel Xe graphics driver killed a GPU job that did not finish in time.",
  key: function (m) { return "gpu|xe|" + pciKey(m[1]) },
  device: function (m) { return "Intel GPU " + pciShort(m[1]) }
})

// -- Display --

rule({
  id: "drm.flip-timeout", cls: "gpu", sev: "warning", prio: 45, pre: "\\[drm[^*]{0,80}\\*error\\*",
  re: /flip_done timed out/i,
  title: "Display update timed out",
  meaning: "The graphics driver waited for the screen to finish updating and gave up. This can appear as a frozen or flickering display.",
  key: function () { return "gpu|display" },
  device: function () { return "Display" }
})

// -- PCIe --

function pcieSeverity(kind) {
  if (/Fatal\)/.test(kind) && !/Non-Fatal/.test(kind)) return "critical"
  if (/Non-Fatal/.test(kind)) return "warning"
  return "notice"
}

function pcieTitle(kind) {
  if (/Corrected/.test(kind)) return "PCIe corrected error"
  if (/Non-Fatal/.test(kind)) return "PCIe uncorrected error (non-fatal)"
  return "PCIe uncorrected error (fatal)"
}

var PCIE_MEANING = {
  notice: "The PCIe link corrected an error on its own. Occasional corrected errors are normal; a steady stream points to a marginal slot, riser, cable or power-management setting.",
  warning: "A PCIe device reported an error the link could not correct, but it is not fatal to the link. Repeats suggest a failing device or a poor connection.",
  critical: "A PCIe device reported a fatal error. The device may stop responding until the system is reset."
}

rule({
  id: "pcie.bus-error", cls: "pcie", pre: "\\S+ [0-9a-f:.]+: pcie bus error",
  re: /^(\S+) ([0-9a-f:.]+): PCIe Bus Error: severity=(Corrected|Uncorrected \((?:Non-Fatal|Fatal)\))(?:, type=([^,(]+))?/i,
  key: function (m) { return "pcie|" + pciKey(m[2]) },
  device: function (m) { return m[1] + " " + pciShort(m[2]) },
  info: function (m) {
    var sev = pcieSeverity(m[3])
    return { title: pcieTitle(m[3]), sev: sev, prio: sev === "critical" ? 70 : sev === "warning" ? 55 : 30, meaning: PCIE_MEANING[sev], known: true }
  },
  detail: function (m) { return m[4] ? clip(m[4], 60) : "" }
})

rule({
  id: "pcie.aer", cls: "pcie", pre: "\\S+ [0-9a-f:.]+: aer:",
  re: /^(\S+) ([0-9a-f:.]+): AER: (Corrected|Uncorrected \((?:Non-Fatal|Fatal)\)|Uncorrectable \((?:Non-Fatal|Fatal)\)) error message received from ([0-9a-f:.]+)/i,
  key: function (m) { return "pcie|" + pciKey(m[4]) },
  device: function (m) { return "PCIe " + pciShort(m[4]) },
  info: function (m) {
    var kind = m[3].replace("Uncorrectable", "Uncorrected")
    var sev = pcieSeverity(kind)
    return { title: pcieTitle(kind), sev: sev, prio: sev === "critical" ? 70 : sev === "warning" ? 55 : 30, meaning: PCIE_MEANING[sev], known: true }
  }
})

rule({
  id: "pcie.inaccessible", cls: "pcie", sev: "critical", prio: 75, pre: "\\S+ [0-9a-f:.]+: (?:can\'t|unable to) change power state from d3cold",
  re: /(?:can't change power state from D3cold to D0 \(config space inaccessible\)|Unable to change power state from D3cold to D0, device inaccessible)/i,
  title: "PCIe device stopped responding",
  meaning: "The system could not wake a PCIe device; its configuration space no longer answers. Often seen when a GPU or drive has dropped off the bus.",
  key: function (m, msg) { return "pcie|" + pciKey(findPci(msg)) },
  device: pciDevice("PCIe")
})

// -- CPU and memory --

rule({
  id: "cpu.mce", cls: "cpu", sev: "critical", prio: 85, pre: "(?:mce: |\\{\\d+\\})?\\[hardware error\\]",
  re: /\[Hardware Error\]/i,
  title: "Machine-check hardware error",
  meaning: "The CPU or platform reported a hardware error through the machine-check architecture. Repeated events can point to failing memory, an unstable overclock or undervolt, or a failing CPU.",
  key: function () { return "cpu|mce" },
  device: function () { return "CPU / platform" }
})

rule({
  id: "memory.ecc-ue", cls: "memory", sev: "critical", prio: 85, pre: "edac [\\w-]+: \\d+ ue\\b",
  re: /EDAC [\w-]+: \d+ UE\b/i,
  title: "Uncorrectable memory error (ECC)",
  meaning: "ECC memory detected an error it could not correct. This can indicate failing RAM.",
  key: function () { return "memory|edac" },
  device: function () { return "System memory" }
})

rule({
  id: "memory.ecc-ce", cls: "memory", sev: "warning", prio: 60, pre: "edac [\\w-]+: \\d+ ce\\b",
  re: /EDAC [\w-]+: \d+ CE\b/i,
  title: "Correctable memory error (ECC)",
  meaning: "ECC memory detected and corrected an error. Occasional events are normal; a steady stream suggests a failing DIMM.",
  key: function () { return "memory|edac" },
  device: function () { return "System memory" }
})

rule({
  id: "memory.hwpoison", cls: "memory", sev: "critical", prio: 85, pre: "memory failure: 0x",
  re: /Memory failure: 0x[0-9a-f]+:/i,
  title: "Kernel isolated a failing memory page",
  meaning: "The kernel found a hardware memory error and took a page out of use, possibly terminating the program that owned it.",
  key: function () { return "memory|hwpoison" },
  device: function () { return "System memory" }
})

rule({
  id: "memory.oom", cls: "memory", sev: "warning", prio: 50, pre: "(?:memory cgroup )?out of memory: killed process|oom-kill:constraint=",
  re: /(?:out of memory: Killed process (\d+) \(([^)]*)\)|^oom-kill:constraint=)/i,
  title: "Out of memory: a process was killed",
  meaning: "The system ran out of memory and the kernel ended a process to recover. Not a hardware fault, but it often explains a sudden disappearing application.",
  key: function () { return "memory|oom" },
  device: function () { return "System memory" },
  detail: function (m) { return m[2] ? m[2] + " (pid " + m[1] + ")" : "" }
})

rule({
  id: "cpu.hard-lockup", cls: "cpu", sev: "critical", prio: 80, pre: "watchdog: watchdog detected hard lockup",
  re: /watchdog: Watchdog detected hard LOCKUP on cpu (\d+)/i,
  title: "CPU hard lockup",
  meaning: "A CPU core stopped responding to interrupts entirely and the watchdog noticed.",
  key: function () { return "cpu|lockup" },
  device: function (m) { return "CPU " + m[1] }
})

rule({
  id: "cpu.soft-lockup", cls: "cpu", sev: "warning", prio: 60, pre: "watchdog: bug: soft lockup",
  re: /watchdog: BUG: soft lockup - CPU#(\d+) stuck for (\d+)s/i,
  title: "CPU soft lockup",
  meaning: "A CPU core spent a long time in kernel code without letting other work run. Often a driver problem; occasionally a symptom of failing hardware.",
  key: function () { return "cpu|lockup" },
  device: function (m) { return "CPU " + m[1] },
  detail: function (m) { return "stuck for " + m[2] + " s" }
})

rule({
  id: "cpu.rcu-stall", cls: "cpu", sev: "warning", prio: 55, pre: "rcu: info: rcu_",
  re: /rcu: INFO: rcu_\w+ (?:self-detected stall on CPU|detected stalls on CPUs\/tasks)/i,
  title: "CPU stall detected",
  meaning: "The kernel noticed a CPU core or task that stopped making progress for an extended time.",
  key: function () { return "cpu|lockup" },
  device: function () { return "CPU" }
})

rule({
  id: "kernel.hung-task", cls: "kernel", sev: "warning", prio: 50, pre: "info: task \\S+ blocked for more than",
  re: /INFO: task (\S+):(\d+) blocked for more than (\d+) seconds/i,
  title: "A task hung",
  meaning: "A process was stuck waiting on the kernel for a long time. Common when a disk, network share or driver stops answering.",
  key: function () { return "kernel|hung" },
  device: function () { return "Kernel" },
  detail: function (m) { return m[1] + " blocked for " + m[3] + " s" }
})

rule({
  id: "kernel.panic", cls: "kernel", sev: "critical", prio: 95, pre: "kernel panic - not syncing",
  re: /Kernel panic - not syncing:? ?(.*)/i,
  title: "Kernel panic",
  meaning: "The kernel hit an unrecoverable error and stopped. The machine normally freezes or reboots.",
  key: function () { return "kernel|panic" },
  device: function () { return "Kernel" },
  detail: function (m) { return clip(m[1], 120) }
})

rule({
  id: "kernel.oops", cls: "kernel", sev: "critical", prio: 80, pre: "oops|bug: (?:unable to handle|kernel null pointer|kernel paging request)|general protection fault",
  re: /^(?:Oops(?:: |\b)|BUG: (?:unable to handle|kernel NULL pointer|kernel paging request)|general protection fault)/i,
  title: "Kernel oops",
  meaning: "The kernel hit a serious error in a driver or its own code and killed the affected task. The system may be unstable until rebooted.",
  key: function () { return "kernel|oops" },
  device: function () { return "Kernel" },
  detail: function (m, msg) { return clip(msg, 120) }
})

rule({
  id: "kernel.warn", cls: "kernel", sev: "notice", prio: 20, pre: "warning: cpu: \\d+ pid: \\d+ at ",
  re: /^WARNING: CPU: \d+ PID: \d+ at (\S+)/i,
  title: "Kernel warning",
  meaning: "The kernel flagged an unexpected condition. Usually harmless on its own; it matters when it repeats or lines up with a crash.",
  key: function (m) { return "kernel|warn|" + m[1] },
  device: function () { return "Kernel" },
  detail: function (m) { return clip(m[1], 80) }
})

// -- Thermal --

rule({
  id: "thermal.critical", cls: "thermal", sev: "critical", prio: 85, pre: "[a-z0-9_ :]{0,40}critical temperature reached",
  re: /critical temperature reached/i,
  title: "Critical temperature reached",
  meaning: "A thermal sensor reported a critical temperature, at which the system may shut itself down to protect the hardware.",
  key: function () { return "thermal|critical" },
  device: function () { return "Thermal" }
})

rule({
  id: "thermal.throttle", cls: "thermal", sev: "warning", prio: 50, pre: "(?:mce: )?(?:cpu\\d+|core\\d*|package\\d*): (?:core |package )?temperature above threshold",
  re: /temperature above threshold, cpu clock throttled/i,
  title: "CPU thermal throttling",
  meaning: "The CPU got hot enough that it slowed itself down. Check cooling, dust, fan curves and case airflow.",
  key: function () { return "thermal|cpu" },
  device: function () { return "CPU" }
})

// -- Storage --

rule({
  id: "nvme.dead", cls: "nvme", sev: "critical", prio: 85, pre: "nvme nvme\\d+: (?:controller is down|removing after probe failure|device not ready; aborting|disabling device after reset failure)",
  re: /^nvme (nvme\d+): (?:controller is down|Removing after probe failure|Device not ready; aborting|Disabling device after reset failure)/i,
  title: "NVMe drive stopped responding",
  meaning: "The NVMe controller stopped answering and the kernel is resetting or removing it. Unsaved data on that drive is at risk.",
  key: function (m) { return "nvme|" + m[1] },
  device: function (m) { return m[1] }
})

rule({
  id: "nvme.timeout", cls: "nvme", sev: "warning", prio: 60, pre: "nvme nvme\\d+: i/o ",
  re: /^nvme (nvme\d+): I\/O .*timeout/i,
  title: "NVMe command timed out",
  meaning: "The NVMe drive did not answer a command in time. Occasional timeouts can come from power-saving states; repeats point to a failing drive, controller or connection.",
  key: function (m) { return "nvme|" + m[1] },
  device: function (m) { return m[1] }
})

rule({
  id: "storage.ata", cls: "storage", sev: "warning", prio: 55, pre: "ata\\d+(?:\\.\\d+)?: (?:exception emask|failed command: |qc timeout|comreset failed|revalidation failed)",
  re: /^ata(\d+)(?:\.\d+)?: (?:exception Emask|failed command: |qc timeout|COMRESET failed|revalidation failed)/i,
  title: "SATA link or drive error",
  meaning: "The SATA controller reported an error talking to a drive. Frequent errors usually mean a bad cable, connector or drive.",
  key: function (m) { return "storage|ata" + m[1] },
  device: function (m) { return "SATA port ata" + m[1] }
})

rule({
  id: "storage.io-error", cls: "storage", sev: "warning", prio: 55,
  pre: "(?:blk_update_request: )?(?:critical (?:medium|target|nexus|protection) error|i/o error), dev ",
  re: /(?:blk_update_request: )?(?:critical (?:medium|target|nexus|protection) error|I\/O error), dev (\S+), sector (\d+)/i,
  title: "Disk read/write error",
  meaning: "The kernel could not read from or write to a disk. Repeats on an internal drive suggest it is failing; a single burst usually means a removable drive was pulled.",
  key: function (m) { return "storage|" + baseDisk(m[1]) },
  device: function (m) { return baseDisk(m[1]) }
})

rule({
  id: "storage.buffer-io", cls: "storage", sev: "warning", prio: 50, pre: "buffer i/o error on dev",
  re: /Buffer I\/O error on dev(?:ice)? (\S+?),? logical block/i,
  title: "Disk read/write error",
  meaning: "The kernel could not read from or write to a disk. Repeats on an internal drive suggest it is failing; a single burst usually means a removable drive was pulled.",
  key: function (m) { return "storage|" + baseDisk(m[1]) },
  device: function (m) { return baseDisk(m[1]) }
})

// -- Filesystems --

rule({
  id: "fs.readonly", cls: "filesystem", sev: "critical", prio: 90, pre: "ext4-fs \\S+: remounting filesystem read-only|btrfs \\w+ \\(device [^)]*\\): forced readonly",
  re: /(?:EXT4-fs \(([\w.\-]+)\): Remounting filesystem read-only|BTRFS .*\(device ([\w.\-]+)[^)]*\): forced readonly)/i,
  title: "Filesystem went read-only",
  meaning: "The filesystem hit an error and the kernel stopped writes to protect it. Nothing more can be saved to it until it is checked and remounted.",
  key: function (m) { return "fs|" + (m[1] || m[2]) },
  device: function (m) { return m[1] || m[2] }
})

rule({
  id: "fs.ext4", cls: "filesystem", sev: "critical", prio: 80, pre: "ext4-fs error \\(device",
  re: /EXT4-fs error \(device ([\w.\-]+)\)/i,
  title: "Filesystem error (ext4)",
  meaning: "The ext4 filesystem detected corruption or an I/O failure. Run a filesystem check and look at the drive's health.",
  key: function (m) { return "fs|" + m[1] },
  device: function (m) { return m[1] }
})

rule({
  id: "fs.btrfs", cls: "filesystem", sev: "critical", prio: 80, pre: "btrfs:? (?:error|critical)|btrfs warning \\(device [^)]*\\): .*(?:csum failed|checksum verify failed|corrupt)",
  re: /BTRFS:? (?:error|critical)(?: \(device ([\w.\-]+)[^)]*\))?|BTRFS warning \(device ([\w.\-]+)[^)]*\): .*(?:csum failed|checksum verify failed|corrupt)/i,
  title: "Filesystem error (Btrfs)",
  meaning: "Btrfs detected corruption, a checksum mismatch or an I/O failure. Run a scrub and look at the drive's health.",
  key: function (m) { return "fs|" + (m[1] || m[2] || "btrfs") },
  device: function (m) { return m[1] || m[2] || "Btrfs" }
})

rule({
  id: "fs.xfs", cls: "filesystem", sev: "critical", prio: 80, pre: "xfs \\([\\w.\\-]+\\): (?:corruption detected|metadata i/o error|log i/o error|filesystem has been shut down|i/o error detected\\. shutting down filesystem)",
  re: /XFS \(([\w.\-]+)\): (?:Corruption detected|Metadata I\/O Error|Log I\/O Error|Filesystem has been shut down|I\/O Error Detected\. Shutting down filesystem)/i,
  title: "Filesystem error (XFS)",
  meaning: "XFS detected corruption or an I/O failure and shut the filesystem down. Unmount it and run xfs_repair.",
  key: function (m) { return "fs|" + m[1] },
  device: function (m) { return m[1] }
})

// -- USB --

rule({
  id: "usb.host-dead", cls: "usb", sev: "critical", prio: 75, pre: "xhci_hcd [0-9a-f:.]+: (?:xhci host controller not responding, assume dead|hc died; cleaning up|host halt failed|host system error)",
  re: /xhci_hcd ([0-9a-f:.]+): (?:xHCI host controller not responding, assume dead|HC died; cleaning up|Host halt failed|Host System Error)/i,
  title: "USB host controller failed",
  meaning: "A USB controller stopped responding, taking every device on it offline until it is reset.",
  key: function (m) { return "usb|host|" + pciKey(m[1]) },
  device: function (m) { return "USB controller " + pciShort(m[1]) }
})

rule({
  id: "usb.enumerate", cls: "usb", sev: "warning", prio: 40, pre: "usb \\d+-[\\d.]+: (?:device descriptor read/|device not accepting address|unable to enumerate usb device|cannot enable\\. maybe the usb cable is bad|can\'t set config)",
  re: /^usb (\d+-[\d.]+): (?:device descriptor read\/\w+, error -?\d+|device not accepting address \d+, error -?\d+|unable to enumerate USB device|Cannot enable\. Maybe the USB cable is bad\?|can't set config #\d+, error -?\d+)/i,
  title: "USB device failed to connect",
  meaning: "A USB device was detected but could not be set up. Usually a bad cable, hub or port, or an unhappy device.",
  key: function (m) { return "usb|port|" + m[1] },
  device: function (m) { return "USB port " + m[1] }
})

// -- Network and wireless --

rule({
  id: "net.watchdog", cls: "net", sev: "warning", prio: 50, pre: "netdev watchdog: ",
  re: /NETDEV WATCHDOG: (\S+) \(([\w-]+)\): transmit queue (\d+) timed out/i,
  title: "Network adapter stalled",
  meaning: "A network adapter stopped sending packets and the kernel's watchdog reset it. Usually a driver or firmware problem.",
  key: function (m) { return "net|" + m[1] },
  device: function (m) { return m[1] + " (" + m[2] + ")" }
})

rule({
  id: "net.iwlwifi", cls: "net", sev: "warning", prio: 50, pre: "iwlwifi [0-9a-f:.]+: (?:microcode sw error detected|start iwl error log dump|hardware error detected)",
  re: /iwlwifi ([0-9a-f:.]+): (?:Microcode SW error detected|Start IWL Error Log Dump|Hardware error detected)/i,
  title: "Wi-Fi firmware error (Intel)",
  meaning: "The Intel Wi-Fi firmware crashed and the driver is restarting it. Wi-Fi drops briefly and usually recovers.",
  key: function (m) { return "net|iwlwifi|" + pciKey(m[1]) },
  device: function (m) { return "Wi-Fi " + pciShort(m[1]) }
})

rule({
  id: "bt.timeout", cls: "bt", sev: "notice", prio: 25, pre: "bluetooth: hci\\d+: command ",
  re: /^Bluetooth: (hci\d+): command (?:0x[0-9a-f]+ )?tx timeout/i,
  title: "Bluetooth adapter timed out",
  meaning: "The Bluetooth adapter did not answer a command in time. Often fixed by the adapter being reset or the system being resumed.",
  key: function (m) { return "bt|" + m[1] },
  device: function (m) { return m[1] }
})

// ---- public API ------------------------------------------------------------

function build(r, m, msg) {
  var info = r.info ? r.info(m) : null
  return {
    rule: r.id,
    cls: r.cls,
    sev: info ? info.sev : (r.sev || "notice"),
    prio: info ? info.prio : (r.prio || 0),
    title: info ? info.title : (r.title || ""),
    meaning: info ? info.meaning : (r.meaning || ""),
    key: r.key ? r.key(m, msg) : r.cls,
    device: r.device ? r.device(m, msg) : "",
    detail: r.detail ? r.detail(m, msg) : ""
  }
}

// Returns null for anything that is not a fault, or a classification object.
function classify(message) {
  var msg = String(message === undefined || message === null ? "" : message)
  if (msg.length === 0) return null
  if (msg.length > MAX_MESSAGE) msg = msg.slice(0, MAX_MESSAGE)
  for (var i = 0; i < RULES.length; i++) {
    var r = RULES[i]
    var m = r.re.exec(msg)
    if (m) return build(r, m, msg)
  }
  return null
}

// One case-insensitive regular expression, valid in both PCRE (journalctl
// --grep) and JavaScript, that matches every message any rule might classify.
// It is anchored to the start of the message on purpose: unanchored, PCRE tries
// every alternative at every character of every line, which made scanning a
// two-million-line boot take over a minute; anchored, a line that cannot match
// is rejected after a few characters.
function prefilter() {
  var seen = {}
  var parts = []
  for (var i = 0; i < PREFILTER.length; i++) {
    if (!seen[PREFILTER[i]]) { seen[PREFILTER[i]] = true; parts.push(PREFILTER[i]) }
  }
  return "^(?:" + parts.join("|") + ")"
}

function ruleIds() {
  var out = []
  for (var i = 0; i < RULES.length; i++) out.push(RULES[i].id)
  return out
}
