import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { VideoStatus } from '@roshai/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useVehicleVideo } from '@/lib/use-vehicle-video';
import { cn } from '@/lib/utils';
import { useTelemetryStore } from '@/store/telemetry-store';

function waitingMessage(videoStatus: VideoStatus | null): string {
  if (!videoStatus) return 'Waiting for video…';
  if (videoStatus.state === 'error') return `Video error: ${videoStatus.errorMessage ?? 'unknown'}`;
  if (videoStatus.state === 'starting') return 'Bot is starting its camera…';
  return 'Waiting for video…';
}

export function VehicleVideo({ vin }: { vin: string }) {
  const { videoRef, state } = useVehicleVideo(vin);
  const videoStatus = useTelemetryStore((s) => s.videoStatus);
  const [expanded, setExpanded] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const collapse = useCallback(() => {
    setExpanded(false);
    expandButtonRef.current?.focus();
  }, []);

  // While enlarged: Esc closes, page behind doesn't scroll, focus moves
  // into the overlay. Cleanup also runs on unmount, so navigating away
  // while enlarged can't leave the body scroll-locked.
  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') collapse();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded, collapse]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Live video</CardTitle>
        <Button
          ref={expandButtonRef}
          variant="ghost"
          size="icon"
          aria-label="Enlarge video"
          title="Enlarge video"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 />
        </Button>
      </CardHeader>
      <CardContent>
        {/* Fixed-height placeholder stays in the grid while enlarged, so the
            map next to it doesn't reflow. */}
        <div className="h-80">
          {expanded && (
            <div className="fixed inset-0 z-[1090] bg-black/80" onClick={collapse} aria-hidden />
          )}
          {/* Enlarging only swaps this wrapper's classes — the <video>
              element itself must never remount or move to a portal: its
              srcObject is set once in useVehicleVideo's ontrack, so a fresh
              element would stay black until the WHEP connection retried.
              z-index sits above Leaflet's panes/controls (up to 1000). */}
          <div
            role={expanded ? 'dialog' : undefined}
            aria-modal={expanded || undefined}
            aria-label={expanded ? 'Live video (enlarged)' : undefined}
            title={expanded ? undefined : 'Click to enlarge'}
            onClick={expanded ? undefined : () => setExpanded(true)}
            className={cn(
              'overflow-hidden rounded-md',
              expanded
                ? 'fixed inset-4 z-[1100] bg-black md:inset-10'
                : 'bg-muted relative h-full cursor-zoom-in'
            )}
          >
            {/* muted: browsers block non-muted autoplay without a user
                gesture, and this feed carries no audio (out of scope — see
                the implementation plan) anyway. */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-contain"
            />
            {state !== 'connected' && (
              <div className="text-muted-foreground absolute inset-0 flex items-center justify-center px-4 text-center text-sm">
                <p>{waitingMessage(videoStatus)}</p>
              </div>
            )}
            {expanded && (
              <Button
                ref={closeButtonRef}
                variant="secondary"
                size="icon"
                aria-label="Restore video size"
                title="Restore (Esc)"
                onClick={collapse}
                className="absolute top-2 right-2 opacity-80 hover:opacity-100"
              >
                <Minimize2 />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
