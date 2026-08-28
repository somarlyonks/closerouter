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

    private func detailInspector(_ row: LogGroup) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let bodyText = row.requestBody, !bodyText.isEmpty {
                    section("Request", prettyBody(bodyText))
                }
                if let bodyText = row.responseBody, !bodyText.isEmpty {
                    section("Response", prettyBody(bodyText))
                }
                if row.requestBody == nil || row.requestBody?.isEmpty == true,
                   row.responseBody == nil || row.responseBody?.isEmpty == true {
                    if viewModel.isLoadingBodies(for: row.id) {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Loading bodies…")
                                .foregroundStyle(.secondary)
                        }
                        .font(.callout)
                    } else {
                        Text("No request/response bodies captured for this request.")
                            .foregroundStyle(.secondary)
                            .font(.callout)
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: 160)
    }

    private func section(_ title: String, _ bodyText: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(bodyText)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
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
        guard let v else { return "—" }
        if v >= 1000 { return String(format: "%.2fs", Double(v) / 1000) }
        return "\(v) ms"
    }

    private func tokensText(_ row: LogGroup) -> String {
        let input = row.inputTokens ?? 0
        let output = row.outputTokens ?? 0
        if input == 0 && output == 0 { return "—" }
        let base = "\(input) in · \(output) out"
        if let cached = row.cachedTokens, cached > 0 {
            return "\(base) · \(cached) cached"
        }
        return base
    }
}
