import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schemaExports from "./schema";
import { platformConfig } from "./schema";

describe("platform_config (foundational, domain-neutral)", () => {
  it("has exactly the approved columns", () => {
    const cols = Object.keys(getTableColumns(platformConfig)).sort();
    expect(cols).toEqual(["createdAt", "id", "key", "updatedAt", "value"]);
  });

  it("contains no domain tables yet (per approved plan)", () => {
    // Guard: the domain model must not leak in before DOMAIN_MODEL.md.
    const exported = Object.keys(schemaExports);
    const forbidden = [
      "productions",
      "scenes",
      "shots",
      "assets",
      "generations",
      "publications",
      "aiCreators",
      "conversations",
      "messages",
      "auditLogs",
    ];
    for (const name of forbidden) expect(exported).not.toContain(name);
  });
});
