import { z } from "zod";
import type { TrackMetadata } from "./room.js";
import { RoomCommandError } from "./room.js";

const oEmbedSchema = z.object({
  title: z.string().min(1),
  html: z.string().min(1),
  thumbnail_url: z.string().url().optional(),
});

const reserved = new Set(["discover", "stream", "you", "search", "upload", "charts", "stations", "settings", "terms-of-use", "pages"]);

export function canonicalTrackUrl(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new RoomCommandError("INVALID_URL", "Enter a complete SoundCloud track URL."); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new RoomCommandError("INVALID_URL", "Only HTTP SoundCloud URLs are accepted.");
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "soundcloud.com" && hostname !== "www.soundcloud.com") throw new RoomCommandError("INVALID_URL", "The URL must be on soundcloud.com.");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || reserved.has(segments[0].toLowerCase()) || segments[1].toLowerCase() === "sets") {
    throw new RoomCommandError("INVALID_URL", "Use a public track URL, not a profile or playlist.");
  }
  try {
    return `https://soundcloud.com/${encodeURIComponent(decodeURIComponent(segments[0]))}/${encodeURIComponent(decodeURIComponent(segments[1]))}`;
  } catch {
    throw new RoomCommandError("INVALID_URL", "The track URL contains invalid escaping.");
  }
}

export async function resolveTrack(input: string, fetcher: typeof fetch = fetch): Promise<TrackMetadata> {
  const url = await resolveInputUrl(input, fetcher);
  const endpoint = new URL("https://soundcloud.com/oembed");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("maxheight", "166");
  let response: Response;
  try {
    response = await fetcher(endpoint, { signal: AbortSignal.timeout(8_000), headers: { "user-agent": "PrimalListenAlong/1.0" } });
  } catch {
    throw new RoomCommandError("TRACK_UNAVAILABLE", "SoundCloud did not respond. Try again shortly.");
  }
  if (!response.ok) {
    if (response.status === 403) throw new RoomCommandError("TRACK_UNAVAILABLE", "SoundCloud has disabled embedding for that track. Open it directly on SoundCloud instead.");
    throw new RoomCommandError("TRACK_UNAVAILABLE", "That track is unavailable or cannot be embedded.");
  }
  const parsed = oEmbedSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new RoomCommandError("TRACK_UNAVAILABLE", "SoundCloud returned incomplete track metadata.");
  const iframeSource = parsed.data.html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]?.replaceAll("&amp;", "&");
  if (!iframeSource) throw new RoomCommandError("TRACK_UNAVAILABLE", "This track does not provide an embeddable player.");
  try {
    const resource = new URL(iframeSource).searchParams.get("url");
    if (!resource || !/\/tracks\/\d+(?:[/?#]|$)/.test(decodeURIComponent(resource))) {
      throw new Error("not a track");
    }
  } catch {
    throw new RoomCommandError("INVALID_URL", "SoundCloud resolved this URL to something other than a track.");
  }
  return { url, title: parsed.data.title, artworkUrl: parsed.data.thumbnail_url ?? null };
}

async function resolveInputUrl(input: string, fetcher: typeof fetch): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new RoomCommandError("INVALID_URL", "Enter a complete SoundCloud track URL."); }
  if (parsed.hostname.toLowerCase() !== "on.soundcloud.com") return canonicalTrackUrl(input);
  if (parsed.protocol !== "https:" || parsed.pathname.split("/").filter(Boolean).length !== 1) {
    throw new RoomCommandError("INVALID_URL", "That SoundCloud share link is malformed.");
  }
  try {
    const response = await fetcher(parsed, {
      method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8_000),
      headers: { "user-agent": "PrimalListenAlong/1.0" },
    });
    if (!response.ok) throw new Error("redirect failed");
    return canonicalTrackUrl(response.url);
  } catch (cause) {
    if (cause instanceof RoomCommandError) throw cause;
    throw new RoomCommandError("TRACK_UNAVAILABLE", "That SoundCloud share link could not be resolved.");
  }
}
