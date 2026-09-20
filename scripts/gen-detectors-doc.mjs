// Generates docs/DETECTORS.md from the live rule table so the documentation
// cannot drift from the code. Run: node scripts/gen-detectors-doc.mjs
import { writeFileSync } from "node:fs"
import { Rules } from "../test/load.mjs"

const CLASS = { gpu: "GPU", pcie: "PCIe", memory: "Memory", cpu: "CPU", thermal: "Thermal", nvme: "NVMe", storage: "Storage", filesystem: "Filesystem", usb: "USB", net: "Network", bt: "Bluetooth", kernel: "Kernel" }
const rows = []
for (const r of Rules.RULES) {
  if (r.info) continue
  rows.push([CLASS[r.cls] || r.cls, r.title, r.sev, r.id])
}
const order = Object.values(CLASS)
rows.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))

let md = "# What OmaBlackbox detects\n\n"
md += "Generated from `lib/Rules.js` by `scripts/gen-detectors-doc.mjs`. Detectors are deliberately conservative: a line only counts if it is a fault, never because it merely mentions a subsystem. A missed benign line costs nothing; a false alarm costs trust.\n\n"
md += "Severity: **critical** means data or a device is likely lost, **warning** means something failed but the system carried on, **notice** means usually harmless (hidden by default).\n\n"
md += "| Area | Event | Severity | Rule id |\n|---|---|---|---|\n"
for (const [area, title, sev, id] of rows) md += `| ${area} | ${title} | ${sev} | \`${id}\` |\n`

md += "\n### PCIe errors (severity follows the error class)\n\n"
md += "| Reported by the kernel | Shown as | Severity |\n|---|---|---|\n"
md += "| `severity=Corrected` / AER *Corrected* | PCIe corrected error | notice |\n"
md += "| `Uncorrected (Non-Fatal)` | PCIe uncorrected error (non-fatal) | warning |\n"
md += "| `Uncorrected (Fatal)` | PCIe uncorrected error (fatal) | critical |\n"

md += "\n### NVIDIA Xid codes with a specific description\n\n"
md += "Any other Xid is shown as *NVIDIA driver reported Xid N* (warning). An Xid says what the driver saw, not why.\n\n"
md += "| Xid | Shown as | Severity |\n|---|---|---|\n"
for (const code of Object.keys(Rules.XID).map(Number).sort((a, b) => a - b)) {
  const [title, sev] = Rules.XID[code]
  md += `| ${code} | ${title} | ${sev} |\n`
}
md += "\n## Session ended without a clean shutdown\n\nSeparately from the log lines, OmaBlackbox notices when an earlier session's log stops without systemd's shutdown sequence (power loss, hard reset, freeze or crash). When a critical fault occurred in the last three minutes of that session, the two are shown as one event.\n"
writeFileSync(new URL("../docs/DETECTORS.md", import.meta.url), md)
console.log(`wrote docs/DETECTORS.md (${rows.length} detectors, ${Object.keys(Rules.XID).length} Xid codes)`)
