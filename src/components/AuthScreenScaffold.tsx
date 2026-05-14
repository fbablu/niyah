import React, { useMemo } from "react";
import { View, Text, StyleSheet, Pressable, Platform } from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
} from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  Typography,
  Spacing,
  Font,
  type ThemeColors,
} from "../constants/colors";
import { useColors } from "../hooks/useColors";

interface AuthScreenScaffoldProps {
  children: React.ReactNode;
  /** Show back button (default: true) */
  showBack?: boolean;
  /** Custom back handler (default: router.back()) */
  onBack?: () => void;
  /** Title text */
  title?: string;
  /** Subtitle text */
  subtitle?: string;
  /** Footer content rendered at bottom with marginTop: auto */
  footer?: React.ReactNode;
  /** Whether to wrap content in ScrollView (default: false) */
  scrollable?: boolean;
  /** Whether to use KeyboardAvoidingView (default: true) */
  keyboardAware?: boolean;
}

export const AuthScreenScaffold: React.FC<AuthScreenScaffoldProps> = ({
  children,
  showBack = true,
  onBack,
  title,
  subtitle,
  footer,
  scrollable = false,
  keyboardAware = true,
}) => {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();

  const handleBack = onBack ?? (() => router.back());

  const header = (
    <>
      {showBack && (
        <Pressable
          onPress={handleBack}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backText}>{"\u2190"}</Text>
        </Pressable>
      )}
      {title && (
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
      )}
    </>
  );

  const footerView = footer ? (
    <View style={styles.footer}>{footer}</View>
  ) : null;

  const innerContent = (
    <>
      {header}
      {children}
      {footerView}
    </>
  );

  if (scrollable) {
    return (
      <SafeAreaView style={styles.container}>
        <KeyboardAwareScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bottomOffset={20}
        >
          {innerContent}
        </KeyboardAwareScrollView>
      </SafeAreaView>
    );
  }

  const content = <View style={styles.content}>{innerContent}</View>;

  return (
    <SafeAreaView style={styles.container}>
      {keyboardAware ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.flex}
        >
          {content}
        </KeyboardAvoidingView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
};

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: Colors.background,
    },
    flex: {
      flex: 1,
    },
    content: {
      flex: 1,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.md,
    },
    scrollContent: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.xl,
      paddingBottom: Spacing.xxl,
    },
    backButton: {
      marginBottom: Spacing.lg,
      width: 44,
      height: 44,
      justifyContent: "center",
    },
    backText: {
      color: Colors.text,
      fontSize: 24,
    },
    header: {
      marginBottom: Spacing.xxl,
    },
    title: {
      fontSize: 36,
      ...Font.heavy,
      color: Colors.text,
      letterSpacing: -0.5,
      lineHeight: 42,
    },
    subtitle: {
      fontSize: Typography.bodyLarge,
      color: Colors.textSecondary,
      marginTop: Spacing.sm,
      lineHeight: Typography.bodyLarge * 1.5,
    },
    footer: {
      marginTop: "auto",
      paddingBottom: Spacing.lg,
      paddingTop: Spacing.md,
    },
  });
