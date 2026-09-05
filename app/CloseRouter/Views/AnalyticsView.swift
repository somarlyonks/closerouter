import Charts
import Combine
import Foundation
import SwiftUI

/// Loads analytics stats from /usage with date-range and provider/model filters.
@MainActor
final class AnalyticsViewModel: ObservableObject {
    enum RangePreset: String, CaseIterable, Identifiable {
        case day = "Day"
        case week = "Week"
        case month = "Month"
        case custom = "Custom"
        var id: Self { self }
    }

    private let server = ServerManager.shared

    @Published private(set) var stats: APIClient.AnalyticsStats?
    @Published private(set) var isLoading = false
    @Published private(set) var providers: [String] = []
    @Published private(set) var models: [String] = []
    @Published var preset: RangePreset = .week
    @Published var from: Date = Date().addingTimeInterval(-7 * 86_400)
    @Published var to: Date = Date()
    @Published var selectedProvider: String?
    @Published var selectedModel: String?

    private var config: APIClient.ConfigInfo?

    init() {
        applyPreset(.week)
    }

    /// (Re)load stats for the current filters and the provider/model option lists.
    func load() {
        guard server.state.isRunning else {
            stats = nil
            return
        }
        isLoading = true
        let port = server.port
        let key = server.key
        let from = from
        let to = to
        let provider = selectedProvider
        let model = selectedModel
        Task {
            if let c = try? await APIClient.getConfig(port: port, key: key) {
                config = c
                providers = providersOffering(selectedModel)
                models = providerModels(selectedProvider)
            }
            if let s = try? await APIClient.getAnalytics(port: port, key: key, from: from, to: to, provider: provider, model: model) {
                stats = s
            }
            isLoading = false
        }
    }

    func selectPreset(_ p: RangePreset) {
        preset = p
        if p != .custom {
            applyPreset(p)
            load()
        }
    }

    /// User edited a custom from/to date directly.
    func customDateChanged() {
        preset = .custom
        load()
    }

    /// Shift the current window by one period (−1 past, +1 future). Calendar
    /// presets only — custom has no fixed step. Adding the component to `to`
    /// (which sits 1ms before the next period) keeps the window aligned.
    func navigate(_ direction: Int) {
        let component: Calendar.Component
        switch preset {
        case .day: component = .day
        case .week: component = .weekOfYear
        case .month: component = .month
        case .custom: return
        }
        guard let newFrom = Calendar.current.date(byAdding: component, value: direction, to: from),
              let newTo = Calendar.current.date(byAdding: component, value: direction, to: to) else { return }
        from = newFrom
        to = newTo
        load()
    }

    func selectProvider(_ p: String?) {
        selectedProvider = p
        models = providerModels(p)
        if let m = selectedModel, !models.contains(m) { selectedModel = nil }
        load()
    }

    func selectModel(_ m: String?) {
        selectedModel = m
        providers = providersOffering(m)
        if let p = selectedProvider, !providers.contains(p) { selectedProvider = nil }
        load()
    }

    /// Calendar-aligned ranges: day = 00:00 to end of today, week = this
    /// week's Monday 00:00 to Sunday end, month = 1st 00:00 to end of month.
    /// `to` sits 1ms before the next period's start so the inclusive
    /// `time <= to` filter can't bleed into the next period.
    private func applyPreset(_ p: RangePreset) {
        let cal = Calendar.current
        let now = Date()
        switch p {
        case .day:
            let start = cal.startOfDay(for: now)
            from = start
            to = (cal.date(byAdding: .day, value: 1, to: start) ?? now).addingTimeInterval(-0.001)
        case .week:
            var week = cal
            week.firstWeekday = 2 // Monday
            if let interval = week.dateInterval(of: .weekOfYear, for: now) {
                from = interval.start
                to = interval.end.addingTimeInterval(-0.001)
            } else {
                from = now.addingTimeInterval(-7 * 86_400)
                to = now
            }
        case .month:
            if let interval = cal.dateInterval(of: .month, for: now) {
                from = interval.start
                to = interval.end.addingTimeInterval(-0.001)
            } else {
                from = now.addingTimeInterval(-30 * 86_400)
                to = now
            }
        case .custom:
            break
        }
    }

