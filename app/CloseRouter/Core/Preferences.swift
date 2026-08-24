import Foundation

@propertyWrapper
struct UserDefault<T> {
    let key: String
    let defaultValue: T

    var wrappedValue: T {
        get { UserDefaults.standard.object(forKey: key) as? T ?? defaultValue }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}

/// App preferences, backed by UserDefaults.
enum Preferences {
    @UserDefault(key: "launchAtLogin", defaultValue: false) static var launchAtLogin
    @UserDefault(key: "startServerOnLaunch", defaultValue: false) static var startServerOnLaunch
    @UserDefault(key: "notificationsEnabled", defaultValue: true) static var notificationsEnabled
    @UserDefault(key: "hideDockIcon", defaultValue: false) static var hideDockIcon
    @UserDefault(key: "checkForUpdatesAutomatically", defaultValue: true) static var checkForUpdatesAutomatically
}
