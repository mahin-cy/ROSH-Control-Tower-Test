import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import type { VehicleSessionHistoryPage } from '@roshai/shared';

import { apiRequest } from '@/lib/api-client';
import { downloadReport } from '@/lib/download-report';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const PAGE_SIZE = 25;

export function SessionHistoryPage() {
  const [page, setPage] = useState(0);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['session-history', page],
    queryFn: () =>
      apiRequest<VehicleSessionHistoryPage>(
        `/api/v1/vehicles/history?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
      ),
    // Keeps the previous page's rows on screen while the next page loads,
    // instead of the table flashing empty between pages.
    placeholderData: (prev) => prev
  });

  // Same shared-mutation pattern as VehicleListPage's Download Report
  // button — a pending download disables every row's button, not just
  // the one clicked, an accepted simplification matching that page.
  const downloadMutation = useMutation({
    mutationFn: ({ vin, sessionId }: { vin: string; sessionId: string }) =>
      downloadReport(vin, sessionId)
  });

  const total = data?.total ?? 0;
  const hasNextPage = (page + 1) * PAGE_SIZE < total;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Session History</h1>
      </div>

      {downloadMutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          Failed to download report: {downloadMutation.error.message}
        </p>
      )}

      {isError && (
        <p className="text-destructive text-sm" role="alert">
          Failed to load session history.
        </p>
      )}

      <Card>
        <CardContent>
          {!isLoading && data?.items.length === 0 ? (
            <p className="text-muted-foreground">
              No completed sessions yet. Ended sessions appear here automatically.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">VIN</th>
                    <th className="py-2 pr-4 font-medium">BOT ID</th>
                    <th className="py-2 pr-4 font-medium">Session ID</th>
                    <th className="py-2 pr-4 font-medium">Started at</th>
                    <th className="py-2 pr-4 font-medium">Ended at</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((record) => (
                    <tr key={record.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{record.vin}</td>
                      <td className="py-2 pr-4">{record.macId ?? '—'}</td>
                      <td className="py-2 pr-4">{record.sessionId}</td>
                      <td className="py-2 pr-4">{new Date(record.startedAt).toLocaleString()}</td>
                      <td className="py-2 pr-4">{new Date(record.endedAt).toLocaleString()}</td>
                      <td className="py-2 pr-4">
                        <Badge variant="secondary">
                          {record.stopCause ? `Ended (${record.stopCause})` : 'Ended'}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {record.report && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={downloadMutation.isPending}
                            onClick={() =>
                              downloadMutation.mutate({
                                vin: record.vin,
                                sessionId: record.sessionId
                              })
                            }
                          >
                            Download Report
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-muted-foreground text-sm">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasNextPage}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
