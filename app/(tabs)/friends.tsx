import React, { useEffect, useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Contacts from "expo-contacts";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Spacing,
  Typography,
  Radius,
  Font,
  type ThemeColors,
} from "../../src/constants/colors";
import { useColors } from "../../src/hooks/useColors";
import { withErrorBoundary } from "../../src/components";
import { useAuthStore } from "../../src/store/authStore";
import { usePartnerStore } from "../../src/store/partnerStore";
import { useSocialStore } from "../../src/store/socialStore";
import { findContactsOnNiyah } from "../../src/config/functions";
import { PublicProfile, Partner } from "../../src/types";
import { logger } from "../../src/utils/logger";

// ─── Styles (makeStyles) ──────────────────────────────────────────────────────

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: Colors.background,
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.lg,
      paddingBottom: Spacing.md,
    },
    title: {
      fontSize: Typography.headlineMedium,
      ...Font.heavy,
      color: Colors.text,
      letterSpacing: -0.5,
    },
    inviteLink: {
      fontSize: Typography.bodyMedium,
      ...Font.semibold,
      color: Colors.primaryLight,
    },
    segmentRow: {
      flexDirection: "row",
      marginHorizontal: Spacing.lg,
      marginBottom: Spacing.md,
      backgroundColor: Colors.backgroundSecondary,
      borderRadius: Radius.full,
      padding: 4,
      gap: 4,
    },
    segment: {
      flex: 1,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      alignItems: "center",
    },
    segmentActive: {
      backgroundColor: Colors.primary,
    },
    segmentLabel: {
      fontSize: Typography.labelLarge,
      ...Font.semibold,
      color: Colors.textMuted,
    },
    segmentLabelActive: {
      color: Colors.white,
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.xxl,
      gap: Spacing.sm,
    },
    emptyState: {
      paddingTop: Spacing.xxl,
      alignItems: "center",
    },
    emptyText: {
      fontSize: Typography.bodyMedium,
      ...Font.regular,
      color: Colors.textMuted,
      textAlign: "center",
      lineHeight: 22,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.lg,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: Colors.border,
      gap: Spacing.md,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: Colors.primaryMuted,
      borderWidth: 1,
      borderColor: Colors.primaryLight,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarInitial: {
      fontSize: Typography.titleSmall,
      ...Font.bold,
      color: Colors.primaryLight,
    },
    rowInfo: {
      flex: 1,
      gap: 4,
    },
    nameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    rowName: {
      fontSize: Typography.bodyMedium,
      ...Font.semibold,
      color: Colors.text,
    },
    tagBadge: {
      fontSize: Typography.labelSmall,
      ...Font.medium,
      color: Colors.accentGold,
      backgroundColor: "rgba(184,134,11,0.15)",
      borderRadius: Radius.full,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    repRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
    },
    repDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    repScore: {
      fontSize: Typography.labelMedium,
      ...Font.regular,
      color: Colors.textSecondary,
    },
    unfollowBtn: {
      paddingVertical: 6,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: Colors.border,
      minWidth: 80,
      alignItems: "center",
    },
    unfollowBtnText: {
      fontSize: Typography.labelLarge,
      ...Font.medium,
      color: Colors.textMuted,
    },
    followBtn: {
      paddingVertical: 6,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.full,
      backgroundColor: Colors.primary,
      minWidth: 80,
      alignItems: "center",
    },
    followingBtn: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: Colors.primaryLight,
    },
    followBtnText: {
      fontSize: Typography.labelLarge,
      ...Font.semibold,
      color: Colors.white,
    },
    followingBtnText: {
      color: Colors.primaryLight,
    },
    findFriendsBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      marginHorizontal: Spacing.lg,
      marginBottom: Spacing.md,
      paddingVertical: Spacing.md,
      backgroundColor: Colors.primaryMuted,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: Colors.primary,
    },
    findFriendsBtnText: {
      fontSize: Typography.bodyMedium,
      ...Font.semibold,
      color: Colors.primary,
    },
    contactMatchSection: {
      marginHorizontal: Spacing.lg,
      marginBottom: Spacing.md,
    },
    contactMatchHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: Spacing.sm,
    },
    contactMatchTitle: {
      fontSize: Typography.labelLarge,
      ...Font.semibold,
      color: Colors.textSecondary,
    },
    contactMatchDismiss: {
      fontSize: Typography.labelMedium,
      color: Colors.textMuted,
    },
    inviteSearchInput: {
      height: 36,
      backgroundColor: Colors.backgroundSecondary,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      fontSize: Typography.bodySmall,
      color: Colors.text,
      marginBottom: Spacing.sm,
    },
    inviteScrollBox: {
      maxHeight: 240,
      borderRadius: Radius.lg,
    },
    inviteRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.md,
      gap: Spacing.sm,
    },
    inviteAvatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: Colors.backgroundTertiary,
      alignItems: "center",
      justifyContent: "center",
    },
    inviteAvatarText: {
      fontSize: Typography.labelMedium,
      ...Font.semibold,
      color: Colors.textSecondary,
    },
    inviteContactName: {
      flex: 1,
      fontSize: Typography.bodySmall,
      ...Font.medium,
      color: Colors.text,
    },
    inviteBtn: {
      paddingVertical: 4,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.full,
      backgroundColor: Colors.primaryMuted,
      borderWidth: 1,
      borderColor: Colors.primary,
    },
    inviteBtnText: {
      fontSize: Typography.labelSmall,
      ...Font.semibold,
      color: Colors.primary,
    },
  });

