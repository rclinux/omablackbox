import QtQuick
import qs.Commons

// Colours for OmaBlackbox (named Tones because QtQuick already owns "Palette"), derived from the active Omarchy theme so the plugin
// looks native under every theme. Only severity needs its own hue: critical
// uses the theme's urgent colour, warning a warm amber, notice a calm blue.
QtObject {
  id: root

  property color foreground: Color.foreground
  property color urgent: Color.urgent

  readonly property color dim: Qt.darker(foreground, 1.4)
  readonly property color faint: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.45)
  readonly property color hairline: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.12)
  readonly property color wash: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.06)
  readonly property color washStrong: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.11)

  readonly property color critical: urgent
  readonly property color warning: Qt.hsla(0.105, 0.72, 0.60, 1)
  readonly property color notice: Qt.tint(foreground, Qt.rgba(0.35, 0.60, 0.85, 0.55))
  readonly property color calm: Qt.tint(foreground, Qt.rgba(0.42, 0.72, 0.55, 0.55))

  function sev(name) {
    return name === "critical" ? critical : (name === "warning" ? warning : notice)
  }
}
