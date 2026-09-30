import { describe, expect, it } from 'vitest';
import { searchCommands } from '../src/lib/command-search.js';

const commands = [
  { id: 'monitor', label: '实时监控', category: 'cpu memory', description: '检查容器资源' },
  { id: 'compose', label: 'Compose 配置', category: 'yaml editor', description: '编辑服务文件' },
  { id: 'logs', label: '日志:my-web', category: 'logs container', description: '查看项目实时日志' },
];
describe('命令搜索', () => {
  it('空查询保留原列表顺序', () => expect(searchCommands(commands, '  ')).toEqual(commands));
  it('支持跨名称和分类的多个关键词', () => expect(searchCommands(commands, '监控 cpu').map(c => c.id)).toEqual(['monitor']));
  it('支持英文缩写并忽略大小写和全角字符', () => expect(searchCommands(commands, 'ＣＭＰ').map(c => c.id)).toEqual(['compose']));
  it('项目名和动作可分开输入', () => expect(searchCommands(commands, 'web 日志').map(c => c.id)).toEqual(['logs']));
  it('所有关键词都必须匹配', () => expect(searchCommands(commands, '日志 不存在')).toEqual([]));
  it('名称匹配优先于描述匹配', () => {
    const results = searchCommands([{ id: 1, label: '别的页面', description: '实时监控' }, commands[0]], '实时监控');
    expect(results[0].id).toBe('monitor');
  });
});
