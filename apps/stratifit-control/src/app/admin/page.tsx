import { resolveControlOperator } from "@/lib/identity";

/**
 * Administration — server-rendered proof of the Control identity chain:
 * browser -> Control BFF -> services/identity -> durable identity state.
 * The resolved operator context (org, roles, capabilities) comes entirely
 * from server-side resolution; nothing here trusts client claims.
 */
export default async function AdminPage() {
  const operator = await resolveControlOperator();

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-bold">Administration</h1>
      <p className="mt-2 text-gray-400">
        Operator roles, capabilities, and audit access. Authorization is enforced
        server-side; the browser never receives infrastructure credentials.
      </p>
      {operator ? (
        <div className="mt-6 space-y-4">
          <div className="rounded-lg border border-gray-700 p-6">
            <p className="text-sm text-gray-400">Resolved operator (server-side)</p>
            <p className="mt-1 font-medium">{operator.identity.email}</p>
            <p className="mt-1 text-sm text-gray-400">
              org: {operator.organizationId} · roles: {operator.roles.join(", ")}
            </p>
          </div>
          <div className="rounded-lg border border-gray-700 p-6">
            <p className="text-sm text-gray-400">Capabilities (capability matrix)</p>
            <ul className="mt-2 grid grid-cols-2 gap-1 text-sm">
              {operator.capabilities.map((cap) => (
                <li key={cap} className="text-gray-200">
                  {cap}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="mt-6 rounded-lg border border-dashed border-gray-700 p-8 text-center text-gray-500">
          No operator identity resolved for this session. Accounts are provisioned
          via the approved runbook; sign-in alone grants nothing.
        </div>
      )}
    </main>
  );
}
