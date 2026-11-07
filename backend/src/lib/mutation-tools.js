/** 会改变运维状态或持久化记录的工具；只读工具不触发页面失效。 */
export const MUTATION_TOOLS = new Set([
  'compose.up', 'compose.stop', 'compose.restart', 'compose.pull', 'compose.scale', 'compose.exec',
  'config.edit', 'config.rollback', 'environment.set', 'volume.mount', 'volume.backup', 'volume.restore', 'volume.verify',
  'alert.create', 'alert.configure', 'alert.delete', 'maintenance.clean', 'maintenance.update',
  'backup.trigger', 'cron.create', 'event.update', 'event.diagnose', 'app.deploy', 'inspection.run',
  'memory.save', 'memory.delete', 'memory.sleep', 'performance.baseline', 'task.stop',
]);
