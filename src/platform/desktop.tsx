import { createRoot } from 'react-dom/client';
import { TaskApp } from '../work/TaskApp.tsx';
import { WorkQueue } from '../work/controller.ts';
import { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import { ServiceWorkspace } from '../runtime/service-workspace.ts';
import { themes } from '../themes/browser.ts';
import { AppearanceNotice } from '../themes/Appearance.tsx';
import '../theme.css';
import '../styles.css';

const controller = new DesktopWorkspace();
const remote = new ServiceWorkspace(controller);
const queue = new WorkQueue(controller);
void themes.load().then(() => {
  createRoot(document.getElementById('root')!).render(<><AppearanceNotice /><TaskApp controller={controller} queue={queue} remote={remote} /></>);
});
