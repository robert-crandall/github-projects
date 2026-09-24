import { useEffect, useRef } from 'react';
import { providerNames, sourceProviders, type SourceProvider, type TaskSource } from './filters.ts';

function SourceCheckbox({ name, checked, mixed = false, count, detail, toggle }: {
  name: string; checked: boolean; mixed?: boolean; count?: number; detail?: string; toggle: (checked: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <label className="source-checkbox">
    <input ref={input} type="checkbox" checked={checked} aria-label={name}
      onChange={event => toggle(event.target.checked)} />
    <span>{name}{detail && <small>{detail}</small>}</span>
    {count !== undefined && <span className="source-count" aria-label={`${count} tasks`}>{count}</span>}
  </label>;
}

export function SourceTree({ sources, selected, collapsed, counts, toggle, selectAll, collapse }: {
  sources: TaskSource[]; selected: string[] | null; collapsed: SourceProvider[]; counts: Map<string, number>;
  toggle: (ids: string[], checked: boolean) => void; selectAll: () => void;
  collapse: (provider: SourceProvider, closed: boolean) => void;
}) {
  const checked = (id: string) => selected === null || selected.includes(id);
  const source = (item: TaskSource) => <SourceCheckbox key={item.id} name={item.name} detail={item.detail}
    checked={checked(item.id)} count={counts.get(item.id) ?? 0} toggle={value => toggle([item.id], value)} />;
  return <section id="task-source-tree" className="task-source-tree" aria-label="Filter sources">
    <div className="source-tree-heading"><span>Show sources</span><button className="text-button" onClick={selectAll}>Select all</button></div>
    {sourceProviders.map(provider => {
      const children = sources.filter(item => item.provider === provider);
      if (!children.length) return null;
      const all = children.every(item => checked(item.id));
      return <details key={provider} open={!collapsed.includes(provider)}>
        <summary onClick={event => { event.preventDefault(); collapse(provider, !collapsed.includes(provider)); }}>
          {providerNames[provider]}</summary>
        <SourceCheckbox name={`Select all ${providerNames[provider]} sources`} checked={all}
          mixed={!all && children.some(item => checked(item.id))} toggle={value => toggle(children.map(item => item.id), value)} />
        <div className="source-tree-children">{children.map(source)}</div>
      </details>;
    })}
    <div className="source-tree-local">{sources.filter(item => !item.provider).map(source)}</div>
    <p>Tasks matching any checked source appear once. Counts follow the current tab and can overlap. Collection and ranking stay unchanged.</p>
  </section>;
}
