/** 写操作、Agent 与后台任务共用的页面失效信号。不携带敏感参数。 */
export const DATA_CHANGED_EVENT = 'composeops:data-changed';
let revision = 0;
export function dataRevision() { return revision; }
export function notifyDataChanged(detail = {}) {
  revision += 1;
  window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT, { detail }));
}
