import AppKit
import PDFKit
import Foundation

let task = CommandLine.arguments[1]
let url = URL(fileURLWithPath: CommandLine.arguments[2])
var pass = false
if task == "N3", let pdf = PDFDocument(url: url) {
    let text = (0..<pdf.pageCount).map { pdf.page(at: $0)?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
    pass = text == ["Fixture page 2: east", "Fixture page 3: south"]
}
if task == "N2", let data = try? Data(contentsOf: url), let note = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil) {
    let text = note.string as NSString
    let lines = note.string.split(separator: "\n").map(String.init)
    let expected = ["Apples arrive Monday", "Berries arrive Tuesday", "Cherries arrive Wednesday"]
    let heading = text.range(of: "Delivery note")
    var bold = heading.location != NSNotFound
    if bold {
        note.enumerateAttribute(.font, in: heading, options: []) { value, _, _ in
            if (value as? NSFont).map({ NSFontManager.shared.traits(of: $0).contains(.boldFontMask) }) != true { bold = false }
        }
    }
    let bullets = expected.allSatisfy { line in
        let range = text.range(of: line)
        if range.location == NSNotFound { return false }
        let style = note.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle
        return style?.textLists.contains(where: { list in
            let marker = list.markerFormat.rawValue
            return marker.contains("disc") || marker.contains("circle") || marker.contains("square")
        }) == true || lines.contains("• " + line)
    }
    let content = lines.map { $0.replacingOccurrences(of: "• ", with: "").trimmingCharacters(in: .whitespaces) }
    pass = bold && bullets && content == ["Delivery note"] + expected
}
let result: [String: Any] = ["task": task, "pass": pass]
let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: json, encoding: .utf8)!)
