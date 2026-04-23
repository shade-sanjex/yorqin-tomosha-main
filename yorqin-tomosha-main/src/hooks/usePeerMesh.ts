import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export interface PeerState {
  userId: string;
  stream: MediaStream | null;
  speaking: boolean;
}

interface UsePeerMeshArgs {
  roomId: string;
  userId: string;
  enabled: boolean;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

interface SignalPayload {
  from: string;
  to: string;
  kind: "offer" | "answer" | "ice-candidate" | "hello" | "bye";
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}

export function usePeerMesh({ roomId, userId, enabled }: UsePeerMeshArgs) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Record<string, PeerState>>({});
  const [permError, setPermError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [localSpeaking, setLocalSpeaking] = useState(false);

  const pcsRef = useRef<Record<string, RTCPeerConnection>>({});
  const channelRef = useRef<RealtimeChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Record<string, { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }>>({});
  const rafRef = useRef<number | null>(null);

  const sendSignal = useCallback(async (p: Omit<SignalPayload, "from">) => {
    const channel = channelRef.current;
    if (!channel) return;
    const result = await channel.send({ type: "broadcast", event: "signal", payload: { ...p, from: userId } });
    if (result !== "ok") {
      console.warn("[webrtc] signal send failed", { kind: p.kind, to: p.to, result });
    }
  }, [userId]);

  const flushPendingIce = useCallback(async (remoteId: string, pc: RTCPeerConnection) => {
    const pending = pendingIceRef.current[remoteId];
    if (!pending?.length) return;
    delete pendingIceRef.current[remoteId];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // ignore malformed/late candidates
      }
    }
  }, []);

  const attachAnalyser = useCallback((peerId: string, stream: MediaStream) => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    const ctx = audioCtxRef.current;
    if (stream.getAudioTracks().length === 0) return;
    try {
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analysersRef.current[peerId] = { analyser, data: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)) };
    } catch {
      // ignore
    }
  }, []);

  const createPC = useCallback((remoteId: string): RTCPeerConnection => {
    if (pcsRef.current[remoteId]) return pcsRef.current[remoteId];
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcsRef.current[remoteId] = pc;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        void sendSignal({ to: remoteId, kind: "ice-candidate", ice: ev.candidate.toJSON() });
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      setPeers((prev) => ({ ...prev, [remoteId]: { userId: remoteId, stream, speaking: false } }));
      attachAnalyser(remoteId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        setPeers((prev) => {
          const n = { ...prev };
          delete n[remoteId];
          return n;
        });
      }
    };

    return pc;
  }, [sendSignal, attachAnalyser]);

  const closePC = useCallback((remoteId: string) => {
    const pc = pcsRef.current[remoteId];
    if (pc) {
      pc.close();
      delete pcsRef.current[remoteId];
    }
    delete analysersRef.current[remoteId];
    delete pendingIceRef.current[remoteId];
    setPeers((prev) => {
      const n = { ...prev };
      delete n[remoteId];
      return n;
    });
  }, []);

  // Acquire local media
  const acquireMedia = useCallback(async () => {
    setPermError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermError("media-unsupported");
      console.warn("[webrtc] navigator.mediaDevices.getUserMedia is unavailable");
      return null;
    }
    try {
      console.debug("[webrtc] requesting local media via getUserMedia");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: 320, height: 240 },
      });
      console.debug("[webrtc] local media acquired", {
        audioTracks: stream.getAudioTracks().length,
        videoTracks: stream.getVideoTracks().length,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      attachAnalyser("__local__", stream);
      // attach to existing PCs
      Object.values(pcsRef.current).forEach((pc) => {
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      });
      return stream;
    } catch {
      setPermError("perm");
      return null;
    }
  }, [attachAnalyser]);

  // Setup signaling channel and media
  useEffect(() => {
    if (!enabled) return;
    let mounted = true;

    (async () => {
      await acquireMedia();
      if (!mounted) return;

      const ch = supabase.channel(`room:${roomId}:webrtc`, {
        config: { broadcast: { self: false } },
      });
      channelRef.current = ch;

      ch.on("broadcast", { event: "signal" }, async ({ payload }) => {
        const p = payload as SignalPayload;
        if (p.to !== userId && p.kind !== "hello" && p.kind !== "bye") return;
        if (p.from === userId) return;

        if (p.kind === "hello") {
          // someone joined; if our id < theirs, we initiate
          if (userId < p.from) {
            const pc = createPC(p.from);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await sendSignal({ to: p.from, kind: "offer", sdp: offer });
          }
          return;
        }
        if (p.kind === "bye") {
          closePC(p.from);
          return;
        }

        const pc = createPC(p.from);
        if (p.kind === "offer" && p.sdp) {
          await pc.setRemoteDescription(p.sdp);
          await flushPendingIce(p.from, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await sendSignal({ to: p.from, kind: "answer", sdp: answer });
        } else if (p.kind === "answer" && p.sdp) {
          if (pc.signalingState !== "stable") {
            await pc.setRemoteDescription(p.sdp);
            await flushPendingIce(p.from, pc);
          }
        } else if (p.kind === "ice-candidate" && p.ice) {
          if (!pc.remoteDescription) {
            (pendingIceRef.current[p.from] ||= []).push(p.ice);
            return;
          }
          try { await pc.addIceCandidate(p.ice); } catch { /* noop */ }
        }
      });

      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void ch.send({ type: "broadcast", event: "signal", payload: { from: userId, to: "*", kind: "hello" } });
        }
      });
    })();

    return () => {
      mounted = false;
      void channelRef.current?.send({ type: "broadcast", event: "signal", payload: { from: userId, to: "*", kind: "bye" } });
      Object.keys(pcsRef.current).forEach(closePC);
      if (channelRef.current) supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      setLocalStream(null);
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, [enabled, roomId, userId, acquireMedia, createPC, closePC, sendSignal, flushPendingIce]);

  // Speaker detection loop
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      Object.entries(analysersRef.current).forEach(([id, { analyser, data }]) => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        const speaking = avg > 18;
        if (id === "__local__") {
          setLocalSpeaking((prev) => (prev !== speaking ? speaking : prev));
        } else {
          setPeers((prev) => {
            const cur = prev[id];
            if (!cur || cur.speaking === speaking) return prev;
            return { ...prev, [id]: { ...cur, speaking } };
          });
        }
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [enabled]);

  const toggleMic = useCallback(() => {
    const s = localStreamRef.current;
    if (!s) return;
    const enabledNow = !micEnabled;
    s.getAudioTracks().forEach((t) => (t.enabled = enabledNow));
    setMicEnabled(enabledNow);
  }, [micEnabled]);

  const toggleCam = useCallback(() => {
    const s = localStreamRef.current;
    if (!s) return;
    const enabledNow = !camEnabled;
    s.getVideoTracks().forEach((t) => (t.enabled = enabledNow));
    setCamEnabled(enabledNow);
  }, [camEnabled]);

  const retryPermission = useCallback(async () => {
    await acquireMedia();
  }, [acquireMedia]);

  return {
    localStream,
    localSpeaking,
    peers,
    permError,
    micEnabled,
    camEnabled,
    toggleMic,
    toggleCam,
    retryPermission,
  };
}
