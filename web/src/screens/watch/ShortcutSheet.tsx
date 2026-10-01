// `?` — the keyboard shortcut sheet (rows come from lib/keys.ts SHORTCUTS, next to the key map).
import { X } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { IconButton } from '../../components/ui';
import { SHORTCUTS } from '../../lib/keys';

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="shortcuts-title" className="max-w-md">
      <div className="flex items-center justify-between px-6 pb-2 pt-5">
        <h2 id="shortcuts-title" className="text-lg font-semibold text-ink">
          Keyboard shortcuts
        </h2>
        <IconButton label="Close" size="sm" onClick={onClose} data-autofocus>
          <X className="size-4" strokeWidth={1.5} />
        </IconButton>
      </div>
      <dl className="px-6 pb-6">
        {SHORTCUTS.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-b-0">
            <dt className="text-sm text-ink">{s.label}</dt>
            <dd className="flex shrink-0 gap-1">
              {s.keys.map((k) => (
                <kbd key={k} className="inline-flex h-6 min-w-6 items-center justify-center rounded-[5px] border border-line bg-fill px-1.5 font-sans text-xs font-medium text-ink-muted">
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
