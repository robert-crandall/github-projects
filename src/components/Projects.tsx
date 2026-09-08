import { useState } from 'react';
import { ArrowLeft, ArrowRight, Folder, Plus } from 'lucide-react';
import type { AppState } from '../domain/types.ts';
import { WorkRow, type Commit } from './Work.tsx';

export function Projects({ state, commit, openItem }: { state: AppState; commit: Commit; openItem: (id: string) => void }) {
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  const project = state.projects.find((entry) => entry.id === selected);
  if (project) return <>
    <button className="quiet back-button" onClick={() => setSelected(undefined)}><ArrowLeft size={16} />All projects</button>
    <div className="page-heading"><h1>{project.name}</h1><span className="subtle">Optional context</span></div>
    <label>Project name<input value={project.name} onChange={(event) => commit({ type: 'project', id: project.id, name: event.target.value, notes: project.notes })} /></label>
    <label className="notes-label">Context notes <span className="subtle">Local autosave</span><textarea rows={6} value={project.notes} onChange={(event) => commit({ type: 'project', id: project.id, name: project.name, notes: event.target.value })} placeholder="Useful background, not another task list." /></label>
    <section className="section-space"><div className="section-heading"><h2>Associated actions</h2></div><p className="subtle">Use Edit action to add or change its project.</p><ul className="work-list">{state.items.filter((item) => item.projectId === project.id && item.status !== 'removed').map((item) => <WorkRow key={item.id} item={item} state={state} open={openItem} commit={commit} />)}</ul></section>
  </>;
  return <>
    <div className="page-heading"><h1>Projects</h1><p>Context when you need it. Never required.</p></div>
    <ul className="project-list">{state.projects.map((entry) => <li key={entry.id}><button onClick={() => setSelected(entry.id)}><Folder size={20} /><span><strong>{entry.name}</strong><span className="field-help">{entry.notes || 'No context notes yet.'}</span></span><ArrowRight size={17} /></button></li>)}</ul>
    <form className="new-project" onSubmit={async (event) => {
      event.preventDefault();
      const id = crypto.randomUUID();
      if (await commit({ type: 'project', id, name: name.trim(), notes: '' }, 'Project added.')) { setName(''); setSelected(id); }
    }}><label htmlFor="project-name">Add a little context</label><div className="input-action"><input id="project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" required /><button className="secondary" disabled={!name.trim()}><Plus size={16} />Add project</button></div></form>
  </>;
}
