"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BrowserCall } from "./browser-call";
import "./call-panel.css";

function Screen({ stream, name }: { stream: MediaStream; name: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current!;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => { video.srcObject = null; };
  }, [stream]);
  return <figure className="zs-call-screen">
    <video ref={ref} autoPlay playsInline muted controls aria-label={`${name}'s shared screen`} />
    <figcaption>{name}</figcaption>
  </figure>;
}

export function CallPanel({ call }: { call: BrowserCall }) {
  const view = useSyncExternalStore(call.subscribe, call.view, call.view);
  if (!view.open) return null;
  return <section className="zs-call" aria-label="Workspace call" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); call.action("show"); }
  }}>
    <header><strong>Workspace call</strong><button type="button" onClick={() => call.action("show")} aria-label="Hide call panel">Close</button></header>
    {view.status.error && <p role="alert">{view.status.error}</p>}
    {view.status.phase === "joining" && <p role="status">Joining…</p>}
    {view.status.phase === "joined" && <>
      <p className="zs-call-note">Anyone with this workspace link can join. Zedspaces does not record calls.</p>
      {!view.relay && <p className="zs-call-note">Direct connections only: some networks need a TURN relay.</p>}
      <ul aria-label="Call participants">
        {view.self && <li><span>{view.self.name} (you)</span><small>{view.status.muted ? "Muted" : "Microphone on"}</small></li>}
        {view.peers.map(({ info, connection }) => <li key={info.id}><span>{info.name}</span><small>
          {connection === "connected" ? (info.muted ? "Muted" : "Microphone on") : connection === "failed" ? "Could not connect" : "Connecting…"}
        </small></li>)}
      </ul>
      <div className="zs-call-actions">
        <button type="button" onClick={() => call.action("microphone")}>{view.status.muted ? "Unmute microphone" : "Mute microphone"}</button>
        <button type="button" onClick={() => call.action("audio")}>{view.status.deafened ? "Unmute audio" : "Mute audio"}</button>
        {view.status.screen_supported && <button type="button" onClick={() => call.action("screen")}>{view.status.sharing_screen ? "Stop sharing" : "Share screen"}</button>}
        <button type="button" onClick={() => call.action("leave")}>Leave call</button>
      </div>
      {view.localScreen && <Screen stream={view.localScreen} name="Your screen" />}
      {view.peers.filter(peer => peer.info.sharing).map(peer => <Screen key={peer.info.id} stream={peer.stream} name={peer.info.name} />)}
    </>}
  </section>;
}
