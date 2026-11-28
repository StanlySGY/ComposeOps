import { Activity, BellRing, Bot, Boxes, ChartNoAxesCombined, Clock3, FileCode2, FileSearch, HardDrive, History, Layers, Play, ScrollText, Settings, ShieldCheck, Store, TerminalSquare } from 'lucide-vue-next';

const commandDefinitions = [
  { to: '/dashboard', label: '运维总览', description: '项目健康、环境指标与最近事件', icon: Boxes, category: 'dashboard home 首页 概览' },
  { to: '/services', label: '服务总览', description: '查看项目健康状态并执行生命周期操作', icon: Boxes, category: 'dashboard stack container 项目 容器' },
  { to: '/compose', label: 'Compose 配置', description: '编辑、校验和恢复 Compose 文件', icon: FileCode2, category: 'yaml editor backup 配置 备份' },
  { to: '/logs', label: '实时日志', description: '连接容器输出并搜索、暂停或导出', icon: ScrollText, category: 'stdout stderr search 日志' },
  { to: '/shell', label: '容器终端', description: '打开受限的交互式 Shell', icon: TerminalSquare, category: 'terminal bash sh 终端' },
  { to: '/agent', label: 'AI 智能运维 Agent', description: '挂载日志、检索资料并执行 Compose 运维操作', icon: Bot, category: 'agent ai chat workflow 编排 执行 工具 运维 诊断 诊断 chat' },
  { to: '/inspection', label: 'AI 巡检中心', description: '只读巡检容器、磁盘、内存与备份时效,输出结论与建议', icon: ShieldCheck, category: 'inspection scan health check 巡检 体检 检查 报告' },
  { to: '/monitor', label: '实时监控', description: '检查容器 CPU、内存用量的实时概览', icon: ChartNoAxesCombined, category: 'metrics cpu memory 监控 realtime 实时' },
  { to: '/monitor?tab=history', label: '历史指标', description: '回看容器资源指标的历史曲线与异常', icon: Activity, category: 'history chart metrics 指标 曲线 历史' },
  { to: '/events?tab=operations', label: '操作与任务', description: '审计 Compose、配置和维护操作,跟踪后台任务', icon: History, category: 'history audit 记录 审计 任务 job' },
  { to: '/events', label: '事件中心', description: '统一查看告警事件、运维时间线与操作任务', icon: BellRing, category: 'alert event timeline 事件 告警 时间线' },
  { to: '/review', label: '变更与回滚', description: '部署前 AI 评审变更,出问题后一键回滚', icon: FileSearch, category: 'review rollback change 变更 评审 回滚' },
  { to: '/topology', label: '服务拓扑', description: '查看服务依赖、端口和数据卷关系', icon: Layers, category: 'topology dependencies graph 拓扑 依赖' },
  { to: '/agent/history', label: 'Agent 执行历史', description: '查看工具调用、执行结果与 token 用量', icon: History, category: 'agent history usage 历史 用量' },
  { to: '/ops-center', label: '任务中心', description: '统一查看 Agent、后台任务、工作流、事件、审批和执行结果', icon: Play, category: 'operations command center jobs tasks 运维 任务 agent approval' },
  { to: '/tickets', label: '工单', description: '跟踪持续排障、处置进度和任务记录', icon: Clock3, category: 'ticket task 长期任务 长期 任务 跟进 工单' },
  { to: '/maintenance-plan', label: '运维计划', description: '创建并管理可复用的定时备份、镜像更新和 AI 巡检计划', icon: Clock3, category: 'maintenance schedule 运维 计划 backup images inspection' },
  { to: '/workflows', label: '工作流', description: '创建可复用流程并处理待审批任务', icon: Layers, category: 'workflow automation 自动化 审批' },
  { to: '/cron', label: '定时任务', description: '自动备份、清理与镜像检查', icon: History, category: 'cron schedule 定时 计划 备份' },
  { to: '/gitops', label: 'GitOps', description: '同步仓库并检查配置漂移', icon: FileCode2, category: 'git repository sync 仓库 同步 漂移' },
  { to: '/cmdb', label: '资产中心', description: '查看主机、项目与容器资产', icon: Boxes, category: 'cmdb inventory 资产' },
  { to: '/node-groups', label: '节点组', description: '按组管理 Docker 节点', icon: Layers, category: 'host group fleet 节点 主机 分组' },
  { to: '/marketplace', label: '应用市场', description: '发现、收藏和部署应用模板', icon: Store, category: 'marketplace app store 模板 应用 市场' },
  { to: '/resources', label: '存储清理', description: '管理镜像、卷、网络与数据卷备份', icon: Boxes, category: 'storage volume image network 存储 清理 备份' },
  { to: '/cost', label: '成本分析', description: '分析项目与镜像的资源占用', icon: ChartNoAxesCombined, category: 'cost resource 成本 分析' },
  { to: '/settings', label: '系统设置', description: '配置通知、更新、AI 与项目纳管', icon: Settings, category: 'notification maintenance mounts 设置' },
  { to: '/settings?tab=mounts', label: '项目纳管', description: '选择允许控制和编辑 Compose 的项目', icon: Boxes, category: 'permission mount compose 权限 目录' },
  { to: '/settings?tab=notifications', label: '异常通知', description: '设置容器、内存和存储告警渠道', icon: Settings, category: 'alert webhook telegram email 告警' },
  { to: '/settings?tab=maintenance', label: 'Docker 维护', description: '检查镜像更新并清理可回收空间', icon: Settings, category: 'prune image update cleanup 清理 镜像' },
  { to: '/maintenance', label: '完整备份', description: '备份项目配置和数据，预览恢复范围并跟踪恢复结果', icon: HardDrive, category: 'backup restore full 完整备份 恢复 迁移' },
  { to: '/oncall', label: 'AI 值守', description: '持续观测异常、关联事件并跟踪处置', icon: ShieldCheck, category: 'oncall guardian 值守 故障 事件' },
  { to: '/reliability', label: '应用可靠性', description: '应用接入、发布验收、恢复演练与可靠性目标', icon: Activity, category: 'sre reliability 应用可靠性 发布 恢复 演练' },
];

