import { capabilitiesFor, type ControlCapability } from "@stratifit/permissions";
import type { OperatorIdentity, OperatorRole } from "@stratifit/auth";
import {
  createDrizzleIdentityRepository,
  createIdentityResolution,
  createSupabaseSessionVerifier,
  type OperatorIdentityContext,
} from "@stratifit/identity";
import { createControlCookieClient, controlAuthEnv } from "@/lib/supabase-server";

/**
 * Control composition root for identity resolution (Decision 3).
 *
 * Server-side only: the operator session is read from the managed cookies,
 * verified by services/identity (Supabase Auth), and resolved against the
 * durable identity state. Pages/routes receive an explicit operator context
 * and enforce capabilities with the existing matrix — never client claims.
 */

export interface ControlOperatorContext extends OperatorIdentityContext {
  readonly identity: OperatorIdentity;
  readonly organizationId: string;
  readonly roles: readonly OperatorRole[];
  readonly capabilities: readonly ControlCapability[];
}

const buildIdentityService = () =>
  createIdentityResolution({
    sessionVerifier: createSupabaseSessionVerifier({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    }),
    repository: createDrizzleIdentityRepository({ databaseUrl: process.env.DATABASE_URL as string }),
  });

/** Resolve the current operator server-side; null when anonymous/unprovisioned. */
export const resolveControlOperator = async (): Promise<ControlOperatorContext | null> => {
  if (!controlAuthEnv().supabaseUrl || !process.env.DATABASE_URL) return null;
  const supabase = createControlCookieClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  const resolved = await buildIdentityService().resolveIdentity(session.access_token);
  if (!resolved || !("capabilities" in resolved)) return null;
  return resolved as ControlOperatorContext;
};

export { capabilitiesFor };
