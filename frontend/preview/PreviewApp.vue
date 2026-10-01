<template>
  <div class="preview-site">
    <div class="demo-banner"><span class="demo-pulse"></span>交互预览 · 全部为示例数据，不连接 Docker 或 AI 服务</div>
    <header class="preview-header">
      <a href="#overview" class="brand" aria-label="ComposeOps 预览首页"><span class="brand-mark"><Boxes :size="23" /></span><span>Compose<span class="brand-accent">Ops</span><small>个人服务器的运维工作台</small></span></a>
      <div class="header-actions"><a :href="repo" target="_blank" rel="noopener noreferrer" class="quiet-link"><Github :size="17" />GitHub</a><button class="demo-button primary" @click="installOpen = true"><Download :size="16" />安装到我的服务器</button></div>
    </header>

    <section class="preview-hero">
      <div><p class="eyebrow">看见问题，也看清下一步</p><h1>让每一次 Docker 运维<br>都有依据。</h1><p class="hero-description">服务、日志与 AI 排障汇集一处。查看证据、确认操作，再检查结果。<br class="desktop-break">先用这个演示，走一遍自己的运维日常。</p></div>
      <div class="hero-note"><ShieldCheck :size="26" /><div><strong>决定权，始终在你手里</strong><p>单用户、自托管。AI 运维操作受权限与审批策略约束。</p><button class="text-action" @click="navigate('agent')">体验一次排障流程 <ArrowUpRight :size="15" /></button></div></div>
    </section>

    <div class="demo-window">
      <aside class="demo-sidebar">
        <div class="workspace-label">示例工作区 <span>DEMO</span></div>
        <nav aria-label="演示导航">
          <a v-for="item in pages" :key="item.id" :href="'#' + item.id" :class="{ selected: page === item.id }" :aria-current="page === item.id ? 'page' : undefined"><component :is="item.icon" :size="18" /><span>{{ item.label }}</span><ChevronRight :size="14" class="nav-chevron" /></a>
        </nav>
        <div class="sidebar-environment"><Server :size="17" /><div><strong>homelab-demo</strong><small>虚构主机 · 本地演示</small></div></div>
      </aside>

      <main class="demo-main">
        <div class="workspace-header"><div><p class="eyebrow">工作区 / {{ currentPage.label }}</p><h2>{{ currentPage.title }}</h2></div><button class="reset-button" @click="resetDemo"><RotateCcw :size="15" />重置演示</button></div>
        <p class="view-description">{{ currentPage.description }}</p>

        <template v-if="page === 'overview'">
          <div class="demo-metrics">
            <div><span>Compose 项目</span><strong>4<small>个</small></strong><p>均已纳入示例工作区</p></div>
            <div><span>运行中的服务</span><strong>{{ repaired ? 4 : 3 }}<small>/ 4</small></strong><p><span class="status-dot-demo" :class="{ warning: !repaired }"></span>{{ repaired ? '所有示例服务运行中' : '1 个服务需要关注' }}</p></div>
            <div><span>待处理告警</span><strong :class="{ amber: !repaired }">{{ repaired ? 0 : 1 }}<small>条</small></strong><p>{{ repaired ? '排障演示已完成' : '数据库连接失败' }}</p></div>
            <div><span>最近备份</span><strong class="metric-text">今天<small>09:40</small></strong><p>{{ backupVerified ? '已完成模拟演练' : '归档待演练' }}</p></div>
          </div>
          <div class="overview-grid">
            <section class="demo-card incident-card">
              <div class="card-heading"><h3><component :is="repaired ? CheckCircle2 : AlertTriangle" :size="18" />{{ repaired ? '问题已在演示中解决' : '有一项服务需要你的关注' }}</h3><span class="pill" :class="repaired ? 'green' : 'amber-pill'">{{ repaired ? '已验证' : '待诊断' }}</span></div>
              <strong class="incident-title">wiki-api {{ repaired ? '恢复运行' : '无法连接数据库' }}</strong>
              <p>{{ repaired ? '模拟流程已完成配置修正、服务重建与健康检查。真实环境请以实际验收结果为准。' : '容器连续退出，日志报告数据库主机无法解析。可以让 AI 先读取证据，再提出修复建议。' }}</p>
              <div class="incident-meta"><span><Clock3 :size="14" />示例时间 09:42</span><span>项目 knowledge-base</span></div>
              <button class="demo-button primary" @click="navigate('agent')"><Bot :size="16" />{{ repaired ? '查看排障过程' : '让 AI 分析这个问题' }}<ArrowRight :size="15" /></button>
            </section>
            <section class="demo-card resource-card">
              <div class="card-heading"><h3>资源概览</h3><span class="muted">示例快照</span></div>
              <div class="resource-row"><span>CPU</span><strong>18%</strong></div><div class="meter"><span style="width:18%"></span></div>
              <svg class="sparkline" viewBox="0 0 320 60" role="img" aria-label="示例 CPU 趋势，约 18%"><path d="M0 46 L20 42 L40 48 L60 35 L80 39 L100 20 L120 33 L140 27 L160 38 L180 30 L200 34 L220 19 L240 29 L260 20 L280 25 L300 15 L320 23" fill="none" stroke="currentColor" stroke-width="2" /></svg>
              <div class="resource-row"><span>内存</span><strong>3.4 / 8 GB</strong></div><div class="meter blue"><span style="width:42%"></span></div>
              <p>正式部署可查看宿主与容器的实时指标和历史变化。</p>
            </section>
          </div>
          <section class="demo-card activity-card"><div class="card-heading"><h3>工作区动态</h3><span class="muted">演示时间线</span></div>
            <div v-for="event in activity" :key="event.title" class="activity-row"><span class="activity-icon"><component :is="event.icon" :size="16" /></span><div><strong>{{ event.title }}</strong><p>{{ event.detail }}</p></div><time>{{ event.time }}</time></div>
          </section>
        </template>

        <template v-else-if="page === 'services'">
          <div class="service-toolbar"><label class="demo-search"><Search :size="17" /><input v-model="search" aria-label="搜索示例服务" placeholder="搜索服务或镜像…" /></label><span class="muted">{{ filteredServices.length }} 个示例服务</span></div>
          <div class="demo-card services-list">
            <div v-for="service in filteredServices" :key="service.name" class="service-row">
              <span class="service-icon"><component :is="service.icon" :size="21" /></span><div class="service-identity"><strong>{{ service.name }}</strong><code>{{ service.image }}</code></div><span class="pill" :class="service.unhealthy && !repaired ? 'amber-pill' : 'green'">{{ service.unhealthy && !repaired ? '异常退出' : '运行中' }}</span><button class="demo-button secondary" @click="selectedService = service"><ScrollText :size="15" />查看日志</button>
            </div>
            <p v-if="!filteredServices.length" class="empty-demo">没有找到匹配的服务。试试搜索 redis 或 wiki。</p>
          </div>
          <div class="context-note"><Info :size="17" /><p>正式部署会自动发现 Compose 项目。先查看状态，再按项目开启纳管与配置权限。</p></div>
        </template>

        <template v-else-if="page === 'agent'">
          <div class="agent-layout">
            <section class="demo-card conversation">
              <div class="card-heading"><h3><Bot :size="18" />AI 排障演示</h3><span class="pill neutral">预设流程</span></div>
              <div class="user-prompt">wiki-api 一直重启，帮我看看原因。修改前先让我确认。</div>
              <div v-if="agentStage === 'idle'" class="agent-intro"><span class="agent-mark"><Sparkles :size="25" /></span><h3>从证据出发</h3><p>这个预设示例展示一次排障如何经过<br>读取日志、分析配置、请求审批和结果验证。</p><button class="demo-button primary" @click="agentStage = 'evidence'"><Play :size="15" />开始演示排查</button></div>
              <template v-else>
                <div class="assistant-answer"><span class="assistant-label"><Bot :size="16" />演示诊断</span><p>日志中的数据库主机名是 <code>db-old</code>，而 Compose 中的服务名是 <code>postgres</code>。两者不一致，导致 wiki-api 连接失败。</p><pre>getaddrinfo ENOTFOUND db-old
