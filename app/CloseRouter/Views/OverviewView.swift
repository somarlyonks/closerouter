import Combine
import Foundation
import SwiftUI

struct OverviewView: View {
    @ObservedObject private var server = ServerManager.shared
    @State private var usage: APIClient.UsageTotals?
    @State private var config: APIClient.ConfigInfo?
    @State private var isLoading = false
    @State private var lastUpdated: Date?
    @State private var stateCancellable: AnyCancellable?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                statusBanner
                if server.state.isRunning {
                    statCards
                    if let config {
                        providersSection(config)
                    }
                } else {
                    stoppedHint
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    refresh()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(!server.state.isRunning || isLoading)
            }
        }
        .onAppear {
            observeServer()
            refresh()
        }
        .onDisappear {
            stateCancellable?.cancel()
        }
    }

    // MARK: Status banner

    private var statusBanner: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusColor)
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(statusTitle)
                    .font(.headline)
                Text(statusDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(server.state.isRunning ? "Stop" : "Start") {
                server.toggle()
            }
            .buttonStyle(.bordered)
            .disabled(server.state.isTransitioning)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
    }

    private var statusTitle: String {
        switch server.state {
        case .running: "Server running"
        case .stopped: "Server stopped"
        case .starting: "Starting…"
        case .stopping: "Stopping…"
        }
    }

    private var statusDetail: String {
        switch server.state {
        case .running(let version):
            var parts = ["port \(server.port)"]
            if let version { parts.append("v\(version)") }
            if let uptime = uptimeText, !uptime.isEmpty { parts.append("up \(uptime)") }
            if let lastUpdated { parts.append("updated \(lastUpdated.formatted(date: .omitted, time: .standard))") }
            return parts.joined(separator: " · ")
        case .stopped:
            return "Start the server from the menu bar or this panel."
        case .starting:
            return "Waiting for the server to become healthy…"
        case .stopping:
            return "Shutting down…"
        }
    }

    private var statusColor: Color {
        switch server.state {
        case .running: .green
        case .starting: .orange
        case .stopping: .orange
        case .stopped: .secondary
        }
    }

    private var uptimeText: String? {
        guard let startedAt = server.startedAt else { return nil }
        let elapsed = Int(Date().timeIntervalSince(startedAt))
        let h = elapsed / 3600
        let m = (elapsed % 3600) / 60
        let s = elapsed % 60
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m \(s)s" }
        return "\(s)s"
    }

    private var stoppedHint: some View {
        VStack(spacing: 8) {
            Image(systemName: "power")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text("The proxy server isn't running.")
                .font(.headline)
            Text("Start it from the menu bar, or press the button above.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    // MARK: Stats

    private var statCards: some View {
        HStack(spacing: 12) {
            statCard("Requests", value: numberText(usage?.count ?? 0), icon: "arrow.left.arrow.right")
            statCard("Input tokens", value: numberText(usage?.inTokens ?? 0), icon: "arrow.up.circle")
            statCard("Cache rate", value: cacheRateText, icon: "percent")
            statCard("Output tokens", value: numberText(usage?.outTokens ?? 0), icon: "arrow.down.circle")
        }
    }

    private func statCard(_ title: String, value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: icon)
                .foregroundStyle(.tint)
            Text(value)
                .font(.system(.title2, design: .rounded, weight: .semibold))
                .monospacedDigit()
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
    }

    private var cacheRateText: String {
        guard let usage, usage.inTokens > 0 else { return "—" }
        let rate = Double(usage.cachedTokens ?? 0) / Double(usage.inTokens)
        return String(format: "%.2f", rate * 100)
    }

    private func numberText(_ n: Int) -> String {
        n.formatted(.number.notation(.compactName))
    }

    // MARK: Providers

    private func providersSection(_ config: APIClient.ConfigInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Providers")
                .font(.headline)
            ForEach(config.providers.keys.sorted(), id: \.self) { name in
                let provider = config.providers[name]!
                HStack(spacing: 8) {
                    Image(systemName: "server.rack")
                        .foregroundStyle(.secondary)
                    Text(name)
                        .fontWeight(.medium)
                    Spacer()
                    Text(provider.base_url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                }
                .padding(.vertical, 6)
                Divider()
            }
        }
    }


    // MARK: Data

    private func observeServer() {
        stateCancellable = server.$state
            .receive(on: DispatchQueue.main)
            .sink { state in
                if state.isRunning { self.refresh() }
                else if !state.isTransitioning { self.clearData() }
            }
    }

    private func clearData() {
        usage = nil
        config = nil
    }

    private func refresh() {
        guard server.state.isRunning else {
            clearData()
            return
        }
        isLoading = true
        let port = server.port
        let key = (try? ConfigStore.read().key) ?? "sk-cr-kee9itsecr1t"
        Task {
            if let u = try? await APIClient.getUsage(port: port, key: key) { usage = u }
            if let c = try? await APIClient.getConfig(port: port, key: key) { config = c }
            isLoading = false
            lastUpdated = Date()
        }
    }
}
