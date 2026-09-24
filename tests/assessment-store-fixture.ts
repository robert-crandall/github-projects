import { savedAssessmentSchema, type SavedAssessment, type TaskAssessment } from '../service/src/work-assessment.ts';
import type { AppState } from '../src/types.ts';

export class AssessmentStoreFixture {
  entries: (TaskAssessment & { sequence: number })[] = [];
  fail = false;
  append(profileId: string, values: SavedAssessment[], state: AppState) {
    if (this.fail) throw { code: 'storage-failed', retryable: true, message: 'History storage unavailable' };
    const tasks = state.activeWorkProfile.id === profileId ? state.tasks
      : state.inactiveWorkProfiles.find(profile => profile.id === profileId)?.tasks ?? [];
    return values.map(value => {
      if (value.profileId !== profileId || !tasks.some(task => task.id === value.id || task.assessmentTaskIds?.includes(value.id))) {
        throw new Error('Wrong assessment owner');
      }
      const existing = this.entries.find(entry => entry.resultId === value.resultId);
      if (existing) {
        const { sequence: _, ...result } = existing;
        if (JSON.stringify(result) !== JSON.stringify(value)) throw new Error('Conflicting assessment');
        return existing;
      }
      const entry = { ...value, sequence: Math.max(0, this.entries.at(-1)?.sequence ?? 0) + 1 };
      this.entries.push(entry);
      return entry;
    });
  }
  values(taskId: string, profileId = 'default') {
    return this.entries.filter(value => value.id === taskId && value.profileId === profileId);
  }
  read(profileId: string, taskId: string, before: number | null, state: AppState) {
    const tasks = state.activeWorkProfile.id === profileId ? state.tasks
      : state.inactiveWorkProfiles.find(profile => profile.id === profileId)?.tasks ?? [];
    const task = tasks.find(task => task.id === taskId);
    if (!task) throw new Error('Task unavailable');
    const entries = this.entries.filter(value => value.profileId === profileId
      && (value.id === taskId || task.assessmentTaskIds?.includes(value.id)) && (!before || value.sequence < before)).reverse();
    const assessments = entries.slice(0, 20);
    return { assessments, before: entries.length > 20 ? assessments.at(-1)!.sequence : null };
  }
  migrate(state: AppState) {
    for (const profile of [{ ...state.activeWorkProfile, tasks: state.tasks }, ...state.inactiveWorkProfiles]) {
      for (const task of profile.tasks) {
        const values = [...task.assessments ?? []].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        const aliases = values.map(value => value.id).filter(id => id !== task.id);
        if (aliases.length) task.assessmentTaskIds = [...new Set([...task.assessmentTaskIds ?? [], ...aliases])];
        if (values.length) this.append(profile.id, values.map(({ sequence: _, ...value }) => savedAssessmentSchema.parse(value)), state);
        delete task.assessments;
      }
    }
  }
}
