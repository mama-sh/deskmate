import { defineChannel, GET } from "eve/channels";
import { avatarPng } from "../deskmate-avatars.js";

// Serves each deskmate's avatar as a PNG at /eve/v1/avatars/<id>.png. These URLs
// become the Slack `icon_url` for per-deskmate replies (see deskmate-identity.ts).
// Public and unauthenticated by design — Slack fetches them to render the sender's
// picture, and they contain no secrets.

export default defineChannel({
  routes: [
    GET("/eve/v1/avatars/:id", async (_req, { params }) => {
      const id = String(params.id ?? "").replace(/\.png$/i, "");
      const png = avatarPng(id);
      if (!png) return new Response("avatar not found", { status: 404 });
      // Response body needs an ArrayBuffer here (Uint8Array isn't in this BodyInit).
      const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
      return new Response(body, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400, immutable",
        },
      });
    }),
  ],
});
