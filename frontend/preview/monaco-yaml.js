// Use the real editor integration, without fetching external schemas in its worker.
// workspaces 提升后依赖在根 node_modules(注意:裸导入会被 vite 别名指回本 shim 造成递归,
// 必须用相对路径直取真实包入口)
import { configureMonacoYaml as configure } from '../../node_modules/monaco-yaml/index.js';
export function configureMonacoYaml(monaco, options) {
  return configure(monaco, { ...options, enableSchemaRequest: false, schemas: [] });
}
