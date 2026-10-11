// Moves and clicks the real macOS pointer, so screen recordings show the actual cursor and clicks.
// Reads one JSON command per line on stdin and answers each with one JSON line on stdout:
//   {"op":"move","x":800,"y":500,"ms":700}   eased path from where the pointer is now
//   {"op":"click","x":800,"y":500}           press and release the left button there
//   {"op":"pos"}                              where the pointer is
//   {"op":"type","text":"Hello","ms":45}     types text as real key events, ms between characters
//   {"op":"key","code":36,"flags":["cmd"]}   one key (virtual key code) with modifiers
//   {"op":"window","owner":"Local Cognitive"} the app's frontmost normal window: id and bounds
// Coordinates are global screen points (origin at the top-left of the main display), the same
// space as Electron's BrowserWindow.getContentBounds(). Needs Accessibility permission for the
// terminal that starts it. Build: swiftc -O scripts/capture/pointer.swift -o .bin/pointer
// The keyboard and window ops drive apps that Playwright cannot reach (the packaged app refuses
// debugging switches): they send the same events a person's keyboard would.
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

func typeText(_ text: String, ms: Double) {
  for character in text {
    let units = Array(String(character).utf16)
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      event.post(tap: .cghidEventTap)
      usleep(8_000)
    }
    usleep(useconds_t(ms * 1000))
  }
}

func pressKey(_ code: Int, _ flags: [String]) {
  var mask: CGEventFlags = []
  for flag in flags {
    switch flag {
    case "cmd": mask.insert(.maskCommand)
    case "shift": mask.insert(.maskShift)
    case "alt": mask.insert(.maskAlternate)
    case "ctrl": mask.insert(.maskControl)
    default: break
    }
  }
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down) else { continue }
    event.flags = mask
    event.post(tap: .cghidEventTap)
    usleep(30_000)
  }
}

func window(owner: String) -> [String: Any]? {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for info in list where (info[kCGWindowOwnerName as String] as? String) == owner && (info[kCGWindowLayer as String] as? Int) == 0 {
    guard let bounds = info[kCGWindowBounds as String] as? [String: Double], (bounds["Height"] ?? 0) > 200 else { continue }
    return ["id": info[kCGWindowNumber as String] as? Int ?? 0, "x": bounds["X"] ?? 0, "y": bounds["Y"] ?? 0, "width": bounds["Width"] ?? 0, "height": bounds["Height"] ?? 0]
  }
  return nil
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
  case "type":
    typeText(command["text"] as? String ?? "", ms: command["ms"] as? Double ?? 45)
    reply(["ok": true])
  case "key":
    pressKey(command["code"] as? Int ?? 36, command["flags"] as? [String] ?? [])
    reply(["ok": true])
  case "window":
    if let found = window(owner: command["owner"] as? String ?? "") { reply(found) } else { reply(["error": "no window"]) }
  default:
    reply(["error": "unknown op \(op)"])
  }
}
