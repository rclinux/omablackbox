import test from "node:test"
import assert from "node:assert/strict"
import { Rules, Incidents, ev, plain } from "./load.mjs"

const classify = (m) => Rules.classify(m)
const fresh = () => Incidents.createStore()
const ingest = (store, e) => Incidents.ingest(store, e, classify)

const SANITY = "NVRM: _threadNodeCheckTimeout: API_GPU_ATTACHED_SANITY_CHECK failed!"
const XID79 = "NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus."
const XID154 = "NVRM: Xid (PCI:0000:01:00): 154, GPU recovery action changed from 0x0 (None) to 0x2 (Node Reboot Required)"

test("a real GPU failure sequence collapses into one incident with the most specific title", () => {
  const s = fresh()
  ingest(s, ev(100.1, SANITY))
  ingest(s, ev(100.6, XID79))
  ingest(s, ev(100.7, "NVRM: GPU 0000:01:00.0: GPU has fallen off the bus."))
  ingest(s, ev(101.2, XID154))
  const rows = Incidents.rows(s, {})
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.title, "GPU fell off the bus")
  assert.equal(r.sev, "critical")
  assert.equal(r.cls, "gpu")
  assert.equal(r.count, 4)
  assert.deepEqual(plain(r.parts.map((p) => p.title)), ["GPU stopped responding", "GPU fell off the bus", "GPU recovery action changed"], "one step per distinct event, in order")
  assert.equal(r.parts[1].n, 2, "the two descriptions of the same event are counted together")
  assert.deepEqual(plain(r.devices), ["NVIDIA GPU 01:00"], "the same GPU is listed once")
  assert.equal(r.device, "NVIDIA GPU 01:00")
})

test("faults far apart are separate incidents", () => {
  const s = fresh()
  ingest(s, ev(0, "NVRM: Xid (PCI:0000:01:00): 13, pid=1, name=a, Graphics Exception"))
  ingest(s, ev(300, "NVRM: Xid (PCI:0000:01:00): 13, pid=1, name=a, Graphics Exception"))
  assert.equal(Incidents.rows(s, {}).length, 2)
})

test("lines inside the gap window extend the same incident", () => {
  const s = fresh()
  for (let t = 0; t < 300; t += 30) ingest(s, ev(t, "pcieport 0000:00:1c.0: PCIe Bus Error: severity=Corrected, type=Physical Layer"))
  const rows = Incidents.rows(s, {})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].count, 10)
})

test("boots never merge with each other", () => {
  const s = fresh()
  ingest(s, ev(0, XID79, "bootA"))
  ingest(s, ev(5, XID79, "bootB"))
  assert.equal(Incidents.rows(s, {}).length, 2)
})

test("duplicate journal cursors are ignored (backfill + live overlap)", () => {
  const s = fresh()
  const a = ev(0, XID79, "b1", "cursor-1")
  assert.ok(ingest(s, a))
  assert.equal(ingest(s, a), null)
  assert.equal(Incidents.rows(s, {})[0].count, 1)
})

test("ingest reports creation and escalation for notifications", () => {
  const s = fresh()
  const first = ingest(s, ev(0, "amdgpu 0000:0c:00.0: amdgpu: ring gfx_0.0.0 timeout, signaled seq=1, emitted seq=2"))
  assert.equal(first.created, true)
  assert.equal(first.incident.sev, "warning")
  const second = ingest(s, ev(2, "amdgpu 0000:0c:00.0: amdgpu: GPU reset(2) failed"))
  assert.equal(second.created, false)
  assert.equal(second.escalated, true)
  assert.equal(second.incident.sev, "critical")
  assert.equal(second.incident.title, "GPU reset failed")
  const third = ingest(s, ev(3, "amdgpu 0000:0c:00.0: amdgpu: GPU reset begin!"))
  assert.equal(third.escalated, false)
})

test("non-fault lines are ignored and create nothing", () => {
  const s = fresh()
  assert.equal(ingest(s, ev(0, "usb 1-1: new high-speed USB device number 4 using xhci_hcd")), null)
  assert.equal(Incidents.rows(s, {}).length, 0)
})

test("raw lines are bounded but keep the start and the end", () => {
  const s = fresh()
  for (let i = 0; i < 200; i++) ingest(s, ev(i * 0.05, `NVRM: Xid (PCI:0000:01:00): 31, pid=${i}, MMU Fault`))
  const r = Incidents.rows(s, {})[0]
  assert.equal(r.count, 200)
  assert.equal(r.lines.length, 40)
  assert.equal(r.dropped, 160)
  assert.match(r.lines[0].msg, /pid=0,/)
  assert.match(r.lines[29].msg, /pid=29,/)
  assert.match(r.lines[39].msg, /pid=199,/)
})

test("parts are de-duplicated and counted, and bounded", () => {
  const s = fresh()
  for (let i = 0; i < 30; i++) ingest(s, ev(i * 0.1, "NVRM: Xid (PCI:0000:01:00): 13, pid=1, name=a, Graphics Exception"))
  const r = Incidents.rows(s, {})[0]
  assert.equal(r.parts.length, 1)
  assert.equal(r.parts[0].n, 30)
})

