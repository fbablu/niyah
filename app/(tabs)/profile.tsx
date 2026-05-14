import React, { useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Platform,
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Alert,
  Switch,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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
import { useThemeStore } from "../../src/store/themeStore";
import * as Haptics from "expo-haptics";
import {
  Card,
  Balance,
  LegalContentView,
  InviteCTA,
  withErrorBoundary,
  HoldToConfirmModal,
  StatusBanner,
} from "../../src/components";
import { useAuthStore } from "../../src/store/authStore";
import { useWalletStore } from "../../src/store/walletStore";
import { usePartnerStore } from "../../src/store/partnerStore";
import { useSocialStore } from "../../src/store/socialStore";
import { formatMoney } from "../../src/utils/format";
import { unlinkBankAccount } from "../../src/config/functions";
import { getFunctionErrorMessage } from "../../src/utils/errors";
import {
  ProfileHeader,
  ReputationCard,
  ScreenTimeCard,
  TransactionHistory,
} from "../../src/components/profile";
import { logger } from "../../src/utils/logger";

function ProfileScreenInner() {
  useScreenProtection("profile");
  const Colors = useColors();
  const { theme, toggleTheme } = useThemeStore();
  const router = useRouter();
  const { user, logout, setBlobAvatar, updateUser } = useAuthStore();
  const { balance, transactions, pendingWithdrawal } = useWalletStore();
  const { partners } = usePartnerStore();
  const { following, loadMyFollows } = useSocialStore();

  useEffect(() => {
    if (user?.id) {
      loadMyFollows(user.id).catch(() => {});
    }
  }, [user?.id, loadMyFollows]);

  const [legalModalVisible, setLegalModalVisible] = useState(false);
  const [removeBankModalVisible, setRemoveBankModalVisible] = useState(false);
  const [bankActionLoading, setBankActionLoading] = useState(false);

  const handleManageBank = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const replaceAction = () => {
      router.push("/session/bank-setup?replace=true");
    };
    const removeAction = () => setRemoveBankModalVisible(true);

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Replace bank", "Remove bank"],
          cancelButtonIndex: 0,
          destructiveButtonIndex: 2,
          title: "Manage linked bank",
        },
        (idx) => {
          if (idx === 1) replaceAction();
          else if (idx === 2) removeAction();
        },
      );
    } else {
      Alert.alert("Manage linked bank", undefined, [
        { text: "Replace bank", onPress: replaceAction },
        { text: "Remove bank", style: "destructive", onPress: removeAction },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  };

  const handleRemoveBankConfirmed = async () => {
    if (bankActionLoading) return;
    setBankActionLoading(true);
    try {
      await unlinkBankAccount();
      updateUser({
        linkedBank: undefined,
        stripeAccountStatus: "pending",
      });
      StatusBanner.show({
        severity: "success",
        message: "Bank removed. Add a new one any time from Withdraw.",
      });
    } catch (err) {
      logger.error("unlinkBankAccount failed:", err);
      StatusBanner.show({
        severity: "error",
        message: getFunctionErrorMessage(
          err,
          "Could not remove bank. Please try again.",
        ),
      });
    } finally {
      setBankActionLoading(false);
      setRemoveBankModalVisible(false);
    }
  };

  const handleLogout = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          try {
            await logout();
          } catch (error) {
            logger.error("Logout error:", error);
          }
          router.replace("/(auth)/welcome");
        },
      },
    ]);
  };

  const styles = useMemo(() => makeStyles(Colors), [Colors]);

  const completionRate =
    user && user.totalSessions > 0
      ? Math.round((user.completedSessions / user.totalSessions) * 100)
      : 0;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.scrollContent}
      >
        <ProfileHeader
          user={user}
          followingCount={following.length}
          partnerCount={partners.length}
          onBlobAvatarChange={setBlobAvatar}
        />

        <ReputationCard
          reputation={user?.reputation}
          partnerCount={partners.length}
        />

        {/* Invite Friends Card */}
        <InviteCTA style={styles.inviteCard} />

        <ScreenTimeCard />

        {/* Linked Bank */}
        {user?.linkedBank && (
          <Card style={styles.balanceCard}>
            <View style={styles.bankCardHeader}>
              <View style={styles.bankCardInfo}>
                <Text style={styles.balanceLabel}>Linked Bank</Text>
                <Text style={styles.bankName}>
                  {(user.linkedBank as { institutionName?: string })
                    .institutionName ?? "Bank"}
                </Text>
                <Text style={styles.bankMask}>
                  Account ending in{" "}
                  {(user.linkedBank as { mask?: string }).mask ?? "****"}
                </Text>
              </View>
              <Pressable
                onPress={handleManageBank}
                style={styles.manageBankButton}
                hitSlop={10}
              >
                <Text style={styles.manageBankButtonText}>Manage</Text>
              </Pressable>
            </View>
          </Card>
        )}

        {/* Balance Card */}
        <Card style={styles.balanceCard}>
          <View style={styles.balanceRow}>
            <View>
              <Text style={styles.balanceLabel}>Available Balance</Text>
              <Balance amount={balance} size="medium" />
            </View>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push("/session/withdraw");
              }}
              style={styles.withdrawButton}
            >
              <Text style={styles.withdrawButtonText}>Withdraw</Text>
            </Pressable>
          </View>
          {pendingWithdrawal > 0 && (
            <View style={styles.pendingRow}>
              <Text style={styles.pendingLabel}>Pending</Text>
              <Text style={styles.pendingAmount}>
                {formatMoney(pendingWithdrawal)}
              </Text>
            </View>
          )}
        </Card>

        {/* Stats Grid */}
        <View style={styles.statsRow}>
          <View style={styles.miniStatCard}>
            <Text style={styles.miniStatValue}>{user?.totalSessions || 0}</Text>
            <Text style={styles.miniStatLabel}>Sessions</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.miniStatCard}>
            <Text style={styles.miniStatValue}>{completionRate}%</Text>
            <Text style={styles.miniStatLabel}>Success</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.miniStatCard}>
            <Text style={styles.miniStatValue}>{user?.longestStreak || 0}</Text>
            <Text style={styles.miniStatLabel}>Best Streak</Text>
          </View>
        </View>

        <TransactionHistory transactions={transactions} />

        {/* Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Settings</Text>
          <Card style={styles.settingsCard} animate={false}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Light Mode</Text>
              <Switch
                value={theme === "light"}
                onValueChange={toggleTheme}
                trackColor={{
                  false: Colors.backgroundTertiary,
                  true: Colors.primary,
                }}
                thumbColor={Colors.white}
              />
            </View>
          </Card>
        </View>

        {/* Legal */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Legal</Text>
          <Card style={styles.settingsCard} animate={false}>
            <Pressable
              onPress={() => setLegalModalVisible(true)}
              style={styles.settingRow}
            >
              <Text style={styles.settingLabel}>Terms & Privacy</Text>
              <Text style={styles.settingChevron}>›</Text>
            </Pressable>
          </Card>
        </View>

        {/* Account */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <Card style={styles.settingsCard} animate={false}>
            <Pressable onPress={handleLogout} style={styles.settingRow}>
              <Text style={styles.settingLabelDestructive}>Sign Out</Text>
            </Pressable>
          </Card>
        </View>

        <HoldToConfirmModal
          visible={removeBankModalVisible}
          title="Remove linked bank?"
          body="Withdrawals will be disabled until you connect a new one. Your balance and history stay intact."
          holdLabel={bankActionLoading ? "Removing…" : "Hold to remove bank"}
          cancelLabel="Keep bank"
          onCancel={() => setRemoveBankModalVisible(false)}
          onConfirm={handleRemoveBankConfirmed}
        />

        {/* Read-only legal modal */}
        <Modal
          visible={legalModalVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setLegalModalVisible(false)}
        >
          <View style={styles.legalModal}>
            <View style={styles.legalModalHeader}>
              <Pressable onPress={() => setLegalModalVisible(false)}>
                <Text style={styles.legalModalClose}>Done</Text>
              </Pressable>
            </View>
            <LegalContentView section="both" />
          </View>
        </Modal>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Niyah v1.0.0</Text>
          <Text style={styles.footerSubtext}>Demo Mode</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const ProfileScreen = withErrorBoundary(ProfileScreenInner, "profile");
export default ProfileScreen;

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
      paddingBottom: Spacing.xxl,
    },
    inviteCard: {
      marginBottom: Spacing.md,
    },
    balanceCard: {
      marginBottom: Spacing.md,
    },
    balanceRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    balanceLabel: {
      fontSize: Typography.labelSmall,
      color: Colors.textSecondary,
      marginBottom: Spacing.xs,
    },
    bankName: {
      fontSize: Typography.bodyMedium,
      ...Font.semibold,
      color: Colors.text,
    },
    bankMask: {
      fontSize: Typography.bodySmall,
      color: Colors.textSecondary,
      marginTop: 2,
    },
    bankCardHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    bankCardInfo: {
      flex: 1,
    },
    manageBankButton: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      backgroundColor: Colors.backgroundTertiary,
    },
    manageBankButtonText: {
      fontSize: Typography.bodySmall,
      ...Font.semibold,
      color: Colors.text,
    },
    withdrawButton: {
      backgroundColor: Colors.backgroundTertiary,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
    },
    withdrawButtonText: {
      fontSize: Typography.bodySmall,
      ...Font.semibold,
      color: Colors.text,
    },
    pendingRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: Spacing.md,
      paddingTop: Spacing.md,
      borderTopWidth: 1,
      borderTopColor: Colors.border,
    },
    pendingLabel: {
      fontSize: Typography.bodySmall,
      color: Colors.warning,
    },
    pendingAmount: {
      fontSize: Typography.bodySmall,
      ...Font.semibold,
      color: Colors.warning,
    },
    statsRow: {
      flexDirection: "row",
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.lg,
      padding: Spacing.md,
      marginBottom: Spacing.xl,
    },
    miniStatCard: {
      flex: 1,
      alignItems: "center",
    },
    statDivider: {
      width: 1,
      backgroundColor: Colors.border,
    },
    miniStatValue: {
      fontSize: Typography.titleLarge,
      ...Font.bold,
      color: Colors.text,
    },
    miniStatLabel: {
      fontSize: Typography.labelSmall,
      color: Colors.textSecondary,
      marginTop: Spacing.xs,
    },
    section: {
      marginBottom: Spacing.xl,
    },
    sectionTitle: {
      fontSize: Typography.titleSmall,
      ...Font.semibold,
      color: Colors.text,
      marginBottom: Spacing.md,
    },
    settingsCard: {
      padding: 0,
      overflow: "hidden",
    },
    settingRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.lg,
    },
    settingLabel: {
      fontSize: Typography.bodyMedium,
      color: Colors.text,
    },
    settingLabelDestructive: {
      fontSize: Typography.bodyMedium,
      color: Colors.danger,
    },
    settingChevron: {
      fontSize: Typography.titleMedium,
      color: Colors.textMuted,
    },
    legalModal: {
      flex: 1,
      backgroundColor: Colors.background,
    },
    legalModalHeader: {
      flexDirection: "row",
      justifyContent: "flex-end",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: Colors.border,
    },
    legalModalClose: {
      fontSize: Typography.bodyLarge,
      ...Font.semibold,
      color: Colors.primary,
    },
    footer: {
      alignItems: "center",
      paddingVertical: Spacing.lg,
    },
    footerText: {
      fontSize: Typography.labelSmall,
      color: Colors.textMuted,
    },
    footerSubtext: {
      fontSize: Typography.labelSmall,
      color: Colors.textMuted,
      marginTop: Spacing.xs,
    },
  });
