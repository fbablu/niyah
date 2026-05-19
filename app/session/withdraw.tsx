import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Alert,
  ActivityIndicator,
  Linking,
  AppState,
} from "react-native";
import { useRouter } from "expo-router";
import {
  Typography,
  Spacing,
  Radius,
  Font,
  type ThemeColors,
} from "../../src/constants/colors";
import { useColors } from "../../src/hooks/useColors";
import { useScreenProtection } from "../../src/hooks/useScreenProtection";
import * as Haptics from "expo-haptics";
import {
  Button,
  NumPad,
  AmountDisplay,
  SessionScreenScaffold,
  withErrorBoundary,
} from "../../src/components";
import { useWalletStore } from "../../src/store/walletStore";
import { useAuthStore } from "../../src/store/authStore";
import { useFeatureFlagsStore } from "../../src/store/featureFlagsStore";
import { formatMoney } from "../../src/utils/format";
import {
  requestWithdrawal,
  createAccountLink,
  getConnectAccountStatus,
  getWithdrawalEligibility,
  type WithdrawalEligibility,
} from "../../src/config/functions";
import { logger } from "../../src/utils/logger";
import { logEvent } from "../../src/utils/analytics";
import { getFunctionErrorMessage } from "../../src/utils/errors";

type WithdrawMethod = "standard" | "instant";

function calcInstantFee(amountCents: number): number {
  return Math.max(50, Math.round(amountCents * 0.015));
}

