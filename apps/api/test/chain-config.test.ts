import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveChainConfig,
  getChainConfig,
  isMainnet,
  isDeterministicRandomnessAllowed,
  assertVrfConfigured,
  resolvePilotLimits,
  getPilotLimits,
  isWithinPilotLimits,
  resetChainConfig,
} from "../src/chain-config.js";

describe("chain-config", () => {
  beforeEach(() => {
    resetChainConfig();
  });

  describe("resolveChainConfig", () => {
    it("defaults to anvil when CHAIN_ENV is unset", () => {
      const config = resolveChainConfig({});
      expect(config.chainEnv).toBe("anvil");
      expect(config.chainId).toBe(31337);
    });

    it("accepts anvil explicitly", () => {
      const config = resolveChainConfig({ CHAIN_ENV: "anvil" });
      expect(config.chainEnv).toBe("anvil");
    });

    it("rejects invalid CHAIN_ENV", () => {
      expect(() => resolveChainConfig({ CHAIN_ENV: "invalid" })).toThrow(
        "Invalid CHAIN_ENV",
      );
    });

    it("requires MAINNET_RPC_URL for mainnet", () => {
      expect(() =>
        resolveChainConfig({
          CHAIN_ENV: "mainnet",
          CHAIN_ID: "1",
        }),
      ).toThrow("MAINNET_RPC_URL is required");
    });

    it("requires VRF config for mainnet", () => {
      expect(() =>
        resolveChainConfig({
          CHAIN_ENV: "mainnet",
          CHAIN_ID: "1",
          MAINNET_RPC_URL: "https://eth.rpc",
        }),
      ).toThrow("VRF configuration required");
    });

    it("resolves mainnet config with all required fields", () => {
      const config = resolveChainConfig({
        CHAIN_ENV: "mainnet",
        CHAIN_ID: "1",
        MAINNET_RPC_URL: "https://eth.rpc",
        MAINNET_RPC_FALLBACK_URL: "https://eth.rpc.fallback",
        VRF_COORDINATOR_ADDRESS: "0xvrf",
        VRF_KEY_HASH: "0xkey",
        VRF_SUBSCRIPTION_ID: "123",
      });

      expect(config.chainEnv).toBe("mainnet");
      expect(config.chainId).toBe(1);
      expect(config.vrfConfig).toBeDefined();
      expect(config.vrfConfig?.coordinatorAddress).toBe("0xvrf");
    });

    it("stores resolved config", () => {
      resolveChainConfig({ CHAIN_ENV: "anvil" });
      expect(getChainConfig()).not.toBeNull();
    });
  });

  describe("isMainnet", () => {
    it("returns false for anvil", () => {
      resolveChainConfig({ CHAIN_ENV: "anvil" });
      expect(isMainnet()).toBe(false);
    });

    it("returns true for mainnet", () => {
      resolveChainConfig({
        CHAIN_ENV: "mainnet",
        CHAIN_ID: "1",
        MAINNET_RPC_URL: "https://eth.rpc",
        VRF_COORDINATOR_ADDRESS: "0xvrf",
        VRF_KEY_HASH: "0xkey",
      });
      expect(isMainnet()).toBe(true);
    });
  });

  describe("isDeterministicRandomnessAllowed", () => {
    it("allows deterministic randomness on anvil", () => {
      resolveChainConfig({ CHAIN_ENV: "anvil" });
      expect(isDeterministicRandomnessAllowed()).toBe(true);
    });

    it("blocks deterministic randomness on mainnet", () => {
      resolveChainConfig({
        CHAIN_ENV: "mainnet",
        CHAIN_ID: "1",
        MAINNET_RPC_URL: "https://eth.rpc",
        VRF_COORDINATOR_ADDRESS: "0xvrf",
        VRF_KEY_HASH: "0xkey",
      });
      expect(isDeterministicRandomnessAllowed()).toBe(false);
    });
  });

  describe("assertVrfConfigured", () => {
    it("passes when VRF is configured", () => {
      resolveChainConfig({
        CHAIN_ENV: "mainnet",
        CHAIN_ID: "1",
        MAINNET_RPC_URL: "https://eth.rpc",
        VRF_COORDINATOR_ADDRESS: "0xvrf",
        VRF_KEY_HASH: "0xkey",
      });
      expect(() => assertVrfConfigured()).not.toThrow();
    });

    it("throws when config not resolved", () => {
      expect(() => assertVrfConfigured()).toThrow("not resolved");
    });
  });

  describe("pilot limits", () => {
    it("resolves pilot limits from env", () => {
      const limits = resolvePilotLimits({
        PILOT_MAX_ACTIVE_TRIALS: "10",
        PILOT_MAX_FUNDING: "0.5",
      });

      expect(limits.maxActiveTrials).toBe(10);
      expect(getPilotLimits().maxActiveTrials).toBe(10);
    });

    it("checks funding limits", () => {
      resolvePilotLimits({
        PILOT_MAX_FUNDING: "0.1",
      });

      const within = isWithinPilotLimits(
        BigInt("100000000000000000"), // 0.1 ether
        "fundingPerTrial",
      );
      expect(within).toBe(true);

      const exceeded = isWithinPilotLimits(
        BigInt("200000000000000000"), // 0.2 ether
        "fundingPerTrial",
      );
      expect(exceeded).toBe(false);
    });

    it("returns true for unknown limit type", () => {
      expect(isWithinPilotLimits(BigInt("999"), "unknown")).toBe(true);
    });
  });
});
