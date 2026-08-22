import AppKit
import SwiftUI

// MARK: - Syntax highlighting

struct JSONTheme {
    let plain: NSColor
    let key: NSColor
    let string: NSColor
    let number: NSColor
    let constant: NSColor

    static let current = JSONTheme(
        plain: .labelColor,
        key: .systemPink,
        string: .systemGreen,
        number: .systemOrange,
        constant: .systemPurple
    )
}

/// NSTextStorage that re-highlights JSON syntax after each edit.
final class JSONTextStorage: NSTextStorage {
    private let backing = NSMutableAttributedString()

    override var string: String { backing.string }

    override func attributes(at location: Int, effectiveRange range: NSRangePointer?) -> [NSAttributedString.Key: Any] {
        backing.attributes(at: location, effectiveRange: range)
    }

    override func replaceCharacters(in range: NSRange, with str: String) {
        beginEditing()
        backing.replaceCharacters(in: range, with: str)
        edited(.editedCharacters, range: range, changeInLength: (str as NSString).length - range.length)
        endEditing()
    }

    override func setAttributes(_ attrs: [NSAttributedString.Key: Any]?, range: NSRange) {
        beginEditing()
        backing.setAttributes(attrs, range: range)
        edited(.editedAttributes, range: range, changeInLength: 0)
        endEditing()
    }

    override func processEditing() {
        super.processEditing()
        guard editedMask.contains(.editedCharacters), editedRange.length > 0 else { return }
        highlight()
        edited(.editedAttributes, range: NSRange(location: 0, length: backing.length), changeInLength: 0)
    }

    private func highlight() {
        let ns = backing.string as NSString
        let length = ns.length
        let theme = JSONTheme.current
        let baseFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        backing.setAttributes([.font: baseFont, .foregroundColor: theme.plain], range: NSRange(location: 0, length: length))

        var i = 0
        while i < length {
            let c = ns.character(at: i)
            if c == 34 { // "
                var j = i + 1
                while j < length {
                    let d = ns.character(at: j)
                    if d == 92 { // backslash escape
                        j += 2
                        continue
                    }
                    if d == 34 { break }
                    j += 1
                }
                let end = min(j, length)
                var k = end + 1
                while k < length, isSpace(ns.character(at: k)) { k += 1 }
                let isKey = k < length && ns.character(at: k) == 58 // :
                backing.addAttribute(.foregroundColor, value: isKey ? theme.key : theme.string, range: NSRange(location: i, length: end - i))
                i = end < length ? end + 1 : length
            } else if isNumberStart(c, ns: ns, at: i) {
                var j = i + 1
                while j < length, isNumberChar(ns.character(at: j)) { j += 1 }
                backing.addAttribute(.foregroundColor, value: theme.number, range: NSRange(location: i, length: j - i))
                i = j
            } else if isLetter(c) {
                var j = i
                while j < length, isLetter(ns.character(at: j)) { j += 1 }
                let word = ns.substring(with: NSRange(location: i, length: j - i))
                if word == "true" || word == "false" || word == "null" {
                    backing.addAttribute(.foregroundColor, value: theme.constant, range: NSRange(location: i, length: j - i))
                }
                i = j
            } else {
                i += 1
            }
        }
    }

    private func isSpace(_ c: unichar) -> Bool {
        c == 32 || c == 9 || c == 10 || c == 13
    }

    private func isNumberStart(_ c: unichar, ns: NSString, at i: Int) -> Bool {
        if c >= 48, c <= 57 { return true } // 0-9
        if c == 45 { // minus sign, only when followed by a digit
            let next = i + 1 < ns.length ? ns.character(at: i + 1) : 0
            return next >= 48 && next <= 57
        }
        return false
    }

    private func isNumberChar(_ c: unichar) -> Bool {
        (c >= 48 && c <= 57) || c == 46 || c == 45 || c == 43 || c == 101 || c == 69 // digits . - + e E
    }

    private func isLetter(_ c: unichar) -> Bool {
        (c >= 97 && c <= 122) || (c >= 65 && c <= 90)
    }
}

// MARK: - Text view

/// NSTextView that triggers completion on ⌃Space / F5.
final class CompletingTextView: NSTextView {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 49, mods.contains(.control) { // ⌃Space
            complete(nil)
            return true
        }
        if event.keyCode == 96, mods.isEmpty { // F5
            complete(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

// MARK: - SwiftUI wrapper

struct CodeTextView: NSViewRepresentable {
    @Binding var text: String
    var isEditable: Bool = true

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let storage = JSONTextStorage()
        let layoutManager = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layoutManager.addTextContainer(container)
        storage.addLayoutManager(layoutManager)

        let textView = CompletingTextView(frame: .zero, textContainer: container)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textContainerInset = NSSize(width: 8, height: 8)
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isEditable = isEditable
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.delegate = context.coordinator

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

        context.coordinator.textView = textView
        context.coordinator.setInitialText(text)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.updateTextIfNeeded(text)
    }
}

// MARK: - Coordinator

@MainActor
final class Coordinator: NSObject, NSTextViewDelegate {
    private let parent: CodeTextView
    weak var textView: NSTextView?
    private var isApplyingExternalText = false

    init(_ parent: CodeTextView) {
        self.parent = parent
    }

    func setInitialText(_ newText: String) {
        guard let textView else { return }
        isApplyingExternalText = true
        textView.string = newText
        isApplyingExternalText = false
    }

    func updateTextIfNeeded(_ newText: String) {
        guard let textView, !isApplyingExternalText else { return }
        if textView.string != newText {
            isApplyingExternalText = true
            textView.string = newText
            isApplyingExternalText = false
        }
    }

    func textDidChange(_ notification: Notification) {
        guard let textView else { return }
        parent.text = textView.string
    }

    // MARK: Completion

    func textView(_ textView: NSTextView, completionsForPartialWordRange charRange: NSRange, indexOfSelectedItem index: UnsafeMutablePointer<Int>) -> [String] {
        let cursor = charRange.location + charRange.length
        let items = ConfigCompletionEngine.completions(in: textView.string, cursor: cursor)
        index.pointee = 0
        return items.map(\.label)
    }

    func textView(_ textView: NSTextView, insertCompletion word: String, forPartialWordRange charRange: NSRange, movement: Int, isFinal flag: Bool) {
        guard flag else { return }
        let cursor = charRange.location + charRange.length
        let items = ConfigCompletionEngine.completions(in: textView.string, cursor: cursor)
        guard let item = items.first(where: { $0.label == word }) else {
            textView.insertCompletion(word, forPartialWordRange: charRange, movement: movement, isFinal: flag)
            return
        }
        let ns = textView.string as NSString
        var start = charRange.location
        if start > 0, ns.substring(with: NSRange(location: start - 1, length: 1)) == "\"" {
            start -= 1 // include the opening quote so a quoted insert lands cleanly
        }
        let range = NSRange(location: start, length: charRange.length + (charRange.location - start))
        textView.textStorage?.replaceCharacters(in: range, with: item.insertText)
        textView.setSelectedRange(NSRange(location: start + item.insertText.count, length: 0))
        parent.text = textView.string
    }
}
