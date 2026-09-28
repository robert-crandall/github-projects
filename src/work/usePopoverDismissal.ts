import { useCallback, useEffect, type RefObject } from 'react';

export function usePopoverDismissal(open: boolean, container: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>, trigger: RefObject<HTMLButtonElement | null>, setOpen: (open: boolean) => void) {
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, [setOpen, trigger]);

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
      close();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, container, panel, trigger, setOpen, close]);

  return close;
}
