/**
 * Firebase App Check — attests that requests come from the genuine Niyah app
 * binary on a non-tampered device. Uses AppAttest on iOS 14+.
 *
 * Rollout state (May 2026):
 *   1. ✅ Ship client with this init (sends tokens on every Cloud Function call).
 *   2. ✅ Server logs token presence in soft-enforcement mode (no reject yet).
 *   3. 🚧 Money paths (`createPlaidLinkToken`, `linkBankAccount`,
 *      `requestWithdrawal`, `createGroupSession`) now hard-reject calls with
 *      no/invalid App Check token. Other endpoints stay soft-fail while
 *      token coverage finishes rolling out. Flip them next when Firebase
 *      Console → App Check metrics show 100% verified traffic.
 */

import appCheck from "@react-native-firebase/app-check";
import { logger } from "../utils/logger";

let initialized = false;
let initPromise: Promise<boolean> | null = null;

export async function ensureAppCheckInitialized(): Promise<boolean> {
  if (initialized) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (__DEV__) {
      // Skip in dev client — AppAttest requires real device + signed build.
      return false;
    }
    try {
      const instance = appCheck();
      const provider = instance.newReactNativeFirebaseAppCheckProvider();
      provider.configure({
        apple: {
          provider: "appAttest",
        },
        android: {
          provider: "playIntegrity",
        },
      });
      await instance.initializeAppCheck({
        provider,
        isTokenAutoRefreshEnabled: true,
      });
      initialized = true;
      logger.info("App Check initialized");
      return true;
    } catch (err) {
      // Soft-fail: if App Check can't init (no entitlement, pre-release build),
      // the app must still function. Server is in soft-enforcement mode during
      // rollout so missing tokens are logged but allowed.
      logger.warn("App Check init failed (continuing without):", err);
      return false;
    }
  })();

  return initPromise;
}

/**
 * Returns a short-lived App Check token for the current app instance, or null
 * if App Check is not initialized / not available on this device.
 */
export async function getAppCheckToken(): Promise<string | null> {
  try {
    const ready = await ensureAppCheckInitialized();
    if (!ready) return null;
    const result = await appCheck().getToken();
    return result?.token ?? null;
  } catch (err) {
    logger.warn("App Check token fetch failed:", err);
    return null;
  }
}
