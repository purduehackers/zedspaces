export interface CallIdentity { id: string; secret: string }
export interface CallParticipant { id: string; name: string; replica: number; muted: boolean; sharing: boolean }
export type CallSignal = { description: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit };
export interface CallOutgoing { seq: number; to: string; signal: CallSignal }
export interface CallIncoming { seq: number; from: string; signal: CallSignal }
export type CallRequest = CallIdentity & (
  | { op: "join"; name: string; replica: number }
  | { op: "sync"; ack: number; muted: boolean; sharing: boolean; messages: CallOutgoing[] }
  | { op: "leave" }
);
export interface CallReply {
  peers: CallParticipant[];
  messages: CallIncoming[];
  sent: number;
  iceServers?: RTCIceServer[];
}
export interface CallStatus {
  phase: "idle" | "joining" | "joined";
  muted: boolean;
  deafened: boolean;
  sharing_screen: boolean;
  screen_supported: boolean;
  peers: number;
  error: string | null;
}
export type CallAction = "join" | "show" | "microphone" | "audio" | "screen" | "leave";
