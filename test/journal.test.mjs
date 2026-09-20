import test from "node:test"
import assert from "node:assert/strict"
import { Journal, Format, plain } from "./load.mjs"

const BOOT_A = "a".repeat(32)
const BOOT_B = "b".repeat(32)
const BOOT_C = "c".repeat(32)
const BOOT_D = "d".repeat(32)

const DAY = 86400 * 1e6
const NOW = 1_800_000_000 * 1e6

test("journalctl argv: follow tails the current boot's kernel messages with a prefilter", () => {
  const a = plain(Journal.followArgs("nvrm", true))
  assert.equal(a[0], "journalctl")
  assert.ok(a.includes("-f") && a.includes("-n") && a.includes("json"))
  assert.equal(a[a.indexOf("-g") + 1], "nvrm")
  assert.ok(a.includes("--case-sensitive=false"))
  assert.equal(a[a.length - 1], "_TRANSPORT=kernel", "match expression comes last")
})

test("journalctl argv: fallback mode drops --grep entirely", () => {
  for (const a of [plain(Journal.followArgs("nvrm", false)), plain(Journal.scanArgs("0", "nvrm", false))]) {
    assert.ok(!a.includes("-g") && !a.includes("--case-sensitive=false"))
  }
})

test("journalctl argv: scanning a boot uses its id, never a shell", () => {
  const a = plain(Journal.scanArgs(BOOT_A, "p", true))
  assert.equal(a[a.indexOf("-b") + 1], BOOT_A)
  for (const arg of a) assert.equal(typeof arg, "string")
})

test("boot ids are validated so nothing else reaches journalctl", () => {
  assert.ok(Journal.isBootId(BOOT_A))
  assert.ok(Journal.isBootId(BOOT_A.toUpperCase()))
  for (const bad of ["", "0", "-1", "x; rm -rf /", BOOT_A + "0", BOOT_A.slice(1), "--vacuum-size=1", undefined, null]) {
    assert.ok(!Journal.isBootId(bad), `should reject ${bad}`)
  }
})

test("the shutdown pattern matches the system manager's shutdown chain and nothing else", () => {
  const re = new RegExp(Journal.SHUTDOWN_PATTERN, "i")
  for (const yes of ["Stopped target Local File Systems.", "Stopped target System Initialization.", "Stopped target Basic System.",
                     "Stopping Flush Journal to Persistent Storage...", "Stopping Load/Save OS Random Seed...",
                     "Stopping Load/Save Random Seed...", "Stopping Record System Boot/Shutdown in UTMP..."]) {
    assert.ok(re.test(yes), yes)
  }
  for (const no of [
    "Reached target Shutdown.",                       // logged by the per-user manager at plain logout
    "Reached target Shutdown graphical session units.",
    "Shutting down.", "Received SIGTERM, shutting down...", "Journal stopped",
    "Started Process Core Dump (PID 1/UID 0).", "Reached target Graphical Interface.", "Stopped target Sound Card.",
    "Unmounted /run/media/user/USBSTICK.", "Stopping Docker Application Container Engine..."
  ]) {
    assert.ok(!re.test(no), no)
  }
})

test("the shutdown check is limited to PID 1 so user sessions cannot vouch for the system", () => {
  const a = plain(Journal.shutdownCheckArgs(BOOT_C))
  assert.equal(a[a.length - 1], "_PID=1")
  assert.ok(a.includes("-g") && a.includes("-n"))
})

test("parseEvent handles the journal JSON shapes it will really see", () => {
  const e = Journal.parseEvent(JSON.stringify({ __REALTIME_TIMESTAMP: "1789917801067427", __CURSOR: "s=1;i=2", _BOOT_ID: BOOT_D, PRIORITY: "4", MESSAGE: "NVRM: hi" }))
  assert.equal(e.ts, 1789917801067427)
  assert.equal(e.cursor, "s=1;i=2")
  assert.equal(e.boot, BOOT_D)
  assert.equal(e.msg, "NVRM: hi")
  assert.equal(e.prio, 4)
  const bytes = Journal.parseEvent(JSON.stringify({ __REALTIME_TIMESTAMP: "5", MESSAGE: [72, 105, 300] }))
  assert.equal(bytes.msg, "Hi,", "byte arrays are decoded (masked to 8 bits)")
})

