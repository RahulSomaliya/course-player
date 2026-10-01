// Calm full-page states: loading skeleton, server not running, stopped.
import { RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Skeleton } from '../components/ui';

function Centered({ children, state }: { children: ReactNode; state: string }) {
  return (
    <main data-state={state} className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="max-w-md text-center">{children}</div>
    </main>
  );
}

/** Boot skeleton. The first start reads every mp4 header (~15 s on a cold SSD), so after a moment it says why. */
export function LoadingScreen() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 2500);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div data-state="loading" aria-busy="true" aria-label="Loading the course">
      <div className="border-b border-line">
        <div className="mx-auto flex h-14 max-w-[1148px] items-center px-4 md:px-6">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="ml-auto h-8 w-24 rounded-full" />
        </div>
      </div>
      <div className="mx-auto max-w-[1148px] px-4 pt-8 md:px-6 md:pt-12">
        <div className="grid items-center gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-10">
          <Skeleton className="aspect-video rounded-lg" />
          <div className="space-y-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="mt-8 h-12 w-40" />
          </div>
        </div>
        <p className={`mt-12 text-center text-sm text-ink-muted transition-opacity duration-500 ${slow ? 'opacity-100' : 'opacity-0'}`} aria-live="polite">
          {slow ? 'Reading the course from the SSD — the first start takes a few seconds.' : ''}
        </p>
      </div>
    </div>
  );
}

export function BootFailed({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <Centered state="boot-failed">
      <h1 className="text-2xl font-semibold text-ink">{message ?? 'The course isn’t running.'}</h1>
      <p className="mt-3 text-ink-muted">
        {message ? 'Reconnect it, then try again.' : 'Double-click 🟢 Open React Course in the React 2023 folder.'}
      </p>
      <Button className="mt-8" onClick={onRetry}>
        <RefreshCw className="size-4" strokeWidth={1.5} aria-hidden="true" />
        Try again
      </Button>
    </Centered>
  );
}

export function Stopped() {
  return (
    <Centered state="stopped">
      <h1 className="text-2xl font-semibold text-ink">Stopped.</h1>
      <p className="mt-3 text-ink-muted">You can close this tab.</p>
      {/* The way back: once the server has stopped, this page cannot restart it. */}
      <p className="mt-2 text-sm text-ink-muted">To study again, double-click 🟢 Open React Course in the React 2023 folder.</p>
    </Centered>
  );
}

export function NoProfiles() {
  return (
    <Centered state="no-profiles">
      <h1 className="text-2xl font-semibold text-ink">No one is set up yet</h1>
      <p className="mt-3 text-ink-muted">
        Add profiles to <code className="rounded bg-fill px-1.5 py-0.5 text-sm">.player/data/config.json</code> in the course folder, then reload.
      </p>
    </Centered>
  );
}
