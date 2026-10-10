import { cn } from '@/lib/utils';

/** An agent's initial on its colour. `live` rings it with a pulse while the agent is working. */
export function AgentAvatar({ name, color, live, className }: { name: string | null; color?: string | null; live?: boolean; className?: string }) {
  if (!name) return <span role="img" aria-label="No agent yet" title="No agent yet" className={cn('size-5 shrink-0 rounded-full border border-dashed border-muted-foreground/50', className)} />;
  return <span role="img" aria-label={`Agent ${name}`} title={`Agent ${name}`}
    className={cn('relative grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white', className)}
    style={{ backgroundColor: color ?? 'var(--muted-foreground)' }}>
    {name[0].toUpperCase()}
    {live && <span aria-hidden className="absolute -inset-[3px] rounded-full border-[1.5px] border-status-running motion-safe:animate-pulse" />}
  </span>;
}
