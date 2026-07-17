import { describe, expect, it, vi } from "vitest";
import { canonicalTrackUrl, resolveTrack } from "./soundcloud";

describe("SoundCloud validation", () => {
  it("accepts track-shaped public URLs and removes query data", () => {
    expect(canonicalTrackUrl("https://www.soundcloud.com/artist/track?si=secret#x")).toBe("https://soundcloud.com/artist/track");
  });

  it.each(["https://soundcloud.com/artist", "https://soundcloud.com/artist/sets/mix", "https://evil.test/artist/track", "not a url"])("rejects %s", (url) => {
    expect(() => canonicalTrackUrl(url)).toThrow();
  });

  it("accepts oEmbed only when it resolves to a track resource", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      title: "Song by Artist", thumbnail_url: "https://i1.sndcdn.com/artworks-x.jpg",
      html: '<iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123"></iframe>',
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(resolveTrack("https://soundcloud.com/artist/song", fetcher as typeof fetch)).resolves.toMatchObject({ title: "Song by Artist" });
  });

  it("rejects profiles returned by oEmbed", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      title: "Artist", html: '<iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Fusers%2F123"></iframe>',
    }), { status: 200 }));
    await expect(resolveTrack("https://soundcloud.com/artist/not-really-track", fetcher as typeof fetch)).rejects.toMatchObject({ code: "INVALID_URL" });
  });

  it("resolves on.soundcloud.com share links before requesting oEmbed", async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input).startsWith("https://on.soundcloud.com/")) {
        return { ok: true, url: "https://soundcloud.com/artist/song?si=share" } as Response;
      }
      return new Response(JSON.stringify({
        title: "Shared song", html: '<iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F456"></iframe>',
      }), { status: 200 });
    });
    await expect(resolveTrack("https://on.soundcloud.com/abc123", fetcher as typeof fetch)).resolves.toMatchObject({
      url: "https://soundcloud.com/artist/song", title: "Shared song",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("explains when SoundCloud prohibits embedding", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(resolveTrack("https://soundcloud.com/artist/blocked", fetcher as typeof fetch)).rejects.toThrow(/disabled embedding/i);
  });
});
