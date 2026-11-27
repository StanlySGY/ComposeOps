import { describe, expect, it } from 'vitest';
import { primaryItems, navGroups, pageCommands } from '../src/lib/page-navigation.js';
import { searchCommands } from '../src/lib/command-search.js';

describe('页面导航与搜索入口一致', () => {
  it('所有侧栏页面均可按可见名称搜索且目标唯一', () => {
    for (const page of [...primaryItems, ...navGroups.flatMap(group => group.items)]) {
      expect(pageCommands.filter(command => command.to === page.to)).toHaveLength(1);
      expect(searchCommands(pageCommands, page.label).map(command => command.to)).toContain(page.to);
    }
  });
  it('完整备份、值守、可靠性与工单别名可用，子页入口保留', () => {
    for (const [query, to] of [['完整备份', '/maintenance'], ['AI 值守', '/oncall'], ['应用可靠性', '/reliability'], ['长期 任务', '/tickets'], ['历史指标', '/monitor?tab=history'], ['项目纳管', '/settings?tab=mounts']]) {
      expect(searchCommands(pageCommands, query).map(command => command.to)).toContain(to);
    }
  });
});
