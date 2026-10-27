import SwiftUI

/// A permission prompt, a question, or a plan to approve: the card Junior waits on.
struct PromptCard: View {
    let prompt: Prompt
    var respond: (String, String, [String: String]?) -> Void

    var body: some View {
        if let r = prompt.resolved {
            Label(resolvedText(r), systemImage: r == "deny" ? "hand.raised" : "checkmark.seal")
                .font(Theme.sans(12))
                .foregroundStyle(Theme.ash)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                switch prompt.toolName {
                case "AskUserQuestion": AskCard(prompt: prompt, respond: respond)
                case "ExitPlanMode": PlanCard(prompt: prompt, respond: respond)
                default: PermissionBody(prompt: prompt, respond: respond)
                }
            }
            .padding(14)
            .background(Theme.elev)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.orange.opacity(0.45), lineWidth: 1))
        }
    }

    private func resolvedText(_ r: String) -> String {
        let what = prompt.toolName == "AskUserQuestion" ? "Answered" : prompt.toolName == "ExitPlanMode" ? "Plan" : prompt.toolName
        switch r {
        case "deny": return "\(what): declined"
        case "expired": return "\(what): expired"
        default: return prompt.toolName == "AskUserQuestion" ? "Answered" : "\(what): allowed"
        }
    }
}

private struct PermissionBody: View {
    let prompt: Prompt
    var respond: (String, String, [String: String]?) -> Void

    var body: some View {
        let call = ToolCall(id: prompt.id, name: prompt.toolName, input: prompt.input)
        let s = Transcript.summary(call)
        Text(prompt.title ?? "Junior wants to use \(prompt.toolName)")
            .font(Theme.sans(14, .medium))
            .foregroundStyle(Theme.ink)
        if let d = prompt.detail, !d.isEmpty {
            Text(d).font(Theme.sans(13)).foregroundStyle(Theme.mute)
        }
        if !s.detail.isEmpty {
            Text(s.detail)
                .font(Theme.mono(12))
                .foregroundStyle(Theme.body)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.deep)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        HStack(spacing: 8) {
            Button("Allow") { respond(prompt.id, "allow", nil) }.buttonStyle(PaperButton())
            if prompt.canAlwaysAllow {
                Button("Always") { respond(prompt.id, "allow_always", nil) }.buttonStyle(GhostButton())
            }
            Spacer()
            Button("Deny") { respond(prompt.id, "deny", nil) }.buttonStyle(GhostButton())
        }
    }
}

private struct PlanCard: View {
    let prompt: Prompt
    var respond: (String, String, [String: String]?) -> Void

    var body: some View {
        Text("Junior has a plan").font(Theme.sans(14, .medium)).foregroundStyle(Theme.ink)
        MarkdownText(text: prompt.input["plan"]?.string ?? "", size: 14)
        HStack(spacing: 8) {
            Button("Approve plan") { respond(prompt.id, "allow", nil) }.buttonStyle(PaperButton())
            Spacer()
            Button("Keep planning") { respond(prompt.id, "deny", nil) }.buttonStyle(GhostButton())
        }
    }
}

private struct AskCard: View {
    let prompt: Prompt
    var respond: (String, String, [String: String]?) -> Void
    @State private var picked: [Int: Set<String>] = [:]

    private var questions: [JSON] { prompt.input["questions"]?.array ?? [] }

    var body: some View {
        Text("Junior has a question").font(Theme.sans(14, .medium)).foregroundStyle(Theme.ink)
        ForEach(Array(questions.enumerated()), id: \.offset) { qi, q in
            let multi = q["multiSelect"]?.bool ?? false
            VStack(alignment: .leading, spacing: 6) {
                Text(q["question"]?.string ?? "").font(Theme.sans(14)).foregroundStyle(Theme.body)
                ForEach(Array((q["options"]?.array ?? []).enumerated()), id: \.offset) { _, o in
                    let label = o["label"]?.string ?? ""
                    let on = picked[qi]?.contains(label) ?? false
                    Button {
                        var cur = picked[qi] ?? []
                        if multi { if on { cur.remove(label) } else { cur.insert(label) } } else { cur = on ? [] : [label] }
                        picked[qi] = cur
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: on ? (multi ? "checkmark.square.fill" : "largecircle.fill.circle") : (multi ? "square" : "circle"))
                                .foregroundStyle(on ? Theme.ink : Theme.ash)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label).font(Theme.sans(14)).foregroundStyle(Theme.ink)
                                if let d = o["description"]?.string, !d.isEmpty {
                                    Text(d).font(Theme.sans(12)).foregroundStyle(Theme.ash)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(8)
                        .background(on ? Theme.hair : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        let complete = questions.indices.allSatisfy { !(picked[$0] ?? []).isEmpty }
        HStack {
            Button("Answer") {
                var answers: [String: String] = [:]
                for (qi, q) in questions.enumerated() {
                    answers[q["question"]?.string ?? ""] = (picked[qi] ?? []).sorted().joined(separator: ", ")
                }
                respond(prompt.id, "allow", answers)
            }
            .buttonStyle(PaperButton())
            .disabled(!complete)
            Spacer()
            Button("Skip") { respond(prompt.id, "deny", nil) }.buttonStyle(GhostButton())
        }
    }
}

/// The paper primary button: one per surface.
struct PaperButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.sans(14, .medium))
            .foregroundStyle(Theme.canvas)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Theme.ink.opacity(configuration.isPressed ? 0.8 : 1))
            .clipShape(Capsule())
    }
}

struct GhostButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.sans(14))
            .foregroundStyle(Theme.body)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .overlay(Capsule().stroke(Theme.hairStrong, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
