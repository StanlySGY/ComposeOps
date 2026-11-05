import { describe, expect, it } from 'vitest';
import { getRollbackableProjects } from '../src/lib/rollback-projects.js';

const projects = [
  { id: 'stopped-with-backup', projectName: 'stopped', managed: true, editable: true, status: 'stopped' },
  { id: 'stopped-no-backup', projectName: 'manual-stop', managed: true, editable: true, status: 'stopped' },
  { id: 'running-with-backup', projectName: 'running', managed: true, editable: true, status: 'running' },
  { id: 'unmanaged-with-backup', projectName: 'unmanaged', managed: false, editable: true, status: 'stopped' },
  { id: 'readonly-with-backup', projectName: 'readonly', managed: true, editable: false, status: 'stopped' },
  { id: 'partial-with-backup', projectName: 'partial', managed: true, editable: true, status: 'partial' },
];

const backups = [
  { projectId: 'stopped-with-backup', reason: 'upgrade:batch-1' },
  { projectId: 'running-with-backup', reason: 'upgrade' },
  { projectId: 'unmanaged-with-backup', reason: 'upgrade' },
  { projectId: 'readonly-with-backup', reason: 'upgrade' },
  { projectId: 'partial-with-backup', reason: 'upgrade' },
  { projectId: 'stopped-no-backup', reason: 'save' },
];

describe('getRollbackableProjects', () => {
  it('only lists non-running managed editable projects with an upgrade backup', () => {
    expect(getRollbackableProjects(projects, backups).map((project) => project.id)).toEqual([
      'stopped-with-backup',
      'partial-with-backup',
    ]);
  });

  it('does not expose rollback actions when backup loading failed or returned malformed data', () => {
    expect(getRollbackableProjects(projects, null)).toEqual([]);
    expect(getRollbackableProjects(projects, [{ projectId: 'stopped-with-backup', reason: 'save' }])).toEqual([]);
    expect(getRollbackableProjects(null, backups)).toEqual([]);
  });
});
