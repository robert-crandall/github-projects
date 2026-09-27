import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, LoaderCircle, X } from 'lucide-react';
import type { WorkQueueSnapshot } from './controller.ts';
import { RunProgress } from './RunProgress.tsx';

const activityLabels: Record<WorkQueueSnapshot['phase'], string> = {
  preparing: 'Preparing', intake: 'Reading intake', collecting: 'Collecting',
  'checking-assessments': 'Checking assessments', 'refreshing-state': 'Checking GitHub',
  assessing: 'Assessing', ranking: 'Ranking', saving: 'Saving', cancelling: 'Cancelling',
  cancelled: 'Assessment cancelled', idle: 'Run complete', error: 'Run incomplete',
};

export function RunProgressPopover({ run, details, error, profileName, cancelAssessor }: {
  run: WorkQueueSnapshot; details: string[]; error: string; profileName: string; cancelAssessor: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const available = !!run.progress || details.length > 0;
  const failed = run.progress?.sources.filter(source => source.state === 'failed').length ?? 0;
  const notes = details.length > 0 || run.progress?.sources.some(source => source.diagnostics.length > 0);
  const warning = failed > 0 || notes || run.phase === 'cancelled';
  const incomplete = !run.running && (!!error || run.phase === 'error');
  const label = run.running ? activityLabels[run.phase] : incomplete ? 'Run incomplete'
    : run.phase === 'cancelled' ? activityLabels.cancelled : failed ? 'Partial coverage'
      : notes ? 'Coverage notes' : 'Run complete';
  const status = `${label}${failed ? ` · ${failed} failed` : run.running && notes ? ' · Coverage notes' : ''}`;
  const Icon = run.running ? LoaderCircle : incomplete || warning ? CircleAlert : Check;
  const kind = run.progress?.kind;
  const scope = !run.progress ? 'Saved run diagnostics' : kind === 'assess' ? 'Assessor only · Order unchanged'
    : kind === 'prioritize' ? 'Prioritizer only · Whole eligible list' : 'Collect, assess, prioritize';

  useLayoutEffect(() => {
    if (!open || !available) return;
    const position = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12));
      const top = Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - bounds.height - 12));
      panel.current.style.left = `${left}px`;
      panel.current.style.top = `${top}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (panel.current) observer.observe(panel.current);
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, available, status]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false);
        if (panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  if (!available) return null;
  return <div className="task-run-activity" ref={container} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} className={`secondary task-run-indicator${incomplete ? ' task-run-incomplete' : warning ? ' task-run-warning' : ''}`}
      aria-label={`Run details: ${status}`} aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>
      <Icon size={15} aria-hidden="true" className={run.running ? 'task-run-spinner' : undefined} />
      <span>{status}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    <span className="task-run-announcement" role="status" aria-atomic="true">{status}</span>
    {open && <section ref={panel} id={id} className="task-run-popover" aria-labelledby={`${id}-title`}>
      <header className="task-run-popover-heading">
        <div><h2 id={`${id}-title`}>{run.running ? 'Current run' : 'Last run'}</h2>
          <p>{profileName} · {scope}</p></div>
        <button className="icon-button" aria-label="Close run details" onClick={() => {
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        }}><X size={17} aria-hidden="true" /></button>
      </header>
      <RunProgress run={run} details={details} cancelAssessor={cancelAssessor} />
      <p className="task-run-popover-footer">{run.running ? 'You can keep working while this runs.' : 'Details remain available until the next run.'}</p>
    </section>}
  </div>;
}
