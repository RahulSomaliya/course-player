// JS Journey plan strip — only for a journey-connected profile with a status. Hidden on 204 or any
// failure; it never blocks the page.
import { CalendarHeart, Quote } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { JourneyStatus } from '../../../../shared/types';
import { getJourneyStatus } from '../../lib/api';
import { todayKey } from '../../lib/dates';
import { describePlan } from '../../lib/plan';

export function PlanStrip({ profileId, connected }: { profileId: string; connected: boolean }) {
  const [status, setStatus] = useState<JourneyStatus | null>(null);

  useEffect(() => {
    if (!connected) {
      setStatus(null);
      return;
    }
    let live = true;
    getJourneyStatus(profileId).then(
      (s) => live && setStatus(s),
      (err: unknown) => console.warn('[journey] plan status unavailable', err),
    );
    return () => {
      live = false;
    };
  }, [profileId, connected]);

  if (status === null) return null;
  const plan = describePlan(status, todayKey());
  const onBreak = plan.breakLine?.active === true;

  return (
    <section aria-label="Study plan" className="animate-fade-in rounded-lg border border-line bg-surface px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {plan.pace && (
          <span
            className={`inline-flex h-7 items-center rounded-full px-3 text-sm font-medium ${
              plan.pace.tone === 'good' ? 'bg-accent-soft text-accent-ink' : 'bg-fill text-ink'
            }`}
          >
            {plan.pace.label}
          </span>
        )}
        {onBreak && plan.breakLine ? (
          <div className="flex items-start gap-3">
            <CalendarHeart className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={1.5} aria-hidden="true" />
            <div>
              <p className="text-base font-medium text-ink">{plan.breakLine.text}</p>
              <p className="mt-0.5 text-sm text-ink-muted">Enjoy it — break days are not study days, so no pace is lost.</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink">{plan.line}</p>
        )}
      </div>
      {!onBreak && plan.breakLine && <p className="mt-2 text-sm text-ink-muted">{plan.breakLine.text}</p>}
      {plan.note && (
        <figure className="mt-3 flex gap-2 border-t border-line pt-3">
          <Quote className="mt-0.5 size-4 shrink-0 text-ink-subtle" strokeWidth={1.5} aria-hidden="true" />
          <blockquote className="text-sm text-ink-muted">{plan.note.body}</blockquote>
        </figure>
      )}
    </section>
  );
}
