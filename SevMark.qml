import QtQuick

// The plugin's one visual motif: a dot. Filled = needs a look, hollow ring =
// quiet or already read. An optional halo pulses gently for critical events.
Item {
  id: root

  property real size: 8
  property color tone: "white"
  property bool filled: true
  property bool pulse: false

  implicitWidth: size
  implicitHeight: size
  width: size
  height: size

  Rectangle {
    id: halo
    anchors.centerIn: parent
    width: root.size
    height: root.size
    radius: width / 2
    color: root.tone
    opacity: 0
    visible: root.pulse

    SequentialAnimation {
      running: root.pulse && root.visible
      loops: Animation.Infinite
      ParallelAnimation {
        NumberAnimation { target: halo; property: "scale"; from: 1.0; to: 2.6; duration: 1800; easing.type: Easing.OutCubic }
        NumberAnimation { target: halo; property: "opacity"; from: 0.38; to: 0.0; duration: 1800; easing.type: Easing.OutCubic }
      }
      PauseAnimation { duration: 900 }
    }
  }

  Rectangle {
    anchors.fill: parent
    radius: width / 2
    color: root.filled ? root.tone : "transparent"
    border.width: root.filled ? 0 : Math.max(1, Math.round(root.size / 6))
    border.color: root.tone

    Behavior on color { ColorAnimation { duration: 180 } }
  }
}
