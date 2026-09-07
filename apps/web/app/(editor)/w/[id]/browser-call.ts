import type { CallAction, CallIdentity, CallIncoming, CallOutgoing, CallParticipant, CallReply, CallRequest, CallSignal, CallStatus } from "@/lib/call-protocol";

interface Peer {
  info: CallParticipant;
  pc: RTCPeerConnection;
  audio: RTCRtpTransceiver;
  video: RTCRtpTransceiver;
  stream: MediaStream;
  playback: HTMLAudioElement;
  makingOffer: boolean;
  ignoringOffer: boolean;
  answering: boolean;
  candidates: RTCIceCandidateInit[];
  restarts: number;
}
export interface CallView {
  status: CallStatus;
  open: boolean;
  self: CallParticipant | null;
  peers: { info: CallParticipant; stream: MediaStream; connection: RTCPeerConnectionState }[];
  localScreen: MediaStream | null;
  relay: boolean;
}
class CallFailure extends Error { constructor(message: string, readonly status: number) { super(message); } }
const stop = (stream: MediaStream | null) => stream?.getTracks().forEach(track => track.stop());

/** Browser-owned media; Zed only sends user actions and receives toolbar state. */
export class BrowserCall {
  private identity: CallIdentity | null = null;
  private name = "";
  private replica = 0;
  private peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private microphone: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private requesting = new Set<"microphone" | "screen">();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private outgoing: CallOutgoing[] = [];
  private sent = 0;
  private received = 0;
  private syncing: CallIdentity | null = null;
  private syncSoon = false;
  private lastSync = 0;
  private signalingError = false;
  private queued = false;
  private disposed = false;
  private listeners = new Set<() => void>();
  private status: CallStatus = { phase: "idle", muted: true, deafened: false, sharing_screen: false,
    screen_supported: typeof navigator.mediaDevices?.getDisplayMedia === "function", peers: 0, error: null };
  private open = false;
  private snapshot: CallView = { status: this.status, open: false, self: null, peers: [], localScreen: null, relay: false };

