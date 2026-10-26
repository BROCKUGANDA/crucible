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
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  network: string;
}
