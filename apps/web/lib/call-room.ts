import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "./api";
import { dbReady } from "./db";
import type { CallIncoming, CallParticipant, CallReply, CallRequest } from "./call-protocol";

const identity = { id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) };
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signal = z.union([
  z.object({ description: z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().min(1).max(32_768) }).strict() }).strict(),
  z.object({ candidate: z.object({ candidate: z.string().max(2048), sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(), usernameFragment: z.string().max(256).nullable().optional() }).strict() }).strict(),
]);
export const callRequestSchema = z.discriminatedUnion("op", [
  z.object({ ...identity, op: z.literal("join"), name: z.string().regex(/^Anonymous [A-Z][a-z]{1,20}$/), replica: z.number().int().min(8).max(65535) }).strict(),
  z.object({ ...identity, op: z.literal("sync"), ack: sequence, muted: z.boolean(), sharing: z.boolean(),
    messages: z.array(z.object({ seq: sequence, to: z.uuid(), signal }).strict()).max(32) }).strict(),
  z.object({ ...identity, op: z.literal("leave") }).strict(),
]);

interface Peer extends CallParticipant { hash: string; seen: number; sent: number; window: number; requests: number; inbox: CallIncoming[] }
interface Room { sequence: number; peers: Record<string, Peer> }
const PEER_TTL = 90_000;
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** One short-lived row per call. Only signaling is stored; media stays in WebRTC. */
export async function exchangeCall(workspaceId: string, request: CallRequest): Promise<CallReply> {
  const key = `zs:call:${workspaceId}`;
  return (await dbReady()).transaction(async tx => {
    const now = Date.now();
    const rows = await tx.all<{ value: string }>(sql`SELECT value FROM kv WHERE key=${key} AND expires_at>${now}`);
    const room: Room = rows[0] ? JSON.parse(rows[0].value) : { sequence: 0, peers: {} };
    for (const [id, peer] of Object.entries(room.peers)) if (now - peer.seen > PEER_TTL) delete room.peers[id];
    let peer = room.peers[request.id];
    if (peer && !timingSafeEqual(Buffer.from(peer.hash, "hex"), Buffer.from(hash(request.secret), "hex"))) {
      throw new ApiError(403, "call_identity", "This call participant belongs to a different tab.");
    }
    if (request.op === "join" && !peer) {
      if (Object.keys(room.peers).length >= 8) throw new ApiError(409, "call_full", "This call already has eight participants.");
      peer = room.peers[request.id] = { id: request.id, name: request.name, replica: request.replica, hash: hash(request.secret),
        muted: true, sharing: false, seen: now, sent: 0, window: now, requests: 0, inbox: [] };
    }
    if (request.op === "leave") delete room.peers[request.id];
    else {
      if (!peer) throw new ApiError(410, "call_expired", "You left the call or the connection expired. Join again.");
      if (now - peer.window > 60_000) { peer.window = now; peer.requests = 0; }
      if (++peer.requests > 300) throw new ApiError(429, "rate_limited", "Call signaling is too busy. Try again shortly.", undefined, { "Retry-After": "5" });
      peer.seen = now;
      if (request.op === "sync") {
        peer.muted = request.muted;
        peer.sharing = request.sharing;
        peer.inbox = peer.inbox.filter(message => message.seq > request.ack);
        for (const message of request.messages) {
          if (message.seq <= peer.sent) continue; // A response may have been lost after committing.
          if (message.seq !== peer.sent + 1) throw new ApiError(409, "call_sequence", "Call signaling arrived out of order. Rejoin the call.");
          const recipient = message.to !== request.id ? room.peers[message.to] : undefined;
          if (recipient) {
            if (recipient.inbox.length >= 128) throw new ApiError(409, "call_congested", "A call participant stopped receiving messages. Rejoin the call.");
            recipient.inbox.push({ seq: ++room.sequence, from: request.id, signal: message.signal });
          }
          peer.sent = message.seq;
        }
      }
    }
    for (const participant of Object.values(room.peers)) participant.inbox = participant.inbox.filter(message => room.peers[message.from]);
    const value = JSON.stringify(room);
    if (Buffer.byteLength(value) > 1_048_576) throw new ApiError(409, "call_congested", "This call has too many pending connection messages.");
    if (Object.keys(room.peers).length) {
      await tx.run(sql`INSERT INTO kv (key,value,expires_at) VALUES (${key},${value},${now + PEER_TTL * 2})
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`);
    } else await tx.run(sql`DELETE FROM kv WHERE key=${key}`);
    return { peers: Object.values(room.peers).map(({ id, name, replica, muted, sharing }) => ({ id, name, replica, muted, sharing })),
      messages: request.op === "leave" ? [] : peer.inbox, sent: peer?.sent ?? 0 };
  });
}
