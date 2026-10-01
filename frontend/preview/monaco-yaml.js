// Use the real editor integration, without fetching external schemas in its worker.
import { configureMonacoYaml as configure } from '../node_modules/monaco-yaml/index.js';
export function configureMonacoYaml(monaco, options) {
  return configure(monaco, { ...options, enableSchemaRequest: false, schemas: [] });
}
