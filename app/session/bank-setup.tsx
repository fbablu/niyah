/**
 * Bank account setup screen using Plaid Link.
 * Users connect their bank account for direct withdrawals.
 * No browser redirect — Plaid Link SDK provides a native UI.
 */

import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from "react";
import { View, Text, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import {
  create,
  open,
  type LinkSuccess,
  type LinkExit,
} from "react-native-plaid-link-sdk";
import {
  Typography,
  Spacing,
  Font,
  type ThemeColors,
} from "../../src/constants/colors";
import { useColors } from "../../src/hooks/useColors";
import { useScreenProtection } from "../../src/hooks/useScreenProtection";
import * as Haptics from "expo-haptics";
import {
  Button,
  Card,
  SessionScreenScaffold,
  withErrorBoundary,
} from "../../src/components";
import { useAuthStore } from "../../src/store/authStore";
import {
  createPlaidLinkToken,
  linkBankAccount,
  replaceBankAccount,
} from "../../src/config/functions";
import { logger } from "../../src/utils/logger";
import { getFunctionErrorMessage } from "../../src/utils/errors";

function BankSetupScreenInner() {
  useScreenProtection("bank-setup");
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ replace?: string }>();
  const isReplaceMode = params.replace === "true";
  const { user, updateUser } = useAuthStore();

  const [isConnecting, setIsConnecting] = useState(false);
  const [isLinking, setIsLinking] = useState(false);

  const isMountedRef = useRef(true);
  const hasNavigatedBackRef = useRef(false);
  useEffect(() => {
    isMountedRef.current = true;
    hasNavigatedBackRef.current = false;
    return () => {
      isMountedRef.current = false;
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

  // Check if bank is already connected
  const linkedBank = user?.linkedBank as
    | { institutionName: string; mask: string; bankName: string }
    | undefined;
  const hasBank = !!linkedBank;

  const handleConnectBank = useCallback(async () => {
    setIsConnecting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      // 1. Get a Plaid Link token from our server
      const { linkToken } = await createPlaidLinkToken();

      // 2. Create the Plaid Link session
      create({ token: linkToken });

      // 3. Open Plaid Link native UI
      open({
        onSuccess: async (success: LinkSuccess) => {
          if (!isMountedRef.current) return;
          setIsConnecting(false);
          setIsLinking(true);

          try {
            const publicToken = success.publicToken;
            const plaidAccountId = success.metadata.accounts[0]?.id;

            if (!publicToken || !plaidAccountId) {
              Alert.alert("Error", "No bank account was selected.");
              setIsLinking(false);
              return;
            }

            // 4. Send to server — exchanges token, creates Stripe account, links bank.
            // Replace mode (deep-linked from Profile → Manage → Replace) swaps
            // the bank in a single transaction so the old one is only detached
            // after the new one validates.
            const result = isReplaceMode
              ? await replaceBankAccount(publicToken, plaidAccountId)
              : await linkBankAccount(publicToken, plaidAccountId);

            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

            // 5. Update local user state
            updateUser({
              stripeAccountStatus: "active",
              linkedBank: {
                institutionName: result.bankName,
                mask: result.bankMask,
                bankName: result.bankName,
              },
            });

            Alert.alert(
              "Bank Connected",
              `${result.bankName} ending in ${result.bankMask} is now linked for withdrawals.`,
              [{ text: "Done", onPress: safeBack }],
            );
          } catch (err) {
            logger.error("linkBankAccount error:", err);
            Alert.alert(
              "Link Failed",
              getFunctionErrorMessage(
                err,
                "Failed to link bank account. Please try again.",
              ),
            );
          } finally {
            if (isMountedRef.current) setIsLinking(false);
          }
        },
        onExit: (exit: LinkExit) => {
          if (!isMountedRef.current) return;
          setIsConnecting(false);
          if (exit.error) {
            logger.error("Plaid Link error:", exit.error);
            Alert.alert(
              "Connection Error",
              "Could not connect to your bank. Please try again.",
            );
          }
          // User dismissed — do nothing
        },
      });
    } catch (err) {
      logger.error("createPlaidLinkToken error:", err);
      Alert.alert(
        "Setup Error",
        "Could not start bank connection. Check your internet and try again.",
      );
      if (isMountedRef.current) setIsConnecting(false);
    }
  }, [updateUser, safeBack, isReplaceMode]);

  const isLoading = isConnecting || isLinking;

  if (hasBank) {
    return (
      <SessionScreenScaffold
        headerVariant="back"
        title="Bank Account"
        scrollable={false}
      >
        <View style={styles.center}>
          <View style={styles.bankIcon}>
            <Text style={styles.bankIconText}>$</Text>
          </View>
          <Text style={styles.connectedTitle}>Bank Connected</Text>
          <Card style={styles.bankCard} variant="outlined">
            <Text style={styles.bankInstitution}>
              {linkedBank.institutionName}
            </Text>
            <Text style={styles.bankAccount}>
              Account ending in {linkedBank.mask}
            </Text>
          </Card>
          <Text style={styles.connectedDescription}>
            Withdrawals will be sent directly to this account via ACH transfer
            (1-2 business days).
          </Text>
          <Button
            title="Done"
            onPress={safeBack}
            size="large"
            style={styles.actionButton}
          />
          <Button
            title="Connect Different Bank"
            onPress={handleConnectBank}
            size="large"
            variant="secondary"
            style={styles.actionButton}
            loading={isLoading}
          />
        </View>
      </SessionScreenScaffold>
    );
  }

  return (
    <SessionScreenScaffold
      headerVariant="back"
      title="Connect Bank"
      subtitle="Link your bank account for direct withdrawals"
      scrollable={false}
    >
      <View style={styles.center}>
        {isLinking ? (
          <>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.linkingText}>Linking your bank account...</Text>
            <Text style={styles.linkingSubtext}>
              This may take a few seconds
            </Text>
          </>
        ) : (
          <>
            <View style={styles.bankIcon}>
              <Text style={styles.bankIconText}>$</Text>
            </View>
            <Text style={styles.heroTitle}>Direct Bank Withdrawals</Text>
            <Text style={styles.heroSubtitle}>
              Connect your checking account to withdraw earnings directly to
              your bank. Secure, fast, and free.
            </Text>

            <Card style={styles.infoCard} variant="outlined">
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Security</Text>
                <Text style={styles.infoValue}>
                  Bank-grade encryption via Plaid
                </Text>
              </View>
              <View style={styles.infoDivider} />
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Speed</Text>
                <Text style={styles.infoValue}>1-2 business days (ACH)</Text>
              </View>
              <View style={styles.infoDivider} />
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Cost</Text>
                <Text style={[styles.infoValue, { color: Colors.gain }]}>
                  Free — no fees
                </Text>
              </View>
            </Card>

            <Button
              title="Connect Bank Account"
              onPress={handleConnectBank}
              size="large"
              style={styles.actionButton}
              loading={isConnecting}
            />

            <Text style={styles.disclaimer}>
              Powered by Plaid. Your credentials are never shared with Niyah. We
              only receive your account and routing numbers for transfers.
            </Text>
          </>
        )}
      </View>
    </SessionScreenScaffold>
  );
}

const BankSetupScreen = withErrorBoundary(BankSetupScreenInner, "bank-setup");
export default BankSetupScreen;

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.lg,
      paddingHorizontal: Spacing.md,
    },
    bankIcon: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: Colors.primaryMuted,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: Spacing.sm,
    },
    bankIconText: {
      fontSize: 32,
      ...Font.bold,
      color: Colors.primary,
    },
    heroTitle: {
      fontSize: Typography.titleLarge,
      ...Font.bold,
      color: Colors.text,
      textAlign: "center",
    },
    heroSubtitle: {
      fontSize: Typography.bodyMedium,
      color: Colors.textSecondary,
      textAlign: "center",
      lineHeight: Typography.bodyMedium * 1.5,
    },
    infoCard: {
      width: "100%",
    },
    infoRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: Spacing.sm,
    },
    infoLabel: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
      ...Font.medium,
    },
    infoValue: {
      fontSize: Typography.bodySmall,
      color: Colors.text,
      ...Font.semibold,
    },
    infoDivider: {
      height: 1,
      backgroundColor: Colors.border,
    },
    actionButton: {
      width: "100%",
    },
    disclaimer: {
      textAlign: "center",
      color: Colors.textMuted,
      fontSize: Typography.labelSmall,
      lineHeight: Typography.labelSmall * 1.6,
    },
    // Connected state
    connectedTitle: {
      fontSize: Typography.titleLarge,
      ...Font.bold,
      color: Colors.gain,
    },
    bankCard: {
      width: "100%",
      alignItems: "center",
      gap: Spacing.xs,
    },
    bankInstitution: {
      fontSize: Typography.titleSmall,
      ...Font.semibold,
      color: Colors.text,
    },
    bankAccount: {
      fontSize: Typography.bodyMedium,
      color: Colors.textSecondary,
    },
    connectedDescription: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
      textAlign: "center",
      lineHeight: Typography.bodySmall * 1.5,
    },
    // Linking state
    linkingText: {
      fontSize: Typography.titleSmall,
      ...Font.semibold,
      color: Colors.text,
    },
    linkingSubtext: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
    },
  });
