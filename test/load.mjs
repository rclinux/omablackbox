// Loads the QML-side JavaScript libraries (.pragma library files) into Node so
// they can be unit tested. Each file is evaluated in its own vm context; its
// top-level functions and vars become the returned module object, exactly as
// QML sees them under `import "lib/X.js" as X`.
process.env.TZ = "UTC"

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import vm from "node:vm"

const here = dirname(fileURLToPath(import.meta.url))

export function loadLib(name) {
  const file = join(here, "..", "lib", name + ".js")
  const src = readFileSync(file, "utf8").replace(/^\.pragma library\s*$/m, "")
  const ctx = vm.createContext({})
  vm.runInContext(src, ctx, { filename: file })
  return ctx
}

export const Rules = loadLib("Rules")
export const Incidents = loadLib("Incidents")
export const Redact = loadLib("Redact")
export const Format = loadLib("Format")
export const Journal = loadLib("Journal")
export const Report = loadLib("Report")

// Helper: build a journal-style event, timestamps in seconds -> microseconds.
let cursorSeq = 0
export function ev(seconds, msg, boot = "b1", cursor) {
  cursorSeq += 1
  return { ts: Math.round(seconds * 1e6), cursor: cursor ?? `c${cursorSeq}`, msg, boot }
}

// Arrays/objects built inside a vm context have a foreign prototype; strict deep-equal
// rejects them. Round-trip through JSON to compare structure only.
export const plain = (x) => JSON.parse(JSON.stringify(x))
