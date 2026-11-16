import AppKit
import CmuxNextCompat
@testable import CmuxNextPages
import Foundation
import Testing

/// Settings' first open after launch (2026-11-15, "still not fixed"): the tab showed, then the page about
/// 155 ms later on cmux-lawrence-2 (bench-settings-open.py, 5 launches). The parked spare held every read
/// until its claim, so the open waited for the host to answer the page's first screen (values, host lists,
/// the section's reads) and for React to draw it. A warm spare reads that first screen at idle, while it is
/// still parked, and the open takes it with no read on its path.
@MainActor @Suite(.serialized) struct WarmSettingsSpareTests {
    static let options = PageEngineOptions(requiresWebKit: .pooledInstantOpen)

    /// Red before the fix: the warm claim took the spare as an open does, and no open took a warm spare.
    @Test func aWarmSpareReadsItsFirstScreenBeforeTheOpenAndTheOpenTakesIt() async throws {
        let (window, pool) = try await Self.readyPool()
        defer { pool.dropSpare(); pool.claimedHosts.forEach(pool.release); window.close() }
        try await Task.sleep(for: .milliseconds(500))
        let provider = RecordingPageProvider()
        let warmed = try #require(pool.claim(.settings, routes: [PageRoute(prefix: "cmux.settings.", provider: provider)],
                                             options: Self.options, window: window, focus: false, warm: true))
        #expect(pool.isSpareReady && pool.spare === warmed, "warming took the spare out of the pool before any open")
        try await Self.wait { provider.readAndListened }
        #expect(provider.readAndListened, "the warm spare did not read its first screen before the open: \(provider.ops)")
        let page = pool.claimWarm(.settings, route: "#/settings/general", window: window, focus: false)
        #expect(page === warmed, "the open did not take the warm spare")
        guard let page else { return }
        try await Self.wait { !page.claimState.pending }
        #expect(page.lastClaim?.path == .acknowledged, "the warm document did not take the open: \(String(describing: page.lastClaim))")
        try await Task.sleep(for: .milliseconds(300))
        #expect(provider.streams.filter { $0 == "cmux.settings.changed" }.count == 1,
                "the open subscribed again (a reload): \(provider.streams)")
        #expect(pool.claims.last?.spare == true && pool.claims.last?.page == PageDescriptor.settings.id)
    }

    /// The pool asks for a warm spare once a spare is ready and no Settings page is open, never twice.
    @Test func thePoolAsksToWarmOnlyWhileNoSettingsPageIsOpen() async throws {
        var warms = 0
        var pool: PageHostPool?
        let (window, ready) = try await Self.readyPool { made in
            pool = made
            made.onSpareCanWarm = {
                warms += 1
                _ = pool?.claim(.settings, routes: [], options: Self.options, window: nil, focus: false, warm: true)
            }
        }
        defer { ready.dropSpare(); ready.claimedHosts.forEach(ready.release); window.close() }
        try await Self.wait { warms > 0 }
        #expect(warms == 1, "a ready spare was not warmed")
        let page = try #require(ready.claimWarm(.settings, route: "#/settings/general", window: window, focus: false))
        try await Self.wait { ready.isSpareReady }
        try await Task.sleep(for: .milliseconds(200))
        #expect(warms == 1, "the next spare was warmed while Settings is open")
        ready.release(page)
        try await Self.wait { warms > 1 }
        #expect(warms == 2, "the spare was not warmed after Settings closed")
    }

    private static func wait(_ done: () -> Bool) async throws {
        let start = ContinuousClock.now
        while !done(), ContinuousClock.now - start < .seconds(3) { try await Task.sleep(for: .milliseconds(5)) }
    }

    private static func readyPool(_ setUp: (PageHostPool) -> Void = { _ in }) async throws -> (NSWindow, PageHostPool) {
        let window = PageHostPoolLaunchWindowTests.shownWindow()
        var policy = PageHostPool.Policy()
        policy.idleInput = .milliseconds(5)
        let pool = PageHostPool(memoryPressure: MemoryPressureEvents(source: ManualMemoryPressureSource()), policy: policy,
                                options: options, activity: { 0 }, isTrackingMenu: { false },
                                engineDecision: { _, _ in .webKit(.pooledInstantOpen) })
        setUp(pool)
        pool.follow(window)
        pool.noteLikely()
        try await wait { pool.isSpareReady }
        try #require(pool.isSpareReady, "no parked Settings spare")
        return (window, pool)
    }
}
