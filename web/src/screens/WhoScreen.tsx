// "Who's studying?" — Netflix-style profile picker. Large initial tiles, names under.
import type { Profile } from '../../../shared/types';
import { Avatar } from '../components/ui';

export function WhoScreen({ profiles, current, onPick }: { profiles: Profile[]; current: string | null; onPick: (id: string) => void }) {
  return (
    <main data-state="who" className="flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      <h1 className="text-center text-3xl font-semibold text-ink sm:text-4xl">Who’s studying?</h1>
      <ul className="mt-12 flex flex-wrap justify-center gap-8 sm:gap-12">
        {profiles.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPick(p.id)}
              aria-current={p.id === current ? 'true' : undefined}
              className="group flex flex-col items-center gap-4 rounded-lg p-2 outline-offset-4"
            >
              <span className="rounded-lg ring-2 ring-transparent ring-offset-4 ring-offset-canvas transition-[transform,box-shadow] duration-200 ease-out group-hover:-translate-y-1 group-hover:ring-accent group-hover:shadow-e2 group-focus-visible:ring-accent">
                <Avatar name={p.name} size="xl" />
              </span>
              <span className="text-base font-medium text-ink-muted group-hover:text-ink">{p.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
