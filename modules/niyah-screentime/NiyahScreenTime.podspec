Pod::Spec.new do |s|
  s.name           = 'NiyahScreenTime'
  s.version        = '1.0.0'
  s.summary        = 'Screen Time API bridge for Niyah'
  s.description    = 'Custom Expo module bridging iOS FamilyControls, ManagedSettings, and DeviceActivity to JavaScript for app blocking during focus sessions.'
  s.homepage       = 'https://github.com/niyah'
  s.license        = 'MIT'
  s.author         = 'Niyah'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  # Only include top-level module files. Extension subdirectories
  # (NiyahShieldConfiguration, NiyahShieldAction, NiyahDeviceActivityMonitor)
  # are compiled by their own extension targets, not the pod.
  s.source_files   = 'ios/*.swift'

  # Screen Time frameworks are system frameworks -- no CocoaPods deps needed.
  # They are linked via weak_framework so the app still launches on iOS < 16
  # (with feature-gated unavailability).
  # ActivityKit is iOS 16.1+ — also weak so the main bridge methods can no-op
  # gracefully on older devices.
  s.weak_frameworks = 'FamilyControls', 'ManagedSettings', 'DeviceActivity', 'ActivityKit'
end
