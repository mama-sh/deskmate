import { describe, it, expect } from "vitest";
import { resolveRoute } from "../src/channel-routes.js";
import type { ChannelRoute } from "../src/channel-routes.js";

const routes = {
  incidents: { deskmate: "devops", lock: true },
  growth: { deskmate: "growth_hacker" },
  C0FIXEDID: { deskmate: "product_analyst" },
};

describe("resolveRoute", () => {
  it("resolves a locked channel by name", () => {
    expect(resolveRoute({ name: "incidents" }, routes)).toEqual({ deskmate: "devops", lock: true });
  });
  it("defaults lock to false", () => {
    expect(resolveRoute({ name: "growth" }, routes)).toEqual({ deskmate: "growth_hacker", lock: false });
  });
  it("resolves by channel id", () => {
    expect(resolveRoute({ id: "C0FIXEDID" }, routes)).toEqual({ deskmate: "product_analyst", lock: false });
  });
  it("returns null for an unmapped channel", () => {
    expect(resolveRoute({ name: "random", id: "Cxxx" }, routes)).toBeNull();
  });
});

describe("ChannelRoute.watch type", () => {
  it("accepts a route with a watch block", () => {
    const route: ChannelRoute = {
      deskmate: "devops",
      watch: { react: true, reply: true, post: false, picker: "routed" },
    };
    expect(route.watch?.picker).toBe("routed");
  });
});
