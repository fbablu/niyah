import React, { useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  Linking,
  Alert,
  Platform,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useRouter } from "expo-router";
import {
  Typography,
  Spacing,
  Radius,
  Font,
  type ThemeColors,
} from "../../src/constants/colors";
import { useColors } from "../../src/hooks/useColors";
import {
  Card,
  Button,
  SessionScreenScaffold,
  withErrorBoundary,
} from "../../src/components";
import * as Haptics from "expo-haptics";
import { useGroupSessionStore } from "../../src/store/groupSessionStore";
import { useAuthStore } from "../../src/store/authStore";
import { GroupSession } from "../../src/types";
import { formatMoney } from "../../src/utils/format";
import { logger } from "../../src/utils/logger";

// ─── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    warningCard: {
      alignItems: "center",
      backgroundColor: Colors.lossLight,
      borderWidth: 1,
      borderColor: Colors.loss,
      paddingVertical: Spacing.xl,
      marginBottom: Spacing.md,
    },
    warningLabel: {
      fontSize: Typography.labelMedium,
      color: Colors.textSecondary,
      marginBottom: Spacing.xs,
    },
    lossAmount: {
      fontSize: Typography.displaySmall,
      ...Font.bold,
      color: Colors.loss,
      marginBottom: Spacing.sm,
    },
    warningNote: {
      fontSize: Typography.labelSmall,
      color: Colors.textMuted,
      textAlign: "center",
    },
    partnerInfo: {
      alignItems: "center",
      marginTop: Spacing.sm,
    },
    partnerVenmo: {
      fontSize: Typography.bodyMedium,
      ...Font.semibold,
      color: Colors.primary,
      marginTop: Spacing.xs,
    },
    paymentCard: {
      alignItems: "center",
      backgroundColor: Colors.lossLight,
      borderWidth: 1,
      borderColor: Colors.loss,
      paddingVertical: Spacing.xl,
      marginBottom: Spacing.md,
    },
    paymentLabel: {
      fontSize: Typography.labelMedium,
      color: Colors.textSecondary,
      marginBottom: Spacing.xs,
    },
    paymentAmount: {
      fontSize: Typography.displayMedium,
      ...Font.bold,
      color: Colors.loss,
      marginBottom: Spacing.xs,
    },
    paymentTo: {
      fontSize: Typography.bodyMedium,
      color: Colors.text,
      marginBottom: Spacing.sm,
    },
    venmoHandle: {
      fontSize: Typography.bodyLarge,
      ...Font.semibold,
      color: Colors.primary,
    },
    reputationCard: {
      backgroundColor: Colors.warningLight,
      borderWidth: 1,
      borderColor: Colors.warning,
      marginBottom: Spacing.md,
    },
    reputationWarning: {
      backgroundColor: Colors.backgroundCard,
      marginBottom: Spacing.lg,
    },
    reputationTitle: {
      fontSize: Typography.titleSmall,
      ...Font.semibold,
      color: Colors.text,
      marginBottom: Spacing.sm,
    },
    reputationText: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
      lineHeight: 20,
    },
    skipButton: {
      alignItems: "center",
      paddingVertical: Spacing.md,
    },
    skipText: {
      fontSize: Typography.labelSmall,
      color: Colors.textMuted,
    },
    alternativeCard: {
      marginBottom: Spacing.lg,
    },
    alternativeTitle: {
      fontSize: Typography.titleSmall,
      ...Font.semibold,
      color: Colors.text,
      marginBottom: Spacing.xs,
    },
    alternativeText: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
      marginBottom: Spacing.md,
    },
    suggestions: {
      gap: Spacing.xs,
    },
    suggestionRow: {
      flexDirection: "row",
      alignItems: "center",
    },
    suggestionBullet: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: Colors.primary,
      marginRight: Spacing.sm,
    },
    suggestionText: {
      fontSize: Typography.bodySmall,
      color: Colors.text,
    },
    confirmSection: {
      marginBottom: Spacing.lg,
    },
    confirmLabel: {
      fontSize: Typography.labelMedium,
      ...Font.medium,
      color: Colors.textSecondary,
      marginBottom: Spacing.sm,
      textAlign: "center",
    },
    confirmInput: {
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.md,
      padding: Spacing.md,
      fontSize: Typography.titleMedium,
      color: Colors.text,
      borderWidth: 2,
      borderColor: Colors.border,
      textAlign: "center",
      letterSpacing: 4,
      ...Font.semibold,
    },
    confirmInputValid: {
      borderColor: Colors.loss,
      backgroundColor: Colors.lossLight,
    },
    footer: {
      marginTop: Spacing.lg,
      gap: Spacing.sm,
    },
  });

