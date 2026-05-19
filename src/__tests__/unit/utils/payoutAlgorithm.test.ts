import {
  calculatePayouts,
  calculateTransfers,
  optimisticGroupPayouts,
  type ParticipantResult,
  type ParticipantPayout,
} from "../../../utils/payoutAlgorithm";
import type {
  GroupSessionDoc,
  GroupSessionParticipant,
  SessionParticipant,
  UserReputation,
} from "../../../types";

const makeParticipant = (
  userId: string,
  name: string,
  stakeAmount: number,
): Pick<SessionParticipant, "userId" | "name" | "stakeAmount"> => ({
  userId,
  name,
  stakeAmount,
});

// ─── calculatePayouts ────────────────────────────────────────────────────────

describe("calculatePayouts", () => {
  it("completer wins opponent's stake (2-person: 1 complete, 1 surrender)", () => {
    const results: ParticipantResult[] = [
      { userId: "a", completed: true },
      { userId: "b", completed: false },
    ];
    const payouts = calculatePayouts(500, results);

    expect(payouts).toHaveLength(2);
    // Pool = 2 × 500 = 1000; only A completed → A gets all 1000, B gets 0
    expect(payouts.find((p) => p.userId === "a")?.payout).toBe(1000);
    expect(payouts.find((p) => p.userId === "b")?.payout).toBe(0);
  });

  it("solo complete returns stake × SOLO_COMPLETION_MULTIPLIER (2×)", () => {
    const payouts = calculatePayouts(1000, [{ userId: "a", completed: true }]);
    expect(payouts).toHaveLength(1);
    // SOLO_COMPLETION_MULTIPLIER = 2, so 1000 × 2 = 2000
    expect(payouts[0].payout).toBe(2000);
  });

  it("two of three complete: completers split full pool, surrenderer gets 0", () => {
    const results: ParticipantResult[] = [
      { userId: "a", completed: true },
      { userId: "b", completed: true },
      { userId: "c", completed: false },
    ];
    const payouts = calculatePayouts(2500, results);
    expect(payouts).toHaveLength(3);
    // Pool = 3 × 2500 = 7500; 2 completers → floor(7500/2) = 3750 each
    expect(payouts.find((p) => p.userId === "a")?.payout).toBe(3750);
    expect(payouts.find((p) => p.userId === "b")?.payout).toBe(3750);
    expect(payouts.find((p) => p.userId === "c")?.payout).toBe(0);
  });

  it("completed flag determines payout: surrenderers get 0, completers split pool", () => {
    const stake = 500;
    const allFail = calculatePayouts(stake, [
      { userId: "a", completed: false },
      { userId: "b", completed: false },
    ]);
    const allWin = calculatePayouts(stake, [
      { userId: "a", completed: true },
      { userId: "b", completed: true },
    ]);
    // All fail → everyone gets 0 (Niyah keeps pool)
    expect(allFail.map((p) => p.payout)).toEqual([0, 0]);
    // All win → pool split evenly = stake each (net 0)
    expect(allWin.map((p) => p.payout)).toEqual([500, 500]);
  });

  it("preserves userId in output", () => {
    const results: ParticipantResult[] = [
      { userId: "user-abc", completed: true },
      { userId: "user-xyz", completed: false },
    ];
    const payouts = calculatePayouts(500, results);
    expect(payouts.map((p) => p.userId)).toContain("user-abc");
    expect(payouts.map((p) => p.userId)).toContain("user-xyz");
  });

  it("solo surrender returns 0 payout", () => {
    const payouts = calculatePayouts(1000, [{ userId: "a", completed: false }]);
    expect(payouts).toHaveLength(1);
    expect(payouts[0].payout).toBe(0);
  });

  it("returns empty array for empty results", () => {
    expect(calculatePayouts(500, [])).toEqual([]);
  });
});

// ─── calculateTransfers ──────────────────────────────────────────────────────

