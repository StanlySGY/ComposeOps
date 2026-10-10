/**
 * 存储域工具注册(volume.backup/restore/verify/list_backups)。
 * 数据卷备份能力由 services/volume-backup.js 提供(tar 备份 + 还原演练),
 * 这里只做 Agent 工具化:恢复是覆盖卷数据的破坏性操作,风险 critical,
 * 永远走人工确认门。
 */
import { findProject } from '../scanner.js';
import {
  createVolumeBackup,
  listProjectVolumes,
  listBackups,
  restoreVolumeBackup,
  verifyVolumeBackup,
} from '../volume-backup.js';

export function registerStorageTools(agent) {
  agent
    .registerTool('volume.backup', {
      description: '为项目的命名数据卷创建 tar 备份(缺省备份该项目的全部命名卷;每卷自动保留最近份数)',
      category: 'maintenance',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          volume: { type: 'string', description: '卷名(可选;缺省备份项目全部命名卷)' },
        },
      },
      execute: async (params, context) => {
        const volumes = params.volume ? [String(params.volume)] : (await listProjectVolumes(context.project)).map((item) => (typeof item === 'string' ? item : item.name));
        if (!volumes.length) return { ok: true, backed: [], note: '该项目没有声明命名卷,无需备份' };
        const backed = [];
        for (const volume of volumes) {
          backed.push({ volume, ...(await createVolumeBackup(context.project, volume)) });
        }
        return { ok: true, backed, note: `已备份 ${backed.length} 个卷,文件存放在 ops/storage/volume-*` };
      },
    })
    .registerTool('volume.restore', {
      description: '从备份恢复数据卷(会用备份 tar 覆盖卷内现有数据,破坏性操作,必须先经人工确认)',
      category: 'maintenance',
      requiredPermission: 'admin',
      confirmationRequired: true,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          backupId: { type: 'number', description: '备份记录 ID(可用 volume.list_backups 查询)' },
        },
        required: ['backupId'],
      },
      execute: async (params) => {
        const result = await restoreVolumeBackup(Number(params.backupId));
        return { ...result, note: '恢复完成:备份内容已覆盖卷内现有数据' };
      },
    })
    .registerTool('volume.verify', {
      description: '验证数据卷备份：校验 tar 完整性，并解包到一次性临时卷统计文件数；不会修改原卷',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          backupId: { type: 'number', description: '备份记录 ID(可用 volume.list_backups 查询)' },
        },
        required: ['backupId'],
      },
      execute: async (params) => verifyVolumeBackup(Number(params.backupId)),
    })
    .registerTool('volume.list_backups', {
      description: '列出数据卷备份记录(卷名/文件/大小/还原演练状态)',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID(可选,缺省列出全部)' },
        },
      },
      execute: async (params) => {
        let projectId = params.projectId ? String(params.projectId) : '';
        if (projectId && !(await findProject(projectId))) {
          throw Object.assign(new Error('项目不存在或当前不可见'), { statusCode: 404 });
        }
        const backups = await listBackups(projectId);
        return { backups, count: backups.length };
      },
    });
  return agent;
}
