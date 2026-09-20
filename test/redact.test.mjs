import test from "node:test"
import assert from "node:assert/strict"
import { Redact, Report, Format, plain } from "./load.mjs"

const r = (s) => Redact.redact(s).text

test("firewall log identifiers are masked", () => {
  const line = "[UFW BLOCK] IN=eth0 OUT= MAC=aa:bb:cc:dd:ee:ff:11:22:33:44:55:66:08:00 SRC=192.0.2.10 DST=198.51.100.7 LEN=328 SPT=1900"
  const out = r(line)
  assert.ok(!/aa:bb:cc/.test(out))
  assert.ok(!/192\.0\.2\.10/.test(out) && !/198\.51\.100\.7/.test(out))
  assert.match(out, /MAC=<mac>/)
  assert.match(out, /SRC=<ip> DST=<ip>/)
  assert.match(out, /LEN=328 SPT=1900/, "unrelated numbers are untouched")
})

test("IPv6 addresses are masked, but PCI addresses and clock times are not", () => {
  assert.equal(r("SRC=2001:db8::1 DST=fe80::1234:5678"), "SRC=<ip> DST=<ip>")
  assert.equal(r("SRC=2001:0db8:0000:0000:0000:0000:0000:0001"), "SRC=<ip>")
  assert.equal(r("pcieport 0000:00:1c.0: AER: Corrected error"), "pcieport 0000:00:1c.0: AER: Corrected error")
  assert.equal(r("at 06:42:01 boot"), "at 06:42:01 boot")
  assert.equal(r("NVRM: Xid (PCI:0000:01:00): 79"), "NVRM: Xid (PCI:0000:01:00): 79")
})

test("GPU and other UUIDs are masked", () => {
  assert.equal(r("NVRM: GPU at PCI:0000:01:00: GPU-00000000-aaaa-bbbb-cccc-111111111111"), "NVRM: GPU at PCI:0000:01:00: GPU-<uuid>")
  assert.equal(r("fsid 00000000-1111-2222-3333-444444444444 mounted"), "fsid <uuid> mounted")
})

test("serial numbers are masked but the word 'serial' in other contexts is not", () => {
  assert.equal(r("NVRM: GPU 0000:01:00.0: GPU serial number is 1234567890123."), "NVRM: GPU 0000:01:00.0: GPU serial number is <serial>.")
  assert.equal(r("Serial Number: ABC-123_x"), "Serial Number: <serial>")
  assert.equal(r("SN=XYZ99 fw=1.2"), "SN=<serial> fw=1.2")
  assert.equal(r("serial8250: ttyS0 at I/O 0x3f8 is a 16550A"), "serial8250: ttyS0 at I/O 0x3f8 is a 16550A")
  assert.equal(r("serial console enabled"), "serial console enabled")
})

test("home paths, e-mail addresses and disk ids are masked", () => {
  assert.equal(r("loaded /home/alice/.config/foo"), "loaded /home/<user>/.config/foo")
  assert.equal(r("contact alice@example.com now"), "contact <email> now")
  assert.equal(r("/dev/disk/by-id/nvme-Example_SSD_1TB_S1234ABCD"), "/dev/disk/by-id/<id>")
  assert.ok(!/S1234ABCD/.test(r("/dev/disk/by-id/nvme-Example_SSD_1TB_S1234ABCD")))
  assert.equal(r("wwn-0x5000c500a1b2c3d4"), "wwn-<id>")
})

test("useful diagnostic detail is preserved", () => {
  const keep = "NVRM: Xid (PCI:0000:01:00): 79, pid=1234, name=game, GPU has fallen off the bus. driver 610.57.04 kernel 7.2.5-3-omarchy"
  assert.equal(r(keep), keep)
  const bug = "BUG: kernel NULL pointer dereference, address: 0000000000000008 RIP: 0010:foo+0x12/0x34"
  assert.equal(r(bug), bug)
})

test("redaction is idempotent and counts what it masked", () => {
  const once = Redact.redact("SRC=192.0.2.10 MAC=aa:bb:cc:dd:ee:ff SRC2=198.51.100.7")
  assert.equal(r(once.text), once.text)
  assert.equal(once.counts.ip, 2)
  assert.equal(once.counts.mac, 1)
  assert.equal(once.total, 3)
})

