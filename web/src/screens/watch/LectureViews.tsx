// Article and PDF lectures, and the in-app pdf sheet for resources.
import { ExternalLink, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Lecture, Resource } from '../../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { Button, IconButton, LinkButton, Skeleton } from '../../components/ui';
import { sanitizeArticle } from '../../lib/article';

type ArticleState = { kind: 'loading' } | { kind: 'ready'; html: string } | { kind: 'error' };

export function ArticleBody({ lecture }: { lecture: Lecture }) {
  const [state, setState] = useState<ArticleState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ kind: 'loading' });
    fetch(lecture.src, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState({ kind: 'ready', html: sanitizeArticle(await res.text()) });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        console.error(`[article] can't read ${lecture.id}`, err);
        setState({ kind: 'error' });
      });
    return () => ctrl.abort();
  }, [lecture.src, lecture.id, attempt]);

  if (state.kind === 'loading') {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading the article">
        <Skeleton className="h-5 w-11/12" />
        <Skeleton className="h-5 w-10/12" />
        <Skeleton className="h-5 w-8/12" />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div role="alert" className="rounded-lg border border-line bg-surface p-6">
        <p className="text-ink">Can’t read this article — is the SSD connected?</p>
        <Button className="mt-4" size="sm" onClick={retry}>
          <RefreshCw className="size-4" strokeWidth={1.5} aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }
  // Sanitized by DOMPurify in lib/article.ts — never render the raw file.
  return <div className="article" dangerouslySetInnerHTML={{ __html: state.html }} />;
}

export function PdfFrame({ src, title, className }: { src: string; title: string; className: string }) {
  return <iframe src={src} title={title} className={`w-full rounded-lg border border-line bg-surface ${className}`} />;
}

export function PdfSheet({ resource, onClose }: { resource: Resource | null; onClose: () => void }) {
  return (
    <Dialog open={resource !== null} onClose={onClose} labelledBy="pdf-sheet-title" className="flex h-[min(90vh,60rem)] max-w-5xl flex-col">
      {resource && (
        <>
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <h2 id="pdf-sheet-title" className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
              {resource.title}
            </h2>
            <LinkButton href={resource.href} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm">
              <ExternalLink className="size-4" strokeWidth={1.5} aria-hidden="true" />
              Open in new tab
            </LinkButton>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <X className="size-4" strokeWidth={1.5} />
            </IconButton>
          </div>
          <iframe src={resource.href} title={resource.title} className="min-h-0 w-full flex-1 rounded-b-lg" />
        </>
      )}
    </Dialog>
  );
}
