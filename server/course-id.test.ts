import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigStore } from './config.ts';
import { courseFile, folderCourseId, resolveCourseId } from './course-id.ts';
import { makeTempDir, memoryLog } from './test-helpers.ts';

// The 2026-10-05 incident: her copy lived in a folder not named "React 2023", so the folder-slug id was not
// "react-2023", JS Journey 404'd "unknown course" and her sign-off never reached Rahul.
let tmp = '';
let root = '';
let dataDir = '';
let cleanup: () => Promise<void> = async () => {};

beforeEach(async () => {
  ({ dir: tmp, cleanup } = await makeTempDir('course-id'));
  root = path.join(tmp, 'React Course (Mansi)');
  dataDir = path.join(root, '.player', 'data');
  await mkdir(dataDir, { recursive: true });
});
afterEach(() => cleanup());

const writeConfig = (extra: Record<string, unknown> = {}): Promise<void> =>
  writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ profiles: [{ id: 'mansi', name: 'Mansi' }], ...extra }));

describe('resolveCourseId', () => {
  it('pins the id from <course>/.player/course.json, whatever the folder is called', async () => {
    await writeFile(courseFile(root), JSON.stringify({ id: 'react-2023' }));
    await writeConfig({ courseId: 'from-config' });
    const { log, lines } = memoryLog();
    expect(await resolveCourseId({ root, config: await ConfigStore.load(dataDir), log })).toEqual({ id: 'react-2023', from: 'course.json' });
    expect(lines).toEqual([]);
  });

  it('falls back to config.json courseId', async () => {
    await writeConfig({ courseId: 'react-2023' });
    const { log, lines } = memoryLog();
    expect(await resolveCourseId({ root, config: await ConfigStore.load(dataDir), log })).toEqual({ id: 'react-2023', from: 'config.json' });
    expect(lines).toEqual([]);
  });

  it('guesses from the folder name only as a last resort — and says so loudly', async () => {
    await writeConfig();
    const { log, lines } = memoryLog();
    expect(await resolveCourseId({ root, config: await ConfigStore.load(dataDir), log })).toEqual({ id: 'react-course-mansi', from: 'folder' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[scan\] WARNING: course id "react-course-mansi" was guessed from the folder name/);
    expect(lines[0]).toContain('.player/course.json');
  });

  it('fails loudly, naming the file, on an unreadable or invalid course.json (never a silent guess)', async () => {
    await writeConfig();
    const config = await ConfigStore.load(dataDir);
    const { log } = memoryLog();
    await writeFile(courseFile(root), '{"id": "react-20');
    await expect(resolveCourseId({ root, config, log })).rejects.toThrow(/course\.json/);
    for (const bad of [{}, { id: '' }, { id: 'React 2023' }, { id: 42 }, { id: '-react' }, []]) {
      await writeFile(courseFile(root), JSON.stringify(bad));
      await expect(resolveCourseId({ root, config, log })).rejects.toThrow(/course\.json: id must be/);
    }
  });
});

describe('folderCourseId', () => {
  it('is the v1/v2 id: the slug of the folder name', () => {
    expect(folderCourseId('/Volumes/SSD/Courses/React 2023')).toBe('react-2023');
    expect(folderCourseId('/Volumes/SSD/Courses/React 2023/')).toBe('react-2023');
    expect(folderCourseId(root)).toBe('react-course-mansi');
  });
});