test("redactMany merges counts and tolerates non-strings", () => {
  const out = Redact.redactMany(["a 192.0.2.1", "b 192.0.2.2", undefined, null, 5])
  assert.equal(out.total, 2)
  assert.equal(out.list.length, 5)
  assert.equal(out.counts.ip, 2)
})

test("redaction stays fast on long adversarial input", () => {
  const nasty = "a:".repeat(1000) + "1.".repeat(1000) + "00:".repeat(1000) + "x".repeat(5000)
  const start = Date.now()
  for (let i = 0; i < 20; i++) Redact.redact(nasty)
  assert.ok(Date.now() - start < 1500)
})

// ---- the exported report ---------------------------------------------------

const LEAKY = {
  meta: { version: "1.0.0", kernel: "7.2.5-3-omarchy", omarchy: "4.0.4", generatedMs: Date.UTC(2026, 8, 20, 12, 0, 0), scanDays: 14, boots: 4 },
  rows: [{
    id: "x", kind: "fault", cls: "gpu", sev: "critical", title: "GPU fell off the bus",
    device: "NVIDIA GPU 01:00", devices: ["NVIDIA GPU 01:00"], detail: "Xid 79", meaning: "The GPU stopped answering.",
    parts: [{ title: "GPU stopped responding", n: 1 }, { title: "GPU fell off the bus", n: 1 }],
    firstTs: Date.UTC(2026, 8, 20, 11, 0, 0) * 1000, lastTs: Date.UTC(2026, 8, 20, 11, 0, 3) * 1000, count: 3, dropped: 0,
    lines: [
      { ts: Date.UTC(2026, 8, 20, 11, 0, 0) * 1000, msg: "NVRM: GPU at PCI:0000:01:00: GPU-00000000-aaaa-bbbb-cccc-111111111111" },
      { ts: Date.UTC(2026, 8, 20, 11, 0, 1) * 1000, msg: "NVRM: GPU 0000:01:00.0: GPU serial number is 1234567890123." },
      { ts: Date.UTC(2026, 8, 20, 11, 0, 3) * 1000, msg: "[UFW BLOCK] SRC=192.0.2.10 DST=198.51.100.7 MAC=aa:bb:cc:dd:ee:ff:11:22:33:44:55:66:08:00 path /home/alice/x" }
    ]
  }]
}

const build = (extra) => Report.buildReport({ ...LEAKY, ...extra, deps: { redact: Redact.redact, fmt: Format } })

test("the exported report contains no raw identifiers", () => {
  const out = build({ redact: true })
  for (const secret of ["aaaa-bbbb", "1234567890123", "192.0.2.10", "198.51.100.7", "aa:bb:cc", "alice"]) {
    assert.ok(!out.includes(secret), `report leaks ${secret}`)
  }
  assert.ok(out.includes("0000:01:00"), "PCI address is kept")
  assert.ok(out.includes("GPU fell off the bus"))
  assert.match(out, /masked automatically/)
  assert.match(out, /Sequence: GPU stopped responding → GPU fell off the bus/)
})

test("an unredacted report says so loudly", () => {
  const out = build({ redact: false })
  assert.ok(out.includes("192.0.2.10"))
  assert.match(out, /NOT redacted/)
})

test("an empty report is still a valid, honest report", () => {
  const out = Report.buildReport({ meta: LEAKY.meta, rows: [], redact: true, deps: { redact: Redact.redact, fmt: Format } })
  assert.match(out, /No hardware faults were recorded/)
})

test("the report notes how the session ended and marks truncated counts honestly", () => {
  const row = {
    ...LEAKY.rows[0], count: 20000, truncated: true, dropped: 19960,
    endNote: "Then the session ended without a clean shutdown, during a very large burst of log lines."
  }
  const out = Report.buildReport({ ...LEAKY, rows: [row], redact: true, deps: { redact: Redact.redact, fmt: Format } })
  assert.match(out, /\| 20,000\+ \|/, "table shows 20,000+")
  assert.match(out, /Lines logged: 20,000\+ \(only the start was read\)/)
  assert.match(out, /Then the session ended without a clean shutdown/)
  assert.match(out, /19,960\+ more lines omitted/)
})
