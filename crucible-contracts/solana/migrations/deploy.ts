// Anchor migration entry — no migration to run in v1 (the program is
// immutable-by-deploy; upgrades go through the multisig runbook, gate 720).
// $Last variable is required by anchor's migration runner signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
module.exports = async function (_provider: any, _program: any): Promise<void> {
  // intentional no-op
};