function page(to, label) {
  const definition = commandDefinitions.find(item => item.to === to);
  if (!definition) throw new Error(`Missing navigation definition: ${to}`);
  return { ...definition, label };
}
export const primaryItems = [
  page('/dashboard', '总览'),
  page('/services', '服务'),
  page('/compose', '配置'),
  page('/logs', '日志'),
  page('/agent', 'AI 助手'),
];
export const navGroups = [
  {
    label: '观测',
    items: [
      page('/oncall', 'AI 值守'),
      page('/reliability', '应用可靠性'),
      page('/topology', '拓扑'),
      page('/monitor', '实时监控'),
      page('/events', '事件中心'),
      page('/inspection', 'AI 巡检'),
      page('/agent/history', 'Agent 执行历史'),
    ],
  },
  {
    label: '自动化',
    items: [
      page('/ops-center', '任务中心'),
      page('/gitops', 'GitOps'),
      page('/review', '变更与回滚'),
    ],
  },
  {
    label: '资源',
    items: [
      page('/cmdb', '资产中心'),
      page('/node-groups', '节点组'),
      page('/marketplace', '应用市场'),
      page('/maintenance', '完整备份'),
      page('/resources', '存储清理'),
      page('/cost', '成本分析'),
    ],
  },
  {
    label: '系统',
    items: [
      page('/shell', '终端'),
      page('/settings', '设置'),
    ],
  },
];

export const pageCommands = commandDefinitions.map(item => {
  const navigation = [...primaryItems, ...navGroups.flatMap(group => group.items)].find(page => page.to === item.to);
  return { ...item, category: `${item.category} ${navigation?.label || ''}` };
});
