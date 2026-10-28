import { useEffect, useRef, useState, type RefObject } from 'react';

// MediaMTX path is the vin — must match the ingest URL the backend hands
// the bot (buildIngestUrl in backend/src/lib/video-control-service.ts),
// or the bot publishes to one path while this reads from another and
// MediaMTX answers every read with "no stream is available". Relative
// path: frontend and MediaMTX share an origin via Traefik's /webrtc route
// (see docker/docker-compose.yml), same reasoning as api-client.ts's
// relative /api paths.
function whepUrl(vin: string): string {
  return `/webrtc/${encodeURIComponent(vin)}/whep`;
}
const RETRY_DELAY_MS = 2000;

export type VideoConnectionState = 'connecting' | 'connected';

// Hand-rolled WHEP (WebRTC-HTTP Egress Protocol) client — deliberately
// not a library: the whole protocol is one HTTP POST exchanging an SDP
// offer/answer, well within hand-rolling range (see the implementation
// plan's "smallest dependency surface" reasoning, same rationale already
// applied to shadcn/ui over a component library). Non-trickle ICE: waits
// for gathering to complete before POSTing the offer rather than
// implementing WHEP's PATCH trickle-ICE extension — simpler, and
// acceptable given ICE gathering is fast on a private tailnet with no
// STUN/TURN round-trip (see docker/mediamtx/mediamtx.yml's ICE comments).
//
// Retries automatically on failure rather than surfacing a dead end —
// there's a real gap between the operator's browser subscribing (which
// triggers the backend's video START command) and the bot's RTSP push
// actually landing, so the first WHEP read attempt failing is a normal,
// expected case, not an error worth making the operator refresh for.
export function useVehicleVideo(vin: string): {
  videoRef: RefObject<HTMLVideoElement | null>;
  state: VideoConnectionState;
} {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<VideoConnectionState>('connecting');

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let resourceUrl: string | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanupPeerConnection() {
      pc?.close();
      pc = null;
      if (resourceUrl) {
        // Best-effort — MediaMTX also detects the closed PeerConnection
        // on its own via ICE disconnection, so a failed DELETE here isn't
        // a real problem, just a slightly delayed cleanup on their side.
        fetch(resourceUrl, { method: 'DELETE' }).catch(() => {});
        resourceUrl = null;
      }
    }

    function scheduleRetry() {
      if (cancelled) return;
      cleanupPeerConnection();
      retryTimer = setTimeout(() => void attempt(), RETRY_DELAY_MS);
    }

    async function attempt() {
      if (cancelled) return;
      setState('connecting');
      const conn = new RTCPeerConnection();
      pc = conn;
      conn.addTransceiver('video', { direction: 'recvonly' });
      conn.ontrack = (event) => {
        if (videoRef.current) videoRef.current.srcObject = event.streams[0] ?? null;
      };
      conn.onconnectionstatechange = () => {
        if (cancelled || pc !== conn) return;
        if (conn.connectionState === 'connected') setState('connected');
        else if (conn.connectionState === 'failed' || conn.connectionState === 'closed') {
          scheduleRetry();
        }
      };

      try {
        const offer = await conn.createOffer();
        await conn.setLocalDescription(offer);

        if (conn.iceGatheringState !== 'complete') {
          await new Promise<void>((resolve) => {
            function check() {
              if (conn.iceGatheringState === 'complete') {
                conn.removeEventListener('icegatheringstatechange', check);
                resolve();
              }
            }
            conn.addEventListener('icegatheringstatechange', check);
          });
        }
        if (cancelled || pc !== conn) return;

        const res = await fetch(whepUrl(vin), {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: conn.localDescription?.sdp ?? ''
        });
        if (!res.ok) throw new Error(`WHEP request failed: ${res.status}`);

        const location = res.headers.get('Location');
        resourceUrl = location ? new URL(location, window.location.origin).toString() : null;

        const answerSdp = await res.text();
        if (cancelled || pc !== conn) return;
        await conn.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      } catch (err) {
        console.warn('WHEP connect attempt failed, will retry', err);
        if (pc === conn) scheduleRetry();
      }
    }

    void attempt();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      cleanupPeerConnection();
    };
  }, [vin]);

  return { videoRef, state };
}
