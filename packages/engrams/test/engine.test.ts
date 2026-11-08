import { describe, it, expect } from "vitest";
import {
  AchievementEngine,
  newAchievementRule,
  newInMemoryEntitlementStore,
} from "../src/index.js";

describe("AchievementEngine", () => {
  it("issues an entitlement for a verified event", () => {
    const engine = new AchievementEngine();
    engine.registerRule(
      newAchievementRule({
        id: "first-forge",
        version: 1,
        name: "The First Forge",
        qualifyingEvents: ["trial.settled"],
        requiredEvidence: ["runHash", "trialId"],
        tokenId: 1001,
        rarity: "common",
      }),
    );
    const result = engine.evaluate(
      {
        eventId: "ev-1",
        eventType: "trial.settled",
        trialId: "trial-1",
        runHash: "0xabc",
        timestamp: 1000,
        verified: true,
        argusVerdict: "paid",
      },
      "0xrecipient",
    );
    expect(result.issued).toHaveLength(1);
    expect(result.issued[0].tokenId).toBe(1001);
    expect(result.issued[0].recipient).toBe("0xrecipient");
  });

  it("skips unverified events", () => {
    const engine = new AchievementEngine();
    engine.registerRule(
      newAchievementRule({
        id: "first-forge",
        version: 1,
        name: "The First Forge",
        qualifyingEvents: ["trial.settled"],
        requiredEvidence: ["runHash"],
        tokenId: 1001,
      }),
    );
    const result = engine.evaluate(
      { eventId: "ev-2", eventType: "trial.settled", timestamp: 1000, verified: false },
      "0xrecipient",
    );
    expect(result.issued).toHaveLength(0);
    expect(result.skipped[0].reason).toBe("event not verified");
  });

  it("skips when evidence missing", () => {
    const engine = new AchievementEngine();
    engine.registerRule(
      newAchievementRule({
        id: "first-forge",
        version: 1,
        name: "The First Forge",
        qualifyingEvents: ["trial.settled"],
        requiredEvidence: ["runHash", "reportDigest"],
        tokenId: 1001,
      }),
    );
    const result = engine.evaluate(
      { eventId: "ev-3", eventType: "trial.settled", trialId: "t1", timestamp: 1000, verified: true },
      "0xrecipient",
    );
    expect(result.issued).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("missing evidence");
  });

  it("enforces issuance cap", () => {
    const engine = new AchievementEngine();
    engine.registerRule(
      newAchievementRule({
        id: "limited",
        version: 1,
        name: "Limited",
        qualifyingEvents: ["trial.settled"],
        requiredEvidence: ["runHash"],
        tokenId: 2001,
        issuanceCap: 1,
      }),
    );
    engine.evaluate(
      { eventId: "ev-a", eventType: "trial.settled", runHash: "0xa", timestamp: 1, verified: true },
      "0xr1",
    );
    const second = engine.evaluate(
      { eventId: "ev-b", eventType: "trial.settled", runHash: "0xb", timestamp: 2, verified: true },
      "0xr2",
    );
    expect(second.issued).toHaveLength(0);
    expect(second.skipped[0].reason).toBe("issuance cap reached");
  });

  it("dedups same recipient/rule/event", () => {
    const engine = new AchievementEngine();
    engine.registerRule(
      newAchievementRule({
        id: "first-forge",
        version: 1,
        name: "The First Forge",
        qualifyingEvents: ["trial.settled"],
        requiredEvidence: ["runHash"],
        tokenId: 1001,
      }),
    );
    const ev = { eventId: "ev-d", eventType: "trial.settled" as const, runHash: "0xd", timestamp: 5, verified: true };
    engine.evaluate(ev, "0xrecipient");
    const second = engine.evaluate(ev, "0xrecipient");
    expect(second.issued).toHaveLength(0);
    expect(second.skipped[0].reason).toBe("already issued");
  });

  it("lists entitlements for recipient", () => {
    const engine = new AchievementEngine();
    engine.registerRule(
      newAchievementRule({
        id: "first-forge",
        version: 1,
        name: "The First Forge",
        qualifyingEvents: ["trial.settled"],
        requiredEvidence: ["runHash"],
        tokenId: 1001,
      }),
    );
    engine.evaluate(
      { eventId: "ev-e", eventType: "trial.settled", runHash: "0xe", timestamp: 9, verified: true },
      "0xalice",
    );
    expect(engine.entitlementsFor("0xalice")).toHaveLength(1);
    expect(engine.entitlementsFor("0xbob")).toHaveLength(0);
  });

  it("rejects duplicate rule registration", () => {
    const engine = new AchievementEngine();
    const rule = newAchievementRule({ id: "r", version: 1, name: "R", qualifyingEvents: ["trial.settled"], requiredEvidence: [], tokenId: 1 });
    engine.registerRule(rule);
    expect(() => engine.registerRule(rule)).toThrow();
  });
});