function WithdrawScreenInner() {
  useScreenProtection("withdraw");
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();
  const balance = useWalletStore((s) => s.balance);
  const withdrawFn = useWalletStore((s) => s.withdraw);
  const withdrawalsPaused = !useFeatureFlagsStore(
    (s) => s.flags.acceptingWithdrawals,
  );
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const [inputValue, setInputValue] = useState("");
  const [step, setStep] = useState<"amount" | "method">("amount");
  const [selectedMethod, setSelectedMethod] =
    useState<WithdrawMethod>("standard");
  const [isLoading, setIsLoading] = useState(false);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [eligibility, setEligibility] = useState<WithdrawalEligibility | null>(
    null,
  );

  // Guard against setState after unmount + double navigation, which crashes
  // "every other time" when Stripe modal dismiss races with React unmount.
  const isMountedRef = useRef(true);
  const hasNavigatedBackRef = useRef(false);
  useEffect(() => {
    isMountedRef.current = true;
    hasNavigatedBackRef.current = false;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Fetch withdrawal eligibility (campus-launch friend-session gate) so the UI
  // can show progress before the user even taps Continue.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stats = await getWithdrawalEligibility();
        if (!cancelled && isMountedRef.current) setEligibility(stats);
      } catch (err) {
        logger.warn("getWithdrawalEligibility failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const safeBack = useCallback(() => {
    if (hasNavigatedBackRef.current) return;
    hasNavigatedBackRef.current = true;
    try {
      router.back();
    } catch (err) {
      logger.warn("router.back failed:", err);
    }
  }, [router]);

  const stripeStatus = user?.stripeAccountStatus ?? "none";
  const hasActiveStripe = stripeStatus === "active";
  const rawLinkedBank = user?.linkedBank as
    | { institutionName?: string; bankName?: string; mask?: string }
    | undefined;
  const linkedBank =
    rawLinkedBank?.institutionName && rawLinkedBank?.mask
      ? {
          institutionName: rawLinkedBank.institutionName,
          mask: rawLinkedBank.mask,
        }
      : undefined;
  const hasBankLinked = hasActiveStripe && !!linkedBank;

  const amountInCents = inputValue
    ? Math.round(parseFloat(inputValue) * 100)
    : 0;
  const displayAmount = inputValue ? `$${inputValue}` : "";
  const isValidAmount =
    amountInCents >= 1000 &&
    amountInCents <= balance &&
    amountInCents <= 1_000_000;
  const instantFee = calcInstantFee(amountInCents);

  const checkStripeStatus = useCallback(async () => {
    if (!isMountedRef.current) return;
    setIsCheckingStatus(true);
    try {
      const result = await getConnectAccountStatus();
      if (!isMountedRef.current) return;
      updateUser({
        stripeAccountStatus:
          result.status === "none" ? undefined : result.status,
        ...(result.bankName && result.bankMask
          ? {
              linkedBank: {
                institutionName: result.bankName,
                bankName: result.bankName,
                mask: result.bankMask,
              },
            }
          : {}),
      });
      if (result.status === "active") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      logger.error("checkStripeStatus error:", err);
    } finally {
      if (isMountedRef.current) setIsCheckingStatus(false);
    }
  }, [updateUser]);

  // Read stripeStatus via ref so the AppState listener doesn't re-subscribe on
  // every status change (which previously caused listener stacking + crashes
  // when a background→foreground happened mid-Stripe-dismiss).
  const stripeStatusRef = useRef(stripeStatus);
  stripeStatusRef.current = stripeStatus;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (!isMountedRef.current) return;
      const status = stripeStatusRef.current;
      if (
        nextState === "active" &&
        (status === "none" || status === "pending")
      ) {
        checkStripeStatus();
      }
    });
    return () => sub.remove();
  }, [checkStripeStatus]);

  const handleSetupStripe = useCallback(async () => {
    // First-time setup collects DOB + legal name + address natively via the
    // verify-identity screen so Stripe's hosted form only needs SSN + phone.
    if (stripeStatus === "none") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.push("/session/verify-identity" as any);
      return;
    }

    setIsSettingUp(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const { url } = await createAccountLink();
      await Linking.openURL(url);
    } catch (err) {
      logger.error("handleSetupStripe error:", err);
      Alert.alert(
        "Setup Error",
        getFunctionErrorMessage(
          err,
          "Could not start withdrawal setup. Please try again.",
        ),
      );
    } finally {
      if (isMountedRef.current) setIsSettingUp(false);
    }
  }, [stripeStatus, router]);

  const handleKeyPress = useCallback(
    (key: string) => {
      if (key === ".") {
        if (inputValue.includes(".")) return;
        if (!inputValue) {
          setInputValue("0.");
          return;
        }
      }
      if (inputValue.includes(".")) {
        const [, decimals] = inputValue.split(".");
        if (decimals && decimals.length >= 2) return;
      }
      if (inputValue.replace(".", "").length >= 6) return;
      const newValue = inputValue + key;
      if (Math.round(parseFloat(newValue) * 100) > balance) return;
      setInputValue(newValue);
    },
    [inputValue, balance],
  );

  const handleBackspace = useCallback(() => {
    setInputValue((prev) => prev.slice(0, -1));
  }, []);

  const handleMaxAmount = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInputValue((balance / 100).toFixed(2));
  };

  const handleContinue = () => {
    if (!isValidAmount) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setStep("method");
  };

  const handleStripeWithdraw = async () => {
    setIsLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    logEvent("withdrawal_requested", {
      amountCents: amountInCents,
      method: selectedMethod,
    });
    try {
      const result = await requestWithdrawal(amountInCents, selectedMethod);
      withdrawFn(amountInCents);
      const methodLabel =
        selectedMethod === "instant"
          ? "within 30 minutes"
          : "in 1–2 business days";
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        "Withdrawal Sent",
        `${formatMoney(amountInCents)} is on its way to your bank — arrives ${methodLabel}.`,
        [{ text: "Done", onPress: safeBack }],
      );
      void result;
    } catch (err: unknown) {
      Alert.alert(
        "Withdrawal Failed",
        getFunctionErrorMessage(err, "Something went wrong. Please try again."),
      );
      const uid = user?.id;
      if (uid) {
        useWalletStore
          .getState()
          .hydrate(uid)
          .catch(() => {});
      }
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  };

  const getAmountError = () => {
    if (!inputValue) return null;
    if (amountInCents < 1000) return "Minimum withdrawal is $10.00";
    if (amountInCents > 1_000_000) return "Maximum withdrawal is $10,000.00";
    if (amountInCents > balance) return "Exceeds available balance";
    return null;
  };
  const error = getAmountError();

  // ── Method selection step ──────────────────────────────────────────────────
  if (step === "method") {
    return (
      <SessionScreenScaffold
        headerVariant="centered"
        backLabel="Back"
        headerTitle="Withdraw"
        onBack={() => setStep("amount")}
        scrollable={true}
      >
        {/* Amount summary */}
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Withdrawal Amount</Text>
          <Text style={styles.summaryAmount}>{formatMoney(amountInCents)}</Text>
        </View>

        {hasBankLinked && linkedBank ? (
          <>
            {/* Bank info */}
            <View style={styles.bankCard}>
              <View style={styles.bankIcon}>
                <Text style={styles.bankIconText}>{"🏦"}</Text>
              </View>
              <View style={styles.bankInfo}>
                <Text style={styles.bankName}>
                  {linkedBank.institutionName}
                </Text>
                <Text style={styles.bankMask}>
                  Account ending in {linkedBank.mask}
                </Text>
              </View>
            </View>

            <Text style={styles.sectionLabel}>Select transfer speed</Text>

            {/* Standard */}
            <Pressable onPress={() => setSelectedMethod("standard")}>
              <View
                style={[
                  styles.methodCard,
                  selectedMethod === "standard" && styles.methodCardSelected,
                ]}
              >
                <View style={styles.methodCardHeader}>
                  <View style={styles.methodInfo}>
                    <Text
                      style={[
                        styles.methodTitle,
                        selectedMethod === "standard" &&
                          styles.methodTitleSelected,
                      ]}
                    >
                      Standard Transfer
                    </Text>
                    <Text style={styles.methodSubtitle}>1–2 business days</Text>
                  </View>
                  <View style={styles.methodBadge}>
                    <Text style={styles.methodBadgeText}>Free</Text>
                  </View>
                </View>
              </View>
            </Pressable>

            {/* Instant */}
            <Pressable onPress={() => setSelectedMethod("instant")}>
              <View
                style={[
                  styles.methodCard,
                  selectedMethod === "instant" && styles.methodCardSelected,
                ]}
              >
                <View style={styles.methodCardHeader}>
                  <View style={styles.methodInfo}>
                    <Text
                      style={[
                        styles.methodTitle,
                        selectedMethod === "instant" &&
                          styles.methodTitleSelected,
                      ]}
                    >
                      Instant Transfer
                    </Text>
                    <Text style={styles.methodSubtitle}>Within 30 minutes</Text>
                  </View>
                  <View style={[styles.methodBadge, styles.methodBadgeAccent]}>
                    <Text style={styles.methodBadgeTextAccent}>
                      {formatMoney(instantFee)} fee
                    </Text>
                  </View>
                </View>
              </View>
            </Pressable>

            {/* Withdraw button + disclaimer */}
            <View style={styles.footer}>
              {isLoading ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color={Colors.primary} />
                  <Text style={styles.loadingText}>
                    Processing withdrawal...
                  </Text>
                </View>
              ) : (
                <>
                  <Button
                    title={`Withdraw ${formatMoney(amountInCents)}`}
                    onPress={handleStripeWithdraw}
                    size="large"
                  />
                  <Text style={styles.disclaimer}>
                    Withdrawals are processed securely via Stripe. Niyah does
                    not collect or store your banking information.
                  </Text>
                </>
              )}
            </View>
          </>
        ) : (
          /* Stripe not set up — onboarding */
          <>
            {isSettingUp || isCheckingStatus ? (
              <View style={styles.linkingContainer}>
                <ActivityIndicator size="large" color={Colors.primary} />
                <Text style={styles.linkingText}>
                  {isCheckingStatus
                    ? "Checking account status..."
                    : "Setting up withdrawals..."}
                </Text>
              </View>
            ) : (
              <View style={styles.setupContainer}>
                <View style={styles.setupIconRow}>
                  <Text style={styles.setupIcon}>{"🔒"}</Text>
                </View>
                <Text style={styles.setupTitle}>
                  {!hasActiveStripe
                    ? "Verify Your Identity"
                    : "Connect Your Bank"}
                </Text>
                <Text style={styles.setupDescription}>
                  {!hasActiveStripe
                    ? "Complete a quick, secure verification to enable withdrawals. You'll verify your identity and connect your bank account."
                    : "Add a bank account to receive your withdrawals."}
                </Text>
                <Button
                  title={
                    !hasActiveStripe
                      ? "Continue to Verification"
                      : "Add Bank Account"
                  }
                  onPress={handleSetupStripe}
                  size="large"
                  style={styles.setupButton}
                />
                {(stripeStatus === "pending" ||
                  stripeStatus === "restricted") && (
                  <Pressable
                    onPress={checkStripeStatus}
                    style={styles.refreshButton}
                  >
                    <Text style={styles.refreshText}>
                      Already completed? Tap to refresh
                    </Text>
                  </Pressable>
                )}
                <Text style={styles.disclaimer}>
                  Verification is handled by Stripe, a trusted payment
                  processor. Niyah never sees or stores your sensitive
                  information.
                </Text>
              </View>
            )}
          </>
        )}
      </SessionScreenScaffold>
    );
  }

  // ── Amount entry step ──────────────────────────────────────────────────────
  return (
    <SessionScreenScaffold
      headerVariant="centered"
      headerTitle="Withdraw"
      scrollable={false}
      headerRight={
        <Pressable
          onPress={handleMaxAmount}
          style={styles.maxButton}
          hitSlop={10}
        >
          <Text style={styles.maxText}>Max</Text>
        </Pressable>
      }
    >
      <View style={styles.balanceInfo}>
        <Text style={styles.balanceLabel}>Available to withdraw</Text>
        <Text style={styles.balanceAmount}>{formatMoney(balance)}</Text>
        <Text style={styles.balanceHint}>
          Earned funds are available immediately.
        </Text>
        <Text style={styles.balanceCap}>
          Min $10 · max $10,000 per withdrawal · $25,000 daily cap
        </Text>
      </View>

      <AmountDisplay
        amount={displayAmount}
        label="Enter amount"
        placeholder="$0"
      />
      {error && <Text style={styles.errorText}>{error}</Text>}

      <View style={styles.numPadContainer}>
        <NumPad
          onKeyPress={handleKeyPress}
          onBackspace={handleBackspace}
          showDecimal={true}
        />
      </View>

      <View style={styles.footer}>
        <Button
          title={
            withdrawalsPaused
              ? "Withdrawals paused"
              : eligibility && !eligibility.eligible
                ? "Complete more sessions to unlock"
                : isValidAmount
                  ? "Continue"
                  : "Enter amount (min $10)"
          }
          onPress={handleContinue}
          disabled={
            !isValidAmount ||
            withdrawalsPaused ||
            (eligibility ? !eligibility.eligible : false)
          }
          size="large"
        />
        {withdrawalsPaused && (
          <Text style={styles.errorText}>
            Withdrawals are temporarily paused. Try again soon.
          </Text>
        )}
        {eligibility && !eligibility.eligible && !withdrawalsPaused && (
          <Text style={styles.errorText}>
            {`Complete ${Math.max(
              0,
              eligibility.requiredSessions - eligibility.completedSessions,
            )} more session${
              eligibility.requiredSessions - eligibility.completedSessions === 1
                ? ""
                : "s"
            } and play with ${Math.max(
              0,
              eligibility.requiredPartners - eligibility.distinctPartners,
            )} more friend${
              eligibility.requiredPartners - eligibility.distinctPartners === 1
                ? ""
                : "s"
            } to unlock withdrawal.`}
          </Text>
        )}
      </View>
    </SessionScreenScaffold>
  );
}

