/**
 * Expo config plugin that patches RCT-Folly headers after pod install
 * to fix the missing folly/coro/Coroutine.h error on Xcode 26+.
 *
 * Xcode 26's Clang enables C++20 coroutine support by default, causing
 * FOLLY_HAS_COROUTINES to evaluate to 1. But RCT-Folly doesn't ship
 * the folly/coro/ directory, so the #include fails.
 *
 * This plugin adds Ruby code to the Podfile's post_install block that
 * patches Expected.h and Optional.h with a __has_include guard.
 */
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PATCH_MARKER = "# [withFollyCoroutinesFix]";

const PATCH_RUBY = `
    ${PATCH_MARKER} Patch folly headers for Xcode 26+ coroutine compat.
    # Covers both the standalone RCT-Folly pod (older RN) and the bundled
    # folly headers inside the ReactNativeDependencies pod / xcframework
    # (RN 0.81 New Architecture). The public/private header symlinks in
    # Pods/Headers/{Public,Private}/... resolve to these real files.
    folly_header_paths = [
      File.join(installer.sandbox.root.to_s, 'RCT-Folly', 'folly', 'Expected.h'),
      File.join(installer.sandbox.root.to_s, 'RCT-Folly', 'folly', 'Optional.h'),
      File.join(installer.sandbox.root.to_s, 'ReactNativeDependencies', 'Headers', 'folly', 'Expected.h'),
      File.join(installer.sandbox.root.to_s, 'ReactNativeDependencies', 'Headers', 'folly', 'Optional.h'),
      File.join(installer.sandbox.root.to_s, 'ReactNativeDependencies', 'framework', 'packages', 'react-native', 'ReactNativeDependencies.xcframework', 'Headers', 'folly', 'Expected.h'),
      File.join(installer.sandbox.root.to_s, 'ReactNativeDependencies', 'framework', 'packages', 'react-native', 'ReactNativeDependencies.xcframework', 'Headers', 'folly', 'Optional.h'),
    ]
    folly_header_paths.each do |header_path|
      next unless File.exist?(header_path) && !File.symlink?(header_path)
      content = File.read(header_path)
      old_guard = '#if FOLLY_HAS_COROUTINES'
      new_guard = '#if FOLLY_HAS_COROUTINES && __has_include(<folly/coro/Coroutine.h>)'
      next unless content.include?(old_guard) && !content.include?('__has_include(<folly/coro/Coroutine.h>)')
      File.chmod(0644, header_path)
      File.write(header_path, content.gsub(old_guard, new_guard))
    end
`;

function withFollyCoroutinesFix(config) {
  return withDangerousMod(config, [
    "ios",
    async (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        "Podfile",
      );
      let podfile = fs.readFileSync(podfilePath, "utf8");

      if (podfile.includes(PATCH_MARKER)) {
        return config;
      }

      // Find the post_install block's closing "end" and insert before it.
      // The Podfile structure is:
      //   post_install do |installer|
      //     react_native_post_install(...)
      //   end
      // We insert our patch code right before that final "end".
      const postInstallMatch = podfile.match(
        /(post_install\s+do\s*\|installer\|[\s\S]*?)(^  end)/m,
      );

      if (postInstallMatch) {
        const insertIndex = postInstallMatch.index + postInstallMatch[1].length;
        podfile =
          podfile.slice(0, insertIndex) +
          PATCH_RUBY +
          podfile.slice(insertIndex);
        fs.writeFileSync(podfilePath, podfile);
      }

      return config;
    },
  ]);
}

module.exports = withFollyCoroutinesFix;
