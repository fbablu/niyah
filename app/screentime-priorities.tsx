import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { withErrorBoundary } from "../src/components/ErrorBoundary";
import { useColors } from "../src/hooks/useColors";
import {
  Spacing,
  Radius,
  Font,
  Typography,
  type ThemeColors,
} from "../src/constants/colors";
import { LANE_B_ENABLED } from "../src/constants/config";
import {
  getScreenTimeBaseline,
  isScreenTimeAvailable,
} from "../src/config/screentime";
import type { BaselineApp } from "../modules/niyah-screentime";

type Priority = "block_hard" | "block_sometimes" | "track_only";

const PRIORITY_LABELS: Record<Priority, string> = {
  block_hard: "Block hard",
  block_sometimes: "Block sometimes",
  track_only: "Track only",
};

const PRIORITY_ORDER: Priority[] = [
  "block_hard",
  "block_sometimes",
  "track_only",
];

function formatDailyAverage(minutes: number): string {
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h/day`;
  return `${Math.round(minutes)}m/day`;
}

function ScreentimePrioritiesInner() {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();

  const [apps, setApps] = useState<BaselineApp[]>([]);
  const [priorities, setPriorities] = useState<Record<string, Priority>>({});

  useEffect(() => {
    if (!LANE_B_ENABLED || !isScreenTimeAvailable) return;
    const baseline = getScreenTimeBaseline();
    setApps(baseline);
    // Default: top 3 → block_hard, next 5 → block_sometimes, rest → track_only.
    const initial: Record<string, Priority> = {};
    baseline.forEach((app, idx) => {
      initial[app.appBundleHash] =
        idx < 3 ? "block_hard" : idx < 8 ? "block_sometimes" : "track_only";
    });
    setPriorities(initial);
  }, []);

  const cyclePriority = (hash: string) => {
    setPriorities((prev) => {
      const current = prev[hash] ?? "track_only";
      const nextIdx = (PRIORITY_ORDER.indexOf(current) + 1) % 3;
      return { ...prev, [hash]: PRIORITY_ORDER[nextIdx] };
    });
  };

  if (!LANE_B_ENABLED) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          Screen Time priorities are not enabled in this build.
        </Text>
      </View>
    );
  }

  if (apps.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Still gathering your baseline</Text>
        <Text style={styles.emptyText}>
          We need about 24 hours of data after you authorize Screen Time. Check
          back tomorrow.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Your top apps this week</Text>
      <Text style={styles.subtitle}>
        Tap each app to cycle its priority. Block hard = always blocked. Track
        only = surfaced in reports, not blocked.
      </Text>

      {apps.map((app) => {
        const priority = priorities[app.appBundleHash] ?? "track_only";
        return (
          <Pressable
            key={app.appBundleHash}
            onPress={() => cyclePriority(app.appBundleHash)}
            style={styles.row}
          >
            <View style={styles.rowMain}>
              <Text style={styles.appName}>{app.displayName}</Text>
              <Text style={styles.category}>
                {app.categoryName} ·{" "}
                {formatDailyAverage(app.dailyAverageMinutes)}
              </Text>
            </View>
            <View
              style={[
                styles.pill,
                priority === "block_hard" && styles.pillHard,
                priority === "block_sometimes" && styles.pillSometimes,
                priority === "track_only" && styles.pillTrack,
              ]}
            >
              <Text style={styles.pillText}>{PRIORITY_LABELS[priority]}</Text>
            </View>
          </Pressable>
        );
      })}

      <Pressable style={styles.doneBtn} onPress={() => router.back()}>
        <Text style={styles.doneText}>Done</Text>
      </Pressable>
    </ScrollView>
  );
}

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    scroll: { flex: 1, backgroundColor: Colors.background },
    content: {
      padding: Spacing.lg,
      gap: Spacing.md,
      paddingBottom: Spacing.xl,
    },
    title: {
      fontSize: Typography.headlineMedium,
      color: Colors.text,
      ...Font.bold,
    },
    subtitle: {
      fontSize: Typography.bodyMedium,
      color: Colors.textSecondary,
      ...Font.regular,
    },
    row: {
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.lg,
      padding: Spacing.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.md,
    },
    rowMain: { flex: 1 },
    appName: {
      fontSize: Typography.bodyLarge,
      color: Colors.text,
      ...Font.semibold,
    },
    category: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
      ...Font.regular,
    },
    pill: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.full,
      backgroundColor: Colors.backgroundSecondary,
    },
    pillHard: { backgroundColor: Colors.dangerLight },
    pillSometimes: { backgroundColor: Colors.warningLight },
    pillTrack: { backgroundColor: Colors.backgroundSecondary },
    pillText: {
      fontSize: Typography.labelSmall,
      color: Colors.text,
      ...Font.medium,
    },
    doneBtn: {
      backgroundColor: Colors.primary,
      borderRadius: Radius.lg,
      paddingVertical: Spacing.md,
      alignItems: "center",
      marginTop: Spacing.md,
    },
    doneText: {
      fontSize: Typography.bodyLarge,
      color: Colors.background,
      ...Font.semibold,
    },
    empty: {
      flex: 1,
      backgroundColor: Colors.background,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.md,
    },
    emptyTitle: {
      fontSize: Typography.headlineMedium,
      color: Colors.text,
      ...Font.bold,
      textAlign: "center",
    },
    emptyText: {
      fontSize: Typography.bodyMedium,
      color: Colors.textSecondary,
      ...Font.regular,
      textAlign: "center",
    },
  });

const ScreentimePrioritiesScreen = withErrorBoundary(
  ScreentimePrioritiesInner,
  "screentime-priorities",
);

export default ScreentimePrioritiesScreen;
