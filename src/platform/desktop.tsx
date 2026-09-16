import { createRoot } from 'react-dom/client';
import { TaskApp } from '../work/TaskApp.tsx';
import { WorkQueue } from '../work/controller.ts';
import { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import { ServiceWorkspace } from '../runtime/service-workspace.ts';
import '../theme.css';
import '../styles.css';

const controller = new DesktopWorkspace();
const remote = new ServiceWorkspace(controller);
const queue = new WorkQueue(controller);
createRoot(document.getElementById('root')!).render(<TaskApp controller={controller} queue={queue} reference={remote} />);
