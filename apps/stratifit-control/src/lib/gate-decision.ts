/**
 * Pure gate-decision logic for the Control middleware auth gate (unit-tested;
 * the middleware only executes the decision).
 *
 * Routing decision ONLY — real authorization is enforced server-side in
 * routes/services via the capability matrix (API_ARCHITECTURE section 7).
 */

export type GateDecision =
  | { action: "next" }
  | { action: "redirect"; location: string }
  | { action: "fail-closed"; status: 503 };

export interface GateEnv {
  readonly supabaseUrl: string | undefined;
  readonly supabaseAnonKey: string | undefined;
}

export interface GateSession {
  /** Supabase Auth user id when a valid session was presented; null otherwise. */
  readonly userId: string | null;
}

export const gateDecision = (session: GateSession, env: GateEnv): GateDecision => {
  // Fail closed when the credential issuer is not configured (OQ-3).
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    return { action: "fail-closed", status: 503 };
  }
  if (!session.userId) {
    return { action: "redirect", location: "/login" };
  }
  return { action: "next" };
};
