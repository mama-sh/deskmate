import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCatalogRoot } from "../src/catalog.js";

describe("resolveCatalogRoot", () => {
  it("returns a directory that contains roles/", () => {
    const root = resolveCatalogRoot();
    expect(existsSync(join(root, "roles"))).toBe(true);
  });

  it("locates a real role (roles/product_analyst/deskmate.json exists)", () => {
    const root = resolveCatalogRoot();
    expect(existsSync(join(root, "roles", "product_analyst", "deskmate.json"))).toBe(true);
  });
});
