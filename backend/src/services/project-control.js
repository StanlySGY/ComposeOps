import { getProjectDocker, assertProjectHostUnchanged } from './docker-hosts.js';

export const CONTAINER_ACTIONS = new Set(['up', 'restart', 'stop', 'ps']);

const ACTION_LABELS = {
  up: '启动',
  restart: '重启',
  stop: '停止',
  ps: '查看',
};

export function supportsContainerAction(action) {
  return CONTAINER_ACTIONS.has(action);
}

/**
 * Compose 文件不可达时的受限控制：只操作 Docker 已上报且属于当前纳管项目的现有容器。
 * 不创建、删除容器，也不修改网络、卷或 Compose 配置。
 */
export async function runContainerAction(project, action, onOutput = () => {}, dockerClient = getProjectDocker(project)) {
  if (!supportsContainerAction(action)) {
    throw Object.assign(new Error('该操作需要挂载 Compose 项目目录'), { statusCode: 409 });
  }

  let failed = 0;
  await Promise.all(project.containers.map(async (item) => {
    const container = dockerClient.getContainer(item.id);
    try {
      const inspection = await container.inspect();
      assertProjectHostUnchanged(project);
      const currentState = inspection.State?.Status || item.state;
      if (action === 'up') {
        if (currentState === 'running' || currentState === 'paused') onOutput('stdout', `${item.name}: 当前状态 ${currentState}，无需启动\n`);
        else { await container.start(); onOutput('stdout', `${item.name}: 已启动\n`); }
      } else if (action === 'restart') {
        if (currentState === 'running' || currentState === 'paused') await container.restart({ t: 10 });
        else await container.start();
        onOutput('stdout', `${item.name}: 已重启\n`);
      } else if (action === 'stop') {
        if (currentState !== 'running') onOutput('stdout', `${item.name}: 当前状态 ${currentState}，无需停止\n`);
        else { await container.stop({ t: 10 }); onOutput('stdout', `${item.name}: 已停止\n`); }
      } else {
        const state = inspection.State || {};
        onOutput('stdout', `${item.name}\t${state.Status || item.state}\t${item.image}\n`);
      }
    } catch (error) {
      if (error.code === 'HOST_CHANGED') throw error;
      failed += 1;
      onOutput('stderr', `${item.name}: ${ACTION_LABELS[action]}失败 - ${error.message}\n`);
    }
  }));
  return failed ? 1 : 0;
}
