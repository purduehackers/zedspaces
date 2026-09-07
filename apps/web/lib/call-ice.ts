import { z } from "zod";
import { ApiError } from "./api";
import { env } from "./env";

const iceSchema = z.object({ iceServers: z.array(z.object({ urls: z.array(z.string().regex(/^(stun|turn|turns):/)).max(16),
  username: z.string().optional(), credential: z.string().optional() })).max(8) });

/** The long-lived Cloudflare key stays server-side; browsers receive expiring TURN credentials. */
export async function callIceServers(): Promise<RTCIceServer[]> {
  const { ZS_TURN_KEY_ID: key, ZS_TURN_API_TOKEN: token } = env();
  if (!key && !token) return [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  if (!key || !token) throw new ApiError(503, "turn_unconfigured", "The call relay is missing its TURN key configuration.");
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key)}/credentials/generate-ice-servers`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: 86_400 }), signal: AbortSignal.timeout(8000), cache: "no-store",
  });
  if (!response.ok) throw new ApiError(503, "turn_unavailable", "The call relay is unavailable. Try joining again shortly.");
  const parsed = iceSchema.safeParse(await response.json());
  if (!parsed.success) throw new ApiError(503, "turn_unavailable", "The call relay returned invalid connection details.");
  return parsed.data.iceServers.map(server => ({ ...server, urls: server.urls.filter(url => !/:53(?:\?|$)/.test(url)) }));
}