const WithdrawScreen = withErrorBoundary(WithdrawScreenInner, "withdraw");
export default WithdrawScreen;

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    // ── Amount step ──
    maxButton: { alignItems: "flex-end" },
    maxText: {
      color: Colors.primary,
      fontSize: Typography.bodyLarge,
      ...Font.semibold,
    },
    balanceInfo: { alignItems: "center", paddingVertical: Spacing.lg },
    balanceLabel: {
      fontSize: Typography.labelMedium,
      color: Colors.textTertiary,
      marginBottom: Spacing.xs,
      ...Font.medium,
    },
    balanceAmount: {
      fontSize: Typography.titleMedium,
      ...Font.semibold,
      color: Colors.gain,
    },
    balanceHint: {
      fontSize: Typography.labelSmall,
      color: Colors.textSecondary,
      marginTop: Spacing.xs,
      ...Font.medium,
    },
    balanceCap: {
      fontSize: Typography.labelSmall,
      color: Colors.textMuted,
      marginTop: 2,
    },
    errorText: {
      textAlign: "center",
      color: Colors.danger,
      fontSize: Typography.bodySmall,
      marginTop: -Spacing.md,
      marginBottom: Spacing.sm,
    },
    numPadContainer: { flex: 1, justifyContent: "center" },
    footer: { paddingVertical: Spacing.lg, gap: Spacing.sm },

    // ── Method step — summary ──
    summaryCard: {
      alignItems: "center",
      paddingVertical: Spacing.xl,
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.lg,
      marginBottom: Spacing.lg,
    },
    summaryLabel: {
      fontSize: Typography.labelMedium,
      color: Colors.textSecondary,
      marginBottom: Spacing.xs,
      ...Font.medium,
    },
    summaryAmount: {
      fontSize: Typography.displaySmall,
      ...Font.bold,
      color: Colors.text,
    },

    // ── Bank info card ──
    bankCard: {
      flexDirection: "row",
      alignItems: "center",
      padding: Spacing.md,
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.border,
      marginBottom: Spacing.xl,
      gap: Spacing.md,
    },
    bankIcon: {
      width: 40,
      height: 40,
      borderRadius: Radius.md,
      backgroundColor: Colors.primaryMuted,
      alignItems: "center",
      justifyContent: "center",
    },
    bankIconText: {
      fontSize: 20,
    },
    bankInfo: {
      flex: 1,
      gap: 2,
    },
    bankName: {
      fontSize: Typography.bodyLarge,
      ...Font.semibold,
      color: Colors.text,
    },
    bankMask: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
      ...Font.regular,
    },

    // ── Section label ──
    sectionLabel: {
      fontSize: Typography.labelLarge,
      ...Font.semibold,
      color: Colors.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginBottom: Spacing.md,
    },

    // ── Method cards ──
    methodCard: {
      padding: Spacing.md,
      borderRadius: Radius.lg,
      backgroundColor: Colors.backgroundCard,
      borderWidth: 2,
      borderColor: Colors.border,
      marginBottom: Spacing.sm,
    },
    methodCardSelected: {
      borderColor: Colors.primary,
      backgroundColor: Colors.primaryMuted,
    },
    methodCardHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    methodInfo: { gap: 2 },
    methodTitle: {
      fontSize: Typography.bodyLarge,
      ...Font.semibold,
      color: Colors.text,
    },
    methodTitleSelected: { color: Colors.primary },
    methodSubtitle: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
      ...Font.regular,
    },
    methodBadge: {
      paddingHorizontal: Spacing.sm + 2,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.full,
      backgroundColor: Colors.gainLight,
    },
    methodBadgeText: {
      fontSize: Typography.labelSmall,
      ...Font.semibold,
      color: Colors.gain,
    },
    methodBadgeAccent: { backgroundColor: Colors.primaryMuted },
    methodBadgeTextAccent: {
      fontSize: Typography.labelSmall,
      ...Font.semibold,
      color: Colors.primary,
    },

    // ── Loading ──
    loadingRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.xl,
    },
    loadingText: {
      color: Colors.textSecondary,
      fontSize: Typography.bodyMedium,
      ...Font.medium,
    },

    // ── Setup / onboarding ──
    setupContainer: {
      alignItems: "center",
      paddingVertical: Spacing.lg,
      gap: Spacing.md,
    },
    setupIconRow: {
      marginBottom: Spacing.sm,
    },
    setupIcon: {
      fontSize: 40,
    },
    setupTitle: {
      fontSize: Typography.titleLarge,
      ...Font.bold,
      color: Colors.text,
      textAlign: "center",
    },
    setupDescription: {
      fontSize: Typography.bodyMedium,
      color: Colors.textSecondary,
      lineHeight: Typography.bodyMedium * 1.6,
      textAlign: "center",
      paddingHorizontal: Spacing.md,
    },
    setupButton: { marginTop: Spacing.sm, width: "100%" },
    refreshButton: {
      alignItems: "center",
      paddingVertical: Spacing.sm,
    },
    refreshText: {
      fontSize: Typography.bodySmall,
      color: Colors.primary,
      ...Font.medium,
    },
    linkingContainer: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.xl * 2,
      gap: Spacing.md,
    },
    linkingText: {
      fontSize: Typography.bodyMedium,
      color: Colors.textSecondary,
      ...Font.medium,
    },

    // ── Disclaimer ──
    disclaimer: {
      fontSize: Typography.labelSmall,
      color: Colors.textMuted,
      textAlign: "center",
      lineHeight: Typography.labelSmall * 1.5,
      paddingHorizontal: Spacing.lg,
      marginTop: Spacing.sm,
    },
  });
