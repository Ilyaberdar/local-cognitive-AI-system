// Moves and clicks the real macOS pointer, so screen recordings show the actual cursor and clicks.
// Reads one JSON command per line on stdin and answers each with one JSON line on stdout:
//   {"op":"move","x":800,"y":500,"ms":700}   eased path from where the pointer is now
//   {"op":"click","x":800,"y":500}           press and release the left button there
//   {"op":"pos"}                              where the pointer is
// Coordinates are global screen points (origin at the top-left of the main display), the same
// space as Electron's BrowserWindow.getContentBounds(). Needs Accessibility permission for the
// terminal that starts it. Build: swiftc -O scripts/capture/pointer.swift -o .bin/pointer
import CoreGraphics
import Foundation

func current() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func post(_ type: CGEventType, _ point: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

// Ease in and out, with a slight arc to one side so the path looks like a hand, not a ruler.
func move(to target: CGPoint, ms: Double) {
  let start = current()
  let dx = target.x - start.x, dy = target.y - start.y
  let distance = (dx * dx + dy * dy).squareRoot()
  let steps = max(1, Int(ms / 1000 * 120))
  let bend = min(36, distance * 0.08)
  let nx = distance > 0 ? -dy / distance : 0, ny = distance > 0 ? dx / distance : 0
  for step in 1...steps {
    let t = Double(step) / Double(steps)
    let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
    let arc = sin(Double.pi * eased) * bend
    post(.mouseMoved, CGPoint(x: start.x + dx * eased + nx * arc, y: start.y + dy * eased + ny * arc))
    usleep(useconds_t(ms * 1000 / Double(steps)))
  }
  post(.mouseMoved, target)
}

func reply(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let op = command["op"] as? String else { reply(["error": "bad command"]); continue }
  let point = CGPoint(x: command["x"] as? Double ?? 0, y: command["y"] as? Double ?? 0)
  switch op {
  case "move":
    move(to: point, ms: command["ms"] as? Double ?? 600)
    reply(["ok": true])
  case "click":
    post(.mouseMoved, point)
    usleep(40_000)
    post(.leftMouseDown, point)
    usleep(70_000)
    post(.leftMouseUp, point)
    reply(["ok": true])
  case "pos":
    let p = current()
    reply(["x": p.x, "y": p.y])
  default:
    reply(["error": "unknown op \(op)"])
  }
}
