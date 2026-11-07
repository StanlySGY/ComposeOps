import { onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api/client.js';
import { observeProjectOperation } from '../lib/operation-verification.js';

export function useOperationVerification(props) {
  const verification = ref(null);
  const checking = ref(false);
  let sequence = 0;
  let disposed = false;
  async function verify() {
    if (disposed || checking.value || props.running || !props.projectId || !props.contextValid || props.action === 'pull') return;
    const request = ++sequence;
    const projectId = props.projectId;
    const action = props.action;
    checking.value = true;
    verification.value = null;
    try {
      const data = await api.getProjects(true);
      if (disposed || request !== sequence || !props.contextValid) return;
      if (!Array.isArray(data?.projects)) throw new Error('未收到有效的项目列表');
      verification.value = { ...observeProjectOperation(data.projects.find(project => project.id === projectId), action), checkedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }) };
    } catch (error) {
      if (disposed || request !== sequence) return;
      verification.value = { state: 'unknown', title: '状态核对暂不可用', detail: error.message || '请稍后重试。', containers: [] };
    } finally {
      if (!disposed && request === sequence) checking.value = false;
    }
  }
  watch(() => [props.projectId, props.action, props.running, props.contextValid], () => {
    sequence += 1;
    checking.value = false;
    verification.value = null;
    if (!props.running && props.projectId && props.contextValid) void verify();
  }, { immediate: true, flush: 'sync' });
  onBeforeUnmount(() => { disposed = true; sequence += 1; });
  return { verification, checking, verify };
}
