import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, close, className = '', initialFocus }: {
  title: string; children: ReactNode; close: () => void; className?: string; initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    initialFocus?.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocus]);
  return <dialog ref={ref} className={`modal ${className}`} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="modal-heading"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={19} /></button></header>
    {children}
  </dialog>;
}