function SurrenderScreenInner() {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();
  const {
    activeGroupSession,
    activeSession,
    completeGroupSession,
    reportSurrender,
    getVenmoPayLink,
    markTransferPaid,
  } = useGroupSessionStore();
  const userId = useAuthStore((state) => state.user?.id);
  const [surrendering, setSurrendering] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [showPayment, setShowPayment] = useState(false);
  const [completedSession, setCompletedSession] = useState<GroupSession | null>(
    null,
  );

  const canSurrender = confirmText.toLowerCase() === "quit";

  const isSoloSession = (activeGroupSession?.participants.length ?? 0) <= 1;

  const settledPartner = completedSession?.participants.find(
    (p) => p.userId !== userId,
  );
  const outboundTransfer = completedSession?.transfers.find(
    (t) => t.fromUserId === userId,
  );
  const amountOwed =
    outboundTransfer?.amount ?? completedSession?.stakePerParticipant ?? 0;

  const handleSurrender = async () => {
    if (!canSurrender || surrendering) return;
    setSurrendering(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

    // If Firestore-backed session, report surrender to server
    if (activeSession) {
      try {
        await reportSurrender(activeSession.id);
        router.replace("/session/complete");
        return;
      } catch (err) {
        // Fallback to legacy local surrender
        logger.warn("Server surrender failed, using local:", err);
      }
    }

    // Legacy local surrender
    if (activeGroupSession) {
      const results = activeGroupSession.participants.map((p) => ({
        userId: p.userId,
        completed: p.userId !== userId, // current user surrenders, partner assumed complete
      }));
      const completed = completeGroupSession(results);
      if (isSoloSession) {
        setCompletedSession(completed ?? null);
        router.replace("/session/complete");
      } else {
        setCompletedSession(completed ?? null);
        setShowPayment(true);
      }
    }
    setSurrendering(false);
  };

  const activePartner = activeGroupSession?.participants.find(
    (p) => p.userId !== userId,
  );

  const handlePayVenmo = async (): Promise<void> => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (settledPartner?.venmoHandle) {
      const venmoUrl = getVenmoPayLink(
        amountOwed,
        settledPartner.venmoHandle,
        `Niyah session - lost to ${settledPartner.name}`,
      );

      try {
        const canOpen = await Linking.canOpenURL(venmoUrl);
        if (canOpen) {
          await Linking.openURL(venmoUrl);
        } else {
          await Linking.openURL(
            `https://venmo.com/${settledPartner.venmoHandle.replace("@", "")}`,
          );
        }
      } catch {
        Alert.alert(
          "Error",
          "Could not open Venmo. Please pay your partner manually.",
        );
      }
    }
  };

  const handleMarkPaid = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (completedSession && outboundTransfer) {
      markTransferPaid(completedSession.id, outboundTransfer.id);
    }
    router.dismissAll();
  };

  const handleSkipPayment = () => {
    Alert.alert(
      "Skip Payment?",
      "Skipping payment will hurt your reputation score. Other users may not want to partner with you.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Skip Anyway",
          style: "destructive",
          onPress: () => router.dismissAll(),
        },
      ],
    );
  };

  useEffect(() => {
    if (!activeGroupSession && !showPayment) {
      router.dismissAll();
    }
  }, [activeGroupSession, showPayment, router]);

  if (!activeGroupSession && !showPayment) {
    return null;
  }

  if (showPayment) {
    return (
      <SessionScreenScaffold
        headerVariant="none"
        scrollable={true}
        title="Pay Your Partner"
        subtitle="You surrendered - time to settle up"
      >
        <Card style={styles.paymentCard}>
          <Text style={styles.paymentLabel}>You owe</Text>
          <Text style={styles.paymentAmount}>{formatMoney(amountOwed)}</Text>
          <Text style={styles.paymentTo}>to {settledPartner?.name}</Text>
          {settledPartner?.venmoHandle && (
            <Text style={styles.venmoHandle}>{settledPartner.venmoHandle}</Text>
          )}
        </Card>

        <Card style={styles.reputationWarning}>
          <Text style={styles.reputationTitle}>About Your Reputation</Text>
          <Text style={styles.reputationText}>
            Paying promptly builds trust. Users with low reputation scores get
            excluded from groups. Your current score affects who wants to
            partner with you.
          </Text>
        </Card>

        <View style={styles.footer}>
          <Button
            title="Pay via Venmo"
            onPress={handlePayVenmo}
            size="large"
            variant="primary"
          />
          <Button
            title="I Already Paid"
            onPress={handleMarkPaid}
            size="large"
            variant="secondary"
          />
          <Pressable onPress={handleSkipPayment} style={styles.skipButton}>
            <Text style={styles.skipText}>Skip Payment (hurts reputation)</Text>
          </Pressable>
        </View>
      </SessionScreenScaffold>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <SessionScreenScaffold
        headerVariant="back"
        backLabel="Go Back"
        onBack={() => router.back()}
        scrollable={true}
        title="Surrender Session?"
        subtitle="This action cannot be undone"
      >
        {/* Loss Warning */}
        <Card style={styles.warningCard}>
          <Text style={styles.warningLabel}>
            {isSoloSession
              ? "You will forfeit your stake"
              : "You will owe your partner"}
          </Text>
          <Text style={styles.lossAmount}>
            {formatMoney(activeGroupSession?.stakePerParticipant || 0)}
          </Text>
          {!isSoloSession && (
            <View style={styles.partnerInfo}>
              <Text style={styles.warningNote}>
                Pay {activePartner?.name} via Venmo
              </Text>
              {activePartner?.venmoHandle && (
                <Text style={styles.partnerVenmo}>
                  {activePartner.venmoHandle}
                </Text>
              )}
            </View>
          )}
        </Card>

        {/* Reputation Impact */}
        <Card style={styles.reputationCard}>
          <Text style={styles.reputationTitle}>Reputation Impact</Text>
          <Text style={styles.reputationText}>
            {isSoloSession
              ? "Surrendering forfeits your stake. Your reputation score will reflect the incomplete session."
              : "Surrendering is okay - but not paying hurts your reputation. Pay your partner to maintain trust."}
          </Text>
        </Card>

        {/* Alternative Suggestions */}
        <Card style={styles.alternativeCard}>
          <Text style={styles.alternativeTitle}>Before you go...</Text>
          <Text style={styles.alternativeText}>
            You have made it this far. Try one of these instead:
          </Text>
          <View style={styles.suggestions}>
            {[
              "Take a 5-minute walk",
              "Get a glass of water",
              "Do some stretches",
              "Take 10 deep breaths",
            ].map((suggestion, index) => (
              <View key={index} style={styles.suggestionRow}>
                <View style={styles.suggestionBullet} />
                <Text style={styles.suggestionText}>{suggestion}</Text>
              </View>
            ))}
          </View>
        </Card>

        {/* Confirm Section */}
        <View style={styles.confirmSection}>
          <Text style={styles.confirmLabel}>
            Type QUIT to confirm surrender
          </Text>
          <TextInput
            style={[
              styles.confirmInput,
              canSurrender && styles.confirmInputValid,
            ]}
            value={confirmText}
            onChangeText={setConfirmText}
            placeholder="Type QUIT"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Button
            title={isSoloSession ? "Surrender" : "Surrender and Pay Partner"}
            onPress={handleSurrender}
            disabled={!canSurrender || surrendering}
            variant="danger"
            size="large"
          />
          <Button
            title="Keep Going"
            onPress={() => router.back()}
            variant="primary"
            size="large"
          />
        </View>
      </SessionScreenScaffold>
    </KeyboardAvoidingView>
  );
}

const SurrenderScreen = withErrorBoundary(SurrenderScreenInner, "surrender");
export default SurrenderScreen;
