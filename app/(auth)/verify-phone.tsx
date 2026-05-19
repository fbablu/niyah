import React, { useState, useRef, useEffect, useMemo } from "react";
import { View, Text, StyleSheet, TextInput, Pressable } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  Typography,
  Spacing,
  Radius,
  Font,
  type ThemeColors,
} from "../../src/constants/colors";
import { useColors } from "../../src/hooks/useColors";
import { Button, AuthScreenScaffold } from "../../src/components";
import { useAuthStore } from "../../src/store/authStore";
import { logger } from "../../src/utils/logger";
import { checkOtpThrottle } from "../../src/utils/otpThrottle";

const CODE_LENGTH = 6;
const RESEND_COOLDOWN = 60; // seconds

export default function VerifyPhoneScreen() {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ phone: string }>();
  const { verifyPhoneCode, sendPhoneCode, isLoading } = useAuthStore();

  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [resendTimer, setResendTimer] = useState(RESEND_COOLDOWN);
  const inputRef = useRef<TextInput>(null);

  // Sync the resend cooldown with the persisted throttle so a hot restart
  // doesn't reset to 60s and let the user blast through Firebase's quota.
  useEffect(() => {
    if (!params.phone) return;
    let cancelled = false;
    (async () => {
      const decision = await checkOtpThrottle(params.phone);
      if (cancelled) return;
      if (!decision.allowed && decision.retryAfterMs) {
        setResendTimer(Math.ceil(decision.retryAfterMs / 1000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.phone]);

  // Resend countdown timer
  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [resendTimer]);

  const handleCodeChange = (text: string) => {
    const digits = text.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    setError("");

    // Auto-submit when all digits entered
    if (digits.length === CODE_LENGTH) {
      handleVerify(digits);
    }
  };

  const handleVerify = async (verifyCode?: string) => {
    const finalCode = verifyCode || code;
    if (finalCode.length !== CODE_LENGTH) {
      setError("Please enter the full 6-digit code");
      return;
    }

    setError("");
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await verifyPhoneCode(finalCode);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Route based on profile state
      const state = useAuthStore.getState();
      if (state.isNewUser || !state.profileComplete) {
        router.replace("/(auth)/profile-setup");
      } else {
        router.replace("/(tabs)");
      }
    } catch (e: unknown) {
      const err = e as { message?: string; code?: string };
      logger.error("Phone code verification error:", e);
      if (
        err?.code === "auth/invalid-verification-code" ||
        err?.code === "auth/code-expired"
      ) {
        setError("Invalid or expired code. Please try again.");
      } else {
        setError(err?.message || "Verification failed. Please try again.");
      }
      setCode("");
    }
  };

  const handleResend = async () => {
    if (resendTimer > 0 || !params.phone) return;
    try {
      await sendPhoneCode(params.phone);
      setResendTimer(RESEND_COOLDOWN);
      setError("");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e: unknown) {
      const err = e as {
        message?: string;
        code?: string;
        retryAfterMs?: number;
      };
      if (err?.code === "niyah/otp-throttled" && err.retryAfterMs) {
        setResendTimer(Math.ceil(err.retryAfterMs / 1000));
      }
      setError(err?.message || "Failed to resend code.");
    }
  };

  return (
    <AuthScreenScaffold
      title="Validate Phone Number"
      subtitle={`Enter 6 digit Verification Code sent to\n${params.phone || ""}`}
    >
      {/* Error */}
      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* Code input cells */}
      <Pressable
        style={styles.codeContainer}
        onPress={() => inputRef.current?.focus()}
      >
        {Array.from({ length: CODE_LENGTH }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.codeCell,
              i < code.length && styles.codeCellFilled,
              i === code.length && styles.codeCellActive,
            ]}
          >
            <Text style={styles.codeCellText}>{code[i] || ""}</Text>
          </View>
        ))}
        {/* Hidden input for keyboard */}
        <TextInput
          ref={inputRef}
          style={styles.hiddenInput}
          value={code}
          onChangeText={handleCodeChange}
          keyboardType="number-pad"
          maxLength={CODE_LENGTH}
          autoFocus
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
        />
      </Pressable>

      {/* Resend */}
      <View style={styles.resendContainer}>
        {resendTimer > 0 ? (
          <Text style={styles.resendTimer}>
            Resend Code in {resendTimer} sec
          </Text>
        ) : (
          <Pressable onPress={handleResend}>
            <Text style={styles.resendLink}>Resend Code</Text>
          </Pressable>
        )}
      </View>

      {/* Verify button */}
      <View style={styles.buttonSection}>
        <Button
          title="Next"
          onPress={() => handleVerify()}
          disabled={code.length !== CODE_LENGTH || isLoading}
          loading={isLoading}
          size="large"
        />
      </View>
    </AuthScreenScaffold>
  );
}

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    errorContainer: {
      backgroundColor: "rgba(220, 38, 38, 0.1)",
      borderRadius: Radius.md,
      padding: Spacing.md,
      marginBottom: Spacing.md,
      borderWidth: 1,
      borderColor: "rgba(220, 38, 38, 0.2)",
    },
    errorText: {
      color: Colors.danger,
      fontSize: Typography.bodySmall,
      textAlign: "center",
    },
    codeContainer: {
      flexDirection: "row",
      justifyContent: "center",
      gap: Spacing.sm,
      marginVertical: Spacing.xl,
    },
    codeCell: {
      width: 48,
      height: 56,
      borderRadius: Radius.md,
      backgroundColor: Colors.backgroundCard,
      borderWidth: 2,
      borderColor: Colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    codeCellFilled: {
      borderColor: Colors.primary,
      backgroundColor: Colors.primaryMuted,
    },
    codeCellActive: {
      borderColor: Colors.textSecondary,
    },
    codeCellText: {
      fontSize: 24,
      ...Font.bold,
      color: Colors.text,
    },
    hiddenInput: {
      position: "absolute",
      opacity: 0,
      width: 1,
      height: 1,
    },
    resendContainer: {
      alignItems: "center",
      marginBottom: Spacing.xl,
    },
    resendTimer: {
      fontSize: Typography.bodySmall,
      color: Colors.textMuted,
      ...Font.medium,
    },
    resendLink: {
      fontSize: Typography.bodySmall,
      color: Colors.primary,
      ...Font.semibold,
    },
    buttonSection: {
      gap: Spacing.md,
    },
  });