// ─── Segment control ──────────────────────────────────────────────────────────

const SegmentControl: React.FC<{
  selected: "following" | "partners";
  onChange: (tab: "following" | "partners") => void;
}> = ({ selected, onChange }) => {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  return (
    <View style={styles.segmentRow}>
      <Pressable
        style={[
          styles.segment,
          selected === "following" && styles.segmentActive,
        ]}
        onPress={() => onChange("following")}
      >
        <Text
          style={[
            styles.segmentLabel,
            selected === "following" && styles.segmentLabelActive,
          ]}
        >
          Following
        </Text>
      </Pressable>
      <Pressable
        style={[
          styles.segment,
          selected === "partners" && styles.segmentActive,
        ]}
        onPress={() => onChange("partners")}
      >
        <Text
          style={[
            styles.segmentLabel,
            selected === "partners" && styles.segmentLabelActive,
          ]}
        >
          Partners
        </Text>
      </Pressable>
    </View>
  );
};

// ─── Rep dot ──────────────────────────────────────────────────────────────────

const repColor = (level: string, Colors: ThemeColors): string => {
  switch (level) {
    case "oak":
      return Colors.accentGold;
    case "tree":
      return Colors.primaryLight;
    case "sapling":
      return Colors.success;
    case "sprout":
      return Colors.warning;
    default:
      return Colors.textMuted;
  }
};

// ─── Following row ────────────────────────────────────────────────────────────

const FollowingRow: React.FC<{
  profile: PublicProfile;
  onPress: () => void;
  onUnfollow: () => void;
  unfollowLoading: boolean;
}> = ({ profile, onPress, onUnfollow, unfollowLoading }) => {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.avatar}>
        <Text style={styles.avatarInitial}>
          {profile.name.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowName}>{profile.name}</Text>
        <View style={styles.repRow}>
          <View
            style={[
              styles.repDot,
              { backgroundColor: repColor(profile.reputation.level, Colors) },
            ]}
          />
          <Text style={styles.repScore}>{profile.reputation.score}</Text>
        </View>
      </View>
      <Pressable
        style={styles.unfollowBtn}
        onPress={onUnfollow}
        disabled={unfollowLoading}
      >
        {unfollowLoading ? (
          <ActivityIndicator size="small" color={Colors.textMuted} />
        ) : (
          <Text style={styles.unfollowBtnText}>Unfollow</Text>
        )}
      </Pressable>
    </Pressable>
  );
};

// ─── Partner row ──────────────────────────────────────────────────────────────