test("parseEvent rejects garbage instead of throwing", () => {
  for (const bad of ["", "  ", "not json", "{", "[]", "null", '{"MESSAGE":"x"}', '{"__REALTIME_TIMESTAMP":"abc"}', undefined, null]) {
    assert.equal(Journal.parseEvent(bad), null, String(bad))
  }
})

test("parseEvents keeps good lines and skips bad ones", () => {
  const text = [
    JSON.stringify({ __REALTIME_TIMESTAMP: "1", MESSAGE: "a" }),
    "-- No entries --",
    "",
    JSON.stringify({ __REALTIME_TIMESTAMP: "2", MESSAGE: "b" })
  ].join("\n")
  assert.deepEqual(plain(Journal.parseEvents(text).map((e) => e.msg)), ["a", "b"])
})

const LIST = JSON.stringify([
  { index: -3, boot_id: BOOT_A, first_entry: NOW - 20 * DAY, last_entry: NOW - 19 * DAY },
  { index: -2, boot_id: BOOT_B, first_entry: NOW - 3 * DAY, last_entry: NOW - 2 * DAY },
  { index: -1, boot_id: BOOT_C, first_entry: NOW - 1 * DAY, last_entry: NOW - 0.5 * DAY },
  { index: 0, boot_id: BOOT_D, first_entry: NOW - 0.4 * DAY, last_entry: NOW }
])

test("parseBootList reads --list-boots json and skips malformed entries", () => {
  assert.equal(Journal.parseBootList(LIST).length, 4)
  const dirty = JSON.stringify([{ index: 0, boot_id: "nope", first_entry: 1, last_entry: 2 }, { index: -1, boot_id: BOOT_A, first_entry: "x", last_entry: 2 }, null])
  assert.equal(Journal.parseBootList(dirty).length, 0)
  for (const bad of ["", "not json", "{}", "null", undefined]) assert.deepEqual(plain(Journal.parseBootList(bad)), [])
})

test("selectBoots returns recent previous boots, newest first, excluding the current one", () => {
  const list = Journal.parseBootList(LIST)
  assert.equal(Journal.currentBoot(list).boot, BOOT_D)
  const sel = plain(Journal.selectBoots(list, NOW, 14, 12).map((b) => b.boot))
  assert.deepEqual(sel, [BOOT_C, BOOT_B], "the 19-day-old boot is outside a 14-day window")
  assert.deepEqual(plain(Journal.selectBoots(list, NOW, 30, 12).map((b) => b.boot)), [BOOT_C, BOOT_B, BOOT_A])
  assert.deepEqual(plain(Journal.selectBoots(list, NOW, 30, 1).map((b) => b.boot)), [BOOT_C], "capped")
  assert.deepEqual(plain(Journal.selectBoots(list, NOW, 30, 0)), [])
  assert.deepEqual(plain(Journal.selectBoots([], NOW, 14, 12)), [])
})

test("a journal with only the current boot yields nothing to scan", () => {
  const only = Journal.parseBootList(JSON.stringify([{ index: 0, boot_id: BOOT_D, first_entry: NOW - DAY, last_entry: NOW }]))
  assert.deepEqual(plain(Journal.selectBoots(only, NOW, 14, 12)), [])
})

test("sawShutdown reads journalctl output for a boot", () => {
  assert.equal(Journal.sawShutdown("Reached target Shutdown.\n"), true)
  assert.equal(Journal.sawShutdown(""), false)
  assert.equal(Journal.sawShutdown("-- No entries --\n"), false)
  assert.equal(Journal.sawShutdown("\n\n"), false)
  assert.equal(Journal.sawShutdown(undefined), false)
})

test("classifyProbe distinguishes readable, permission-denied and missing journals", () => {
  assert.equal(Journal.classifyProbe(0, "Sep 20 kernel: hi\n", ""), "ok")
  assert.equal(Journal.classifyProbe(0, "", "Hint: You are currently not seeing messages from other users and the system."), "no-access")
  assert.equal(Journal.classifyProbe(1, "", "No journal files were opened due to insufficient permissions."), "no-access")
  assert.equal(Journal.classifyProbe(1, "", "Failed to open journal"), "no-journal")
  assert.equal(Journal.classifyProbe(1, "", ""), "no-journal")
  assert.equal(Journal.classifyProbe(0, "-- No entries --\n", ""), "ok", "an empty kernel log is still readable")
})

