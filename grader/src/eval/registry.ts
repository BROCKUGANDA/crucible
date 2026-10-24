/** Gate 433 — GraderRegistry.
 *
 * Model swap is a protocol event: an RFC plus an explicit GraderRegistry version
 * bump. Never a silent config change. Every deployed graderVersion maps to exactly
 * one (modelId, promptVersion) pair, and changes are append-only.
 */
export interface GraderRegistration {
  graderVersion: number;
  modelId: string;
  promptVersion: string;
  /** RFC that authorized this registration. */
  rfc: string;
  /** Unix seconds when this version became active. */
  activatedAt: number;
}

export class GraderRegistry {
  private readonly registrations: GraderRegistration[] = [];

  /**
   * Register a new grader version. Requires an RFC identifier — a model swap
   * without an RFC is rejected.
   */
  register(graderVersion: number, modelId: string, promptVersion: string, rfc: string): void {
    if (!rfc) throw new Error("grader registration requires an RFC");
    if (this.registrations.some((r) => r.graderVersion === graderVersion)) {
      throw new Error(`grader version ${graderVersion} already registered`);
    }
    this.registrations.push({
      graderVersion,
      modelId,
      promptVersion,
      rfc,
      activatedAt: Date.now() / 1000,
    });
  }

  /** Look up the registration for a deployed graderVersion. */
  active(graderVersion: number): GraderRegistration | undefined {
    return this.registrations.find((r) => r.graderVersion === graderVersion);
  }

  /** The latest registered version. */
  latest(): GraderRegistration | undefined {
    if (this.registrations.length === 0) return undefined;
    return [...this.registrations].sort((a, b) => b.graderVersion - a.graderVersion)[0];
  }

  /** All registrations (append-only audit trail). */
  all(): readonly GraderRegistration[] {
    return this.registrations;
  }

  /** Bump from an existing version to a new one — the only supported model swap path. */
  bump(from: number, to: number, modelId: string, promptVersion: string, rfc: string): void {
    if (!this.active(from)) throw new Error(`no such grader version: ${from}`);
    this.register(to, modelId, promptVersion, rfc);
  }
}
