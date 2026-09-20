.pragma library

// Sample data for the "Preview" setting. It exists so the plugin's look can be
// judged, screenshotted and theme-tested on a healthy machine. The events are
// synthetic kernel messages that go through the same classifier and grouping
// as real ones; nothing here touches the journal, the state file or the
// notification service.

var HOUR = 3600 * 1000000
var MIN = 60 * 1000000

var BOOTS = {
  now: "0123456789abcdef0123456789abcdef",
  gpu: "1123456789abcdef0123456789abcdef",
  nvme: "2123456789abcdef0123456789abcdef",
  usb: "3123456789abcdef0123456789abcdef",
  lost: "4123456789abcdef0123456789abcdef",
  pcie: "5123456789abcdef0123456789abcdef"
}

var seq = 0
function line(nowUs, agoUs, boot, msg) {
  seq += 1
  return { ts: nowUs - agoUs, cursor: "preview-" + seq, msg: msg, boot: boot }
}

// mode: "events" | "quiet" | "no-access"
// -> { events, ends, sessions, uptimeUs }
function build(mode, nowUs) {
  seq = 0
  var out = { events: [], ends: [], sessions: 1, uptimeUs: 95 * MIN }
  if (mode !== "events") return out

  var e = out.events
  var gpuAgo = 100 * MIN
  e.push(line(nowUs, gpuAgo + 5100000, BOOTS.gpu, "NVRM: _threadNodeCheckTimeout: API_GPU_ATTACHED_SANITY_CHECK failed!"))
  e.push(line(nowUs, gpuAgo + 4600000, BOOTS.gpu, "NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus."))
  e.push(line(nowUs, gpuAgo + 4500000, BOOTS.gpu, "NVRM: GPU 0000:01:00.0: GPU has fallen off the bus."))
  e.push(line(nowUs, gpuAgo + 3900000, BOOTS.gpu, "NVRM: Xid (PCI:0000:01:00): 154, GPU recovery action changed from 0x0 (None) to 0x2 (Node Reboot Required)"))
  out.ends.push({ boot: BOOTS.gpu, firstTs: nowUs - 9 * HOUR, lastTs: nowUs - gpuAgo })

  var nvmeAgo = 27 * HOUR
  e.push(line(nowUs, nvmeAgo + 21000000, BOOTS.nvme, "nvme nvme0: I/O 258 (I/O Cmd) QID 4 timeout, aborting"))
  e.push(line(nowUs, nvmeAgo + 14000000, BOOTS.nvme, "nvme nvme0: I/O 259 (I/O Cmd) QID 4 timeout, aborting"))
  e.push(line(nowUs, nvmeAgo + 2000000, BOOTS.nvme, "nvme nvme0: I/O 260 (I/O Cmd) QID 2 timeout, reset controller"))

  var usbAgo = 3 * 24 * HOUR
  e.push(line(nowUs, usbAgo + 8000000, BOOTS.usb, "usb 1-4: device descriptor read/64, error -71"))
  e.push(line(nowUs, usbAgo + 3000000, BOOTS.usb, "usb 1-4: device not accepting address 7, error -71"))

  out.ends.push({ boot: BOOTS.lost, firstTs: nowUs - 4 * 24 * HOUR - 6 * HOUR, lastTs: nowUs - 4 * 24 * HOUR })

  var pcieAgo = 5 * 24 * HOUR
  for (var i = 0; i < 4; i++) {
    e.push(line(nowUs, pcieAgo + i * 20000000, BOOTS.pcie, "pcieport 0000:00:1c.0: PCIe Bus Error: severity=Corrected, type=Physical Layer, (Receiver ID)"))
  }

  out.sessions = 14
  return out
}
