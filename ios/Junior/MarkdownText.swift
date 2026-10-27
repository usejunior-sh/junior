import SwiftUI

/// Junior's prose: markdown in Geist, code in Geist Mono on the deep inset. Blocks
/// (headings, lists, quotes, code fences, tables) are split here; each block's inline
/// markdown (bold, italic, code, links) goes through Foundation's own parser.
struct MarkdownText: View {
    let text: String
    var size: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MD.blocks(text).enumerated()), id: \.offset) { _, b in
                block(b)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func block(_ b: MD.Block) -> some View {
        switch b {
        case .heading(let level, let s):
            Text(MD.inline(s, size: level <= 1 ? size + 6 : level == 2 ? size + 3 : size + 1, weight: .semibold))
                .padding(.top, 4)
        case .paragraph(let s):
            Text(MD.inline(s, size: size))
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(i + 1)." : "•").font(Theme.sans(size)).foregroundStyle(Theme.ash)
                        Text(MD.inline(item.text, size: size))
                    }
                    .padding(.leading, CGFloat(item.indent) * 14)
                }
            }
        case .quote(let s):
            Text(MD.inline(s, size: size))
                .foregroundStyle(Theme.mute)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.hairStrong).frame(width: 2) }
        case .code(let s):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(s).font(Theme.mono(12.5)).foregroundStyle(Theme.body).padding(10)
            }
            .background(Theme.deep)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.hair, lineWidth: 1))
        case .rule:
            Rectangle().fill(Theme.hair).frame(height: 1).padding(.vertical, 4)
        }
    }
}

enum MD {
    struct Item { let text: String; let indent: Int }

    enum Block {
        case heading(Int, String)
        case paragraph(String)
        case list([Item], ordered: Bool)
        case quote(String)
        /// code fences, and tables (kept aligned in mono)
        case code(String)
        case rule
    }

    static func blocks(_ text: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var list: [Item] = []
        var ordered = false
        var quote: [String] = []
        var code: [String]?
        var table: [String] = []

        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
            if !list.isEmpty { out.append(.list(list, ordered: ordered)); list = [] }
            if !quote.isEmpty { out.append(.quote(quote.joined(separator: "\n"))); quote = [] }
            if !table.isEmpty { out.append(.code(table.joined(separator: "\n"))); table = [] }
        }

        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if code != nil {
                if line.hasPrefix("```") { out.append(.code(code!.joined(separator: "\n"))); code = nil } else { code!.append(raw) }
                continue
            }
            if line.hasPrefix("```") { flush(); code = []; continue }
            if line.isEmpty { flush(); continue }
            if line.hasPrefix("|") { if table.isEmpty { flush() }; table.append(line); continue }
            if line == "---" || line == "***" || line == "___" { flush(); out.append(.rule); continue }
            if let m = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) { flush(); out.append(.heading(m.1.count, String(m.2))); continue }
            if line.hasPrefix(">") {
                if quote.isEmpty { flush() }
                quote.append(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            let indent = (raw.prefix { $0 == " " }.count) / 2
            if let m = line.firstMatch(of: /^[-*+]\s+(.*)$/) {
                if list.isEmpty || ordered { flush(); ordered = false }
                list.append(Item(text: String(m.1), indent: indent))
                continue
            }
            if let m = line.firstMatch(of: /^\d+[.)]\s+(.*)$/) {
                if list.isEmpty || !ordered { flush(); ordered = true }
                list.append(Item(text: String(m.1), indent: indent))
                continue
            }
            if !list.isEmpty || !quote.isEmpty || !table.isEmpty { flush() }
            para.append(line)
        }
        if let code { out.append(.code(code.joined(separator: "\n"))) }
        flush()
        return out
    }

    static func inline(_ s: String, size: CGFloat, weight: Font.Weight = .regular) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var a = (try? AttributedString(markdown: s, options: options)) ?? AttributedString(s)
        a.font = Theme.sans(size, weight)
        a.foregroundColor = weight == .regular ? Theme.body : Theme.ink
        let runs = a.runs.map { ($0.range, $0.inlinePresentationIntent, $0.link) }
        for (range, intent, link) in runs {
            if let intent {
                if intent.contains(.code) {
                    a[range].font = Theme.mono(size * 0.88)
                    a[range].backgroundColor = Theme.elev
                } else if intent.contains(.stronglyEmphasized) {
                    a[range].font = Theme.sans(size, .semibold)
                    a[range].foregroundColor = Theme.ink
                } else if intent.contains(.emphasized) {
                    a[range].font = Theme.sans(size, weight).italic()
                }
            }
            if link != nil { a[range].foregroundColor = Theme.blue }
        }
        return a
    }
}