const PartnerRow: React.FC<{
  uid: string;
  name: string;
  tag?: string;
  reputationLevel: string;
  reputationScore: number;
  isFollowing: boolean;
  onPress: () => void;
  onToggleFollow: () => void;
  followLoading: boolean;
}> = ({
  name,
  tag,
  reputationLevel,
  reputationScore,
  isFollowing,
  onPress,
  onToggleFollow,
  followLoading,
}) => {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.avatar}>
        <Text style={styles.avatarInitial}>{name.charAt(0).toUpperCase()}</Text>
      </View>
      <View style={styles.rowInfo}>
        <View style={styles.nameRow}>
          <Text style={styles.rowName}>{name}</Text>
          {tag ? <Text style={styles.tagBadge}>{tag}</Text> : null}
        </View>
        <View style={styles.repRow}>
          <View
            style={[
              styles.repDot,
              { backgroundColor: repColor(reputationLevel, Colors) },
            ]}
          />
          <Text style={styles.repScore}>{reputationScore}</Text>
        </View>
      </View>
      <Pressable
        style={[styles.followBtn, isFollowing && styles.followingBtn]}
        onPress={onToggleFollow}
        disabled={followLoading}
      >
        {followLoading ? (
          <ActivityIndicator size="small" color={Colors.primaryLight} />
        ) : (
          <Text
            style={[
              styles.followBtnText,
              isFollowing && styles.followingBtnText,
            ]}
          >
            {isFollowing ? "Following" : "Follow"}
          </Text>
        )}
      </Pressable>
    </Pressable>
  );
};

// ─── Discriminated union for FlatList items ──────────────────────────────────

type FollowingItem = { type: "following"; uid: string; profile: PublicProfile };
type PartnerItem = { type: "partner"; partner: Partner };
type ListItem = FollowingItem | PartnerItem;

// ─── Main screen ──────────────────────────────────────────────────────────────

