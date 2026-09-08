import Charts
import SwiftUI

/// GitHub-style year heatmap: one square per calendar day, colored by request
/// count. Rendered only for the Year preset. `days` is the server's sparse
/// per-day list; the grid expands every calendar day in `from...to`, treating
/// absent days as zero.
///
/// Layout uses explicit x/y domains so the plot frame maps linearly onto the
/// grid: columns are Monday-anchored 7-day bands, rows are weekdays with
/// Monday on top (row value 7 = Monday on a 1...8 scale). The hover hit-test
/// reads the same geometry, so the tooltip always matches the block under the
/// cursor - including the January/December edge columns.
struct UsageHeatmapView: View {
    let days: [APIClient.HeatmapDay]
    let from: Date
    let to: Date

    /// One grid cell = one calendar day.
    struct Cell: Identifiable {
        let date: Date
        let count: Int
        let inTokens: Int
        let outTokens: Int
        let cachedTokens: Int
        var id: Date { date }
    }

    @State private var hovered: (cell: Cell, point: CGPoint)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            grid
            legend
        }
    }

    /// Cell fill: light gray for zero, accent ramped by sqrt(count) so bursty
    /// traffic doesn't flatten the whole year into one level.
    private func levelColor(_ count: Int) -> Color {
        guard count > 0 else { return Color(nsColor: .quaternaryLabelColor).opacity(0.45) }
        let maxCount = Double(max(maxCount, 1)).squareRoot()
        let t = min(1, Double(count).squareRoot() / maxCount)
        return Color.accentColor.opacity(0.2 + 0.8 * t)
    }

    private var maxCount: Int {
        cells.map(\.count).max() ?? 0
    }

    // MARK: Chart

    private var grid: some View {
        Chart(cells) { cell in
            RectangleMark(
                xStart: .value("Start week", weekStart(for: cell.date).addingTimeInterval(gapInset)),
                xEnd: .value("End week", weekStart(for: cell.date).addingTimeInterval(weekSpan - gapInset)),
                yStart: .value("Start weekday", rowValue(for: cell.date) + yGap),
                yEnd: .value("End weekday", rowValue(for: cell.date) + 1 - yGap)
            )
            .clipShape(RoundedRectangle(cornerRadius: 2))
            .foregroundStyle(levelColor(cell.count))
        }
        .chartLegend(.hidden)
        .chartXScale(domain: xDomain)
        .chartYScale(domain: 1.0...8.0)
        .chartXAxis {
            AxisMarks(position: .top, values: .stride(by: .month)) {
                AxisValueLabel(format: .dateTime.month())
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: [3.5, 5.5, 7.5]) { value in
                if let v = value.as(Double.self) {
                    AxisValueLabel { Text(weekdayName(v)) }
                }
            }
        }
        .chartPlotStyle { plot in
            plot.aspectRatio(aspectRatio, contentMode: .fit)
        }
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle()
                    .fill(Color.clear)
                    .contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location):
                            hovered = hoveredCell(at: location, proxy: proxy, geo: geo)
                        case .ended:
                            hovered = nil
                        }
                    }
            }
        }
        .overlay {
            if let hovered {
                GeometryReader { geo in
                    let w = geo.size.width
                    HeatmapTooltip(cell: hovered.cell)
                        .position(
                            x: min(max(hovered.point.x, 84), max(84, w - 84)),
                            y: max(18, hovered.point.y - 16)
                        )
                }
                .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Data

    /// Every calendar day in the range; days absent from the server payload
    /// become zero-count cells.
    private var cells: [Cell] {
        let cal = Calendar.current
        let start = cal.startOfDay(for: from)
        let end = cal.startOfDay(for: to)
        let lookup = Dictionary(uniqueKeysWithValues: days.map { (Int64($0.bucket), $0) })
        var result: [Cell] = []
        var cursor = start
        while cursor <= end {
            let ms = Int64(cursor.timeIntervalSince1970 * 1000)
            let day = lookup[ms]
            result.append(Cell(
                date: cursor,
                count: day?.count ?? 0,
                inTokens: day?.inTokens ?? 0,
                outTokens: day?.outTokens ?? 0,
                cachedTokens: day?.cachedTokens ?? 0
            ))
            cursor = cal.date(byAdding: .day, value: 1, to: cursor) ?? cursor
        }
        return result
    }

    /// Hit-test the hovered plot location against the year grid. With explicit
    /// domains the plot frame maps linearly onto the grid, so the column/row
    /// come from plain geometry - no axis-value interpolation to get wrong at
    /// the January/December edges. The popover anchors to the matched cell.
    private func hoveredCell(at location: CGPoint, proxy: ChartProxy, geo: GeometryProxy) -> (cell: Cell, point: CGPoint)? {
        guard let frame = proxy.plotFrame else { return nil }
        let plot = geo[frame]
        guard plot.width > 0, plot.height > 0,
              location.x >= plot.minX, location.x <= plot.maxX,
              location.y >= plot.minY, location.y <= plot.maxY else { return nil }

        let weeks = weekCount
        let xFrac = (location.x - plot.minX) / plot.width
        let col = min(weeks - 1, max(0, Int(xFrac * Double(weekDomainDays) / 7)))
        // Plot top = row value 8 (Monday), bottom = 1 (Sunday).
        let yValue = 1 + (plot.maxY - location.y) / plot.height * 7
        let row = min(6, max(0, 7 - Int(yValue.rounded(.down))))

        var cal = Calendar.current
        cal.firstWeekday = 2 // Monday
        guard let gridStart = cal.dateInterval(of: .weekOfYear, for: cells[0].date)?.start,
              let day = cal.date(byAdding: .day, value: col * 7 + row, to: gridStart),
              let cell = cells.first(where: { Calendar.current.isDate($0.date, inSameDayAs: day) }) else { return nil }

        let point = CGPoint(
            x: plot.minX + (CGFloat(col) + 0.5) * (plot.width / CGFloat(weeks)),
            y: plot.minY + (CGFloat(row) + 0.5) * (plot.height / 7)
        )
        return (cell, point)
    }

    /// The Monday starting the cell's week — each cell is laid out as an inset
    /// 7-day band so cells never touch.
    private func weekStart(for date: Date) -> Date {
        var cal = Calendar.current
        cal.firstWeekday = 2 // Monday
        return cal.dateInterval(of: .weekOfYear, for: date)?.start ?? date
    }

    /// Weekday 1 (Monday) … 7 (Sunday).
    private func weekday(for date: Date) -> Int {
        let weekday = Calendar.current.component(.weekday, from: date)
        return weekday == 1 ? 7 : weekday - 1
    }

    /// Grid row value on the 1...8 scale: Monday = 7 (top), Sunday = 1.
    private func rowValue(for date: Date) -> Double {
        Double(8 - weekday(for: date))
    }

    private func weekdayName(_ v: Double) -> String {
        switch v {
            case 7.5: "Mon"
            case 5.5: "Wed"
            case 3.5: "Fri"
            default: ""
        }
    }

    /// Monday of the first cell's week - the grid's first column.
    private var gridStart: Date? {
        guard let first = cells.first?.date else { return nil }
        var cal = Calendar.current
        cal.firstWeekday = 2
        return cal.dateInterval(of: .weekOfYear, for: first)?.start
    }

    /// Number of week columns spanned by the range.
    private var weekCount: Int {
        guard let gridStart, let last = cells.last?.date else { return 1 }
        let cal = Calendar.current
        let days = (cal.dateComponents([.day], from: gridStart, to: cal.startOfDay(for: last)).day ?? 0) + 1
        return max(1, Int(ceil(Double(days) / 7)))
    }

    private var aspectRatio: Double {
        Double(weekCount) / 7.0
    }

    /// Explicit x domain: the first column's inset left edge to the last
    /// column's inset right edge, so the plot frame maps exactly onto the grid.
    private var xDomain: ClosedRange<Date> {
        guard let gridStart else { return from...to }
        let start = gridStart.addingTimeInterval(gapInset)
        let end = gridStart.addingTimeInterval(Double((weekCount - 1) * 7) * 86_400 + weekSpan - gapInset)
        return start...end
    }

    /// Span of the x domain in days (insets removed from both ends).
    private var weekDomainDays: Int {
        (weekCount - 1) * 7 + 6
    }

    private let weekSpan: TimeInterval = 7 * 86_400
    private let gapInset: TimeInterval = 0.5 * 86_400 // half-day gap each side -> 1 day between week columns
    private let yGap: Double = 0.1 // gap between weekday rows

    // MARK: Legend

    private let heatmapGradient: [Color] = [
        Color(nsColor: .quaternaryLabelColor),
        Color.accentColor.opacity(0.35),
        Color.accentColor.opacity(0.7),
        Color.accentColor,
    ]

    private var legend: some View {
        HStack(spacing: 6) {
            Text("Less")
                .font(.caption2)
                .foregroundStyle(.secondary)
            RoundedRectangle(cornerRadius: 2)
                .fill(LinearGradient(colors: heatmapGradient, startPoint: .leading, endPoint: .trailing))
                .frame(width: 90, height: 10)
            Text("More")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }
}

// MARK: Tooltip

private extension UsageHeatmapView {
    struct HeatmapTooltip: View {
        let cell: Cell

        var body: some View {
            VStack(alignment: .leading, spacing: 3) {
                Text(cell.date.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    Text("\(cell.count) req")
                        .font(.caption)
                        .fontWeight(.medium)
                    if cell.inTokens > 0 || cell.outTokens > 0 {
                        Text("\u{2191}\(compact(cell.inTokens)) \u{2193}\(compact(cell.outTokens))")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(8)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(nsColor: .controlBackgroundColor))
                    .shadow(color: .black.opacity(0.18), radius: 5, y: 2)
            )
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
        }

        private func compact(_ n: Int) -> String {
            n.formatted(.number.notation(.compactName))
        }
    }
}