  constructor(private workspaceId: string, private setStatus: (status: CallStatus) => void) {
    window.addEventListener("pagehide", this.onPageHide);
    this.changed();
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  view = () => this.snapshot;
  private onPageHide = () => this.leave();

  // Do not defer this entry point: getDisplayMedia requires the original click's activation.
  action(action: CallAction, replica = this.replica, name = this.name): void {
    if (this.disposed) return;
    this.status = { ...this.status, error: null };
    if (action === "join") { void this.join(replica, name); return; }
    if (action === "show") { this.open = !this.open; this.changed(); return; }
    if (action === "leave") { this.leave(); return; }
    if (this.status.phase !== "joined") return;
    if (action === "audio") {
      this.status.deafened = !this.status.deafened;
      for (const peer of this.peers.values()) {
        peer.playback.muted = this.status.deafened;
        if (!this.status.deafened && peer.playback.srcObject) this.play(peer);
      }
      this.changed();
    } else void this.capture(action);
  }

  private async join(replica: number, name: string): Promise<void> {
    if (this.identity) return;
    if (typeof RTCPeerConnection !== "function") { this.fail("This browser does not support WebRTC calls."); return; }
    const identity = { id: crypto.randomUUID(), secret: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("") };
    this.identity = identity; this.replica = replica; this.name = name;
    this.status = { ...this.status, phase: "joining", error: null }; this.open = true;
    try {
      this.changed();
      const reply = await this.request({ ...identity, op: "join", replica, name });
      if (this.identity !== identity) { this.depart(identity); return; }
      this.iceServers = reply.iceServers ?? [];
      this.status.phase = "joined"; this.lastSync = Date.now();
      await this.accept(reply, identity);
      this.schedule(0);
    } catch (error) {
      if (this.identity === identity) { this.leave(); this.fail(error instanceof Error ? error.message : "Could not join the call."); }
    }
  }

  private async capture(kind: "microphone" | "screen"): Promise<void> {
    if (this.requesting.has(kind)) return;
    if (kind === "microphone" ? this.microphone : this.screen) { this.replaceCapture(kind, null); return; }
    const identity = this.identity;
    this.requesting.add(kind);
    try {
      const stream = await (kind === "screen"
        ? navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, frameRate: { ideal: 15, max: 30 } }, audio: false })
        : navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }));
      if (!identity || this.identity !== identity) { stop(stream); return; }
      this.replaceCapture(kind, stream);
      const track = stream.getTracks()[0];
      track.onended = () => { if ((kind === "microphone" ? this.microphone : this.screen) === stream) this.replaceCapture(kind, null); };
    } catch (error) {
      if (this.identity === identity) this.fail(error instanceof DOMException && error.name === "NotAllowedError"
        ? `${kind === "screen" ? "Screen sharing" : "Microphone access"} was not allowed. You can try again when ready.`
        : `Could not start ${kind === "screen" ? "screen sharing" : "the microphone"}: ${error instanceof Error ? error.message : "device unavailable"}`);
    } finally { this.requesting.delete(kind); }
  }

  private replaceCapture(kind: "microphone" | "screen", stream: MediaStream | null): void {
    stop(kind === "microphone" ? this.microphone : this.screen);
    if (kind === "microphone") { this.microphone = stream; this.status.muted = !stream; }
    else { this.screen = stream; this.status.sharing_screen = !!stream; }
    for (const peer of this.peers.values()) {
      const sender = (kind === "microphone" ? peer.audio : peer.video).sender;
      void sender.replaceTrack(stream?.getTracks()[0] ?? null).catch(() => this.fail("The media connection changed. Leave and rejoin the call."));
    }
    this.changed(); this.schedule(0);
  }

  private addPeer(info: CallParticipant): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: "max-bundle" });
    const peer: Peer = { info, pc, audio: pc.addTransceiver(this.microphone?.getAudioTracks()[0] ?? "audio", { direction: "sendrecv" }),
      video: pc.addTransceiver(this.screen?.getVideoTracks()[0] ?? "video", { direction: "sendrecv" }), stream: new MediaStream(),
      playback: new Audio(),
      makingOffer: false, ignoringOffer: false, answering: false, candidates: [], restarts: 0 };
    this.peers.set(info.id, peer);
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send(info.id, { candidate: candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.send(info.id, { description: pc.localDescription.toJSON() });
      } catch { if (pc.connectionState !== "closed") this.fail("Could not negotiate the call connection."); }
      finally { peer.makingOffer = false; }
    };
    pc.ontrack = ({ track }) => {
      peer.stream.addTrack(track);
      if (track.kind === "audio") {
        // A media element drives remote WebRTC audio decoding in Chromium.
        peer.playback.srcObject = new MediaStream([track]);
        peer.playback.muted = this.status.deafened;
        this.play(peer);
      }
      track.onunmute = () => this.changed();
      track.onended = () => { peer.stream.removeTrack(track); this.changed(); };
      this.changed();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        if (peer.restarts++ < 2) pc.restartIce();
        else this.fail("A peer could not connect. A TURN relay may be needed on this network; try rejoining the call.");
      }
      this.changed();
    };
    return peer;
  }

  private play(peer: Peer): void {
    const stream = peer.playback.srcObject;
    void peer.playback.play().catch(() => {
      if (this.peers.get(peer.info.id) !== peer || peer.playback.srcObject !== stream || this.status.deafened) return;
      this.status.deafened = true;
      for (const peer of this.peers.values()) peer.playback.muted = true;
      this.fail("Call audio could not start. Click Unmute Audio to try again.");
    });
  }

  private async signal(message: CallIncoming): Promise<void> {
    const peer = this.peers.get(message.from);
    if (!peer) return;
    const pc = peer.pc;
    try {
      if ("description" in message.signal) {
        const description = message.signal.description;
        const ready = !peer.makingOffer && (pc.signalingState === "stable" || peer.answering);
        peer.ignoringOffer = this.identity!.id < message.from && description.type === "offer" && !ready;
        if (peer.ignoringOffer) return;
        peer.answering = description.type === "answer";
        await pc.setRemoteDescription(description);
        peer.answering = false;
        for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          if (pc.localDescription) this.send(message.from, { description: pc.localDescription.toJSON() });
        }
      } else if (!peer.ignoringOffer) {
        if (pc.remoteDescription) await pc.addIceCandidate(message.signal.candidate);
        else peer.candidates.push(message.signal.candidate);
      }
    } catch {
      peer.answering = false;
      if (pc.connectionState !== "closed" && !peer.ignoringOffer) this.fail("A peer's connection could not be established. Try rejoining the call.");
    }
  }

  private send(to: string, signal: CallSignal): void {
    if (!this.identity || !this.peers.has(to)) return;
    if (this.outgoing.length >= 512) { this.leave(); this.fail("The call signaling connection stalled. Join again."); return; }
    this.outgoing.push({ seq: ++this.sent, to, signal }); this.schedule(100);
  }
  private schedule(delay: number): void {
    if (this.status.phase !== "joined") return;
    if (this.syncing === this.identity) { this.syncSoon = true; return; }
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.sync(); }, delay);
  }
  private async sync(): Promise<void> {
    const identity = this.identity;
    if (!identity || this.syncing === identity) return;
    this.syncing = identity; this.syncSoon = false;
    let delay = 4000;
    try {
      const reply = await this.request({ ...identity, op: "sync", ack: this.received,
        muted: this.status.muted, sharing: this.status.sharing_screen, messages: this.outgoing.slice(0, 32) });
      if (this.identity !== identity) return;
      this.lastSync = Date.now();
      if (this.signalingError) { this.status.error = null; this.signalingError = false; }
      this.outgoing = this.outgoing.filter(message => message.seq > reply.sent);
      await this.accept(reply, identity);
      if (this.outgoing.length || [...this.peers.values()].some(peer => peer.pc.connectionState === "new" || peer.pc.connectionState === "connecting")) delay = 250;
    } catch (error) {
      if (this.identity !== identity) return;
      if ((error instanceof CallFailure && error.status >= 400 && error.status < 500 && error.status !== 429) || Date.now() - this.lastSync > 75_000) {
        this.leave(); this.fail(error instanceof Error ? error.message : "The call connection expired. Join again."); return;
      }
      this.signalingError = true;
      this.fail("Call signaling is reconnecting. Existing audio and screen sharing can continue."); delay = 5000;
    } finally {
      if (this.syncing === identity) this.syncing = null;
      if (this.identity === identity) this.schedule(this.syncSoon ? 100 : delay);
    }
  }
  private async accept(reply: CallReply, identity: CallIdentity): Promise<void> {
    const ids = new Set(reply.peers.map(peer => peer.id));
    for (const [id, peer] of this.peers) if (!ids.has(id)) { this.closePeer(peer); this.peers.delete(id); }
    for (const info of reply.peers) {
      if (info.id === this.identity?.id) continue;
      let peer = this.peers.get(info.id);
      if (!peer) peer = this.addPeer(info);
      if (info.sharing && !peer.info.sharing) this.open = true;
      peer.info = info;
    }
    for (const message of reply.messages) {
      if (message.seq <= this.received) continue;
      await this.signal(message);
      if (this.identity !== identity) return;
      this.received = message.seq;
    }
    this.status.peers = reply.peers.length; this.changed();
  }
  private async request(body: CallRequest): Promise<CallReply> {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(this.workspaceId)}/call`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new CallFailure(result?.error?.message ?? `Call request failed (${response.status}).`, response.status);
    }
    return response.json();
  }
  private depart(identity: CallIdentity): void {
    void fetch(`/api/workspaces/${encodeURIComponent(this.workspaceId)}/call`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...identity, op: "leave" }), keepalive: true }).catch(() => undefined);
  }
  private closePeer(peer: Peer): void {
    peer.pc.onconnectionstatechange = null; peer.pc.close();
    peer.playback.pause(); peer.playback.srcObject = null; stop(peer.stream);
  }
  leave(): void {
    const identity = this.identity; this.identity = null;
    clearTimeout(this.timer);
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear(); stop(this.microphone); stop(this.screen); this.microphone = this.screen = null;
    this.outgoing = []; this.sent = this.received = 0; this.signalingError = false;
    this.status = { ...this.status, phase: "idle", muted: true, deafened: false, sharing_screen: false, peers: 0, error: null };
    this.open = false; this.changed();
    if (identity) this.depart(identity);
  }
  dispose(): void { this.leave(); this.disposed = true; window.removeEventListener("pagehide", this.onPageHide); this.listeners.clear(); }
  private fail(message: string): void { this.status = { ...this.status, error: message }; this.open = true; this.changed(); }
  private changed(): void {
    if (this.queued || this.disposed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed) return;
      this.snapshot = { status: { ...this.status }, open: this.open, self: this.identity ? { id: this.identity.id, name: this.name, replica: this.replica, muted: this.status.muted, sharing: this.status.sharing_screen } : null,
        peers: [...this.peers.values()].map(peer => ({ info: peer.info, stream: peer.stream, connection: peer.pc.connectionState })), localScreen: this.screen,
        relay: this.iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/.test(url))) };
      this.setStatus(this.snapshot.status);
      for (const listener of this.listeners) listener();
    });
  }
}