function FriendsScreenInner() {
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();
  const { tab: requestedTab } = useLocalSearchParams<{
    tab?: "following" | "partners";
  }>();
  const { user } = useAuthStore();
  const { partners } = usePartnerStore();
  const {
    following,
    profiles,
    isLoading,
    loadMyFollows,
    followUser,
    unfollowUser,
    loadProfile,
    isFollowing,
    contactMatches,
    lastContactSyncAt,
    setContactMatches,
    clearContactMatches,
    isContactSyncStale,
  } = useSocialStore();

  const [tab, setTab] = useState<"following" | "partners">(
    requestedTab === "partners" ? "partners" : "following",
  );
  const [loadingUids, setLoadingUids] = useState<Record<string, boolean>>({});
  const [isImporting, setIsImporting] = useState(false);
  const hasImported = lastContactSyncAt !== null;

  // Local contacts that are NOT on Niyah — shown with "Invite" button
  const [nonMatchedContacts, setNonMatchedContacts] = useState<
    { name: string; phone?: string; email?: string }[]
  >([]);
  const [inviteSearch, setInviteSearch] = useState("");

  // Persist invite contacts to AsyncStorage
  const CONTACTS_STORAGE_KEY = "@niyah/invite_contacts";

  useEffect(() => {
    AsyncStorage.getItem(CONTACTS_STORAGE_KEY).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setNonMatchedContacts(parsed);
          }
        } catch {
          // Corrupted storage — ignore
        }
      }
    });
  }, []);

  const myUid = user?.id ?? "";

  useEffect(() => {
    if (myUid) {
      loadMyFollows(myUid);
    }
  }, [myUid, loadMyFollows]);

  useEffect(() => {
    if (requestedTab === "following" || requestedTab === "partners") {
      setTab(requestedTab);
    }
  }, [requestedTab]);

  useEffect(() => {
    following.forEach((uid) => {
      if (!profiles[uid]) {
        loadProfile(uid).catch(() => {});
      }
    });
  }, [following, profiles, loadProfile]);

  const getFallbackProfile = (uid: string): PublicProfile | null => {
    const partner = partners.find((p) => p.oderId === uid);
    if (!partner) return null;

    return {
      uid,
      name: partner.name,
      reputation: {
        score: partner.reputation.score,
        level: partner.reputation.level,
        referralCount: 0,
      },
      currentStreak: 0,
      totalSessions: partner.totalSessionsTogether,
      completedSessions: partner.totalSessionsTogether,
    };
  };

  const handleUnfollow = async (targetUid: string) => {
    setLoadingUids((prev) => ({ ...prev, [targetUid]: true }));
    try {
      await unfollowUser(myUid, targetUid);
    } finally {
      setLoadingUids((prev) => ({ ...prev, [targetUid]: false }));
    }
  };

  const handleToggleFollow = async (targetUid: string) => {
    setLoadingUids((prev) => ({ ...prev, [targetUid]: true }));
    try {
      if (isFollowing(targetUid)) {
        await unfollowUser(myUid, targetUid);
      } else {
        await followUser(myUid, targetUid);
        setTab("following");
        // Best-effort profile hydration; fallback data still renders if missing.
        loadProfile(targetUid).catch(() => {});
      }
    } finally {
      setLoadingUids((prev) => ({ ...prev, [targetUid]: false }));
    }
  };

  // ── Import contacts ───────────────────────────────────────────────────────

  const handleImportContacts = useCallback(async () => {
    // Skip re-fetch if cache is fresh (< 5 min old) and we have results
    if (
      !isContactSyncStale() &&
      (contactMatches.length > 0 || nonMatchedContacts.length > 0)
    ) {
      return;
    }

    setIsImporting(true);
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Contacts Access Needed",
          "Allow Niyah to access contacts so you can find friends already on the app.",
          [{ text: "OK" }],
        );
        setIsImporting(false);
        return;
      }

      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
      });

      // Build a map of contact name → phone/email for later "Invite" display
      const contactMap: Record<
        string,
        { name: string; phone?: string; email?: string }
      > = {};

      // Extract phone numbers and emails
      const phones: string[] = [];
      const emails: string[] = [];
      for (const contact of data) {
        const name = [contact.firstName, contact.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (!name) continue;

        let primaryPhone: string | undefined;
        let primaryEmail: string | undefined;

        if (contact.phoneNumbers) {
          for (const pn of contact.phoneNumbers) {
            if (pn.number) {
              const digits = pn.number.replace(/[^\d+]/g, "");
              let normalized: string | null = null;
              if (digits.startsWith("+")) {
                normalized = digits;
              } else if (digits.length === 10) {
                normalized = `+1${digits}`;
              } else if (digits.length === 11 && digits.startsWith("1")) {
                normalized = `+${digits}`;
              }
              if (normalized) {
                phones.push(normalized);
                if (!primaryPhone) primaryPhone = normalized;
              }
            }
          }
        }
        if (contact.emails) {
          for (const em of contact.emails) {
            if (em.email) {
              const lower = em.email.toLowerCase();
              emails.push(lower);
              if (!primaryEmail) primaryEmail = lower;
            }
          }
        }

        if (primaryPhone || primaryEmail) {
          const key = primaryPhone || primaryEmail || name;
          contactMap[key] = { name, phone: primaryPhone, email: primaryEmail };
        }
      }

      if (phones.length === 0 && emails.length === 0) {
        Alert.alert(
          "No Contacts",
          "No phone numbers or emails found in your contacts.",
        );
        setIsImporting(false);
        return;
      }

      // Filter to contacts with real names (not just phone numbers/emails)
      // and who have a phone number (needed for SMS invite)
      const isRealName = (name: string) => {
        // Reject names that are just digits, emails, or phone-number-like
        if (/^[\d+\-() ]+$/.test(name)) return false;
        if (name.includes("@")) return false;
        if (name.length < 2) return false;
        // Must have at least one letter
        return /[a-zA-Z]/.test(name);
      };

      const allLocalContacts = Object.values(contactMap)
        .filter((c) => isRealName(c.name) && c.phone)
        .sort((a, b) => a.name.localeCompare(b.name));
      setNonMatchedContacts(allLocalContacts);
      AsyncStorage.setItem(
        CONTACTS_STORAGE_KEY,
        JSON.stringify(allLocalContacts),
      ).catch(() => {});

      // Now try to find which contacts are already on Niyah
      try {
        const result = await findContactsOnNiyah(phones, emails);

        // Filter out users we already follow
        const newMatches = result.matches.filter(
          (m) => !isFollowing(m.uid) && m.uid !== myUid,
        );

        setContactMatches(newMatches);

        // Remove matched users from the invite list
        if (newMatches.length > 0) {
          const matchedNames = new Set(
            result.matches.map((m) => m.name.toLowerCase()),
          );
          setNonMatchedContacts((prev) => {
            const filtered = prev.filter(
              (c) => !matchedNames.has(c.name.toLowerCase()),
            );
            AsyncStorage.setItem(
              CONTACTS_STORAGE_KEY,
              JSON.stringify(filtered),
            ).catch(() => {});
            return filtered;
          });
        }
      } catch (matchErr) {
        // Cloud function failed (rate limit, etc.) — that's fine,
        // we still show all contacts as invite-able
        logger.warn(
          "findContactsOnNiyah failed, showing all as invitable:",
          matchErr,
        );
      }
    } catch (err) {
      logger.error("Import contacts error:", err);
      Alert.alert("Error", "Could not import contacts. Please try again.");
    } finally {
      setIsImporting(false);
    }
  }, [
    isFollowing,
    isContactSyncStale,
    contactMatches.length,
    nonMatchedContacts.length,
    myUid,
    setContactMatches,
  ]);

  // ── Build list data based on active tab ──────────────────────────────────

  const listData: ListItem[] = useMemo(() => {
    if (tab === "following") {
      return following
        .map((uid): FollowingItem | null => {
          const profile = profiles[uid] ?? getFallbackProfile(uid);
          if (!profile) return null;
          return { type: "following", uid, profile };
        })
        .filter((item): item is FollowingItem => item !== null);
    }
    return partners.map(
      (partner): PartnerItem => ({ type: "partner", partner }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, following, profiles, partners]);

  const keyExtractor = useCallback((item: ListItem) => {
    return item.type === "following" ? item.uid : item.partner.id;
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.type === "following") {
        return (
          <FollowingRow
            profile={item.profile}
            onPress={() =>
              router.push(`/user/${item.uid}` as `/user/${string}`)
            }
            onUnfollow={() => handleUnfollow(item.uid)}
            unfollowLoading={!!loadingUids[item.uid]}
          />
        );
      }
      const { partner } = item;
      return (
        <PartnerRow
          uid={partner.oderId}
          name={partner.name}
          tag={partner.tag}
          reputationLevel={partner.reputation.level}
          reputationScore={partner.reputation.score}
          isFollowing={isFollowing(partner.oderId)}
          onPress={() =>
            router.push(`/user/${partner.oderId}` as `/user/${string}`)
          }
          onToggleFollow={() => handleToggleFollow(partner.oderId)}
          followLoading={!!loadingUids[partner.oderId]}
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadingUids, isFollowing, router],
  );

  const handleInviteContact = useCallback(
    (contact: { name: string; phone?: string }) => {
      if (!contact.phone) return;
      const body = encodeURIComponent(
        `Hey ${contact.name.split(" ")[0]}! Join me on Niyah — we stake real money on focus sessions and pocket the split when we win.\n\niOS (TestFlight beta): https://testflight.apple.com/join/YOUR_CODE\nWeb: https://niyah.live`,
      );
      // iOS sms: URL scheme opens iMessage with pre-filled body
      Linking.openURL(`sms:${contact.phone}&body=${body}`);
    },
    [],
  );

  const handleFollowMatch = useCallback(
    async (targetUid: string) => {
      setLoadingUids((prev) => ({ ...prev, [targetUid]: true }));
      try {
        await followUser(myUid, targetUid);
        // Remove from matches since they're now followed
        setContactMatches(contactMatches.filter((m) => m.uid !== targetUid));
        loadProfile(targetUid).catch(() => {});
      } finally {
        setLoadingUids((prev) => ({ ...prev, [targetUid]: false }));
      }
    },
    [myUid, followUser, loadProfile, contactMatches, setContactMatches],
  );

  const listHeader = useMemo(
    () => (
      <>
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <Text style={styles.title}>Friends</Text>
          <Pressable onPress={() => router.push("/invite")}>
            <Text style={styles.inviteLink}>Invite →</Text>
          </Pressable>
        </View>

        {/* ── Find Friends button ──────────────────────────────────────────── */}
        <Pressable
          style={styles.findFriendsBtn}
          onPress={handleImportContacts}
          disabled={isImporting}
        >
          {isImporting ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : null}
          <Text style={styles.findFriendsBtnText}>
            {isImporting
              ? "Searching contacts..."
              : hasImported
                ? "Refresh Contacts"
                : "Find Friends from Contacts"}
          </Text>
        </Pressable>

        {/* ── Contact matches ───────────────────────────────────────────────── */}
        {contactMatches.length > 0 && (
          <View style={styles.contactMatchSection}>
            <View style={styles.contactMatchHeader}>
              <Text style={styles.contactMatchTitle}>
                Friends on Niyah ({contactMatches.length})
              </Text>
              <Pressable onPress={clearContactMatches}>
                <Text style={styles.contactMatchDismiss}>Dismiss</Text>
              </Pressable>
            </View>
            {contactMatches.map((match) => (
              <View
                key={match.uid}
                style={[styles.row, { marginBottom: Spacing.sm }]}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarInitial}>
                    {match.name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.rowInfo}>
                  <Text style={styles.rowName}>{match.name}</Text>
                  <View style={styles.repRow}>
                    <View
                      style={[
                        styles.repDot,
                        {
                          backgroundColor: repColor(
                            match.reputation.level,
                            Colors,
                          ),
                        },
                      ]}
                    />
                    <Text style={styles.repScore}>
                      {match.reputation.score}
                    </Text>
                  </View>
                </View>
                <Pressable
                  style={styles.followBtn}
                  onPress={() => handleFollowMatch(match.uid)}
                  disabled={!!loadingUids[match.uid]}
                >
                  {loadingUids[match.uid] ? (
                    <ActivityIndicator size="small" color={Colors.white} />
                  ) : (
                    <Text style={styles.followBtnText}>Follow</Text>
                  )}
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* ── Invite contacts (not on Niyah) ──────────────────────────────── */}
        {nonMatchedContacts.length > 0 && (
          <View style={styles.contactMatchSection}>
            <View style={styles.contactMatchHeader}>
              <Text style={styles.contactMatchTitle}>
                Invite to Niyah ({nonMatchedContacts.length})
              </Text>
            </View>
            <TextInput
              style={styles.inviteSearchInput}
              placeholder="Search contacts..."
              placeholderTextColor={Colors.textMuted}
              value={inviteSearch}
              onChangeText={setInviteSearch}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
            <ScrollView
              style={styles.inviteScrollBox}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {nonMatchedContacts
                .filter((c) =>
                  inviteSearch
                    ? c.name.toLowerCase().includes(inviteSearch.toLowerCase())
                    : true,
                )
                .map((contact, index) => (
                  <View
                    key={`invite-${contact.phone || contact.email || index}`}
                    style={[styles.inviteRow, { marginBottom: Spacing.xs }]}
                  >
                    <View style={styles.inviteAvatar}>
                      <Text style={styles.inviteAvatarText}>
                        {contact.name.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.inviteContactName} numberOfLines={1}>
                      {contact.name}
                    </Text>
                    <Pressable
                      style={styles.inviteBtn}
                      onPress={() => handleInviteContact(contact)}
                    >
                      <Text style={styles.inviteBtnText}>Invite</Text>
                    </Pressable>
                  </View>
                ))}
            </ScrollView>
          </View>
        )}

        {/* ── Segment control ─────────────────────────────────────────────── */}
        <SegmentControl selected={tab} onChange={setTab} />
      </>
    ),
    [
      styles,
      tab,
      router,
      Colors,
      contactMatches,
      nonMatchedContacts,
      isImporting,
      hasImported,
      loadingUids,
      handleImportContacts,
      handleFollowMatch,
      handleInviteContact,
      inviteSearch,
      clearContactMatches,
    ],
  );

  const listEmpty = useMemo(
    () => (
      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>
          {tab === "following"
            ? "Follow your partners to stay connected"
            : "No partners yet. Invite friends to do sessions together."}
        </Text>
      </View>
    ),
    [styles, tab],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primaryLight} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <FlatList<ListItem>
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={listData}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />
    </SafeAreaView>
  );
}

const FriendsScreen = withErrorBoundary(FriendsScreenInner, "friends");
export default FriendsScreen;