test("grepUnsupported spots an old journalctl", () => {
  assert.ok(Journal.grepUnsupported("journalctl: unrecognized option '--grep'"))
  assert.ok(Journal.grepUnsupported("Compiled without pattern matching support"))
  assert.ok(!Journal.grepUnsupported("Failed to open journal"))
})

test("time formatting is stable and locale independent (UTC)", () => {
  const t = Date.UTC(2026, 8, 20, 6, 42, 1)
  assert.equal(Format.clock(t), "06:42")
  assert.equal(Format.clockSec(t), "06:42:01")
  assert.equal(Format.dateTime(t), "2026-09-20 06:42:01")
  assert.equal(Format.tzOffset(t), "+00:00")
  const now = Date.UTC(2026, 8, 20, 12, 0, 0)
  assert.equal(Format.dayLabel(t, now), "Today")
  assert.equal(Format.dayLabel(Date.UTC(2026, 8, 19, 23, 59, 0), now), "Yesterday")
  assert.equal(Format.dayLabel(Date.UTC(2026, 8, 14, 8, 0, 0), now), "Mon 14 Sep")
  assert.equal(Format.ago(now - 10 * 1000, now), "just now")
  assert.equal(Format.ago(now - 5 * 60 * 1000, now), "5 min ago")
  assert.equal(Format.ago(now - 3 * 3600 * 1000, now), "3 h ago")
  assert.equal(Format.ago(now - 3 * 86400 * 1000, now), "3 d ago")
  assert.equal(Format.ago(now + 5000, now), "just now", "clock skew never yields a negative")
  assert.equal(Format.duration(45000), "45 s")
  assert.equal(Format.duration(12 * 60000), "12 min")
  assert.equal(Format.duration((4 * 60 + 33) * 60000), "4 h 33 min")
  assert.equal(Format.duration(51 * 3600 * 1000), "2 d 3 h")
  assert.equal(Format.grouped(0), "0")
  assert.equal(Format.grouped(999), "999")
  assert.equal(Format.grouped(20000), "20,000")
  assert.equal(Format.grouped(2184079), "2,184,079")
  assert.equal(Format.plural(1, "boot"), "1 boot")
  assert.equal(Format.plural(3, "boot"), "3 boots")
})

test("the flood guard passes normal traffic untouched", () => {
  const b = Journal.newBucket(0)
  for (let i = 0; i < 200; i++) assert.ok(Journal.admit(b, i * 10), "200 lines over 2 s is normal")
  assert.equal(Journal.takeDropped(b), 0)
})

test("the flood guard sheds a flood and reports how much it shed", () => {
  const b = Journal.newBucket(0)
  let admitted = 0
  for (let i = 0; i < 100000; i++) if (Journal.admit(b, 0)) admitted++   // 100k lines in the same millisecond
  assert.equal(admitted, Journal.FLOOD_BURST)
  assert.equal(Journal.takeDropped(b), 100000 - Journal.FLOOD_BURST)
  assert.equal(Journal.takeDropped(b), 0, "counter resets")
})

test("the flood guard recovers once the flood ends", () => {
  const b = Journal.newBucket(0)
  for (let i = 0; i < 5000; i++) Journal.admit(b, 0)
  assert.ok(!Journal.admit(b, 0))
  assert.ok(Journal.admit(b, 2000), "after 2 s of quiet the bucket has refilled")
})

test("a sustained flood is throttled to the configured rate", () => {
  const b = Journal.newBucket(0)
  let admitted = 0
  for (let ms = 0; ms < 10000; ms++) for (let k = 0; k < 100; k++) if (Journal.admit(b, ms)) admitted++   // 100k lines/s for 10 s
  const perSec = admitted / 10
  assert.ok(perSec <= Journal.FLOOD_RATE + Journal.FLOOD_BURST / 10 + 1, `admitted ${perSec}/s`)
  assert.ok(perSec >= Journal.FLOOD_RATE * 0.9)
})
