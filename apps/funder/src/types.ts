/** Shared types for the funder service. */

export interface Allocation {
  wallet: string;
  amountEth: number;
}

export interface AllocateResponse {
  ok: boolean;
  wallet: string;
  requestedEth: string;
  grantedEth: string | null;
  transferId: string | null;
  reason: string | null;
  /**
   * How the risk reading sized this allocation. `available: false` means the identity service
   * could not be reached and the base factor was used — a different fact from a clean score.
   */
  risk?: {
    pUniqueHuman: number | null;
    factor: number;
    reason: string;
    available: boolean;
  };
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  network: string;
}