database connection failed
process exited with code 1</pre><p>建议修正数据库主机名，并只重建 wiki-api。此操作会短暂中断该服务，需要你确认。</p></div>
                <div class="demo-diff"><span>建议变更 · 示例</span><code class="removed">− DB_HOST=db-old</code><code class="added">+ DB_HOST=postgres</code></div>
                <div v-if="!repaired" class="approval-actions"><p v-if="agentStage === 'cancelled'" class="amber">已取消模拟操作，示例服务状态保持原样。</p><button class="demo-button primary" @click="approvalOpen = true"><ShieldCheck :size="16" />查看并确认模拟修复</button><span>确认前不会改变演示状态</span></div>
                <div v-else class="verified-result"><CheckCircle2 :size="20" /><div><strong>模拟修复完成，检查通过</strong><p>wiki-api 运行中 · 数据库连接成功 · 健康检查通过</p><button class="text-action" @click="navigate('services')">查看服务状态 <ArrowRight :size="15" /></button></div></div>
              </template>
            </section>
            <aside class="demo-card trace-card"><h3>操作轨迹</h3><ol><li v-for="(step, index) in traceSteps" :key="step.label" :class="{ completed: step.complete }"><span><Check v-if="step.complete" :size="13" /><template v-else>{{ index + 1 }}</template></span><div><strong>{{ step.label }}</strong><p>{{ step.detail }}</p></div></li></ol><div class="trace-footnote"><LockKeyhole :size="16" /><p>这里没有真实模型请求或服务器操作。正式环境中的结果取决于模型、配置与服务状态。</p></div></aside>
          </div>
        </template>

        <template v-else-if="page === 'backups'">
          <section class="demo-card backup-intro"><span class="backup-symbol"><DatabaseBackup :size="28" /></span><div><h3>备份之后，再验证一次</h3><p>将归档解压到一次性临时卷，检查是否能够读取。演练不覆盖原卷。</p></div></section>
          <div class="demo-card backup-record"><div><span class="eyebrow">示例归档 / 命名卷</span><h3>knowledge-base_uploads</h3><code>uploads-2026-10-01.tar.gz</code><p class="muted">今天 09:40 · 24.6 MB · homelab-demo</p></div><div class="backup-actions"><span class="pill" :class="backupVerified ? 'green' : 'neutral'">{{ backupVerified ? '模拟演练通过 · 128 个文件' : '尚未演练' }}</span><button class="demo-button secondary" :disabled="backupVerified" @click="verifyBackup"><ShieldCheck :size="16" />{{ backupVerified ? '已完成模拟演练' : '模拟还原演练' }}</button></div></div>
          <div v-if="backupVerified" class="verified-result"><CheckCircle2 :size="20" /><div><strong>演示流程：归档读取 → 临时卷解压 → 检查 → 清理</strong><p>这是预设结果，未创建任何文件或 Docker 卷。</p></div></div>
          <div class="context-note"><Info :size="18" /><p>归档可解压不等于数据库业务一致。数据库应使用原生 Dump 或协调停写；ComposeOps 自身的 SQLite 提供在线一致性备份命令。<a :href="repo + '/blob/main/docs/public/BACKUP_RESTORE.md'" target="_blank" rel="noopener noreferrer">阅读备份与恢复指南 <ArrowUpRight :size="13" /></a></p></div>
        </template>
      </main>
    </div>
    <footer class="preview-footer"><span>ComposeOps · 单用户 · 自托管 · MIT</span><p>预览展示 main 分支的精选交互，具体能力请查看对应版本说明。</p><a :href="repo + '#-快速开始'" target="_blank" rel="noopener noreferrer">安装文档 <ArrowUpRight :size="14" /></a></footer>
    <p v-if="notice" class="demo-toast" role="status"><CheckCircle2 :size="17" />{{ notice }}</p>

    <BaseModal :show="installOpen" title="部署到自己的服务器" size-class="sm:max-w-xl" body-class="p-5 space-y-4" @close="installOpen = false">
      <p class="text-sm text-surface-300">需要 Docker Engine 与 Compose v2。下面的命令使用当前稳定版；main 新功能可按源码构建方式体验。</p>
      <pre class="install-command">{{ installCommand }}</pre>
      <p class="text-sm text-surface-400">启动后打开 <code>http://服务器IP:28765</code>，设置管理员密码，再选择要纳管的项目。AI 配置可稍后完成。</p>
      <p class="text-xs leading-5 text-amber-300">正式部署需要访问 Docker Socket，请在可信网络中使用。公网访问建议通过 VPN 或 HTTPS 反向代理。</p>
      <a class="text-action" :href="repo + '#-快速开始'" target="_blank" rel="noopener noreferrer">完整安装与升级说明 <ArrowUpRight :size="15" /></a>
      <template #footer><button class="demo-button secondary" @click="copyInstall">{{ copied ? '已复制' : '复制安装命令' }}</button><button class="demo-button primary" @click="installOpen = false">知道了</button></template>
    </BaseModal>
    <BaseModal :show="!!selectedService" :title="(selectedService?.name || '') + ' · 示例日志'" size-class="sm:max-w-2xl" body-class="p-5 space-y-4" @close="selectedService = null"><p class="text-sm text-surface-400">以下为预设示例，不是实时服务器日志。</p><pre class="log-output">{{ serviceLogs }}</pre><button v-if="selectedService?.unhealthy && !repaired" class="demo-button primary" @click="selectedService = null; navigate('agent')"><Bot :size="15" />带着日志进入排障演示</button></BaseModal>
    <ConfirmDialog :show="approvalOpen" title="确认模拟修复" message="演示将把 wiki-api 的数据库主机从 db-old 改为 postgres，并模拟重建和健康检查。此处不会访问真实服务器。" tone="warning" confirm-text="确认模拟修复" @confirm="approveRepair" @cancel="approvalOpen = false; agentStage = 'cancelled'" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { Activity, AlertTriangle, ArrowRight, ArrowUpRight, Bot, Boxes, Check, CheckCircle2, ChevronRight, Clock3, Database, DatabaseBackup, Download, Github, Globe, Info, LockKeyhole, Play, RotateCcw, ScrollText, Search, Server, ShieldCheck, Sparkles } from 'lucide-vue-next';