test("the store caps how many incidents it remembers", () => {
  const s = fresh()
  for (let i = 0; i < 700; i++) ingest(s, ev(i * 1000, "usb 1-4: device descriptor read/64, error -71", "b1"))
  assert.ok(Incidents.rows(s, {}).length <= 450)
  const newest = Incidents.rows(s, {})[0]
  assert.equal(newest.lastTs, 699 * 1000 * 1e6, "newest survives pruning")
})

test("the seen-cursor memory is bounded", () => {
  const s = fresh()
  for (let i = 0; i < 9000; i++) ingest(s, ev(i, "irrelevant line", "b1", "cur-" + i))
  assert.ok(s.seenQueue.length <= 8000)
  assert.ok(Object.keys(s.seen).length <= 8000)
})

test("rows are newest first and unread depends on ack time and minimum severity", () => {
  const s = fresh()
  ingest(s, ev(1000, "pcieport 0000:00:1c.0: PCIe Bus Error: severity=Corrected, type=Physical Layer"))   // notice
  ingest(s, ev(2000, "usb 1-4: device descriptor read/64, error -71"))                                   // warning
  ingest(s, ev(3000, XID79))                                                                             // critical
  let rows = Incidents.rows(s, { ackedThrough: 0, minSeverity: "warning" })
  assert.deepEqual(plain(rows.map((r) => r.sev)), ["critical", "warning", "notice"])
  assert.deepEqual(plain(rows.map((r) => r.unread)), [true, true, false])
  rows = Incidents.rows(s, { ackedThrough: 2000e6, minSeverity: "warning" })
  assert.deepEqual(plain(rows.map((r) => r.unread)), [true, false, false])
  rows = Incidents.rows(s, { ackedThrough: 0, minSeverity: "critical" })
  assert.deepEqual(plain(rows.map((r) => r.unread)), [true, false, false])
  const sum = Incidents.summary(Incidents.rows(s, { ackedThrough: 0, minSeverity: "notice" }))
  assert.equal(sum.unread, 3)
  assert.equal(sum.worst, "critical")
  assert.equal(Incidents.summary(Incidents.rows(s, { ackedThrough: 9999e6 })).unread, 0)
  assert.equal(Incidents.summary([]).worst, "")
})

test("a boot that ended abruptly right after a critical fault is linked to it", () => {
  const s = fresh()
  ingest(s, ev(1000, XID79, "bootX"))
  const end = Incidents.addBootEnd(s, { boot: "bootX", firstTs: 500e6, lastTs: 1006e6 })
  assert.equal(end.kind, "boot")
  assert.equal(end.sev, "critical")
  assert.equal(end.relatedTitle, "GPU fell off the bus")
  assert.match(end.detail, /GPU fell off the bus, 6 s before the log ended/)
})

test("an abrupt end with no recent fault is a plain warning, and adding it twice is harmless", () => {
  const s = fresh()
  ingest(s, ev(10, XID79, "bootY"))     // long before the end: not correlated
  const a = Incidents.addBootEnd(s, { boot: "bootY", firstTs: 1e6, lastTs: 5000e6 })
  const b = Incidents.addBootEnd(s, { boot: "bootY", firstTs: 1e6, lastTs: 5000e6 })
  assert.equal(a, b)
  assert.equal(a.sev, "warning")
  assert.equal(a.detail, "")
  assert.equal(Incidents.rows(s, {}).filter((r) => r.kind === "boot").length, 1)
})

test("a boot-end never borrows a fault from a different boot", () => {
  const s = fresh()
  ingest(s, ev(1000, XID79, "bootA"))
  const end = Incidents.addBootEnd(s, { boot: "bootB", firstTs: 1e6, lastTs: 1002e6 })
  assert.equal(end.sev, "warning")
  assert.equal(end.related, "")
})

test("malformed events are rejected without throwing", () => {
  const s = fresh()
  for (const bad of [null, undefined, {}, { msg: 5 }, { ts: "x", msg: XID79 }]) {
    assert.doesNotThrow(() => ingest(s, bad))
  }
})

test("lines dropped by the flood guard are credited to the incident they belonged to", () => {
  const s = fresh()
  Incidents.addDropped(s, 5) // nothing to credit yet: harmless
  ingest(s, ev(0, XID79))
  Incidents.addDropped(s, 1000)
  const r = Incidents.rows(s, {})[0]
  assert.equal(r.count, 1001)
  assert.equal(r.lines.length, 1)
  assert.equal(r.dropped, 1000)
})

