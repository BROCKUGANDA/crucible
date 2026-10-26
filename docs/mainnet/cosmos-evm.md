# Cosmos EVM target (candidate, not a deployment)  
  
Cosmos EVM is EVM-equivalent: the same Solidity, Foundry and wagmi stack deploys there with no contract changes. It is recorded as a candidate third EVM target behind the same fail-closed preflight: a Cosmos chain-id, RPC and funded deployer would be separate sign-off fields, and adding a target is an ADR decision, not a config flip, because the v1 escrow law (native ETH, 5 percent, pull settlement) is chain-specific. No Cosmos deployment exists today and none is claimed.  
