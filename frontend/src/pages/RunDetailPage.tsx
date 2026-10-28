import { useParams } from 'react-router';

export function RunDetailPage() {
  const { vin, runId } = useParams();

  return (
    <div>
      <h1 className="text-2xl font-semibold">Run detail</h1>
      <p className="text-muted-foreground mt-2">
        Vehicle {vin}, run {runId} — session detail will appear here once the sessions API is wired
        up (Phase 3/9).
      </p>
    </div>
  );
}
