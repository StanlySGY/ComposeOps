// Use the real editor integration, without fetching external schemas in its worker.
// workspaces 提升后依赖在根 node_modules,走裸导入交给解析器,不再硬编码相对路径
import { configureMonacoYaml as configure } from 'monaco-yaml';
export function configureMonacoYaml(monaco, options) {
  return configure(monaco, { ...options, enableSchemaRequest: false, schemas: [] });
}
