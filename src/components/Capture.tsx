import { useEffect, useRef } from 'react';
import { ArrowDownLeft, Check, Copy, X } from 'lucide-react';
import type { AppState } from '../domain/types.ts';
import type { Commit } from './Work.tsx';
import { desktop } from '../desktop.ts';

const examples = {
  review: 'Can you review this PR? demo://github/harbor/pull/42',
  routine: 'Every day at 10am, alert the Slack channels, then increase the feature flag',
};

export function CapturePanel({ state, commit, close, openItem, saving = false, saveError = '' }: {
  state: AppState; commit: Commit; close: () => void; openItem: (id: string) => void; saving?: boolean; saveError?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const latest = state.captures.at(-1);
  async function save() {
    if (!state.draft.trim()) return;
    const id = crypto.randomUUID();
    // Interpretation runs only after this separate raw-capture write succeeds.
    await commit({ type: 'capture', id, text: state.draft }, 'Original capture saved.');
    input.current?.focus();
  }
  return <section className="capture-panel" aria-label="Capture a commitment">
    <div className="section-heading"><h2>Get it out of your head.</h2><button className="icon-button" onClick={close} aria-label="Close capture"><X size={19} /></button></div>
    <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label className="sr-only" htmlFor="capture-text">Freeform capture</label>
      <textarea id="capture-text" ref={input} rows={3} value={state.draft} onChange={(event) => commit({ type: 'draft', text: event.target.value })} placeholder="A request, a link, something you don't want to forget..." onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
      }} />
      <div className="capture-footer"><span className="field-help">Original saved first. No organizing required.</span><button className="primary" disabled={!state.draft.trim()} type="submit">Save capture<ArrowDownLeft size={17} /></button></div>
    </form>
    {latest && <div className="capture-result" role="status">{!saving && !saveError && <Check size={17} className="success" />}<div><strong>{saveError ? 'Original not yet saved' : saving ? 'Saving original...' : 'Saved original'}</strong><p>{saveError || latest.explanation || 'Interpretation pending.'}</p><button className="quiet" onClick={() => openItem(latest.itemId)}>View &amp; edit action<ArrowDownLeft size={15} /></button></div></div>}
    <details className="capture-examples"><summary>{desktop ? 'Capture ideas' : 'Try a supported example'}</summary><div className="example-options">{Object.entries(desktop ? { review: 'Review the PR linked here', routine: examples.routine } : examples).map(([key, example]) => <button className="example-button" key={key} onClick={() => { void commit({ type: 'draft', text: example }); input.current?.focus(); }}><Copy size={14} /><span>{example}</span></button>)}</div><p className="field-help">{desktop ? 'Add the actual GitHub URL to link a review. Original text saves even if Copilot is unavailable.' : 'The review reference is synthetic and already in the sample data. Other text still saves as an ordinary action.'}</p></details>
  </section>;
}