import BaseModal from '../src/components/common/BaseModal.vue';
import ConfirmDialog from '../src/components/common/ConfirmDialog.vue';

const repo = 'https://github.com/StanlySGY/ComposeOps';
const pages = [
  { id: 'overview', label: '总览', icon: Activity, title: '工作区总览', description: '从运行状态和告警开始，找到今天最值得关注的事。' },
  { id: 'services', label: '服务', icon: Boxes, title: '服务与日志', description: '查看示例项目状态，搜索服务，或把异常日志带入 AI 排障。' },
  { id: 'agent', label: 'AI 排障', icon: Bot, title: '分析 → 审批 → 验证', description: '体验一个完整的预设排障流程，了解每一步发生了什么。' },
  { id: 'backups', label: '备份演练', icon: DatabaseBackup, title: '让备份有验证记录', description: '了解还原演练的作用与边界，不必等到故障发生才检查备份。' },
];
const readPage = () => pages.some(item => item.id === location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
const page = ref(readPage());
const updatePage = () => { page.value = readPage(); };
window.addEventListener('hashchange', updatePage);
const navigate = (id) => { location.hash = id; page.value = id; };
const currentPage = computed(() => pages.find(item => item.id === page.value));
const repaired = ref(false), backupVerified = ref(false), agentStage = ref('idle'), search = ref('');
const approvalOpen = ref(false), installOpen = ref(false), selectedService = ref(null), copied = ref(false), notice = ref('');
let noticeTimer;
const services = [
  { name: 'homepage', image: 'nginx:1.28-alpine', icon: Globe },
  { name: 'wiki-api', image: 'example/wiki-api:2.3', icon: Server, unhealthy: true },
  { name: 'postgres', image: 'postgres:17-alpine', icon: Database },
  { name: 'redis', image: 'redis:7.4-alpine', icon: Database },
];
const filteredServices = computed(() => services.filter(item => (item.name + ' ' + item.image).toLowerCase().includes(search.value.trim().toLowerCase())));
const serviceLogs = computed(() => selectedService.value?.unhealthy && !repaired.value
  ? '09:42:01 [INFO] Starting wiki-api\n09:42:02 [ERROR] getaddrinfo ENOTFOUND db-old\n09:42:02 [ERROR] database connection failed\n09:42:03 [INFO] process exited with code 1'
  : '09:42:01 [INFO] Service started\n09:42:02 [INFO] Ready to accept connections\n09:42:10 [INFO] Health check passed');
const activity = computed(() => [
  { title: repaired.value ? 'wiki-api 模拟修复完成' : 'wiki-api 触发健康告警', detail: repaired.value ? '已模拟更新配置与结果验证' : '数据库主机名解析失败，等待诊断', time: '09:42', icon: repaired.value ? CheckCircle2 : AlertTriangle },
  { title: backupVerified.value ? '命名卷模拟演练通过' : '命名卷归档已生成', detail: 'knowledge-base · uploads', time: '09:40', icon: DatabaseBackup },
  { title: '主页服务运行正常', detail: 'homepage · nginx', time: '09:35', icon: Globe },
]);
const traceSteps = computed(() => [
  { label: '读取证据', detail: '容器状态与最近日志', complete: agentStage.value !== 'idle' },
  { label: '核对配置', detail: '定位数据库主机名差异', complete: agentStage.value !== 'idle' },
  { label: '请求审批', detail: repaired.value ? '已确认模拟操作' : '等待管理员确认', complete: repaired.value },
  { label: '执行并验证', detail: '重建目标服务，检查连接', complete: repaired.value },
]);
const installCommand = 'mkdir composeops && cd composeops\ncurl -fsSL https://raw.githubusercontent.com/StanlySGY/ComposeOps/main/deploy/compose.yml -o compose.yml\ndocker compose pull\ndocker compose up -d';
function notify(text) { notice.value = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.value = ''; }, 4000); }
function approveRepair() { approvalOpen.value = false; repaired.value = true; agentStage.value = 'done'; notify('模拟修复与健康检查完成'); }
function verifyBackup() { backupVerified.value = true; notify('模拟还原演练完成，未操作真实数据'); }
function resetDemo() { repaired.value = false; backupVerified.value = false; agentStage.value = 'idle'; search.value = ''; approvalOpen.value = false; selectedService.value = null; notify('演示已重置'); }
async function copyInstall() {
  try { await navigator.clipboard.writeText(installCommand); copied.value = true; }
  catch { notify('浏览器未允许复制，请选择上方命令手动复制'); }
}
onBeforeUnmount(() => { clearTimeout(noticeTimer); window.removeEventListener('hashchange', updatePage); });
</script>