describe("calculateTransfers", () => {
  it("returns empty array when all nets are zero (even-split case)", () => {
    const participants = [
      makeParticipant("a", "Alice", 500),
      makeParticipant("b", "Bob", 500),
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 500 },
      { userId: "b", payout: 500 },
    ];
    expect(calculateTransfers(participants, payouts)).toEqual([]);
  });

  it("single debtor pays single creditor", () => {
    // A wins (payout=1000), B loses (payout=0). Stake=500 each.
    const participants = [
      makeParticipant("a", "Alice", 500),
      makeParticipant("b", "Bob", 500),
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 1000 }, // net +500
      { userId: "b", payout: 0 }, // net -500
    ];
    const transfers = calculateTransfers(participants, payouts);

    expect(transfers).toHaveLength(1);
    expect(transfers[0].fromUserId).toBe("b");
    expect(transfers[0].toUserId).toBe("a");
    expect(transfers[0].amount).toBe(500);
  });

  it("includes correct user names in transfers", () => {
    const participants = [
      makeParticipant("a", "Alice", 500),
      makeParticipant("b", "Bob", 500),
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 1000 },
      { userId: "b", payout: 0 },
    ];
    const transfers = calculateTransfers(participants, payouts);

    expect(transfers[0].fromUserName).toBe("Bob");
    expect(transfers[0].toUserName).toBe("Alice");
  });

  it("single debtor pays two creditors, largest creditor served first", () => {
    // A: +500, B: +500, C: -1000
    const participants = [
      makeParticipant("a", "Alice", 1000),
      makeParticipant("b", "Bob", 1000),
      makeParticipant("c", "Charlie", 1000),
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 1500 }, // net +500
      { userId: "b", payout: 1500 }, // net +500
      { userId: "c", payout: 0 }, // net -1000
    ];
    const transfers = calculateTransfers(participants, payouts);

    expect(transfers).toHaveLength(2);
    expect(transfers.every((t) => t.fromUserId === "c")).toBe(true);
    const totalPaid = transfers.reduce((sum, t) => sum + t.amount, 0);
    expect(totalPaid).toBe(1000);
  });

  it("two debtors each pay one creditor", () => {
    // A wins all, B and C each lose their stake
    const participants = [
      makeParticipant("a", "Alice", 1000),
      makeParticipant("b", "Bob", 1000),
      makeParticipant("c", "Charlie", 1000),
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 3000 }, // net +2000
      { userId: "b", payout: 0 }, // net -1000
      { userId: "c", payout: 0 }, // net -1000
    ];
    const transfers = calculateTransfers(participants, payouts);

    expect(transfers).toHaveLength(2);
    expect(transfers.every((t) => t.toUserId === "a")).toBe(true);
    const totalPaid = transfers.reduce((sum, t) => sum + t.amount, 0);
    expect(totalPaid).toBe(2000);
  });

  it("four-person: A+1500, B+500, C-1000, D-1000 — amounts balance", () => {
    const stake = 1000;
    const participants = [
      makeParticipant("a", "Alice", stake),
      makeParticipant("b", "Bob", stake),
      makeParticipant("c", "Charlie", stake),
      makeParticipant("d", "Dave", stake),
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 2500 }, // net +1500
      { userId: "b", payout: 1500 }, // net +500
      { userId: "c", payout: 0 }, // net -1000
      { userId: "d", payout: 0 }, // net -1000
    ];
    const transfers = calculateTransfers(participants, payouts);

    const totalPaid = transfers.reduce((sum, t) => sum + t.amount, 0);
    expect(totalPaid).toBe(2000); // C and D each owe 1000
  });

  it("no self-transfers (fromUserId !== toUserId)", () => {
    const stake = 500;
    const participants = [
      makeParticipant("a", "Alice", stake),
      makeParticipant("b", "Bob", stake),
      makeParticipant("c", "Charlie", stake),
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 1000 }, // net +500
      { userId: "b", payout: 500 }, // net 0
      { userId: "c", payout: 0 }, // net -500
    ];
    const transfers = calculateTransfers(participants, payouts);

    transfers.forEach((t) => expect(t.fromUserId).not.toBe(t.toUserId));
  });

  it("single participant produces no transfers", () => {
    const participants = [makeParticipant("a", "Alice", 500)];
    const payouts: ParticipantPayout[] = [{ userId: "a", payout: 500 }];
    expect(calculateTransfers(participants, payouts)).toEqual([]);
  });

  it("all amounts are positive", () => {
    const participants = [
      makeParticipant("a", "Alice", 500),
      makeParticipant("b", "Bob", 500),
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 1000 },
      { userId: "b", payout: 0 },
    ];
    const transfers = calculateTransfers(participants, payouts);
    transfers.forEach((t) => expect(t.amount).toBeGreaterThan(0));
  });

  it("uses stake as payout fallback when userId missing from payouts", () => {
    const participants = [
      makeParticipant("a", "Alice", 500),
      makeParticipant("b", "Bob", 500),
    ];
    // Only A in payouts; B defaults to its stakeAmount (net 0)
    const payouts: ParticipantPayout[] = [{ userId: "a", payout: 1000 }];

    // Should not throw and should return an array
    const transfers = calculateTransfers(participants, payouts);
    expect(Array.isArray(transfers)).toBe(true);
  });

  it("skips exhausted creditor when multiple debtors drain it (creditor.remaining <= 0 branch)", () => {
    // Set up: 2 debtors and 1 creditor whose amount is less than the total debt
    // The first debtor exhausts the creditor, second debtor finds creditor.remaining <= 0
    const participants = [
      makeParticipant("a", "Alice", 1000), // creditor: net +500
      makeParticipant("b", "Bob", 1000), // debtor: net -300
      makeParticipant("c", "Charlie", 1000), // debtor: net -200
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 1500 }, // net +500
      { userId: "b", payout: 700 }, // net -300
      { userId: "c", payout: 800 }, // net -200
    ];
    const transfers = calculateTransfers(participants, payouts);

    // Both debtors should pay Alice
    const totalPaid = transfers.reduce((sum, t) => sum + t.amount, 0);
    expect(totalPaid).toBe(500);
    expect(transfers.every((t) => t.toUserId === "a")).toBe(true);
  });

  it("creditor exhausted by first debtor is skipped by second debtor", () => {
    // Creditors sorted largest-first: Bob (+200), Alice (+100)
    // First debtor Charlie (-200) pays Bob 200 (exhausts Bob), then Alice 0 remaining.
    // Second debtor Dave (-100) encounters Bob (remaining=0 -> continue), then pays Alice 100.
    // This triggers the `creditor.remaining <= 0` continue branch at line 108.
    const participants = [
      makeParticipant("a", "Alice", 1000), // net +100
      makeParticipant("b", "Bob", 1000), // net +200
      makeParticipant("c", "Charlie", 1000), // net -200
      makeParticipant("d", "Dave", 1000), // net -100
    ];
    const payouts: ParticipantPayout[] = [
      { userId: "a", payout: 1100 }, // net +100
      { userId: "b", payout: 1200 }, // net +200
      { userId: "c", payout: 800 }, // net -200
      { userId: "d", payout: 900 }, // net -100
    ];
    const transfers = calculateTransfers(participants, payouts);

    // Total transfers should balance: 200 + 100 = 300
    const totalPaid = transfers.reduce((sum, t) => sum + t.amount, 0);
    expect(totalPaid).toBe(300);

    // Bob (largest creditor, sorted first) gets exhausted by Charlie
    const bobReceived = transfers
      .filter((t) => t.toUserId === "b")
      .reduce((sum, t) => sum + t.amount, 0);
    expect(bobReceived).toBe(200);

    // Alice gets paid by Dave (after Dave skips exhausted Bob)
    const aliceReceived = transfers
      .filter((t) => t.toUserId === "a")
      .reduce((sum, t) => sum + t.amount, 0);
    expect(aliceReceived).toBe(100);
  });
});

