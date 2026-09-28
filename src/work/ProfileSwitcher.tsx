import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronUp, PanelsTopLeft, Plus, X } from 'lucide-react';
import { usePopoverDismissal } from './usePopoverDismissal.ts';

type Profile = { id: string; name: string };

export function ProfileSwitcher({ profiles, active, busy, select, add }: {
  profiles: Profile[]; active: Profile; busy: boolean;
  select: (id: string) => void; add: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const close = usePopoverDismissal(open, container, panel, trigger, setOpen);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const above = anchor.top - 20;
      const below = window.innerHeight - anchor.bottom - 20;
      // Prefer upward placement; flip when the responsive sidebar is at the top.
      const upward = above >= Math.min(380, panel.current.scrollHeight) || above >= below;
      panel.current.style.maxHeight = `${Math.max(0, Math.min(380, upward ? above : below))}px`;
      const bounds = panel.current.getBoundingClientRect();
      panel.current.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
      panel.current.style.top = `${Math.max(12, Math.min(upward ? anchor.top - bounds.height - 8 : anchor.bottom + 8,
        window.innerHeight - bounds.height - 12))}px`;
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
  }, [open, busy, profiles]);

  return <div className="task-profile-switcher" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} className="task-profile-trigger" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>
      <PanelsTopLeft size={17} aria-hidden="true" />
      <span className="task-profile-identity"><span>Work profile</span><strong title={active.name}>{active.name}</strong></span>
      <ChevronUp size={14} aria-hidden="true" />
    </button>
    {open && <section ref={panel} id={id} className="task-profile-popover" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-help`}>
      <header className="task-profile-heading">
        <h2 id={`${id}-title`}>Work profiles</h2>
        <button className="icon-button" aria-label="Close work profiles" onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      <p id={`${id}-help`}>Only the selected profile collects and ranks work. Other task lists stay saved.</p>
      <p id={`${id}-busy`} role="status" hidden={!busy}>Profiles can be switched after the current run or unsubscribe finishes.</p>
      <div className="task-profile-choices">
        {profiles.map(profile => <button key={profile.id} aria-pressed={profile.id === active.id} disabled={busy}
          aria-label={profile.name} aria-describedby={busy ? `${id}-busy` : undefined}
          onClick={() => {
            if (profile.id !== active.id) select(profile.id);
            close();
          }}>
          <span className="task-profile-check">{profile.id === active.id && <Check size={15} aria-hidden="true" />}</span>
          <span className="task-profile-name">{profile.name}</span>
          {profile.id === active.id && <small>Current</small>}
        </button>)}
      </div>
      <div className="task-profile-add"><button disabled={busy} aria-describedby={busy ? `${id}-busy` : undefined}
        onClick={() => { close(); add(); }}><Plus size={15} aria-hidden="true" />Add profile</button></div>
    </section>}
  </div>;
}
