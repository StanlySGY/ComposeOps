/** Run-local discovery over an already authorized catalogue. Never registers or executes new code. */
export const SEARCH_TOOL_NAME = 'tool.search';
const schema = tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } });
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function terms(text) {
  const words = String(text).normalize('NFKC').toLowerCase().match(/[a-z0-9_.-]+|[\p{Script=Han}]+/gu) || [];
  return [...new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 2
    ? [word, ...Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))] : [word]))];
}
export function createToolDiscovery(catalogue, initial, { maxLoaded = 12, maxSchemaBytes = 24000 } = {}) {
  const permitted = new Map(catalogue.map(tool => [tool.name, tool]));
  const base = initial.filter(tool => permitted.has(tool.name));
  const baseNames = new Set(base.map(tool => tool.name)), loaded = new Map();
  const searchTool = {
    name: SEARCH_TOOL_NAME, description: '查找当前角色可用的运维工具。目录中没有所需能力时，先用任务关键词、工具名或分类搜索（支持中英文）；每次最多加载 5 个工具，下轮可按完整参数调用。搜索不会执行操作，也不会授予权限。',
    category: 'context', readOnly: true, storedScope: true, requiresProject: false,
    requiredPermission: 'readonly', confirmationRequired: false,
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 5 },
    } },
    execute({ query, limit = 5 }) {
      const tokens = terms(query), exact = String(query).trim().toLowerCase();
      if (!tokens.length) return { matches: [], reason: '请输入工具名或任务关键词' };
      const ranked = catalogue.map(tool => {
        const name = tool.name.toLowerCase(), text = `${name} ${tool.description || ''} ${tool.category || ''} ${JSON.stringify(tool.parameters?.properties || {})}`.toLowerCase();
        const score = (name === exact ? 10000 : 0) + tokens.reduce((sum, token) => sum + (name.includes(token) ? 20 : text.includes(token) ? 1 : 0), 0);
        return { tool, score };
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, limit);
      const matches = ranked.map(({ tool }) => {
        let available = baseNames.has(tool.name) || loaded.has(tool.name);
        if (!available && loaded.size < maxLoaded && bytes([...loaded.values(), tool].map(schema)) <= maxSchemaBytes) {
          loaded.set(tool.name, tool); available = true;
        }
        return { name: tool.name, description: tool.description, loaded: available, confirmationRequired: tool.confirmationRequired === true };
      });
      return { matches, loadedCount: loaded.size, limitReached: matches.some(item => !item.loaded),
        note: '已加载工具会出现在下一次请求的工具定义中。仍需参数校验、项目权限、策略和审批；搜索结果不代表执行成功。' };
    },
  };
  return { tool: searchTool, schemas: () => [...base, searchTool, ...loaded.values()].map(schema) };
}
