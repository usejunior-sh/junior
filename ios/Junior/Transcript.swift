import Foundation

/// A session's event log folded into rows, the essentials of web/src/transcript.ts:
/// messages, tool calls with their results stitched on, prompts, errors, turn ends.
/// A subagent's own messages (parent_tool_use_id) stay out; its Agent call is one row.
struct ToolCall: Equatable {
    let id: String
    let name: String
    let input: JSON
    var result: String?
    var isError = false
}

struct Prompt: Equatable {
    let id: String
    let toolName: String
    let title: String?
    let detail: String?
    let input: JSON
    let canAlwaysAllow: Bool
    /// allow | allow_always | deny | expired; nil while it waits
    var resolved: String?
}

enum Row: Equatable {
    case user(text: String, images: [String])
    case assistant(String)
    case tool(ToolCall)
    case prompt(Prompt)
    case error(String)
    case notice(String)
    case turnEnd(String)
}

struct TranscriptItem: Identifiable, Equatable {
    let id: String
    var row: Row
}

enum Transcript {
    static func fold(_ events: [JSON]) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        var tools: [String: Int] = [:]
        var prompts: [String: Int] = [:]
        for (i, ev) in events.enumerated() {
            switch ev["kind"]?.string {
            case "local_user":
                let images = ev["images"]?.array?.compactMap { $0["data"]?.string } ?? []
                items.append(TranscriptItem(id: "u\(i)", row: .user(text: ev["text"]?.string ?? "", images: images)))
            case "error":
                items.append(TranscriptItem(id: "e\(i)", row: .error(ev["message"]?.string ?? "Something went wrong")))
            case "notice":
                items.append(TranscriptItem(id: "n\(i)", row: .notice(ev["text"]?.string ?? "")))
            case "permission_request":
                guard let id = ev["id"]?.string else { continue }
                let p = Prompt(
                    id: id,
                    toolName: ev["toolName"]?.string ?? "",
                    title: ev["title"]?.string,
                    detail: ev["description"]?.string,
                    input: ev["input"] ?? .null,
                    canAlwaysAllow: ev["canAlwaysAllow"]?.bool ?? false
                )
                prompts[id] = items.count
                items.append(TranscriptItem(id: "p\(id)", row: .prompt(p)))
            case "permission_resolved":
                guard let id = ev["id"]?.string, let at = prompts[id], case .prompt(var p) = items[at].row else { continue }
                p.resolved = ev["behavior"]?.string ?? "allow"
                items[at].row = .prompt(p)
            case "sdk":
                guard let m = ev["message"] else { continue }
                if let parent = m["parent_tool_use_id"]?.string, !parent.isEmpty { continue }
                let blocks = m["message"]?["content"]?.array ?? []
                switch m["type"]?.string {
                case "assistant":
                    for (j, b) in blocks.enumerated() {
                        switch b["type"]?.string {
                        case "text":
                            let text = b["text"]?.string ?? ""
                            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                items.append(TranscriptItem(id: "a\(i).\(j)", row: .assistant(text)))
                            }
                        case "tool_use":
                            guard let id = b["id"]?.string else { continue }
                            tools[id] = items.count
                            let call = ToolCall(id: id, name: b["name"]?.string ?? "tool", input: b["input"] ?? .null)
                            items.append(TranscriptItem(id: "t\(id)", row: .tool(call)))
                        default:
                            break
                        }
                    }
                case "user":
                    for b in blocks where b["type"]?.string == "tool_result" {
                        guard let id = b["tool_use_id"]?.string, let at = tools[id], case .tool(var call) = items[at].row else { continue }
                        call.result = resultText(b["content"])
                        call.isError = b["is_error"]?.bool ?? false
                        items[at].row = .tool(call)
                    }
                case "result":
                    if m["is_error"]?.bool == true, m["subtype"]?.string != "success" {
                        items.append(TranscriptItem(id: "r\(i)", row: .error("The turn ended with an error.")))
                    } else if let ms = m["duration_ms"]?.number {
                        items.append(TranscriptItem(id: "r\(i)", row: .turnEnd(duration(ms))))
                    }
                default:
                    break
                }
            default:
                break
            }
        }
        return items
    }

    static func resultText(_ c: JSON?) -> String {
        if let s = c?.string { return s }
        if let a = c?.array { return a.compactMap { $0["text"]?.string }.joined(separator: "\n") }
        return ""
    }

    static func duration(_ ms: Double) -> String {
        let s = Int(ms / 1000)
        return s < 60 ? "Done in \(s)s" : "Done in \(s / 60)m \(s % 60)s"
    }

    /// The one line that says what a call did: the command, the file, the pattern.
    static func summary(_ call: ToolCall) -> (label: String, detail: String) {
        let i = call.input
        let leaf = call.name.hasPrefix("mcp__") ? (call.name.components(separatedBy: "__").last ?? call.name) : call.name
        let file = (i["file_path"]?.string ?? i["path"]?.string).map { ($0 as NSString).lastPathComponent }
        switch call.name {
        case "Bash": return ("Ran", i["command"]?.string ?? "")
        case "Read": return ("Read", file ?? "")
        case "Edit", "MultiEdit": return ("Edited", file ?? "")
        case "Write": return ("Wrote", file ?? "")
        case "Grep": return ("Searched", i["pattern"]?.string ?? "")
        case "Glob": return ("Found files", i["pattern"]?.string ?? "")
        case "WebFetch": return ("Fetched", i["url"]?.string ?? "")
        case "WebSearch": return ("Searched the web", i["query"]?.string ?? "")
        case "Agent", "Task": return ("Agent", i["description"]?.string ?? "")
        case "TodoWrite": return ("Updated the plan", "")
        default:
            let first = i.object?.values.compactMap(\.string).first ?? ""
            return (leaf.replacingOccurrences(of: "_", with: " "), first)
        }
    }
}
