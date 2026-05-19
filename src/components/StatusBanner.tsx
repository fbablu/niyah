import React, { useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Pressable,
  Easing,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { create } from "zustand";
import {
  Typography,
  Spacing,
  Radius,
  Font,
  type ThemeColors,
} from "../constants/colors";
import { useColors } from "../hooks/useColors";

export type StatusBannerSeverity = "info" | "success" | "warn" | "error";

export interface StatusBannerInput {
  message: string;
  severity?: StatusBannerSeverity;
  // 0 disables auto-dismiss; user must tap.
  durationMs?: number;
  // Action button on the right (e.g. "View"). Tapping fires onAction then dismisses.
  actionLabel?: string;
  onAction?: () => void;
}

interface QueuedBanner extends Required<
  Omit<StatusBannerInput, "actionLabel" | "onAction">
> {
  id: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface BannerState {
  queue: QueuedBanner[];
  current: QueuedBanner | null;
  show: (banner: StatusBannerInput) => void;
  dismiss: (id?: string) => void;
  _advance: () => void;
}

let _nextId = 0;
const makeId = (): string => `banner_${++_nextId}_${Date.now()}`;

const useBannerStore = create<BannerState>((set, get) => ({
  queue: [],
  current: null,
  show: (banner) => {
    const queued: QueuedBanner = {
      id: makeId(),
      message: banner.message,
      severity: banner.severity ?? "info",
      durationMs: banner.durationMs ?? 4000,
      actionLabel: banner.actionLabel,
      onAction: banner.onAction,
    };
    const { current } = get();
    if (!current) {
      set({ current: queued });
    } else {
      set((s) => ({ queue: [...s.queue, queued] }));
    }
  },
  dismiss: (id) => {
    const { current } = get();
    if (id && current?.id !== id) {
      // Drop from queue if matched
      set((s) => ({ queue: s.queue.filter((b) => b.id !== id) }));
      return;
    }
    get()._advance();
  },
  _advance: () => {
    const { queue } = get();
    if (queue.length === 0) {
      set({ current: null });
      return;
    }
    const [next, ...rest] = queue;
    set({ current: next, queue: rest });
  },
}));

export function useStatusBanner(): {
  show: (banner: StatusBannerInput) => void;
  dismiss: () => void;
} {
  const show = useBannerStore((s) => s.show);
  const dismiss = useBannerStore((s) => s.dismiss);
  return { show, dismiss: () => dismiss() };
}

// Imperative API for non-component callers (e.g. notification handlers).
export const StatusBanner = {
  show: (banner: StatusBannerInput): void =>
    useBannerStore.getState().show(banner),
  dismiss: (): void => useBannerStore.getState().dismiss(),
};

export function StatusBannerHost() {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const current = useBannerStore((s) => s.current);
  const advance = useBannerStore((s) => s._advance);

  const translateY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (!current) {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: -120,
          duration: 200,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
    if (current.durationMs > 0) {
      timeoutRef.current = setTimeout(() => {
        advance();
      }, current.durationMs);
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [current, advance, translateY, opacity]);

  if (!current) return null;

  const palette = severityPalette(current.severity, Colors);

  const handleAction = () => {
    current.onAction?.();
    advance();
  };

  return (
    <SafeAreaView
      pointerEvents="box-none"
      style={styles.safeArea}
      edges={["top"]}
    >
      <Animated.View
        pointerEvents="auto"
        style={[
          styles.banner,
          {
            backgroundColor: palette.background,
            borderColor: palette.border,
            transform: [{ translateY }],
            opacity,
          },
        ]}
      >
        <View style={styles.dot}>
          <View
            style={[styles.dotInner, { backgroundColor: palette.accent }]}
          />
        </View>
        <Pressable
          style={styles.messageWrap}
          onPress={() => advance()}
          accessibilityRole="button"
          accessibilityLabel={`Dismiss notification: ${current.message}`}
        >
          <Text
            style={[styles.message, { color: palette.text }]}
            numberOfLines={3}
          >
            {current.message}
          </Text>
        </Pressable>
        {current.actionLabel ? (
          <Pressable onPress={handleAction} hitSlop={10} style={styles.action}>
            <Text style={[styles.actionLabel, { color: palette.accent }]}>
              {current.actionLabel}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </SafeAreaView>
  );
}

function severityPalette(
  severity: StatusBannerSeverity,
  Colors: ThemeColors,
): { background: string; border: string; accent: string; text: string } {
  switch (severity) {
    case "success":
      return {
        background: Colors.gainLight,
        border: Colors.gain,
        accent: Colors.gain,
        text: Colors.text,
      };
    case "warn":
      return {
        background: Colors.warningLight,
        border: Colors.warning,
        accent: Colors.warning,
        text: Colors.text,
      };
    case "error":
      return {
        background: Colors.lossLight,
        border: Colors.loss,
        accent: Colors.loss,
        text: Colors.text,
      };
    case "info":
    default:
      return {
        background: Colors.infoLight,
        border: Colors.info,
        accent: Colors.info,
        text: Colors.text,
      };
  }
}

const makeStyles = (_Colors: ThemeColors) =>
  StyleSheet.create({
    safeArea: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      zIndex: 9999,
      elevation: 9999,
    },
    banner: {
      flexDirection: "row",
      alignItems: "center",
      marginHorizontal: Spacing.md,
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm + 2,
      borderRadius: Radius.lg,
      borderWidth: 1,
      gap: Spacing.sm,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18,
      shadowRadius: 12,
      elevation: 6,
    },
    dot: {
      width: 18,
      height: 18,
      borderRadius: 9,
      alignItems: "center",
      justifyContent: "center",
    },
    dotInner: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    messageWrap: {
      flex: 1,
    },
    message: {
      fontSize: Typography.bodySmall,
      ...Font.medium,
      lineHeight: Typography.bodySmall * 1.4,
    },
    action: {
      paddingHorizontal: Spacing.xs,
      paddingVertical: Spacing.xs,
    },
    actionLabel: {
      fontSize: Typography.labelMedium,
      ...Font.semibold,
    },
  });
