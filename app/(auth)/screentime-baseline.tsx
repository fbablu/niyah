import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { withErrorBoundary } from "../../src/components/ErrorBoundary";
import { AuthScreenScaffold, Button } from "../../src/components";
import { useColors } from "../../src/hooks/useColors";
import {
  Spacing,
  Radius,
  Font,
  Typography,
  type ThemeColors,
} from "../../src/constants/colors";
import { LANE_B_ENABLED } from "../../src/constants/config";
import {
  isScreenTimeAvailable,
  requestScreenTimeAuth,
  presentAppPicker,
  getSavedAppSelection,
} from "../../src/config/screentime";

function ScreentimeBaselineScreenInner() {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // Lane B feature-flagged: if disabled, fall through to the existing
  // screentime-setup screen unchanged.
  if (!LANE_B_ENABLED) {
    router.replace("/(auth)/screentime-setup" as never);
    return null;
  }

  const onAllow = async () => {
    if (!isScreenTimeAvailable) {
      router.replace("/(tabs)");
      return;
    }
    setBusy(true);
    try {
      await requestScreenTimeAuth();
      // Present picker with no constraint — user picks broadly so the
      // DeviceActivityReport extension has a wide net for baseline data.
      await presentAppPicker();
      if (getSavedAppSelection()) {
        router.replace("/(tabs)");
      }
    } catch {
      // User cancelled — let them retry
    } finally {
      setBusy(false);
    }
  };

  const onSkip = () => router.replace("/(tabs)");

  return (
    <AuthScreenScaffold
      showBack={false}
      title={"Pick a wide net first"}
      subtitle={
        "We'll watch your top apps for 24 hours so we can suggest the right ones to block. Apple keeps the data on your device."
      }
    >
      <View style={styles.body}>
        <View style={styles.card}>
          <Text style={styles.bullet}>• Pick All Apps & Categories</Text>
          <Text style={styles.bullet}>
            • Tomorrow you'll see your top 10 ranked by daily use
          </Text>
          <Text style={styles.bullet}>
            • Then choose which to block hard vs track-only
          </Text>
        </View>

        <Button
          title={busy ? "Loading…" : "Pick apps"}
          onPress={onAllow}
          disabled={busy}
          loading={busy}
        />
        <Text style={styles.skip} onPress={onSkip}>
          Skip for now
        </Text>
      </View>
    </AuthScreenScaffold>
  );
}

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    body: {
      flex: 1,
      paddingHorizontal: Spacing.lg,
      gap: Spacing.lg,
    },
    card: {
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.lg,
      padding: Spacing.lg,
      gap: Spacing.sm,
    },
    bullet: {
      fontSize: Typography.bodyLarge,
      color: Colors.text,
      ...Font.regular,
    },
    skip: {
      fontSize: Typography.bodyMedium,
      textAlign: "center",
      color: Colors.textSecondary,
      ...Font.medium,
      paddingVertical: Spacing.md,
    },
  });

const ScreentimeBaselineScreen = withErrorBoundary(
  ScreentimeBaselineScreenInner,
  "screentime-baseline",
);

export default ScreentimeBaselineScreen;