    /// Models offered by a provider, or every distinct model when no provider is selected.
    private func providerModels(_ provider: String?) -> [String] {
        guard let config else { return [] }
        guard let provider, let p = config.providers[provider] else { return allModels() }
        return p.models?.compactMap(\.id) ?? []
    }

    private func allModels() -> [String] {
        guard let config else { return [] }
        return Set(config.providers.values.flatMap { $0.models?.compactMap(\.id) ?? [] }).sorted()
    }

    /// Providers whose catalog contains the model, or every provider when no model is selected.
    private func providersOffering(_ model: String?) -> [String] {
        guard let config else { return [] }
        guard let model else { return config.providers.keys.sorted() }
        return config.providers
            .filter { $0.value.models?.contains { $0.id == model } ?? false }
            .keys.sorted()
    }
}

struct AnalyticsView: View {
    enum ChartMetric: String, CaseIterable, Identifiable {
        case requests = "Requests"
        case tokens = "Tokens"
        var id: Self { self }
    }

    @StateObject private var viewModel = AnalyticsViewModel()
    @State private var chartMetric: ChartMetric = .requests
    @State private var showCustomRange = false

    var body: some View {
        VStack(spacing: 0) {
            filtersBar
            Divider()
            content
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.load()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(viewModel.isLoading)
            }
        }
        .onAppear { viewModel.load() }
        .onReceive(ServerManager.shared.$state) { state in
            if state.isRunning { viewModel.load() }
        }
    }

    // MARK: Filters

    private var filtersBar: some View {
        GeometryReader { geo in
            HStack(spacing: 12) {
                rangePicker
                Spacer(minLength: 0)
                if geo.size.width >= compactWidth {
                    filterTrailing
                } else {
                    compactTrailing
                }
            }
        }
        .frame(height: 26)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    /// Below this detail-column width (window ≈ 950pt) the Model selector and
    /// the Provider label are dropped. Wrapping the bar in a GeometryReader
    /// keeps its minimum width at 0 even though the full layout is ~660pt, so
    /// the detail column can't impose a huge minimum on NavigationSplitView -
    /// otherwise its NSSplitView overflows when the window is narrow and
    /// shoves the sidebar off the window's left edge.
    private let compactWidth: CGFloat = 660

    private var customRangeEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Custom range")
                .font(.headline)
            HStack(spacing: 8) {
                Text("From")
                    .frame(width: 44, alignment: .leading)
                    .foregroundStyle(.secondary)
                DatePicker("", selection: $viewModel.from, in: ...viewModel.to, displayedComponents: .date)
                    .labelsHidden()
                    .onChange(of: viewModel.from) { _ in viewModel.customDateChanged() }
            }
            HStack(spacing: 8) {
                Text("To")
                    .frame(width: 44, alignment: .leading)
                    .foregroundStyle(.secondary)
                DatePicker("", selection: $viewModel.to, in: viewModel.from..., displayedComponents: .date)
                    .labelsHidden()
                    .onChange(of: viewModel.to) { _ in viewModel.customDateChanged() }
            }
        }
        .padding(16)
        .frame(width: 200, alignment: .leading)
    }

    private let rangePickerWidth: CGFloat = 300
    private var rangeSegmentWidth: CGFloat {
        rangePickerWidth / CGFloat(AnalyticsViewModel.RangePreset.allCases.count)
    }

    private var rangePicker: some View {
        Picker("Range", selection: Binding(
            get: { viewModel.preset },
            set: { viewModel.selectPreset($0) }
        )) {
            ForEach(AnalyticsViewModel.RangePreset.allCases) { p in
                Text(p.rawValue).tag(p)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(minWidth: 250, idealWidth: rangePickerWidth, maxWidth: rangePickerWidth, alignment: .leading)
        .overlay(alignment: .trailing) {
            Color.clear
                .frame(width: rangeSegmentWidth)
                .contentShape(Rectangle())
                .onTapGesture {
                    viewModel.selectPreset(.custom)
                    showCustomRange = true
                }
        }
        .background(alignment: .trailing) {
            Color.clear
                .frame(width: 1)
                .popover(isPresented: $showCustomRange, arrowEdge: .bottom) {
                    customRangeEditor
                }
                .padding(.trailing, rangeSegmentWidth / 2)
        }
        .onChange(of: viewModel.preset) { p in
            guard p != .custom else { return }
            DispatchQueue.main.async { showCustomRange = false }
        }
    }

    private var filterTrailing: some View {
        HStack(spacing: 12) {
            progressSlot
            Text("Provider")
                .foregroundStyle(.secondary)
                .fixedSize()
            providerPicker
            Text("Model")
                .foregroundStyle(.secondary)
                .fixedSize()
            modelPicker
        }
    }

    private var compactTrailing: some View {
        HStack(spacing: 12) {
            progressSlot
            providerPicker
        }
    }

    private var progressSlot: some View {
        // Reserved slot: the layout width stays constant while loading,
        // so selecting a preset can't shift the bar or resize the split.
        ProgressView()
            .controlSize(.small)
            .frame(width: 16)
            .opacity(viewModel.isLoading && viewModel.stats != nil ? 1 : 0)
    }

    private var providerPicker: some View {
        Picker("Provider", selection: Binding(
            get: { viewModel.selectedProvider },
            set: { viewModel.selectProvider($0) }
        )) {
            Text("All providers").tag(String?.none)
            ForEach(viewModel.providers, id: \.self) { p in
                Text(p).tag(String?.some(p))
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .frame(width: 110)
    }

    private var modelPicker: some View {
        Picker("Model", selection: Binding(
            get: { viewModel.selectedModel },
            set: { viewModel.selectModel($0) }
        )) {
            Text("All models").tag(String?.none)
            ForEach(viewModel.models, id: \.self) { m in
                Text(m).tag(String?.some(m))
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .frame(width: 100)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.stats == nil {
            ProgressView("Loading…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let stats = viewModel.stats {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    statCards(stats)
                    chartCard(stats)
                    breakdownSection(stats)
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if ServerManager.shared.state.isRunning {
            VStack(spacing: 8) {
                Image(systemName: "chart.bar.xaxis")
                    .font(.system(size: 36))
                    .foregroundStyle(.secondary)
                Text("No analytics yet.")
                    .font(.headline)
                Text("Requests logged by the proxy will appear here.")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 8) {
                Image(systemName: "power")
                    .font(.system(size: 36))
                    .foregroundStyle(.secondary)
                Text("The proxy server isn't running.")
                    .font(.headline)
                Text("Start it from the menu bar or the Overview panel.")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Card wrapper

    @ViewBuilder
    private func card(@ViewBuilder _ content: () -> some View) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
    }

    // MARK: Stat cards

    private func statCards(_ stats: APIClient.AnalyticsStats) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
            statCard("Requests", value: compact(stats.count), icon: "arrow.left.arrow.right")
            statCard("Error rate", value: rateText(stats.errorCount, of: stats.count), icon: "exclamationmark.triangle")
            statCard("Avg TTFT", value: msText(stats.avgTtftMs), icon: "bolt")
            statCard("Avg duration", value: msText(stats.avgDurationMs), icon: "timer")
            statCard("Input tokens", value: compact(stats.inTokens), icon: "arrow.up.circle")
            statCard("Cache rate", value: rateText(stats.cachedTokens, of: stats.inTokens), icon: "percent")
            statCard("Output tokens", value: compact(stats.outTokens), icon: "arrow.down.circle")
        }
    }

    private func statCard(_ title: String, value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: icon)
                .foregroundStyle(.tint)
            Text(value)
                .font(.system(.title2, design: .rounded, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
    }

    // MARK: Chart

    private func chartCard(_ stats: APIClient.AnalyticsStats) -> some View {
        card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Usage over time")
                        .font(.headline)
                    Spacer()
                    HStack(spacing: 6) {
                        Button {
                            viewModel.navigate(-1)
                        } label: {
                            Image(systemName: "chevron.left")
                        }
                        .buttonStyle(.borderless)
                        .disabled(!canNavigateBack)
                        .help("Previous \(stepName)")

                        Button {
                            viewModel.navigate(1)
                        } label: {
                            Image(systemName: "chevron.right")
                        }
                        .buttonStyle(.borderless)
                        .disabled(!canNavigateForward)
                        .help("Next \(stepName)")
                    }
                    .font(.callout)
                    Picker("Metric", selection: $chartMetric) {
                        ForEach(ChartMetric.allCases) { m in
                            Text(m.rawValue).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 180, alignment: .trailing)
                }
                if stats.series.isEmpty {
                    Text("No usage in this range.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 40)
                } else {
                    let scale = modelStyleScale(stats)
                    Chart {
                        chartMarks(stats)
                    }
                    .chartForegroundStyleScale(domain: scale.domain, range: scale.range)
                    .chartLegend(chartMetric == .tokens ? .visible : .hidden)
                    .frame(height: 240)
                    .chartXAxis {
                        AxisMarks(values: .automatic) { _ in
                            AxisGridLine()
                            AxisValueLabel(format: axisFormat)
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .trailing) { _ in
                            AxisGridLine()
                            AxisValueLabel()
                        }
                    }
                    .chartOverlay { proxy in
                        GeometryReader { _ in
                            Rectangle()
                                .fill(Color.clear)
                                .contentShape(Rectangle())
                                .onContinuousHover { phase in
                                    guard chartMetric == .tokens else { return }
                                    switch phase {
                                    case .active(let location):
                                        if let (date, _) = proxy.value(at: location, as: (Date, Int).self) {
                                            hoveredBucket = nearestBucket(to: date, in: stats)
                                        }
                                    case .ended:
                                        hoveredBucket = nil
                                    }
                                }
                        }
                    }
                    .onChange(of: chartMetric) { _ in hoveredBucket = nil }
                }
            }
        }
    }

    @ChartContentBuilder
    private func chartMarks(_ stats: APIClient.AnalyticsStats) -> some ChartContent {
        switch chartMetric {
        case .requests:
            ForEach(stats.series) { b in
                let d = bucketDate(b.bucket)
                AreaMark(
                    x: .value("Time", d),
                    y: .value("Requests", b.count)
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(.linearGradient(colors: [Color.accentColor.opacity(0.22), Color.accentColor.opacity(0.02)], startPoint: .top, endPoint: .bottom))

                LineMark(
                    x: .value("Time", d),
                    y: .value("Requests", b.count)
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 2))

                PointMark(
                    x: .value("Time", d),
                    y: .value("Requests", b.count)
                )
                .symbolSize(chartPointSymbolSize)
                .foregroundStyle(Color.accentColor)
            }
        case .tokens:
            if stats.seriesByModel.isEmpty {
                // Older server without a per-model series: fall back to total tokens per bucket.
                ForEach(stats.series) { b in
                    BarMark(
                        x: .value("Time", bucketDate(b.bucket)),
                        y: .value("Tokens", b.inTokens + b.outTokens)
                    )
                    .foregroundStyle(Color.accentColor)
                    .cornerRadius(2)
                }
            } else {
                ForEach(stats.seriesByModel) { point in
                    BarMark(
                        x: .value("Time", bucketDate(point.bucket)),
                        y: .value("Tokens", point.inTokens + point.outTokens)
                    )
                    .foregroundStyle(by: .value("Model", point.model))
                    .cornerRadius(2)
                }
                if let hovered = hoveredBucket,
                   stats.seriesByModel.contains(where: { $0.bucket == hovered }) {
                    hoverRule(hovered, stats)
                }
            }
        }
    }

    /// Hide point markers once buckets get dense - they read as noise.
    private var chartPointSymbolSize: CGFloat {
        guard let stats = viewModel.stats else { return 36 }
        return stats.series.count > 16 ? 0 : 36
    }

    // MARK: Period navigation

    private var stepName: String {
        switch viewModel.preset {
        case .day: "day"
        case .week: "week"
        case .month: "month"
        case .custom: "range"
        }
    }

    private var canNavigateBack: Bool {
        viewModel.preset != .custom
    }

    /// Forward is off once the window already includes the present -
    /// there is no data in the future.
    private var canNavigateForward: Bool {
        guard viewModel.preset != .custom else { return false }
        return viewModel.to < Date()
    }

    // MARK: Chart hover (tokens)

    @State private var hoveredBucket: Int64?

    private func hoverRule(_ bucket: Int64, _ stats: APIClient.AnalyticsStats) -> some ChartContent {
        RuleMark(x: .value("Hover", bucketDate(bucket)))
            .foregroundStyle(Color(nsColor: .separatorColor))
            .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                tokensHoverCard(bucket, stats)
            }
    }

    /// Hover-card header. Single-day buckets show one date (with time when
    /// hourly); aggregated groups wider than a day show the covered range,
    /// e.g. "Jun 9 \u{2013} Jun 10, 2026".
    private func hoverHeader(_ bucket: Int64, _ stats: APIClient.AnalyticsStats) -> String {
        let step: Int64 = stats.series.count > 1
            ? stats.series[1].bucket - stats.series[0].bucket
            : fallbackBucketStep
        let start = bucketDate(bucket)
        let end: Date
        if let index = stats.series.firstIndex(where: { $0.bucket == bucket }) {
            let endMs = index + 1 < stats.series.count
                ? stats.series[index + 1].bucket - 1
                : Int64(viewModel.to.timeIntervalSince1970 * 1000) - 1
            end = bucketDate(max(endMs, bucket))
        } else {
            end = start
        }
        if step <= 86_400_000 {
            let time: Date.FormatStyle.TimeStyle = step <= 3_600_000 ? .shortened : .omitted
            return start.formatted(Date.FormatStyle(date: .abbreviated, time: time))
        }
        let sameYear = Calendar.current.isDate(start, equalTo: end, toGranularity: .year)
        let startText = sameYear
            ? start.formatted(.dateTime.month().day())
            : start.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted))
        let endText = end.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted))
        return "\(startText) \u{2013} \(endText)"
    }

    private func tokensHoverCard(_ bucket: Int64, _ stats: APIClient.AnalyticsStats) -> some View {
        let points = stats.seriesByModel
            .filter { $0.bucket == bucket }
            .sorted { ($0.inTokens + $0.outTokens) > ($1.inTokens + $1.outTokens) }
        let totalIn = points.reduce(0) { $0 + $1.inTokens }
        let totalOut = points.reduce(0) { $0 + $1.outTokens }
        let count = points.reduce(0) { $0 + $1.count }
        let header = hoverHeader(bucket, stats)
        return VStack(alignment: .leading, spacing: 4) {
            Text(header)
                .font(.caption2)
                .foregroundStyle(.secondary)
            ForEach(points) { p in
                HStack(spacing: 6) {
                    Circle()
                        .fill(modelColor(in: stats, model: p.model))
                        .frame(width: 7, height: 7)
                    Text(p.model)
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    Text("\u{2191}\(compact(p.inTokens)) \u{2193}\(compact(p.outTokens)) \u{00b7} \(p.count) req")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            Divider()
            HStack {
                Text("Total")
                    .font(.caption)
                    .fontWeight(.medium)
                Spacer(minLength: 0)
                Text("\u{2191}\(compact(totalIn)) \u{2193}\(compact(totalOut)) \u{00b7} \(count) req")
                    .font(.caption)
                    .monospacedDigit()
            }
        }
        .padding(8)
        .frame(width: 230)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor))
            .shadow(color: .black.opacity(0.18), radius: 5, y: 2))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
    }

    private func nearestBucket(to date: Date, in stats: APIClient.AnalyticsStats) -> Int64? {
        let buckets = stats.series.map(\.bucket)
        let t = Int64(date.timeIntervalSince1970 * 1000)
        guard let nearest = buckets.min(by: { abs($0 - t) < abs($1 - t) }) else { return nil }
        let step = buckets.count > 1 ? buckets[1] - buckets[0] : fallbackBucketStep
        return abs(nearest - t) <= step / 2 ? nearest : nil
    }

    private var fallbackBucketStep: Int64 {
        let hour: Int64 = 3_600_000
        let day: Int64 = 86_400_000
        switch viewModel.preset {
        case .day:
            return hour
        case .custom:
            let span = Int64(viewModel.to.timeIntervalSince(viewModel.from) * 1000)
            return span > 0 && span <= 3 * day ? hour : day
        default:
            return day
        }
    }

    private var axisFormat: Date.FormatStyle {
        switch viewModel.preset {
        case .day: .dateTime.hour()
        default: .dateTime.month().day()
        }
    }

    private func bucketDate(_ ms: Int64) -> Date {
        Date(timeIntervalSince1970: Double(ms) / 1000)
    }

    private let modelPalette: [Color] = [
        .blue, .green, .orange, .purple, .teal, .pink, .indigo, .mint, .red, .yellow,
    ]

    private func modelStyleScale(_ stats: APIClient.AnalyticsStats) -> (domain: [String], range: [Color]) {
        let domain = Array(Set(stats.seriesByModel.map(\.model))).sorted()
        let range = (0..<max(domain.count, 1)).map { modelPalette[$0 % modelPalette.count] }
        return (domain.isEmpty ? ["Tokens"] : domain, range)
    }

    /// The color a model gets from the stable scale, so hover cards match the bars.
    private func modelColor(in stats: APIClient.AnalyticsStats, model: String) -> Color {
        let domain = Array(Set(stats.seriesByModel.map(\.model))).sorted()
        guard let index = domain.firstIndex(of: model) else { return .accentColor }
        return modelPalette[index % modelPalette.count]
    }

    // MARK: Breakdown

    private func breakdownSection(_ stats: APIClient.AnalyticsStats) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 340), spacing: 16, alignment: .top)], alignment: .leading, spacing: 20) {
            groupCard("By provider", stats.byProvider.sortedByTokens, totalTokens: stats.inTokens + stats.outTokens)
            groupCard("By model", stats.byModel.sortedByTokens, totalTokens: stats.inTokens + stats.outTokens)
        }
    }

    private func groupCard(_ title: String, _ groups: [APIClient.AnalyticsGroup], totalTokens: Int) -> some View {
        card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(title)
                        .font(.headline)
                    Spacer()
                    Text(groups.isEmpty ? "No data" : "\(groups.count) entries")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(groups) { g in
                    groupRow(g, totalTokens: totalTokens)
                }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func groupRow(_ g: APIClient.AnalyticsGroup, totalTokens: Int) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(g.key)
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Text("\(rateText(g.inTokens + g.outTokens, of: totalTokens)) · ↑\(compact(g.inTokens)) ↓\(compact(g.outTokens)) · \(g.count) req")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(nsColor: .quaternaryLabelColor))
                    Capsule().fill(Color.accentColor.gradient)
                        .frame(width: max(2, geo.size.width * groupProgress(g, totalTokens)))
                }
            }
            .frame(height: 6)
        }
        .padding(.vertical, 2)
        .help("\(g.key): \(g.count) requests, \(g.inTokens) in / \(g.outTokens) out tokens")
    }

    private func groupProgress(_ g: APIClient.AnalyticsGroup, _ total: Int) -> Double {
        total > 0 ? Double(g.inTokens + g.outTokens) / Double(total) : 0
    }

    // MARK: Formatting helpers

    private func compact(_ n: Int) -> String {
        n.formatted(.number.notation(.compactName))
    }

    private func rateText(_ part: Int, of total: Int) -> String {
        guard total > 0 else { return "-" }
        return String(format: "%.1f%%", Double(part) / Double(total) * 100)
    }

    private func msText(_ ms: Int) -> String {
        if ms >= 1000 { return String(format: "%.2fs", Double(ms) / 1000) }
        return "\(ms) ms"
    }
}

private extension Array where Element == APIClient.AnalyticsGroup {
    var sortedByTokens: [APIClient.AnalyticsGroup] {
        sorted { ($0.inTokens + $0.outTokens) > ($1.inTokens + $1.outTokens) }
    }
}
