/**
 * Account-linking client wrapper tests.
 *
 * The wrapper exists for one reason: ensure the client NEVER runs raw
 * Firestore queries against the users collection to detect a duplicate
 * account. That was the original enumeration vulnerability — anyone could
 * `users.where("phone","==","+1victim").get()` and learn who had signed
 * up. All detection now flows through the `requestAccountMerge` Cloud
 * Function, which uses admin-only auth lookups.
 *
 * Two contracts are pinned here:
 *   1. `checkForAccountMerge` calls the CF wrapper and returns its result.
 *   2. Errors from the CF do not bubble — they must not block sign-in.
 *
 * Plus a blackbox sanity check that the module does not import Firestore.
 */

import fs from "fs";
import path from "path";

jest.mock("../../../config/functions", () => ({
  requestAccountMerge: jest.fn(),
}));

// `accountLinking.ts` also imports from `@react-native-firebase/auth` for
// `linkProviderToCurrentUser`. We don't exercise that path here; mocking
// keeps Jest from booting the native module.
jest.mock("@react-native-firebase/auth", () => ({
  getAuth: jest.fn(),
  GoogleAuthProvider: { credential: jest.fn() },
  AppleAuthProvider: { credential: jest.fn() },
  linkWithCredential: jest.fn(),
}));

// Logger goes through console.warn in __DEV__, which Jest treats as a
// failure. Mute it for the CF-error paths.
jest.mock("../../../utils/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { checkForAccountMerge } from "../../../utils/accountLinking";
import {
  requestAccountMerge,
  type AccountMergeResponse,
} from "../../../config/functions";

const requestAccountMergeMock = requestAccountMerge as jest.MockedFunction<
  typeof requestAccountMerge
>;

describe("checkForAccountMerge", () => {
  beforeEach(() => {
    requestAccountMergeMock.mockReset();
  });

  it("delegates to the requestAccountMerge Cloud Function", async () => {
    requestAccountMergeMock.mockResolvedValue({ status: "no_match" });
    const result = await checkForAccountMerge();
    expect(requestAccountMergeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "no_match" });
  });

  it("passes through a duplicate-role merge response unchanged", async () => {
    const merge: AccountMergeResponse = {
      status: "merge",
      role: "duplicate",
      canonicalUid: "older-uid",
      matchedField: "phone",
    };
    requestAccountMergeMock.mockResolvedValue(merge);
    expect(await checkForAccountMerge()).toBe(merge);
  });

  it("returns null when the CF rejects so sign-in is never blocked", async () => {
    requestAccountMergeMock.mockRejectedValue(new Error("network down"));
    const result = await checkForAccountMerge();
    expect(result).toBeNull();
  });

  it("returns null when the CF throws a synchronous error", async () => {
    requestAccountMergeMock.mockImplementation(() => {
      throw new Error("sync throw");
    });
    const result = await checkForAccountMerge();
    expect(result).toBeNull();
  });
});

// ─── Blackbox: module must not depend on Firestore client ────────────────────

describe("accountLinking module: source contract", () => {
  it("does not import firestore (enumeration was the original CVE)", () => {
    const filePath = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "utils",
      "accountLinking.ts",
    );
    const source = fs.readFileSync(filePath, "utf8");
    // Firebase JS query primitives that would re-enable enumeration.
    expect(source).not.toMatch(/@react-native-firebase\/firestore/);
    expect(source).not.toMatch(/\bgetFirestore\b/);
    expect(source).not.toMatch(/\bcollection\(.*users.*\)/);
    expect(source).not.toMatch(/\bwhere\(/);
  });
});
