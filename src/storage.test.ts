import { describe, expect, test } from 'bun:test';
import { initialState } from './domain/engine.ts';
import { legacyFixture } from './domain/test-fixtures.ts';
import { decodeWorkspace, replaceWithBackup, saveWorkspace, STORAGE_KEY, withStorageEnabled, type WorkspaceStorage } from './storage.ts';

class MemoryStorage implements WorkspaceStorage {
  values = new Map<string, string>();
  fail = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.fail) throw new Error('Quota exceeded');
    this.values.set(key, value);
  }
}
const fixture = () => ({ state: initialState('UTC'), scroll: { attention: 245 } });

describe('isolated prototype persistence', () => {
  test('round trips all work and scroll position without touching unrelated storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('previous-app', 'leave this alone');
    const saved = fixture();
    const raw = saveWorkspace(storage, saved, null);
    expect(decodeWorkspace(raw)).toEqual(saved);
    expect(storage.getItem('previous-app')).toBe('leave this alone');
    expect([...storage.values.keys()]).toEqual(['previous-app', STORAGE_KEY]);
  });

  test('rejects damaged and unsupported documents rather than resetting them', () => {
    expect(() => decodeWorkspace('{"version":1}')).toThrow('unsupported or damaged');
    expect(() => decodeWorkspace('{')).toThrow();
    const saved = fixture();
    saved.state.selectedKey = 'a:missing-task';
    expect(() => decodeWorkspace(JSON.stringify(saved))).toThrow('inconsistent');
  });

  test('does not overwrite a different tab', () => {
    const storage = new MemoryStorage();
    const raw = saveWorkspace(storage, fixture(), null);
    storage.setItem(STORAGE_KEY, 'changed elsewhere');
    expect(() => saveWorkspace(storage, fixture(), raw)).toThrow('Another tab');
    expect(storage.getItem(STORAGE_KEY)).toBe('changed elsewhere');
  });

  test('invalid saved timezones cannot crash the rendered workspace', () => {
    const saved = fixture();
    saved.state.timeZone = 'Not/A_Timezone';
    expect(() => decodeWorkspace(JSON.stringify(saved))).toThrow('invalid timezone');
  });

  test('retry saves the current pending state, not the previously saved version', () => {
    const storage = new MemoryStorage();
    const saved = fixture();
    const raw = saveWorkspace(storage, saved, null);
    saved.state.draft = 'A capture I must not lose';
    saved.state.failures.storage = true;
    expect(() => saveWorkspace(storage, saved, raw)).toThrow('Simulated storage failure');
    expect(decodeWorkspace(storage.getItem(STORAGE_KEY)!).state.draft).not.toBe(saved.state.draft);
    saved.state = withStorageEnabled(saved.state);
    const retried = saveWorkspace(storage, saved, raw);
    expect(decodeWorkspace(retried).state.draft).toBe('A capture I must not lose');
  });

  test('explicit replacement backs up the old data before changing it', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, 'damaged but recoverable');
    replaceWithBackup(storage, fixture());
    const backup = [...storage.values.entries()].find(([key]) => key.startsWith(`${STORAGE_KEY}:recovery:`));
    expect(backup?.[1]).toBe('damaged but recoverable');
    expect(decodeWorkspace(storage.getItem(STORAGE_KEY)!)).toEqual(fixture());
  });

  test('backup failure cannot erase the old data', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, 'keep');
    storage.fail = true;
    expect(() => replaceWithBackup(storage, fixture())).toThrow('Quota exceeded');
    expect(storage.getItem(STORAGE_KEY)).toBe('keep');
  });

  test('v2 conversion saves an immutable original before replacement and later saves do not overwrite it', () => {
    const storage = new MemoryStorage();
    const original = JSON.stringify({ state: legacyFixture(), scroll: { attention: 20 } });
    storage.setItem(STORAGE_KEY, original);
    storage.setItem('previous-app', 'unrelated');
    const migrated = decodeWorkspace(original);
    const raw = saveWorkspace(storage, migrated, original);
    const backups = [...storage.values.entries()].filter(([key]) => key.startsWith(`${STORAGE_KEY}:recovery:`));
    expect(backups.map(([, text]) => text)).toEqual([original]);
    expect(decodeWorkspace(raw).state.version).toBe(3);
    migrated.state.notes[0]!.text = 'Latest edit';
    saveWorkspace(storage, migrated, raw);
    expect(storage.getItem(backups[0]![0])).toBe(original);
    expect(storage.getItem('previous-app')).toBe('unrelated');
  });

  test('failed migration backup prevents replacement without losing original notes', () => {
    const storage = new MemoryStorage();
    const original = JSON.stringify({ state: legacyFixture(), scroll: {} });
    storage.setItem(STORAGE_KEY, original);
    storage.fail = true;
    expect(() => saveWorkspace(storage, decodeWorkspace(original), original)).toThrow('Quota exceeded');
    expect(storage.getItem(STORAGE_KEY)).toBe(original);
  });
});
