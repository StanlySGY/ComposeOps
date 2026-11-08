import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowReactive } from 'vue';
import { api } from '../api/client.js';
import { useToastStore } from '../stores/toast.js';

const templateData = (source = {}) => ({
  name: source.name || '', category: source.category || '', description: source.description || '',
  defaultCompose: source.defaultCompose || '', envSchema: (source.envSchema || []).map(field => ({ ...field })),
});

/** 仅保存页面会话内的草稿；配置可能含秘密，不能写入浏览器持久存储。 */
export function useMarketplaceEditor(onSaved) {
  const toast = useToastStore();
  const showCreateModal = ref(false); const editingTemplate = ref(null); const formData = ref(templateData());
  const savingTemplate = ref(false); const saveError = ref(''); const formErrors = ref({}); const saveNotice = ref(null);
  const drafts = shallowReactive(new Map()); const hasCreateDraft = computed(() => drafts.has('new'));
  const draftRestored = ref(false); const resetBackup = ref(null); const resetMessage = ref('');
  let active = true; let sessionId = 0; let formKey = 'new'; let original = '';
  const visible = () => showCreateModal.value || !!editingTemplate.value;
  function rememberDraft() {
    if (!visible()) return;
    const data = templateData(formData.value);
    if (JSON.stringify(data) !== original || saveError.value || savingTemplate.value) drafts.set(formKey, { data, error: saveError.value });
    else drafts.delete(formKey);
  }
  function open(template = null) {
    if (savingTemplate.value) return false;
    rememberDraft(); sessionId++; formKey = template?.id || 'new';
    const baseline = templateData(template || {}); const draft = drafts.get(formKey);
    original = JSON.stringify(baseline); formData.value = templateData(draft?.data || baseline);
    saveError.value = draft?.error || ''; formErrors.value = {}; draftRestored.value = !!draft; resetBackup.value = null; resetMessage.value = '';
    editingTemplate.value = template; showCreateModal.value = !template;
    return true;
  }
  function close(force = false) {
    if (!force && savingTemplate.value) return;
    rememberDraft(); sessionId++; showCreateModal.value = false; editingTemplate.value = null;
  }
  function resetDraft() {
    if (savingTemplate.value) return;
    resetBackup.value = templateData(formData.value); formData.value = JSON.parse(original);
    drafts.delete(formKey); saveError.value = ''; formErrors.value = {}; draftRestored.value = false;
    resetMessage.value = editingTemplate.value ? '已恢复打开时的配置。' : '表单已清空。';
  }
  function undoReset() {
    if (!resetBackup.value || savingTemplate.value) return;
    formData.value = templateData(resetBackup.value); resetBackup.value = null; resetMessage.value = '已撤销，原草稿已恢复。';
  }
  async function saveTemplate() {
    if (savingTemplate.value || !visible()) return;
    formErrors.value = {};
    if (!formData.value.name.trim()) formErrors.value.name = '请输入模板名称。';
    if (!formData.value.defaultCompose.trim()) formErrors.value.defaultCompose = '请输入 Compose 配置。';
    if (Object.keys(formErrors.value).length) {
      const elementId = formErrors.value.name ? 'market-template-name' : 'market-template-compose';
      void nextTick(() => document.getElementById(elementId)?.focus()); return;
    }
    const requestSession = sessionId; const key = formKey; const targetId = editingTemplate.value?.id;
    const payload = templateData(formData.value); const fingerprint = JSON.stringify(payload);
    const current = () => active && requestSession === sessionId && visible();
    saveError.value = ''; savingTemplate.value = true;
    saveNotice.value = { state: 'pending', message: `正在保存“${payload.name}”…` };
    try {
      if (targetId) await api.updateMarketplaceTemplate(targetId, payload);
      else await api.createMarketplaceTemplate(payload);
      // 离页时记录的同一份草稿可清除，但不能清掉用户后来编辑的不同内容。
      const stored = drafts.get(key);
      if (!stored || JSON.stringify(stored.data) === fingerprint) drafts.delete(key);
      const message = `“${payload.name}”${targetId ? '已更新' : '已创建'}`;
      saveNotice.value = { state: 'success', message };
      if (active) toast.success(message);
      if (current()) { sessionId++; showCreateModal.value = false; editingTemplate.value = null; formData.value = templateData(); }
      // 服务端已确认保存；读取列表失败由列表自己报告，不反转写入结果。
      void onSaved?.();
    } catch (error) {
      const message = error?.message || '保存失败，请重试。';
      const stored = drafts.get(key);
      if (!stored || JSON.stringify(stored.data) === fingerprint) drafts.set(key, { data: payload, error: message });
      saveNotice.value = { state: 'error', message: `“${payload.name}”保存失败：${message}。草稿已保留。` };
      if (current()) saveError.value = message;
    } finally { savingTemplate.value = false; }
  }
  function adoptTemplate(template) {
    if (!open()) return false;
    // 调用方在已有创建草稿时使用“替换草稿并填入”的明确按钮。
    drafts.delete('new'); draftRestored.value = false; formData.value = templateData(template); saveError.value = ''; return true;
  }
  function suspend() { active = false; close(true); }
  onDeactivated(suspend); onBeforeUnmount(suspend); onActivated(() => { active = true; });
  return { showCreateModal, editingTemplate, formData, savingTemplate, saveError, formErrors, saveNotice, draftRestored, hasCreateDraft, resetBackup, resetMessage, resetDraft, undoReset,
    openCreate: () => open(), editTemplate: template => open(template), closeModal: () => close(), saveTemplate, adoptTemplate };
}