test("a finished boot round-trips through the cache as JSON", () => {
  const s = fresh()
  ingest(s, ev(1000, XID79, "bootX"))
  ingest(s, ev(1010, "usb 1-4: device descriptor read/64, error -71", "bootX"))
  ingest(s, ev(50, "usb 1-4: device descriptor read/64, error -71", "bootOther"))
  Incidents.addBootEnd(s, { boot: "bootX", firstTs: 900e6, lastTs: 1012e6 })
  const cached = JSON.parse(JSON.stringify(Incidents.exportBoot(s, "bootX")))
  assert.equal(cached.length, 3)
  const t = fresh()
  assert.equal(Incidents.importIncidents(t, cached), 3)
  assert.equal(Incidents.importIncidents(t, cached), 0, "importing twice adds nothing")
  const a = Incidents.rows(s, {}).filter((r) => r.boot === "bootX")
  const b = Incidents.rows(t, {})
  assert.deepEqual(plain(b.map((r) => [r.id, r.sev, r.title, r.count, r.kind])), plain(a.map((r) => [r.id, r.sev, r.title, r.count, r.kind])))
})

test("a corrupt cache is ignored rather than trusted", () => {
  const t = fresh()
  const good = { id: "g", boot: "b", kind: "fault", cls: "gpu", sev: "warning", title: "ok", firstTs: 1, lastTs: 2 }
  const junk = [null, 5, "x", {}, { id: "a" }, { ...good, id: "s", sev: "apocalyptic" }, { ...good, id: "t", firstTs: "1" }, { ...good, id: "u", lines: "nope", parts: 7, devices: 9 }, good]
  const added = Incidents.importIncidents(t, junk)
  assert.equal(added, 2, "only well-formed entries are imported (good and the one with junk optional fields)")
  for (const r of Incidents.rows(t, {})) {
    assert.ok(Array.isArray(r.lines) && Array.isArray(r.parts) && Array.isArray(r.devices))
  }
  assert.doesNotThrow(() => Incidents.importIncidents(t, undefined))
  assert.doesNotThrow(() => Incidents.importIncidents(t, "not a list"))
})

test("a truncated scan is flagged, and a boot-end never claims a precise gap from it", () => {
  const s = fresh()
  for (let i = 0; i < 50; i++) ingest(s, ev(1000 + i, "NVRM: gpuHandleSanityCheckRegReadError_GHN: Possible bad register read: addr: 0x1"))
  Incidents.markTruncated(s, "b1")
  const end = Incidents.addBootEnd(s, { boot: "b1", firstTs: 500e6, lastTs: 1200e6 })
  assert.equal(end.sev, "critical")
  assert.match(end.detail, /GPU registers unreadable \(a very large burst of log lines\)/)
  assert.ok(!/before the log ended/.test(end.detail))
  assert.equal(Incidents.rows(s, {}).find((r) => r.kind === "fault").truncated, true)
  const back = fresh()
  Incidents.importIncidents(back, JSON.parse(JSON.stringify(Incidents.exportBoot(s, "b1"))))
  assert.equal(Incidents.rows(back, {}).find((r) => r.kind === "fault").truncated, true, "flag survives the cache")
})

test("a boot that ended right after a critical fault is one row, with the shutdown as a note", () => {
  const s = fresh()
  ingest(s, ev(1000, XID79, "bootX"))
  Incidents.addBootEnd(s, { boot: "bootX", firstTs: 500e6, lastTs: 1006e6 })
  const rows = Incidents.rows(s, { ackedThrough: 0, minSeverity: "warning" })
  assert.equal(rows.length, 1, "no separate 'session ended' row")
  assert.equal(rows[0].kind, "fault")
  assert.equal(rows[0].title, "GPU fell off the bus")
  assert.equal(rows[0].endNote, "Then the session ended without a clean shutdown, 6 s later.")
  assert.equal(Incidents.summary(rows).unread, 1, "one story, one unread event")
  assert.equal(Incidents.exportBoot(s, "bootX").length, 2, "both are still stored and cached")
})

test("an unread abrupt end still counts when only the shutdown is newer than the acknowledgement", () => {
  const s = fresh()
  ingest(s, ev(1000, XID79, "bootX"))
  Incidents.addBootEnd(s, { boot: "bootX", firstTs: 500e6, lastTs: 1006e6 })
  const acked = Incidents.rows(s, { ackedThrough: 1003e6, minSeverity: "warning" })
  assert.equal(acked[0].unread, true, "the shutdown at 1006 s is newer than the ack at 1003 s")
  assert.equal(Incidents.rows(s, { ackedThrough: 1007e6, minSeverity: "warning" })[0].unread, false)
})

test("a truncated burst gets an honest end note, and an unrelated abrupt end stays its own row", () => {
  const s = fresh()
  ingest(s, ev(1000, "NVRM: gpuHandleSanityCheckRegReadError_GHN: Possible bad register read: addr: 0x1", "bootT"))
  Incidents.markTruncated(s, "bootT")
  Incidents.addBootEnd(s, { boot: "bootT", firstTs: 500e6, lastTs: 1100e6 })
  Incidents.addBootEnd(s, { boot: "bootU", firstTs: 1e6, lastTs: 9000e6 })
  const rows = Incidents.rows(s, { ackedThrough: 0, minSeverity: "warning" })
  assert.equal(rows.length, 2)
  const fault = rows.find((r) => r.kind === "fault")
  const alone = rows.find((r) => r.kind === "boot")
  assert.match(fault.endNote, /during a very large burst of log lines/)
  assert.equal(alone.boot, "bootU")
  assert.equal(alone.endNote, "")
})
