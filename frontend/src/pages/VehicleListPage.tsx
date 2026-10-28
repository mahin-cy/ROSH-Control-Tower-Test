import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';

import { useVehicleRegistry } from '@/lib/vehicle-registry-client';
import { useVehicleRegistryStore } from '@/store/vehicle-registry-store';
import { useAuthStore } from '@/store/auth-store';
import { apiRequest } from '@/lib/api-client';
import { downloadReport } from '@/lib/download-report';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export function VehicleListPage() {
  const navigate = useNavigate();
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');

  useVehicleRegistry();
  const sessions = useVehicleRegistryStore((s) => s.sessions);
  const connected = useVehicleRegistryStore((s) => s.connected);

  // Grid updates itself once the bot reports back via stop-event (see
  // backend/src/index.ts) — this mutation only needs to deliver the
  // command and surface an error if that delivery fails; it doesn't need
  // to optimistically update the row itself.
  const stopMutation = useMutation({
    mutationFn: (vin: string) =>
      apiRequest(`/api/v1/vehicles/${encodeURIComponent(vin)}/stop`, { method: 'POST' })
  });

  // The Watch button below disables once a session ends — which is
  // exactly when a report becomes available — so this grid is the only
  // reliably reachable place to download it, not LiveTelemetryPage alone.
  // One shared mutation across every row, same pattern as stopMutation
  // above (a pending download disables every row's button, not just the
  // one clicked — an accepted simplification, matching the existing one).
  const downloadMutation = useMutation({
    mutationFn: ({ vin, sessionId }: { vin: string; sessionId: string }) =>
      downloadReport(vin, sessionId)
  });

  // Grid updates itself once the backend broadcasts a fresh snapshot (see
  // backend/src/routes/vehicles-route.ts) — this mutation only needs to
  // deliver the request and surface an error, same pattern as
  // stopMutation above.
  const clearEndedMutation = useMutation({
    mutationFn: (sessionIds: string[]) =>
      apiRequest('/api/v1/vehicles/clear-ended-sessions', {
        method: 'POST',
        body: JSON.stringify({ sessionIds })
      }),
    onSuccess: () => setSelectedIds(new Set())
  });

  // Keyed by compositeId, not sessionId — sessionId alone isn't
  // guaranteed unique across different bots/vehicles (see
  // VehicleSession.compositeId's doc comment on the shared type).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const endedSessions = sessions.filter((s) => s.status === 'ended');
  const allEndedSelected =
    endedSessions.length > 0 && endedSessions.every((s) => selectedIds.has(s.compositeId));
  const someEndedSelected = endedSessions.some((s) => selectedIds.has(s.compositeId));

  // A selected session can stop being 'ended'-and-selectable out from
  // under this page — another admin clears it first, or (in principle)
  // it starts a new active run — so prune stale ids whenever the list
  // changes rather than letting the count/checkbox state drift from
  // what's actually still clearable.
  useEffect(() => {
    setSelectedIds((prev) => {
      const endedIds = new Set(endedSessions.map((s) => s.compositeId));
      const next = new Set([...prev].filter((id) => endedIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someEndedSelected && !allEndedSelected;
    }
  }, [someEndedSelected, allEndedSelected]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Pre Delivery Inspections (PDIs)</h1>
        <Badge variant={connected ? 'default' : 'secondary'}>
          {connected ? 'Live' : 'Disconnected'}
        </Badge>
        {isAdmin && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={selectedIds.size === 0 || clearEndedMutation.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Clear ${selectedIds.size} selected session${selectedIds.size === 1 ? '' : 's'} from the grid?`
                )
              ) {
                clearEndedMutation.mutate([...selectedIds]);
              }
            }}
          >
            Clear selected ({selectedIds.size})
          </Button>
        )}
      </div>

      {stopMutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          Failed to send stop signal: {stopMutation.error.message}
        </p>
      )}

      {downloadMutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          Failed to download report: {downloadMutation.error.message}
        </p>
      )}

      {clearEndedMutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          Failed to clear ended sessions: {clearEndedMutation.error.message}
        </p>
      )}

      <Card>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-muted-foreground">
              No vehicles have connected yet. This list populates automatically as bots handshake.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">
                      {isAdmin && endedSessions.length > 0 && (
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          aria-label="Select all ended sessions"
                          checked={allEndedSelected}
                          onChange={(e) =>
                            setSelectedIds(
                              e.target.checked
                                ? new Set(endedSessions.map((s) => s.compositeId))
                                : new Set()
                            )
                          }
                        />
                      )}
                    </th>
                    <th className="py-2 pr-4 font-medium">VIN</th>
                    <th className="py-2 pr-4 font-medium">BOT ID</th>
                    <th className="py-2 pr-4 font-medium">Session ID</th>
                    <th className="py-2 pr-4 font-medium">Started at</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.compositeId} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        {isAdmin && session.status === 'ended' && (
                          <input
                            type="checkbox"
                            aria-label={`Select session ${session.sessionId}`}
                            checked={selectedIds.has(session.compositeId)}
                            onChange={(e) => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(session.compositeId);
                                else next.delete(session.compositeId);
                                return next;
                              });
                            }}
                          />
                        )}
                      </td>
                      <td className="py-2 pr-4 font-medium">{session.vin}</td>
                      <td className="py-2 pr-4">{session.macId ?? '—'}</td>
                      <td className="py-2 pr-4">{session.sessionId}</td>
                      <td className="py-2 pr-4">{new Date(session.startedAt).toLocaleString()}</td>
                      <td className="py-2 pr-4">
                        {/* 'lost-contact' is deliberately never rendered like 'ended' —
                            it means the backend stopped hearing from this vehicle and
                            gave up waiting, NOT that the vehicle confirmed it stopped.
                            Conflating the two could lead an operator to believe a
                            still-moving vehicle has safely stopped. */}
                        {session.status === 'active' && <Badge variant="default">Active</Badge>}
                        {session.status === 'lost-contact' && (
                          <Badge variant="destructive">Lost contact</Badge>
                        )}
                        {session.status === 'ended' && (
                          <Badge variant="secondary">
                            {session.stopCause ? `Ended (${session.stopCause})` : 'Ended'}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={session.status === 'ended'}
                            onClick={() =>
                              navigate(`/vehicles/${encodeURIComponent(session.vin)}/live`)
                            }
                          >
                            Watch
                          </Button>
                          {session.report ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={downloadMutation.isPending}
                              onClick={() =>
                                downloadMutation.mutate({
                                  vin: session.vin,
                                  sessionId: session.sessionId
                                })
                              }
                            >
                              Download Report
                            </Button>
                          ) : (
                            session.status === 'ended' && (
                              <span className="text-muted-foreground self-center text-xs">
                                Report not available
                              </span>
                            )
                          )}
                          {isAdmin && (
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={session.status === 'ended' || stopMutation.isPending}
                              onClick={() => {
                                stopMutation.mutate(session.vin);
                              }}
                            >
                              Stop
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
