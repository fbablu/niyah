import React, { useMemo } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  Typography,
  Spacing,
  Font,
  type ThemeColors,
} from "../constants/colors";
import { useColors } from "../hooks/useColors";

interface SessionScreenScaffoldProps {
  children: React.ReactNode;
  /**
   * Header variant:
   * - "back": Left-aligned "Back"/"Cancel" text button
   * - "centered": Centered title with left Cancel and optional right action
   * - "none": No header
   */
  headerVariant?: "back" | "centered" | "none";
  /** Back/cancel button label (default: "Back" for "back" variant, "Cancel" for "centered") */
  backLabel?: string;
  /** Custom back handler (default: router.back()) */
  onBack?: () => void;
  /** Centered header title (only for "centered" variant) */
  headerTitle?: string;
  /** Right header action (only for "centered" variant) */
  headerRight?: React.ReactNode;
  /** Title displayed below header */
  title?: string;
  /** Subtitle displayed below title */
  subtitle?: string;
  /** Center the title section (default: true) */
  centerTitle?: boolean;
  /** Footer content with border-top separator and padding */
  footer?: React.ReactNode;
  /** Whether to use ScrollView for main content (default: true) */
  scrollable?: boolean;
  /** Whether footer sticks to bottom with marginTop: auto instead of border-top (default: false) */
  stickyFooter?: boolean;
}

export const SessionScreenScaffold: React.FC<SessionScreenScaffoldProps> = ({
  children,
  headerVariant = "back",
  backLabel,
  onBack,
  headerTitle,
  headerRight,
  title,
  subtitle,
  centerTitle = true,
  footer,
  scrollable = true,
  stickyFooter = false,
}) => {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();

  const handleBack = onBack ?? (() => router.back());

  const renderHeader = () => {
    if (headerVariant === "none") return null;

    if (headerVariant === "centered") {
      return (
        <View style={styles.centeredHeader}>
          <Pressable
            onPress={handleBack}
            style={styles.centeredHeaderButton}
            hitSlop={20}
            accessibilityRole="button"
            accessibilityLabel={backLabel ?? "Cancel"}
          >
            <Text style={styles.centeredHeaderButtonText}>
              {backLabel ?? "Cancel"}
            </Text>
          </Pressable>
          {headerTitle && (
            <Text style={styles.centeredHeaderTitle}>{headerTitle}</Text>
          )}
          {headerRight ? (
            <View style={styles.centeredHeaderButton}>{headerRight}</View>
          ) : (
            <View style={styles.centeredHeaderButton} />
          )}
        </View>
      );
    }

    // "back" variant
    return (
      <View style={styles.backHeader}>
        <Pressable
          onPress={handleBack}
          hitSlop={20}
          accessibilityRole="button"
          accessibilityLabel={backLabel ?? "Back"}
        >
          <Text style={styles.backText}>{backLabel ?? "Back"}</Text>
        </Pressable>
      </View>
    );
  };

  const renderTitleSection = () => {
    if (!title) return null;
    return (
      <View style={[styles.titleSection, centerTitle && styles.titleCenter]}>
        <Text style={styles.title}>{title}</Text>
        {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
    );
  };

  const renderFooter = () => {
    if (!footer) return null;
    return (
      <View style={stickyFooter ? styles.stickyFooter : styles.footer}>
        {footer}
      </View>
    );
  };

  if (scrollable) {
    return (
      <SafeAreaView style={styles.container}>
        <KeyboardAwareScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          bottomOffset={20}
        >
          {renderHeader()}
          {renderTitleSection()}
          {children}
        </KeyboardAwareScrollView>
        {renderFooter()}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.contentContainer}>
        {renderHeader()}
        {renderTitleSection()}
        {children}
        {renderFooter()}
      </View>
    </SafeAreaView>
  );
};

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: Colors.background,
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      padding: Spacing.lg,
      paddingBottom: Spacing.xl,
    },
    contentContainer: {
      flex: 1,
      padding: Spacing.lg,
    },
    // ── Back header ──
    backHeader: {
      marginBottom: Spacing.md,
    },
    backText: {
      color: Colors.textSecondary,
      fontSize: Typography.bodyLarge,
      ...Font.medium,
    },
    // ── Centered header ──
    centeredHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: Spacing.md,
    },
    centeredHeaderButton: {
      width: 60,
    },
    centeredHeaderButtonText: {
      color: Colors.textSecondary,
      fontSize: Typography.bodyLarge,
      ...Font.medium,
    },
    centeredHeaderTitle: {
      fontSize: Typography.titleLarge,
      ...Font.semibold,
      color: Colors.text,
    },
    // ── Title section ──
    titleSection: {
      marginBottom: Spacing.xl,
    },
    titleCenter: {
      alignItems: "center",
    },
    title: {
      fontSize: Typography.headlineMedium,
      ...Font.bold,
      color: Colors.text,
    },
    subtitle: {
      fontSize: Typography.bodyMedium,
      color: Colors.textSecondary,
      marginTop: Spacing.xs,
    },
    // ── Footer ──
    footer: {
      padding: Spacing.lg,
      paddingBottom: Spacing.xl,
      gap: Spacing.md,
      borderTopWidth: 1,
      borderTopColor: Colors.border,
    },
    stickyFooter: {
      marginTop: "auto",
      gap: Spacing.sm,
    },
  });
