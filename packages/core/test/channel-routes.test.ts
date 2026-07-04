import { describe, it, expect } from "vitest";
import { resolveRoute } from "../src/channel-routes.js";
import type { ChannelRoute } from "../src/channel-routes.js";
import { resolveWatch, watchDisabled, DEFAULT_REACTION_PALETTE } from "../src/channel-routes.js";

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

describe("resolveWatch", () => {
  it("returns null when the route has no watch block", () => {
    expect(resolveWatch({ deskmate: "devops" })).toBeNull();
  });
  it("fills defaults for a bare watch block", () => {
    const w = resolveWatch({ deskmate: "devops", watch: {} })!;
    expect(w).toMatchObject({ react: true, reply: true, post: false, approvePosts: false, picker: "routed" });
    expect(w.palette).toEqual(DEFAULT_REACTION_PALETTE);
  });
  it("honors explicit overrides", () => {
    const w = resolveWatch({ deskmate: "devops", watch: { post: true, picker: "frontdesk", reactionPalette: ["eyes"] } })!;
    expect(w.post).toBe(true);
    expect(w.picker).toBe("frontdesk");
    expect(w.palette).toEqual(["eyes"]);
  });
  it("reads cooldown + cap from env with sane defaults", () => {
    const prev = process.env.DESKMATE_REPLY_COOLDOWN_MIN;
    process.env.DESKMATE_REPLY_COOLDOWN_MIN = "30";
    expect(resolveWatch({ deskmate: "x", watch: {} })!.replyCooldownMin).toBe(30);
    if (prev === undefined) delete process.env.DESKMATE_REPLY_COOLDOWN_MIN; else process.env.DESKMATE_REPLY_COOLDOWN_MIN = prev;
  });
});

describe("watchDisabled", () => {
  it("is true only when DESKMATE_WATCH_DISABLED is set non-empty", () => {
    const prev = process.env.DESKMATE_WATCH_DISABLED;
    delete process.env.DESKMATE_WATCH_DISABLED; expect(watchDisabled()).toBe(false);
    process.env.DESKMATE_WATCH_DISABLED = "1"; expect(watchDisabled()).toBe(true);
    if (prev === undefined) delete process.env.DESKMATE_WATCH_DISABLED; else process.env.DESKMATE_WATCH_DISABLED = prev;
  });
});
