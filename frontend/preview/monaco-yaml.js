// Use the real editor integration, without fetching external schemas in its worker.
// 使用预览 Vite 配置中按当前 workspace 解析到的真实包入口，避免裸导入递归回到本 shim。
import { configureMonacoYaml as configure } from '@composeops/monaco-yaml-real';
export function configureMonacoYaml(monaco, options) {
  return configure(monaco, { ...options, enableSchemaRequest: false, schemas: [] });
}