// ─── optimisticGroupPayouts ──────────────────────────────────────────────────
//
// Drives the live "if you finish, you'd take home $X" preview on the active
// session leaderboard. The function is intentionally permissive about future
// completers — still-focused participants are projected as if they will
// complete. The server runs the authoritative `calculatePayouts` at settle
// time; these tests pin the optimistic-side math so the UI can't drift away
// from the eventual server result.

const DEFAULT_REP: UserReputation = {
  score: 50,
  level: "sapling",
  paymentsCompleted: 0,
  paymentsMissed: 0,
  totalOwedPaid: 0,
  totalOwedMissed: 0,
  lastUpdated: new Date(),
};

const participant = (
  override: Partial<GroupSessionParticipant> & { name: string },
): GroupSessionParticipant => ({
  accepted: true,
  online: true,
  reputation: DEFAULT_REP,
  ...override,
});

const session = (
  stakePerParticipant: number,
  participants: Record<string, GroupSessionParticipant>,
): Pick<GroupSessionDoc, "stakePerParticipant" | "participants"> => ({
  stakePerParticipant,
  participants,
});

describe("optimisticGroupPayouts", () => {
  it("solo focused → projects 2x stake payout", () => {
    const rows = optimisticGroupPayouts(
      session(2000, { me: participant({ name: "Me" }) }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "me",
      estimatedPayout: 4000,
      share: 1,
      status: "focused",
    });
  });

  it("solo completed → keeps 2x projection (already won)", () => {
    const rows = optimisticGroupPayouts(
      session(2000, { me: participant({ name: "Me", completed: true }) }),
    );
    expect(rows[0]).toMatchObject({
      estimatedPayout: 4000,
      status: "completed",
    });
  });

  it("solo surrendered → 0 payout, 0 share, surrendered status", () => {
    const rows = optimisticGroupPayouts(
      session(2000, { me: participant({ name: "Me", surrendered: true }) }),
    );
    expect(rows[0]).toMatchObject({
      estimatedPayout: 0,
      share: 0,
      status: "surrendered",
    });
  });

  it("group all focused → pool splits equally", () => {
    const rows = optimisticGroupPayouts(
      session(1000, {
        a: participant({ name: "A" }),
        b: participant({ name: "B" }),
        c: participant({ name: "C" }),
      }),
    );
    rows.forEach((r) => {
      expect(r.estimatedPayout).toBe(1000); // 3 * 1000 / 3
      expect(r.share).toBeCloseTo(1 / 3);
      expect(r.status).toBe("focused");
    });
  });

  it("group with one surrender → remaining members split pool, surrendered zeros out", () => {
    // Pool = 3 * 1000 = 3000. Surrendered participant excluded from completers
    // count → 2 remaining → 1500 each.
    const rows = optimisticGroupPayouts(
      session(1000, {
        a: participant({ name: "A" }),
        b: participant({ name: "B" }),
        c: participant({ name: "C", surrendered: true }),
      }),
    );
    const byUid = Object.fromEntries(rows.map((r) => [r.userId, r]));
    expect(byUid.a.estimatedPayout).toBe(1500);
    expect(byUid.b.estimatedPayout).toBe(1500);
    expect(byUid.c.estimatedPayout).toBe(0);
    expect(byUid.c.status).toBe("surrendered");
    expect(byUid.c.share).toBe(0);
  });

  it("group all surrendered → everyone zeroed (pool to Niyah)", () => {
    const rows = optimisticGroupPayouts(
      session(1000, {
        a: participant({ name: "A", surrendered: true }),
        b: participant({ name: "B", surrendered: true }),
      }),
    );
    rows.forEach((r) => {
      expect(r.estimatedPayout).toBe(0);
      expect(r.share).toBe(0);
      expect(r.status).toBe("surrendered");
    });
  });

  it("estimated payouts never exceed the total pool", () => {
    // Property test: regardless of who surrenders, sum of estimated payouts
    // ≤ pool. Catches off-by-one or floor() regressions.
    const stake = 1000;
    const scenarios: Array<Partial<GroupSessionParticipant>[]> = [
      [{}, {}, {}, {}],
      [{ surrendered: true }, {}, {}, {}],
      [{ surrendered: true }, { surrendered: true }, {}, {}],
      [{ completed: true }, {}, { surrendered: true }, {}],
    ];
    for (const scenario of scenarios) {
      const participants: Record<string, GroupSessionParticipant> = {};
      scenario.forEach((p, i) => {
        participants[`p${i}`] = participant({ name: `P${i}`, ...p });
      });
      const rows = optimisticGroupPayouts(session(stake, participants));
      const total = rows.reduce((acc, r) => acc + r.estimatedPayout, 0);
      const pool = stake * scenario.length;
      expect(total).toBeLessThanOrEqual(pool);
    }
  });

  it("regression: surrender flips a focused participant's projected payout up", () => {
    // The leaderboard nudge depends on this: when someone caves, survivors'
    // projected payout should strictly increase.
    const before = optimisticGroupPayouts(
      session(1000, {
        a: participant({ name: "A" }),
        b: participant({ name: "B" }),
        c: participant({ name: "C" }),
      }),
    ).find((r) => r.userId === "a")!.estimatedPayout;

    const after = optimisticGroupPayouts(
      session(1000, {
        a: participant({ name: "A" }),
        b: participant({ name: "B" }),
        c: participant({ name: "C", surrendered: true }),
      }),
    ).find((r) => r.userId === "a")!.estimatedPayout;

    expect(after).toBeGreaterThan(before);
  });

  it("matches server-side calculateGroupSessionPayouts on the all-completed case", () => {
    // Cross-validate against the (replicated) server math via calculatePayouts.
    // Both must produce the same per-completer payout — if they drift, the
    // UI promises something the server won't deliver.
    const stake = 1000;
    const ids = ["a", "b", "c", "d"];
    const optimistic = optimisticGroupPayouts(
      session(
        stake,
        Object.fromEntries(
          ids.map((id) => [id, participant({ name: id, completed: true })]),
        ),
      ),
    );
    const server = calculatePayouts(
      stake,
      ids.map((id) => ({ userId: id, completed: true })),
    );
    optimistic.forEach((r) => {
      const expected = server.find((s) => s.userId === r.userId)?.payout;
      expect(r.estimatedPayout).toBe(expected);
    });
  });
});
