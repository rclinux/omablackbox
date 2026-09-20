import test from "node:test"
import assert from "node:assert/strict"
import { loadLib, Rules, Incidents, plain } from "./load.mjs"

const Preview = loadLib("Preview")
const NOW = 1_800_000_000 * 1e6

function store(mode) {
  const s = Incidents.createStore()
  const d = Preview.build(mode, NOW)
  for (const e of d.events) Incidents.ingest(s, e, Rules.classify)
  for (const e of d.ends) Incidents.addBootEnd(s, e)
  return { s, d }
}

test("preview events go through the real classifier and produce the intended story", () => {
  const { s } = store("events")
  // The engine hides incidents below the minimum severity; mirror that here.
  const rows = Incidents.rows(s, { ackedThrough: 0, minSeverity: "warning" }).filter((r) => Incidents.rank(r.sev) >= 2)
  assert.deepEqual(plain(rows.map((r) => [r.title, r.sev, r.kind])), [
    ["GPU fell off the bus", "critical", "fault"],
    ["NVMe command timed out", "warning", "fault"],
    ["USB device failed to connect", "warning", "fault"],
    ["Session ended without a clean shutdown", "warning", "boot"]
  ])
  assert.match(rows[0].endNote, /Then the session ended without a clean shutdown, 4 s later\./)
  const all = Incidents.rows(s, { ackedThrough: 0, minSeverity: "notice" })
  assert.equal(all.filter((r) => r.sev === "notice").length, 1, "one minor PCIe incident, hidden at the default threshold")
  assert.equal(Incidents.summary(Incidents.rows(s, { ackedThrough: 0, minSeverity: "warning" })).unread, 4, "the notice is not counted as unread")
})

test("quiet and no-access previews contain no incidents", () => {
  for (const mode of ["quiet", "no-access"]) {
    assert.equal(Incidents.rows(store(mode).s, {}).length, 0)
  }
})

test("preview data is deterministic in shape and free of identifying values", () => {
  const a = plain(Preview.build("events", NOW))
  const b = plain(Preview.build("events", NOW))
  assert.deepEqual(a, b)
  const blob = JSON.stringify(a)
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(blob) && !/[0-9a-f]{2}(:[0-9a-f]{2}){5}/.test(blob) && !/home\//.test(blob))
})
