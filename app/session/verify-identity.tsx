/**
 * Native KYC intake — collects DOB + legal name + home address in-app so the
 * Stripe Express hosted form only needs to ask for SSN + phone verification.
 * DOB + address are never written to Firestore; Stripe is the sole source of
 * truth for those sensitive fields. Only legal names are cached locally for
 * idempotent retry.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import {
  Typography,
  Spacing,
  Radius,
  Font,
  type ThemeColors,
} from "../../src/constants/colors";
import { useColors } from "../../src/hooks/useColors";
import { useScreenProtection } from "../../src/hooks/useScreenProtection";
import {
  Button,
  SessionScreenScaffold,
  withErrorBoundary,
} from "../../src/components";
import { useAuthStore } from "../../src/store/authStore";
import {
  createAccountLink,
  createConnectAccount,
  getConnectAccountStatus,
  type ConnectAccountKycPayload,
} from "../../src/config/functions";
import { logger } from "../../src/utils/logger";
import { logEvent } from "../../src/utils/analytics";
import { getFunctionErrorMessage } from "../../src/utils/errors";

// Format numeric DOB digits into MM/DD/YYYY for display.
function formatDobDisplay(digits: string): string {
  const d = digits.slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

function parseDobDigits(
  digits: string,
): { day: number; month: number; year: number } | null {
  if (digits.length !== 8) return null;
  const month = parseInt(digits.slice(0, 2), 10);
  const day = parseInt(digits.slice(2, 4), 10);
  const year = parseInt(digits.slice(4, 8), 10);
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 2100
  ) {
    return null;
  }
  return { day, month, year };
}

function isAtLeast18(dob: {
  day: number;
  month: number;
  year: number;
}): boolean {
  const today = new Date();
  const eighteen = new Date(
    today.getUTCFullYear() - 18,
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return new Date(Date.UTC(dob.year, dob.month - 1, dob.day)) <= eighteen;
}

function VerifyIdentityScreenInner() {
  useScreenProtection("verify-identity");
  const Colors = useColors();
  const styles = useMemo(() => makeStyles(Colors), [Colors]);
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  const [firstName, setFirstName] = useState(
    user?.legalFirstName ?? user?.firstName ?? "",
  );
  const [lastName, setLastName] = useState(
    user?.legalLastName ?? user?.lastName ?? "",
  );
  const [dobDigits, setDobDigits] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [zip, setZip] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleDob = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    setDobDigits(digits);
  };

  const handleZip = (raw: string) => {
    setZip(raw.replace(/\D/g, "").slice(0, 5));
  };

  const handleState = (raw: string) => {
    setStateCode(
      raw
        .replace(/[^A-Za-z]/g, "")
        .slice(0, 2)
        .toUpperCase(),
    );
  };

  const validate = (): ConnectAccountKycPayload | null => {
    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    if (trimmedFirst.length < 1 || trimmedLast.length < 1) {
      setError("Legal first and last name are required.");
      return null;
    }
    const dob = parseDobDigits(dobDigits);
    if (!dob) {
      setError("Enter your date of birth as MM/DD/YYYY.");
      return null;
    }
    if (!isAtLeast18(dob)) {
      setError("You must be at least 18 to enable payouts.");
      return null;
    }
    const trimmedLine1 = line1.trim();
    if (trimmedLine1.length < 3) {
      setError("Enter your street address.");
      return null;
    }
    const trimmedCity = city.trim();
    if (trimmedCity.length < 2) {
      setError("Enter your city.");
      return null;
    }
    if (!/^[A-Z]{2}$/.test(stateCode)) {
      setError("Enter your state as a 2-letter code (e.g. TN).");
      return null;
    }
    if (!/^\d{5}$/.test(zip)) {
      setError("ZIP code must be 5 digits.");
      return null;
    }
    setError(null);
    const trimmedLine2 = line2.trim();
    return {
      legalFirstName: trimmedFirst,
      legalLastName: trimmedLast,
      dob,
      address: {
        line1: trimmedLine1,
        ...(trimmedLine2 ? { line2: trimmedLine2 } : {}),
        city: trimmedCity,
        state: stateCode,
        postalCode: zip,
      },
    };
  };

  const handleContinue = async () => {
    const payload = validate();
    if (!payload) return;

    setIsLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    logEvent("kyc_intake_submitted");

    try {
      const { accountId } = await createConnectAccount(payload);
      updateUser({
        stripeAccountId: accountId,
        stripeAccountStatus: "pending",
        legalFirstName: payload.legalFirstName,
        legalLastName: payload.legalLastName,
        stripeKycProvidedAt: new Date(),
      });
      logEvent("kyc_connect_account_created");

      const { url } = await createAccountLink();
      await WebBrowser.openBrowserAsync(url, {
        dismissButtonStyle: "close",
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });

      // Browser sheet closed — re-check status and propagate to auth store.
      try {
        const status = await getConnectAccountStatus();
        if (isMountedRef.current) {
          updateUser({
            stripeAccountStatus:
              status.status === "none" ? undefined : status.status,
            ...(status.bankName && status.bankMask
              ? {
                  linkedBank: {
                    institutionName: status.bankName,
                    bankName: status.bankName,
                    mask: status.bankMask,
                  },
                }
              : {}),
          });
        }
      } catch (statusErr) {
        logger.warn("getConnectAccountStatus after KYC failed:", statusErr);
      }

      if (isMountedRef.current) router.back();
    } catch (err) {
      logger.error("verify-identity submit failed:", err);
      const msg = getFunctionErrorMessage(
        err,
        "We couldn't start payout setup. Please try again.",
      );
      setError(msg);
      Alert.alert("Verification Error", msg);
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  };

  return (
    <SessionScreenScaffold
      headerVariant="centered"
      headerTitle="Verify Identity"
      scrollable={false}
    >
      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bottomOffset={20}
      >
        <Text style={styles.subtitle}>
          We need a few details to enable payouts. Stripe handles SSN + phone
          verification in the next step.
        </Text>

        <View style={styles.section}>
          <Text style={styles.label}>Legal First Name</Text>
          <TextInput
            style={styles.input}
            value={firstName}
            onChangeText={setFirstName}
            placeholder="First name on government ID"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="words"
            autoComplete="given-name"
            textContentType="givenName"
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Legal Last Name</Text>
          <TextInput
            style={styles.input}
            value={lastName}
            onChangeText={setLastName}
            placeholder="Last name on government ID"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="words"
            autoComplete="family-name"
            textContentType="familyName"
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Date of Birth</Text>
          <TextInput
            style={styles.input}
            value={formatDobDisplay(dobDigits)}
            onChangeText={handleDob}
            placeholder="MM/DD/YYYY"
            placeholderTextColor={Colors.textMuted}
            keyboardType="number-pad"
            maxLength={10}
          />
          <Text style={styles.hint}>Must be 18 or older</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Street Address</Text>
          <TextInput
            style={styles.input}
            value={line1}
            onChangeText={setLine1}
            placeholder="123 Main Street"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="words"
            autoComplete="address-line1"
            textContentType="streetAddressLine1"
          />
        </View>

        <View style={styles.section}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Apt / Unit</Text>
            <Text style={styles.optional}>Optional</Text>
          </View>
          <TextInput
            style={styles.input}
            value={line2}
            onChangeText={setLine2}
            placeholder="Apt 4B"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="words"
            autoComplete="address-line2"
            textContentType="streetAddressLine2"
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>City</Text>
          <TextInput
            style={styles.input}
            value={city}
            onChangeText={setCity}
            placeholder="Nashville"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="words"
            autoComplete="address-line1"
            textContentType="addressCity"
          />
        </View>

        <View style={styles.row}>
          <View style={[styles.section, styles.stateCol]}>
            <Text style={styles.label}>State</Text>
            <TextInput
              style={[styles.input, styles.stateInput]}
              value={stateCode}
              onChangeText={handleState}
              placeholder="TN"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={2}
              textContentType="addressState"
            />
          </View>
          <View style={[styles.section, styles.zipCol]}>
            <Text style={styles.label}>ZIP Code</Text>
            <TextInput
              style={styles.input}
              value={zip}
              onChangeText={handleZip}
              placeholder="37203"
              placeholderTextColor={Colors.textMuted}
              keyboardType="number-pad"
              maxLength={5}
              textContentType="postalCode"
            />
          </View>
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.disclosure}>
          <Text style={styles.disclosureText}>
            Your information is sent directly to Stripe, our payment processor.
            Niyah does not store your date of birth, SSN, or physical address.
            US bank accounts only.
          </Text>
        </View>

        <View style={styles.footer}>
          <Button
            title={isLoading ? "Verifying..." : "Continue"}
            onPress={handleContinue}
            disabled={isLoading}
            loading={isLoading}
            size="large"
          />
          <Pressable
            onPress={() => router.back()}
            style={styles.cancelButton}
            disabled={isLoading}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </KeyboardAwareScrollView>
    </SessionScreenScaffold>
  );
}

const VerifyIdentityScreen = withErrorBoundary(
  VerifyIdentityScreenInner,
  "verify-identity",
);
export default VerifyIdentityScreen;

const makeStyles = (Colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    scroll: {
      paddingVertical: Spacing.md,
      gap: Spacing.md,
    },
    subtitle: {
      fontSize: Typography.bodyMedium,
      color: Colors.textSecondary,
      lineHeight: Typography.bodyMedium * 1.5,
      marginBottom: Spacing.sm,
    },
    section: {
      gap: Spacing.xs,
    },
    labelRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    label: {
      fontSize: Typography.labelLarge,
      ...Font.medium,
      color: Colors.text,
    },
    optional: {
      fontSize: Typography.labelSmall,
      color: Colors.textMuted,
    },
    input: {
      height: 52,
      backgroundColor: Colors.backgroundCard,
      borderRadius: Radius.lg,
      paddingHorizontal: Spacing.md,
      fontSize: 18,
      ...Font.medium,
      color: Colors.text,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    hint: {
      fontSize: Typography.labelSmall,
      color: Colors.textMuted,
      marginTop: Spacing.xs,
    },
    row: {
      flexDirection: "row",
      gap: Spacing.md,
    },
    stateCol: {
      flex: 1,
    },
    zipCol: {
      flex: 2,
    },
    stateInput: {
      letterSpacing: 2,
      textAlign: "center",
    },
    errorBox: {
      backgroundColor: "rgba(220, 38, 38, 0.1)",
      borderRadius: Radius.md,
      padding: Spacing.md,
      borderWidth: 1,
      borderColor: "rgba(220, 38, 38, 0.2)",
    },
    errorText: {
      color: Colors.danger,
      fontSize: Typography.bodySmall,
      textAlign: "center",
    },
    disclosure: {
      backgroundColor: Colors.backgroundSecondary,
      borderRadius: Radius.md,
      padding: Spacing.md,
    },
    disclosureText: {
      fontSize: Typography.labelSmall,
      color: Colors.textSecondary,
      lineHeight: Typography.labelSmall * 1.6,
    },
    footer: {
      paddingTop: Spacing.md,
      paddingBottom: Spacing.xl,
      gap: Spacing.sm,
    },
    cancelButton: {
      alignItems: "center",
      paddingVertical: Spacing.sm,
    },
    cancelText: {
      fontSize: Typography.bodyMedium,
      ...Font.medium,
      color: Colors.textSecondary,
    },
  });
