<template>
  <div class="page-shell">
    <div class="page-header"><div><h1 class="page-title">设置</h1><p class="page-subtitle">个人偏好、通知、更新与维护</p></div></div>
    <div class="tabs-segment">
      <button v-for="item in tabs" :key="item.id" :class="{ active: tab === item.id }" @click="setTab(item.id)"><component :is="item.icon" class="w-4 h-4" />{{ item.label }}</button>
    </div>
    <p v-if="message" class="alert-success">{{ message }}</p><p v-if="error" class="alert-error">{{ error }}</p>

    <section v-if="tab === 'ai'" class="settings-section">
      <AiChannelsPanel v-model:channels="ai.channels" @health-change="refreshChannelHealth" />
      <fieldset class="space-y-4" :disabled="savingAi">
      <h2 class="section-title">通用 AI 设置</h2>
      <div class="ios-group">
        <div class="ios-row">
          <div class="ios-row-main">
            <div class="ios-row-title">故障时自动切换备用渠道</div>
            <div class="ios-row-desc">超时、限流或服务异常时按顺序尝试。已开始输出的回复会明确报错，已完成的操作不会重复执行。连续失败的渠道会暂时跳过，冷却后自动探测。</div>
          </div>
          <label class="toggle-label"><input v-model="ai.failoverEnabled" type="checkbox" aria-label="故障时自动切换备用渠道" /></label>
        </div>
        <div class="ios-row-stack">
          <label class="text-xs font-medium text-surface-400">系统 Prompt</label>
          <textarea v-model="ai.systemPrompt" rows="6" class="input block w-full"></textarea>
        </div>
        <div class="ios-row-stack">
          <h3 class="section-title">联网检索 Grounding</h3>
          <div class="ios-group">
            <div class="ios-row">
              <div class="ios-row-main">
                <div class="ios-row-title">检索后端</div>
                <div class="ios-row-desc">内置检索(GitHub + DuckDuckGo)无需任何配置;需要更强检索质量时可切换 Tavily / Brave / 自托管 SearXNG,失败自动回退内置。</div>
              </div>
              <select v-model="ai.searchProvider" class="input max-w-44!">
                <option v-for="item in (ai.searchProviders || ['builtin'])" :key="item" :value="item">{{ searchProviderLabel(item) }}</option>
              </select>
            </div>
            <div v-if="ai.searchProvider === 'searxng'" class="ios-row-stack">
              <label class="text-xs font-medium text-surface-400">SearXNG Base URL</label>
              <input v-model="ai.searchBaseUrl" class="input" placeholder="https://searx.example.com" />
            </div>
            <div v-else-if="ai.searchProvider !== 'builtin' && ai.searchProvider !== 'duckduckgo'" class="ios-row-stack">
              <label class="text-xs font-medium text-surface-400">检索 API Key</label>
              <input v-model="ai.searchApiKey" type="password" class="input" :placeholder="searchMasked ? '已配置,留空保持不变' : '在此输入 Key'" />
            </div>
          </div>
        </div>
      </div>
      <button class="btn-primary self-start" @click="saveAi"><Save class="w-4 h-4" />{{ savingAi ? '保存中…' : '保存通用设置' }}</button>
      </fieldset>
    </section>

    <section v-if="tab === 'personal'" class="settings-section">
      <h2 class="section-title">界面偏好</h2>
      <div class="ios-group">
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">自动刷新间隔（秒）</div><div class="ios-row-desc">服务、监控等页面的轮询周期,最小 3 秒。</div></div><div class="ios-row-control"><input v-model.number="preferences.refreshInterval" type="number" min="3" max="300" class="input max-w-24! text-center" /></div></div>
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">日志默认行数</div><div class="ios-row-desc">打开日志页时默认拉取的行数,10–5000。</div></div><div class="ios-row-control"><input v-model.number="preferences.logTail" type="number" min="10" max="5000" class="input max-w-24! text-center" /></div></div>
      </div>
      <button class="btn-primary self-start" @click="savePreferences"><Save class="w-4 h-4" />保存偏好</button>
      <h2 class="section-title">修改管理员密码</h2>
      <div class="ios-group">
        <div class="ios-row-stack"><label class="text-xs font-medium text-surface-400">当前密码</label><input v-model="password.currentPassword" type="password" class="input" /></div>
        <div class="ios-row-stack"><label class="text-xs font-medium text-surface-400">新密码</label><input v-model="password.nextPassword" type="password" class="input" /></div>
      </div>
      <button class="btn-secondary self-start" @click="changePassword"><KeyRound class="w-4 h-4" />修改密码</button>
      <h2 class="section-title">数据迁移</h2>
      <div class="ios-group">
        <div class="ios-row">
          <div class="ios-row-main">
            <div class="ios-row-title">导出 / 导入配置</div>
            <div class="ios-row-desc">导出项目备注、偏好、AI 模型设置和最近操作记录。密码、API Key 与通知密钥不包含在导出文件中。</div>
          </div>
          <div class="ios-row-control"><a class="btn-secondary inline-flex" :href="api.exportUrl" download><Download class="w-4 h-4" />导出</a><label class="btn-secondary cursor-pointer"><Upload class="w-4 h-4" />导入<input type="file" accept="application/json" class="hidden" @change="importData" /></label></div>
        </div>
      </div>
    </section>

    <section v-if="tab === 'notifications'" class="settings-section">
      <h2 class="section-title">异常通知</h2>
      <div class="ios-group">
        <div class="ios-row">
          <div class="ios-row-main"><div class="ios-row-title">启用异常通知</div><div class="ios-row-desc">触发时按下方渠道推送,并写入事件中心。</div></div>
          <label class="toggle-label"><input v-model="notifications.enabled" type="checkbox" aria-label="启用异常通知" /></label>
        </div>
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">轮询间隔（秒）</div><div class="ios-row-desc">容器状态巡检周期,最小 30 秒。</div></div><div class="ios-row-control"><input v-model.number="notifications.intervalSeconds" type="number" min="30" class="input max-w-24! text-center" /></div></div>
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">内存告警阈值（%）</div></div><div class="ios-row-control"><input v-model.number="notifications.memoryThreshold" type="number" min="1" max="100" class="input max-w-24! text-center" /></div></div>
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">Docker 空间告警（GB）</div></div><div class="ios-row-control"><input v-model.number="notifications.dockerStorageThresholdGb" type="number" min="1" class="input max-w-24! text-center" /></div></div>
      </div>
      <h2 class="section-title">推送渠道</h2>
      <div v-for="channel in notifications.channels || []" :key="channel.type" class="ios-group mb-4">
        <div class="ios-row">
          <div class="ios-row-main"><div class="ios-row-title">{{ channelLabel(channel.type) }}</div></div>
          <label class="toggle-label"><input v-model="channel.enabled" type="checkbox" :aria-label="channelLabel(channel.type)" /></label>
        </div>
        <template v-if="channel.enabled">
          <div v-if="['bark','wecom','dingtalk','feishu','webhook'].includes(channel.type)" class="ios-row-stack"><label class="text-xs font-medium text-surface-400">通知地址</label><input v-model="channel.endpoint" class="input" placeholder="https://..." /></div>
          <template v-if="channel.type === 'telegram'">
            <div class="ios-row-stack"><label class="text-xs font-medium text-surface-400">Bot Token</label><input v-model="channel.token" type="password" class="input" placeholder="已配置时显示 configured" /></div>
            <div class="ios-row-stack"><label class="text-xs font-medium text-surface-400">Chat ID</label><input v-model="channel.chatId" class="input" /></div>
          </template>
          <template v-if="channel.type === 'email'">
            <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">SMTP 主机</div></div><div class="ios-row-control"><input v-model="channel.smtpHost" class="input max-w-44!" /></div></div>
            <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">端口</div></div><div class="ios-row-control"><input v-model.number="channel.smtpPort" type="number" class="input max-w-24! text-center" /></div></div>
            <div class="ios-row-stack"><label class="text-xs font-medium text-surface-400">用户名 / 密码</label><div class="grid gap-2 sm:grid-cols-2"><input v-model="channel.smtpUser" class="input" /><input v-model="channel.smtpPassword" type="password" class="input" /></div></div>
            <div class="ios-row-stack"><label class="text-xs font-medium text-surface-400">发件人 / 收件人</label><div class="grid gap-2 sm:grid-cols-2"><input v-model="channel.emailFrom" class="input" /><input v-model="channel.emailTo" class="input" /></div></div>
            <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">TLS/SSL</div></div><label class="toggle-label"><input v-model="channel.smtpSecure" type="checkbox" aria-label="TLS/SSL" /></label></div>
          </template>
        </template>
      </div>
      <h2 class="section-title">触发事件</h2>
      <div class="ios-group">
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">容器崩溃退出</div></div><label class="toggle-label"><input v-model="alertEvents" type="checkbox" value="exit" aria-label="容器崩溃退出" /></label></div>
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">OOM 内存溢出</div></div><label class="toggle-label"><input v-model="alertEvents" type="checkbox" value="oom" aria-label="OOM 内存溢出" /></label></div>
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">容器不健康</div></div><label class="toggle-label"><input v-model="alertEvents" type="checkbox" value="unhealthy" aria-label="容器不健康" /></label></div>
      </div>
      <div class="flex gap-2"><button class="btn-primary" @click="saveNotifications"><Save class="w-4 h-4" />保存</button><button class="btn-secondary" @click="testNotifications"><Send class="w-4 h-4" />发送测试</button></div>
    </section>

    <section v-if="tab === 'maintenance'" class="settings-section">
      <div class="flex items-center justify-between"><h2 class="section-title">镜像更新</h2><button class="btn-secondary" :disabled="checkingUpdates" @click="checkUpdates"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': checkingUpdates }" />立即检查</button></div>
      <div class="ios-group">
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">定时拉取并检查更新</div><div class="ios-row-desc">按下方间隔自动拉取镜像并检查更新。</div></div><label class="toggle-label"><input v-model="updates.autoEnabled" type="checkbox" aria-label="定时拉取并检查更新" /></label></div>
        <div class="ios-row"><div class="ios-row-main"><div class="ios-row-title">检查间隔（小时）</div></div><div class="ios-row-control"><input v-model.number="updates.intervalHours" type="number" min="1" max="720" class="input max-w-24! text-center" /></div></div>
      </div><div class="flex flex-wrap items-center gap-3"><button class="btn-primary" @click="saveUpdates"><Save class="w-4 h-4" />保存更新策略</button><span v-if="updates.lastCheck" class="text-muted">上次检查：{{ new Date(updates.lastCheck).toLocaleString() }}</span></div>
      <div v-if="updateSummary.total" class="grid gap-3 sm:grid-cols-3"><StatCard title="已检查镜像" :value="String(updateSummary.total)" sub="最近一次检查"/><StatCard title="发现更新" :value="String(updateSummary.updated)" sub="需重建相关容器"/><StatCard title="检查失败" :value="String(updateSummary.failed)" sub="请检查仓库或网络"/></div>
      <div v-if="updateResults.length" class="space-y-1"><div v-for="item in updateResults" :key="item.image" class="flex justify-between gap-3 text-sm py-1 border-b border-surface-800"><span class="min-w-0 truncate font-mono" :title="item.image">{{ item.image }}</span><span class="shrink-0" :class="item.status === 'updated' ? 'text-amber-400' : item.status === 'failed' ? 'text-rose-400' : 'text-emerald-400'">{{ imageStatusLabel(item.status) }}</span></div></div>
      <div class="border-t border-surface-800 pt-4 space-y-3"><div class="flex items-center justify-between"><h2 class="section-title">Docker 空间</h2><div class="flex items-center gap-2"><button class="icon-btn" title="刷新用量" @click="loadUsage"><RefreshCw class="w-4 h-4" /></button><button class="btn-primary" @click="storageModal = true"><HardDrive class="w-4 h-4" />清理 Hub</button></div></div>
        <div class="card p-3">
          <div class="flex items-center justify-between text-sm"><span class="text-surface-300">磁盘占用</span><span v-if="usage" class="text-muted">{{ formatBytes(usageTotal) }} · 可释放 {{ formatBytes(usageReclaimable) }}</span></div>
          <div v-if="usage" class="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-800"><span class="block h-full rounded-full bg-linear-to-r from-emerald-500 to-teal-400 transition-all duration-500" :style="{ width: usagePercent }"></span></div>
          <p class="mt-2 flex flex-wrap gap-3 text-[11px] text-surface-400"><span>镜像 {{ usage ? formatBytes(usage.images.total) : '—' }}</span><span>缓存 {{ usage ? formatBytes(usage.buildCache.total) : '—' }}</span><span>卷 {{ usage ? formatBytes(usage.volumes.total) : '—' }} · 停止容器 {{ usage ? usage.containers.count : '—' }}</span></p>
        </div>
        <p class="text-sm text-surface-400">打开清理 Hub 可查看分段占用、一键极速安全清理,或深度清理孤儿卷与构建缓存(需二次确认)。</p></div></section>

    <section v-if="tab === 'mounts'" class="settings-section">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div><h2 class="section-title">Compose 项目纳管</h2><p class="text-sm text-surface-400 mt-1">自动发现的项目默认没有操作权限，只有明确勾选并应用后才加入管理。</p></div>
        <button class="btn-secondary" :disabled="mountLoading" @click="loadMountPlan"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': mountLoading }" />重新扫描</button>
      </div>

      <div v-if="mountPlan" class="grid sm:grid-cols-4 gap-2">
        <StatCard title="已发现" :value="String(mountPlan.summary?.total || 0)" sub="Compose 项目" />
        <StatCard title="已纳管" :value="String(mountPlan.summary?.managed || 0)" sub="由你明确授权" />
        <StatCard title="Compose 就绪" :value="String(mountPlan.summary?.operable || 0)" sub="可编辑、拉取和创建" />
        <StatCard title="已选 Compose" :value="String(mountPlan.projects.filter((project) => project.managed && project.mountEnabled).length)" sub="按需精确挂载" />
      </div>

      <div v-if="mountPlan" class="space-y-2">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div><h3 class="section-title">选择管理范围</h3><p class="text-xs text-surface-400 mt-1">第一项授权容器控制、日志、终端和 AI 诊断；第二项允许按需挂载该 Compose 目录，启用配置编辑、拉取和创建缺失服务。</p></div>
          <button class="btn-primary" :disabled="mountLoading || !selectionDirty" @click="saveManagement"><ShieldCheck class="w-4 h-4" />应用选择</button>
        </div>
        <p v-if="selectionDirty" class="alert-warning">当前选择尚未应用；保存前不会改变项目权限或 Compose 目录范围。</p>
        <EmptyState v-if="!mountPlan.projects.length" icon="FolderCog" title="暂未发现 Compose 项目" description="重新扫描以发现新的 Docker Compose 项目" action-label="重新扫描" action-icon="RefreshCw" :action-disabled="mountLoading" @action="loadMountPlan" />
        <div v-for="project in mountPlan.projects" :key="project.id" class="card p-3 flex items-start gap-3" :class="{ 'ring-1 ring-amber-500/70': highlightedProjectId === project.id }">
          <div class="flex flex-col gap-2 pt-0.5">
            <label class="toggle-label text-xs whitespace-nowrap" title="允许控制该项目的现有容器"><input v-model="selectedProjectIds" type="checkbox" :value="project.id" class="accent-accent" />纳管</label>
            <label class="toggle-label text-xs whitespace-nowrap" :class="{ 'opacity-40 pointer-events-none': !selectedProjectIds.includes(project.id) }" title="选择后生成同路径目录挂载"><input v-model="selectedMountProjectIds" type="checkbox" :value="project.id" class="accent-accent" :disabled="!selectedProjectIds.includes(project.id)" />Compose</label>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2"><span class="font-mono text-sm">{{ project.projectName }}</span><span class="count-badge">{{ projectAccessLabel(project) }}</span><span class="count-badge">{{ project.containerCount }} 个容器</span></div>
            <div class="text-muted font-mono break-all mt-1">{{ project.workingDir || 'Docker 标签未提供工作目录' }}</div>
          </div>
        </div>
      </div>

      <p v-if="mountPlan?.projects.some((project) => project.editable)" class="alert-success">已勾选的 Compose 项目会按需创建临时工作容器，只挂载对应目录；短时间内切换会复用，空闲约 90 秒后自动销毁，无需重建面板。</p>

      <div v-if="mountPlan?.unsupportedProjects.length" class="space-y-2">
        <h3 class="section-title">已纳管但无法自动规划</h3>
        <div v-for="project in mountPlan.unsupportedProjects" :key="project.id" class="alert-warning">
          <span class="font-mono">{{ project.projectName }}</span>：
          Docker Compose 标签缺少安全的项目绝对路径。请在独立项目目录中使用较新的 <code class="font-mono">docker compose up -d</code> 重新创建该项目。
        </div>
      </div>
    </section>

    <section v-if="tab === 'hosts'" class="settings-section">
      <div class="flex items-center justify-between gap-3">
        <div><h2 class="section-title">Docker 节点纳管</h2><p class="text-sm text-surface-400 mt-1">添加远程 Docker 主机(Local/TCP/SSH),全局切换后所有项目、日志与指标跟随目标节点。</p></div>
        <button class="btn-primary" @click="openHostEditor()"><Server class="w-4 h-4" />添加远程主机</button>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div v-for="host in hostsStore.hosts" :key="host.id" class="card p-3 flex items-start gap-3" :class="{ 'ring-1 ring-emerald-500/60': host.id === hostsStore.activeHostId }">
          <span class="mt-1.5 w-2.5 h-2.5 shrink-0 rounded-full" :class="host.status === 'online' ? 'bg-emerald-400 shadow-glow-emerald' : host.status === 'offline' ? 'bg-rose-400' : 'bg-surface-600'"></span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2"><strong class="font-mono text-sm">{{ host.name }}</strong><span class="count-badge">{{ host.type.toUpperCase() }}</span><span v-if="host.id === hostsStore.activeHostId" class="count-badge text-emerald-300">当前</span></div>
            <div class="mt-1 text-muted font-mono text-xs">{{ host.type === 'local' ? '本机 Docker Socket' : `${host.host}:${host.port}` }}<template v-if="host.latencyMs"> · {{ host.latencyMs }}ms</template><template v-if="host.version"> · v{{ host.version }}</template><template v-if="host.containerCount != null"> · {{ host.containerCount }} 容器</template></div>
            <div class="mt-1 flex flex-wrap gap-1.5">
              <button class="btn-ghost" :disabled="hostsStore.pinging === host.id" @click="pingHost(host)"><Activity class="w-4 h-4" />{{ hostsStore.pinging === host.id ? '检测中' : '测试连接' }}</button>
              <button v-if="host.id !== hostsStore.activeHostId" class="btn-secondary" @click="activate(host)"><Zap class="w-4 h-4" />切换</button>
              <button v-if="!host.builtin" class="btn-ghost" @click="openHostEditor(host)"><Pencil class="w-4 h-4" />编辑</button>
              <button v-if="!host.builtin" class="btn-ghost text-rose-300" @click="removeHost(host)"><Trash2 class="w-4 h-4" />删除</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <BaseModal :show="!!hostEditor" :title="hostEditor?.id ? '编辑远程主机' : '添加远程主机'" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[90vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="hostEditor = null">
      <template v-if="hostEditor">
        <div class="form-grid">
          <label class="md:col-span-2">节点名称<input v-model="hostEditor.name" class="input" placeholder="例如 K8s Worker / 生产机" /></label>
          <label>连接方式<select v-model="hostEditor.type" class="input"><option value="tcp">TCP (Docker API)</option><option value="ssh">SSH</option></select></label>
          <label>端口<input v-model.number="hostEditor.port" type="number" class="input" :placeholder="hostEditor.type === 'ssh' ? '22' : '2375'" /></label>
          <label>主机地址<input v-model="hostEditor.host" class="input" placeholder="192.168.1.10" /></label>
          <label>用户名<input v-model="hostEditor.username" class="input" placeholder="root" /></label>
        </div>
        <template v-if="hostEditor.type === 'ssh'">
          <div class="form-grid">
            <label class="md:col-span-2">SSH 密码<input v-model="hostEditor.password" type="password" class="input" :placeholder="hostEditor.hasPassword ? '已配置,留空保持不变' : '…'" /></label>
            <label class="md:col-span-2">私钥(可选)<textarea v-model="hostEditor.privateKey" rows="4" class="input font-mono" :placeholder="hostEditor.hasPrivateKey ? '已配置,留空保持不变' : '-----BEGIN OPENSSH PRIVATE KEY-----…'"></textarea></label>
          </div>
        </template>
        <template v-else>
          <details class="text-sm"><summary class="cursor-pointer text-surface-300">TLS 客户端证书(可选)</summary>
            <div class="form-grid mt-2">
              <label class="md:col-span-2">CA 证书<textarea v-model="hostEditor.tls.ca" rows="3" class="input font-mono" :placeholder="hostEditor.tls.ca ? '已配置,留空保持不变' : '-----BEGIN CERTIFICATE-----…'"></textarea></label>
              <label class="md:col-span-2">客户端证书<textarea v-model="hostEditor.tls.cert" rows="3" class="input font-mono" placeholder="-----BEGIN CERTIFICATE-----…"></textarea></label>
              <label class="md:col-span-2">客户端私钥<textarea v-model="hostEditor.tls.key" rows="3" class="input font-mono" placeholder="-----BEGIN PRIVATE KEY-----…"></textarea></label>
            </div>
          </details>
        </template>
        <p v-if="hostEditor.pingResult" class="text-sm" :class="hostEditor.pingResult.ok ? 'text-emerald-400' : 'text-rose-400'">{{ hostEditor.pingResult.ok ? `连接成功 · ${hostEditor.pingResult.latencyMs}ms · v${hostEditor.pingResult.version} · ${hostEditor.pingResult.containerCount} 容器` : `连接失败:${hostEditor.pingResult.message}` }}</p>
      </template>
      <template #footer>
        <button class="btn-secondary" :disabled="hostEditor?.pinging" @click="testHostConnection"><Activity class="w-4 h-4" />{{ hostEditor?.pinging ? '检测中…' : '测试连接' }}</button>
        <button class="btn-primary" @click="saveHost"><Save class="w-4 h-4" />保存节点</button>
      </template>
    </BaseModal>
    <StoragePruneModal v-if="storageModal" @close="storageModal = false" @reclaimed="loadUsage" />
    <ConfirmDialog :show="!!removeHostTarget" title="删除 Docker 节点" :message="`确认删除节点 ${removeHostTarget?.name || ''}?删除后不会影响远程主机本身。`" tone="danger" confirm-text="删除节点" @confirm="confirmRemoveHost" @cancel="removeHostTarget = null" />
    <ConfirmDialog :show="managementConfirm" title="取消项目纳管" :message="`将取消 ${removedProjectCount} 个项目的管理权限,相关控制与编辑入口会立即关闭。确认继续?`" tone="warning" confirm-text="确认应用" @confirm="confirmSaveManagement" @cancel="managementConfirm = false" />
    <section v-if="tab === 'mcp'" class="settings-section space-y-4">
      <div class="flex items-center justify-between">
        <div><h2 class="section-title">MCP 服务</h2><p class="mt-1 text-sm text-surface-400">把面板的运维工具通过 MCP 协议暴露给 Claude Desktop、Cursor 等客户端</p></div>
        <label class="toggle-label"><input v-model="mcp.enabled" type="checkbox" @change="saveMcp" />启用</label>
      </div>
      <template v-if="mcp.enabled">
        <div class="form-grid">
          <label>暴露范围
            <select v-model="mcp.mode" class="input" @change="saveMcp">
              <option value="readonly">只读工具(推荐)</option>
              <option value="all">包含高风险工具(不含 critical)</option>
            </select>
          </label>
          <label>当前可调用工具数
            <input class="input" :value="`${mcp.toolsExported} 个`" disabled />
          </label>
        </div>
        <div class="space-y-2 rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-xs">
          <div class="space-y-1.5">
            <p class="text-surface-300">Streamable HTTP(现行标准,推荐):<code class="font-mono text-accent">POST {{ mcp.httpUrl }}</code><span class="ml-2 text-surface-600">Codex CLI / Gemini CLI / 新版 harness</span></p>
            <p class="text-surface-300">SSE(经典传输):<code class="font-mono text-accent">{{ mcp.sseUrl }}</code><span class="ml-2 text-surface-600">Claude Desktop / Cursor</span></p>
            <p class="text-surface-300">stdio 桥(仅 stdio 的客户端):<code class="font-mono text-accent">node mcp/stdio-bridge.mjs</code><span class="ml-2 text-surface-600">环境变量 COMPOSEOPS_URL / COMPOSEOPS_TOKEN</span></p>
          </div>
          <p class="text-surface-500">认证:Authorization: Bearer &lt;token&gt;(HTTP 端点也可 ?token=)· 会话数:{{ mcp.sessionCount }} · 协议:{{ mcp.protocolVersion || '2026-07-28' }} · critical 级工具(清理/部署)任何模式下都不经 MCP 暴露。</p>
          <p class="text-surface-500">高危工具(重建容器、改 Compose、回滚等)在 MCP 通道必须由调用方显式传 <code class="font-mono text-surface-400">confirm: true</code> 才会执行——这条通道没有确认弹窗,用显式开关代替。</p>
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn-secondary py-1.5! text-xs" @click="copyMcpConfig">复制客户端配置</button>
            <button class="btn-secondary py-1.5! text-xs" @click="regenerateMcpToken"><RefreshCw class="h-3.5 w-3.5" />重置 Token</button>
            <button class="btn-secondary py-1.5! text-xs" @click="showMcpToken">查看 Token</button>
          </div>
        </div>
      </template>
      <p v-else class="text-sm text-surface-500">启用后,外部 MCP 客户端可以用独立 Token 安全调用面板工具(默认只读:状态查询、日志、巡检等)。</p>
    </section>
    <section v-if="tab === 'about'" class="settings-section">
      <h2 class="section-title">ComposeOps <span class="count-badge">v{{ capabilities.version || '?' }}</span></h2>
      <p class="text-sm text-surface-400">单用户 Docker Compose 运维台。默认建议仅监听本机或通过 Tailscale 访问。</p>
      <div class="text-sm space-y-1"><p>Web Shell：{{ capabilities.shellEnabled ? '已启用' : '未启用' }}</p><p>环境指标范围：{{ capabilities.hostMetricsScope === 'host' ? '宿主机' : 'ComposeOps 容器' }}</p></div>
      <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-surface-800 pt-4">
        <a class="btn-secondary inline-flex" href="https://github.com/StanlySGY" target="_blank" rel="noopener noreferrer"><Github class="w-4 h-4" />作者 @StanlySGY</a>
        <a class="btn-secondary inline-flex" href="https://github.com/StanlySGY/ComposeOps" target="_blank" rel="noopener noreferrer"><Github class="w-4 h-4" />项目仓库</a>
        <a class="btn-primary inline-flex" href="https://github.com/StanlySGY/ComposeOps/stargazers" target="_blank" rel="noopener noreferrer" title="去 GitHub 给项目点个 Star"><Star class="w-4 h-4" />觉得有用就点个 Star</a>
      </div>
      <p class="mt-2 text-xs text-surface-500">遇到问题或有功能建议,欢迎到仓库提 Issue;如果 ComposeOps 帮到了你,一个 Star 就是最好的鼓励。</p>
    </section>
  </div>
</template>

<script setup>
import { computed, markRaw, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Activity, Bell, Bot, Download, FolderCog, Github, HardDrive, Info, KeyRound, Pencil, Plug, RefreshCw, Save, Send, Server, ShieldCheck, SlidersHorizontal, Star, Trash2, Upload, Wrench, Zap } from 'lucide-vue-next';
import { api } from '../api/client.js'; import { useAiStore } from '../stores/ai.js'; import { useHostsStore } from '../stores/hosts.js'; import StatCard from '../components/StatCard.vue';
import EmptyState from '../components/common/EmptyState.vue';
import StoragePruneModal from '../components/settings/StoragePruneModal.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';
import AiChannelsPanel from '../components/settings/AiChannelsPanel.vue';
const tabs = [{ id: 'ai', label: 'AI', icon: markRaw(Bot) }, { id: 'personal', label: '偏好', icon: markRaw(SlidersHorizontal) }, { id: 'notifications', label: '通知', icon: markRaw(Bell) }, { id: 'maintenance', label: '维护', icon: markRaw(Wrench) }, { id: 'mounts', label: '项目纳管', icon: markRaw(FolderCog) }, { id: 'hosts', label: 'Docker 节点', icon: markRaw(Server) }, { id: 'mcp', label: 'MCP', icon: markRaw(Plug) }, { id: 'about', label: '关于', icon: markRaw(Info) }];
const route = useRoute();
const router = useRouter();
const initialTab = tabs.some((item) => item.id === route.query.tab) ? route.query.tab : 'ai';
const tab = ref(initialTab); const message = ref(''); const error = ref(''); const aiStore = useAiStore(); const hostsStore = useHostsStore(); const ai = ref({ channels: [], failoverEnabled: true }); const searchMasked = ref(false); const savingAi = ref(false); const preferences = ref({ refreshInterval: 5, logTail: 200 }); const password = ref({ currentPassword: '', nextPassword: '' }); const notifications = ref({}); const updates = ref({ autoEnabled: false, intervalHours: 24 }); const updateResults = ref([]); const checkingUpdates = ref(false); const usage = ref(null); const capabilities = ref({}); const storageModal = ref(false); const alertEvents = ref(['exit', 'oom', 'unhealthy']);
const mountPlan = ref(null); const mountLoading = ref(false); const highlightedProjectId = computed(() => String(route.query.projectId || ''));
const hostEditor = ref(null);
const removeHostTarget = ref(null);
const managementConfirm = ref(false);
const removedProjectCount = computed(() => savedManagedProjectIds.value.filter((id) => !selectedProjectIds.value.includes(id)).length);
const updateSummary = computed(() => ({ total: updateResults.value.length, updated: updateResults.value.filter((item) => item.status === 'updated').length, failed: updateResults.value.filter((item) => item.status === 'failed').length }));
const usageTotal = computed(() => Number(usage.value?.total) || 0);
const usageReclaimable = computed(() => Number(usage.value?.reclaimable) || 0);
const usagePercent = computed(() => (usage.value?.total && usage.value?.disk?.free ? Math.min(100, Math.max(2, (usage.value.total / (usage.value.total + usage.value.disk.free)) * 100)) : 2) + '%');
const selectedProjectIds = ref([]); const savedManagedProjectIds = ref([]);
const selectedMountProjectIds = ref([]); const savedMountProjectIds = ref([]);
const managementDirty = computed(() => {
  const selected = [...selectedProjectIds.value].sort(); const saved = [...savedManagedProjectIds.value].sort();
  return selected.length !== saved.length || selected.some((id, index) => id !== saved[index]);
});
const mountsDirty = computed(() => {
  const selected = [...selectedMountProjectIds.value].sort(); const saved = [...savedMountProjectIds.value].sort();
  return selected.length !== saved.length || selected.some((id, index) => id !== saved[index]);
});
const selectionDirty = computed(() => managementDirty.value || mountsDirty.value);
function ok(text) { message.value = text; error.value = ''; } function fail(e) { error.value = e.message; message.value = ''; }
function applyAiConfig(cfg) {
  ai.value = { channels: (cfg.channels || []).map((item) => ({ ...item, apiKey: '', saved: true, dirty: false })),
    failoverEnabled: cfg.failoverEnabled !== false, systemPrompt: cfg.systemPrompt,
    searchProvider: cfg.searchProvider || 'builtin', searchProviders: cfg.searchProviders, searchApiKey: '', searchBaseUrl: cfg.searchBaseUrl || '' };
  searchMasked.value = !!cfg.searchApiKey;
}
async function refreshChannelHealth() {
  try {
    const cfg = await api.getAiConfig();
    ai.value.channels = ai.value.channels.map((channel) => ({ ...channel, health: cfg.channels?.find((item) => item.id === channel.id)?.health }));
  } catch (e) { fail(e); }
}

function openHostEditor(host) {
  hostEditor.value = host ? {
    id: host.id,
    name: host.name,
    type: host.type === 'ssh' ? 'ssh' : 'tcp',
    host: host.host || '',
    port: host.port || (host.type === 'ssh' ? 22 : 2375),
    username: host.username || 'root',
    password: host.hasPassword ? '' : '',
    privateKey: host.hasPrivateKey ? '' : '',
    hasPassword: host.hasPassword,
    hasPrivateKey: host.hasPrivateKey,
    tls: { ca: '', cert: '', key: '' },
    pingResult: null,
    pinging: false,
  } : { id: '', name: '', type: 'tcp', host: '', port: 2375, username: 'root', password: '', privateKey: '', hasPassword: false, hasPrivateKey: false, tls: { ca: '', cert: '', key: '' }, pingResult: null, pinging: false };
}
async function testHostConnection() {
  const editor = hostEditor.value;
  if (!editor) return;
  editor.pinging = true;
  editor.pingResult = null;
  try {
    const payload = editorToPayload(editor);
    const result = await api.pingHost('_probe', payload);
    editor.pingResult = { ok: result.ok, latencyMs: result.latencyMs, version: result.version, message: result.message };
  } catch (e) {
    editor.pingResult = { ok: false, message: e.message };
  } finally {
    editor.pinging = false;
  }
}
function editorToPayload(editor) {
  const payload = {
    id: editor.id || undefined,
    name: editor.name,
    type: editor.type,
    host: editor.host,
    port: editor.port,
    username: editor.username,
  };
  if (editor.type === 'tcp' && (editor.tls?.ca || editor.tls?.cert || editor.tls?.key)) {
    payload.tls = { ca: editor.tls.ca, cert: editor.tls.cert, key: editor.tls.key };
  }
  if (editor.type === 'ssh') {
    if (editor.password) payload.password = editor.password;
    if (editor.privateKey) payload.privateKey = editor.privateKey;
  }
  return payload;
}
async function saveHost() {
  const editor = hostEditor.value;
  if (!editor) return;
  try {
    if (!editor.name.trim()) throw new Error('节点名称不能为空');
    if (editor.type !== 'local' && !editor.host.trim()) throw new Error('请填写主机地址');
    await hostsStore.addOrUpdate(editorToPayload(editor));
    hostEditor.value = null;
    ok('Docker 节点已保存');
  } catch (e) { fail(e); }
}
async function pingHost(host) {
  try {
    await hostsStore.ping(host.id);
    ok(`节点 ${host.name} 连接正常`);
  } catch (e) { fail(e); }
}
async function activate(host) {
  try {
    await hostsStore.switchHost(host.id);
    ok(`已切换到节点 ${host.name},项目列表将自动刷新`);
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
  } catch (e) { fail(e); }
}
async function removeHost(host) {
  removeHostTarget.value = host;
}
async function confirmRemoveHost() {
  const host = removeHostTarget.value;
  removeHostTarget.value = null;
  if (!host) return;
  try {
    await hostsStore.remove(host.id);
    ok('节点已删除');
  } catch (e) { fail(e); }
}

onMounted(async () => { try { await aiStore.loadConfig(); applyAiConfig(aiStore.config); const [prefs, notificationConfig, updateConfig, systemCapabilities, plan] = await Promise.all([api.getPreferences(), api.getNotifications(), api.getUpdateSettings(), api.getCapabilities(), api.getMountPlan()]); preferences.value = prefs; void hostsStore.load(); notifications.value = notificationConfig; updates.value = updateConfig; updateResults.value = updateConfig.lastResults || []; capabilities.value = systemCapabilities; applyMountPlan(plan); await loadUsage(); try { const ev = await api.getNotificationEvents(); alertEvents.value = ev.events || ['exit', 'oom', 'unhealthy']; } catch (e) { /* 忽略事件回填失败 */ } } catch (e) { fail(e); } });
async function saveAi() {
  if (savingAi.value) return;
  savingAi.value = true;
  try {
    const { systemPrompt, failoverEnabled, searchProvider, searchApiKey, searchBaseUrl } = ai.value;
    const payload = { systemPrompt, failoverEnabled, searchProvider, searchBaseUrl };
    if (searchApiKey) payload.searchApiKey = searchApiKey;
    await aiStore.saveConfig(payload);
    searchMasked.value = !!aiStore.config.searchApiKey;
    ai.value.searchApiKey = '';
    ok('通用 AI 设置已保存');
  } catch (e) { fail(e); }
  finally { savingAi.value = false; }
}
function searchProviderLabel(value) {
  return { builtin: '内置(GitHub + DuckDuckGo)', duckduckgo: 'DuckDuckGo', tavily: 'Tavily', brave: 'Brave Search', searxng: 'SearXNG(自托管)' }[value] || value;
}
async function savePreferences() { try { preferences.value = await api.savePreferences(preferences.value); ok('个人偏好已保存'); } catch (e) { fail(e); } }
async function changePassword() { try { if (password.value.nextPassword.length < 10) throw new Error('新密码至少需要 10 个字符'); await api.changePassword(password.value); password.value = { currentPassword: '', nextPassword: '' }; ok('管理员密码已修改，其他会话已退出'); } catch (e) { fail(e); } }
async function importData(event) { try { const file = event.target.files?.[0]; if (!file) return; await api.importData(JSON.parse(await file.text())); ok('设置与项目备注已导入，刷新页面后生效'); event.target.value = ''; } catch (e) { fail(e); } }
function channelLabel(type) {
  return { bark: 'Bark', telegram: 'Telegram', wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书', email: '邮件 SMTP', webhook: '通用 Webhook' }[type] || type;
}
const mcp = ref({ enabled: false, mode: 'readonly', token: '', configured: false, sseUrl: '/mcp/sse', sessionCount: 0, toolsExported: 0 });
async function loadMcp() {
  try { mcp.value = { ...mcp.value, ...(await api.getMcpConfig()) }; } catch (e) { /* MCP 配置读取失败时保持默认 */ }
}
async function saveMcp() {
  try { mcp.value = { ...mcp.value, ...(await api.saveMcpConfig({ enabled: mcp.value.enabled, mode: mcp.value.mode })) }; ok(mcp.value.enabled ? 'MCP 服务已启用' : 'MCP 服务已关闭'); } catch (e) { fail(e); }
}
async function regenerateMcpToken() {
  try { mcp.value = { ...mcp.value, ...(await api.saveMcpConfig({ regenerateToken: true })) }; ok('Token 已重置,旧 Token 立即失效'); } catch (e) { fail(e); }
}
async function showMcpToken() {
  try { const { token } = await api.revealMcpToken(); if (token) { await navigator.clipboard.writeText(token).catch(() => {}); ok(`Token 已复制到剪贴板:${token.slice(0, 6)}••••`); } } catch (e) { fail(e); }
}
async function copyMcpConfig() {
  try {
    const { token } = await api.revealMcpToken();
    const origin = window.location.origin;
    const config = { mcpServers: { composeops: { url: `${origin}${mcp.value.httpUrl || '/mcp'}`, headers: { Authorization: `Bearer ${token}` } } } };
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    ok('MCP 客户端配置 JSON 已复制(Streamable HTTP)');
  } catch (e) { fail(e); }
}
async function saveNotifications() { try { notifications.value = await api.saveNotifications({ ...notifications.value, events: alertEvents.value }); await api.saveNotificationEvents(alertEvents.value); ok('通知配置已保存'); } catch (e) { fail(e); } }
async function testNotifications() { try { await api.testNotifications(notifications.value); ok('测试通知已发送'); } catch (e) { fail(e); } }
async function saveUpdates() { try { updates.value = await api.saveUpdateSettings(updates.value); ok('更新策略已保存'); } catch (e) { fail(e); } }
async function checkUpdates() { checkingUpdates.value = true; try { updateResults.value = (await api.checkUpdates()).results; updates.value.lastCheck = Date.now(); updates.value.lastResults = updateResults.value; ok('镜像检查完成'); } catch (e) { fail(e); } finally { checkingUpdates.value = false; } }
async function loadUsage() { try { usage.value = await api.getStorageDf(); } catch (e) { fail(e); } }
function applyMountPlan(plan) {
  mountPlan.value = plan;
  savedManagedProjectIds.value = plan.projects.filter((project) => project.managed).map((project) => project.id);
  savedMountProjectIds.value = plan.projects.filter((project) => project.managed && project.mountEnabled).map((project) => project.id);
  selectedProjectIds.value = [...savedManagedProjectIds.value];
  selectedMountProjectIds.value = [...savedMountProjectIds.value];
}
async function loadMountPlan() { mountLoading.value = true; try { applyMountPlan(await api.getMountPlan()); ok('项目与权限状态已重新扫描'); } catch (e) { fail(e); } finally { mountLoading.value = false; } }
async function saveManagement() {
  if (removedProjectCount.value) { managementConfirm.value = true; return; }
  await confirmSaveManagement();
}
async function confirmSaveManagement() {
  managementConfirm.value = false;
  mountLoading.value = true;
  try {
    selectedMountProjectIds.value = selectedMountProjectIds.value.filter((id) => selectedProjectIds.value.includes(id));
    await api.saveProjectManagement(selectedProjectIds.value, selectedMountProjectIds.value);
    applyMountPlan(await api.getMountPlan());
    ok('管理与 Compose 目录选择已更新');
  }
  catch (e) { fail(e); } finally { mountLoading.value = false; }
}
function projectAccessLabel(project) { if (!project.managed) return '未纳管'; if (!project.mountEnabled) return '仅管理容器'; if (project.editable) return project.mounted ? 'Compose 直连' : 'Compose 按需'; return 'Compose 路径需处理'; }
function imageStatusLabel(status) { return ({ updated: '已拉取，待应用', current: '已是最新', failed: '检查失败' })[status] || status; }
function formatBytes(value = 0) { const units = ['B','KB','MB','GB','TB']; let n = value; let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; }
function setTab(next) {
  tab.value = next;
  const query = { ...route.query };
  if (next === 'ai') delete query.tab;
  else query.tab = next;
  router.replace({ query });
  if (next === 'mcp') loadMcp();
}
watch(() => route.query.tab, (value) => { tab.value = tabs.some((item) => item.id === value) ? value : 'ai'; });
watch(selectedProjectIds, (ids) => { selectedMountProjectIds.value = selectedMountProjectIds.value.filter((id) => ids.includes(id)); }, { deep: true });
</script>
