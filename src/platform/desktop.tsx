import { createRoot } from 'react-dom/client';
import { DesktopApp } from '../runtime/DesktopApp.tsx';
import { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import { ServiceWorkspace } from '../runtime/service-workspace.ts';
import '../theme.css';
import '../styles.css';

const controller = new DesktopWorkspace();
const remote = new ServiceWorkspace(controller);
createRoot(document.getElementById('root')!).render(<DesktopApp controller={controller} remote={remote} />);
