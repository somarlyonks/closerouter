import Foundation
import SwiftUI

struct LogsView: View {
    @StateObject private var viewModel = LogsViewModel()
    @State private var selection: LogGroup.ID?

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            table
            if let row = selectedRow {
                Divider()
                detailInspector(row)
            }
            Divider()
            footer
        }
        .onAppear { viewModel.start() }
        .onDisappear { viewModel.stop() }
        .onChange(of: selection) { _, newValue in
            viewModel.loadBodies(for: newValue)
        }
    }

    // MARK: Toolbar

    private var toolbar: some View {
        HStack(spacing: 10) {
            Text("Live logs")
                .font(.headline)
            Spacer()
            TextField("Filter method, path, status…", text: $viewModel.filterText)
                .textFieldStyle(.roundedBorder)
                .frame(width: 200)
                .controlSize(.small)
            Button(viewModel.isPaused ? "Resume" : "Pause") {
                viewModel.togglePause()
            }
            Button("Clear", role: .destructive) {
                viewModel.clear()
            }
        }
        .padding(10)
    }

    // MARK: Table

    private var table: some View {
        Table(viewModel.displayedGroups, selection: $selection) {
            TableColumn("Time") { row in
                Text(row.time.formatted(date: .omitted, time: .standard))
                    .monospacedDigit()
            }
            .width(min: 80, ideal: 90)

            TableColumn("Method") { row in
                Text(row.method)
                    .monospaced()
                    .foregroundStyle(.secondary)
            }
            .width(min: 60, ideal: 72)

            TableColumn("Path") { row in
                Text(row.path)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            TableColumn("Model") { row in
                Text(row.model ?? "-")
                    .foregroundStyle(.secondary)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Status") { row in
                Text(statusText(row.status))
                    .monospacedDigit()
                    .foregroundStyle(statusColor(row.status))
            }
            .width(min: 48, ideal: 56)

            TableColumn("Duration") { row in
                Text(msText(row.durationMs))
                    .monospacedDigit()
            }
            .width(min: 70, ideal: 84)

            TableColumn("TTFT") { row in
                Text(msText(row.ttftMs))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .width(min: 60, ideal: 74)

            TableColumn("Tokens") { row in
                Text(tokensText(row))
                    .monospacedDigit()
            }
            .width(min: 90, ideal: 108)
        }
        .alternatingRowBackgrounds()
    }

    // MARK: Detail inspector

    /// Split detail inspector: request body on the left, response body on the right.
    private func detailInspector(_ row: LogGroup) -> some View {
        HStack(alignment: .top, spacing: 0) {
            detailPane("Request", body: row.requestBody, row: row)
            Divider()
            detailPane("Response", body: row.responseBody, row: row)
        }
        .frame(height: 200)
    }

    /// One side of the split detail inspector - a scrollable body or a placeholder.
    private func detailPane(_ title: String, body: String?, row: LogGroup) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            if let body, !body.isEmpty {
                ScrollView {
                    Text(prettyBody(body))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
            } else {
                VStack(spacing: 6) {
                    Spacer()
                    if viewModel.isLoadingBodies(for: row.id) {
                        ProgressView().controlSize(.small)
                        Text("Loading \(title.lowercased()) body…")
                            .foregroundStyle(.secondary)
                    } else {
                        Text("No \(title.lowercased()) body.")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .frame(maxWidth: .infinity)
                .font(.callout)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func prettyBody(_ text: String) -> String {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else {
            return text
        }
        return String(data: pretty, encoding: .utf8) ?? text
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 10) {
            if viewModel.isConnected {
                Label("Live", systemImage: "dot.radiowaves.left.and.right")
                    .foregroundStyle(.green)
            } else {
                Label("Not connected", systemImage: "slash.circle")
                    .foregroundStyle(.secondary)
            }
            Text("\(viewModel.displayedGroups.count) requests")
                .foregroundStyle(.secondary)
            Spacer()
            Text(serverStateLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minHeight: 28)
    }

    // MARK: Helpers

    private var selectedRow: LogGroup? {
        guard let selection else { return nil }
        return viewModel.displayedGroups.first { $0.id == selection }
    }

    private var serverStateLabel: String {
        switch ServerManager.shared.state {
        case .running(let version):
            let v = version.map { " · v\($0)" } ?? ""
            return "server running\(v) on port \(ServerManager.shared.port)"
        case .stopped:
            return "server stopped"
        case .starting:
            return "server starting…"
        case .stopping:
            return "server stopping…"
        }
    }

    private func statusText(_ status: Int?) -> String {
        status.map(String.init) ?? "…"
    }

    private func statusColor(_ status: Int?) -> Color {
        guard let status else { return .secondary }
        if status < 300 { return .green }
        if status < 400 { return .blue }
        return .red
    }

    private func msText(_ v: Int?) -> String {
        guard let v else { return "-" }
        if v >= 1000 { return String(format: "%.2fs", Double(v) / 1000) }
        return "\(v) ms"
    }

    private func tokensText(_ row: LogGroup) -> String {
        let input = row.inputTokens ?? 0
        let output = row.outputTokens ?? 0
        if input == 0 && output == 0 { return "-" }
        let base = "\(input) in · \(output) out"
        if let cached = row.cachedTokens, cached > 0 {
            return "\(base) · \(cached) cached"
        }
        return base
    }
}
