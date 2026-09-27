import { useEffect, useState } from 'react';
import type { SavedAssessment } from '../../service/src/work-assessment.ts';
import type { WorkStyle } from '../../service/src/work-styles.ts';
import type { Task } from '../types.ts';
import type { DesktopStatus, DesktopWorkspace } from '../runtime/desktop-workspace.ts';

export function taskStyles(task: Task, styles: WorkStyle[], assessment?: SavedAssessment): WorkStyle[] {
  const ids = task.workStyleOverride ?? (assessment?.assessmentVersion === 'work-assessment-v4'
    ? assessment.assessment.workStyleIds : []);
  return styles.filter(style => ids.includes(style.id));
}

export function matchesStyles(task: Task, styles: WorkStyle[], selected: string[] | null, assessment?: SavedAssessment): boolean {
  return selected === null || taskStyles(task, styles, assessment).some(style => selected.includes(style.id));
}

// Read the authoritative history, not a second copy in the task snapshot.
export function useStyleAssessments(controller: DesktopWorkspace, snapshot: DesktopStatus) {
  const state = snapshot.workspace?.state;
  const tasks = state?.tasks ?? [];
  const enabled = !!state?.work.settings.workStyles?.length;
  const profileId = state?.activeWorkProfile.id;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([enabled, profileId, controller.assessmentGeneration, snapshot.assessmentRevision,
    tasks.map(task => [task.id, task.assessmentTaskIds]), attempt]);
  const [result, setResult] = useState<{ key: string; values: Map<string, SavedAssessment>; error: string }>();
  useEffect(() => {
    if (!enabled || !profileId) return;
    let disposed = false;
    void (async () => {
      await controller.flush();
      const values = new Map<string, SavedAssessment>();
      for (let offset = 0; offset < tasks.length && !disposed; offset += 20) {
        const batch = await Promise.all(tasks.slice(offset, offset + 20).map(async task => {
          const page = await controller.platform.assessmentRead(profileId, task.id, null);
          return [task.id, page.assessments[0]] as const;
        }));
        for (const [id, value] of batch) if (value) values.set(id, value);
      }
      if (!disposed) setResult({ key, values, error: '' });
    })().catch(error => {
      if (!disposed) setResult({ key, values: new Map(), error: error instanceof Error ? error.message : 'Saved work styles could not be read.' });
    });
    return () => { disposed = true; };
  }, [controller, key]);
  const current = result?.key === key ? result : undefined;
  return {
    values: current?.values ?? new Map<string, SavedAssessment>(),
    loading: enabled && !current,
    error: enabled ? current?.error ?? '' : '',
    retry: () => setAttempt(value => value + 1),
  };
}
