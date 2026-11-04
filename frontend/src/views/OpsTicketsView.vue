<template>
  <div class="page-shell ops-ticket-workspace" :aria-busy="loading || saving">
    <div class="page-header">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="page-title">长期运维任务</h1>
          <span class="rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-sky-300">TICKETS · MANDATES · REPORTS</span>
        </div>
        <p class="page-subtitle">任务独立于 Agent 会话；执行可交接、授权可追溯、结果必须经过证据验收。</p>
      </div>
      <div class="page-actions flex-wrap">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button>
        <button class="btn-secondary" @click="router.push('/ops-center')"><Activity class="h-4 w-4" />执行态势</button>
        <button class="btn-primary" @click="showTicketForm = !showTicketForm"><Plus class="h-4 w-4" />新建长期任务</button>
      </div>
    </div>

    <div v-if="error" class="alert-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200" role="status">{{ notice }}</div>

    <section class="grid gap-3 grid-cols-2 xl:grid-cols-4" aria-label="长期任务概况">
      <div class="card p-3 sm:p-4"><p class="text-xs text-surface-500">进行中任务</p><p class="mt-1 text-2xl font-semibold tabular-nums text-surface-100">{{ stats.open || 0 }}</p></div>
      <div class="card p-3 sm:p-4"><p class="text-xs text-surface-500">阻塞等待</p><p class="mt-1 text-2xl font-semibold tabular-nums text-amber-300">{{ stats.blocked || 0 }}</p></div>
      <div class="card p-3 sm:p-4"><p class="text-xs text-surface-500">等待验收</p><p class="mt-1 text-2xl font-semibold tabular-nums text-sky-300">{{ stats.review || 0 }}</p></div>
      <div class="card p-3 sm:p-4"><p class="text-xs text-surface-500">已结束任务</p><p class="mt-1 text-2xl font-semibold tabular-nums text-surface-300">{{ stats.terminal || 0 }}</p></div>
    </section>

    <section v-if="showTicketForm" class="section-panel">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div><h2 class="section-title">创建独立任务</h2><p class="mt-1 text-muted">先定义目标和验收标准，不会自动启动 Agent 或执行操作。</p></div>
        <button class="icon-btn" aria-label="关闭创建表单" @click="showTicketForm = false"><X class="h-4 w-4" /></button>
      </div>
      <form class="grid gap-3 md:grid-cols-2" @submit.prevent="createTicket">
        <label class="form-grid-label md:col-span-2"><span>任务标题</span><input v-model="ticketForm.title" class="input" maxlength="200" required placeholder="例如：检查 staging 所有 Compose 服务并形成更新计划" /></label>
        <label class="form-grid-label md:col-span-2"><span>目标与背景</span><textarea v-model="ticketForm.description" class="input min-h-20" maxlength="8000" placeholder="说明要解决的问题、边界和已知情况。" /></label>
        <label class="form-grid-label"><span>优先级</span><select v-model="ticketForm.priority" class="input"><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label>
        <label class="form-grid-label"><span>来源</span><select v-model="ticketForm.sourceType" class="input"><option value="manual">手动创建</option><option value="event">事件</option><option value="inspection">巡检</option><option value="agent">Agent</option><option value="workflow">工作流</option></select></label>
        <label class="form-grid-label"><span>项目 ID（可选）</span><input v-model="ticketForm.projectId" class="input" maxlength="160" placeholder="project-id" /></label>
        <label class="form-grid-label"><span>Host ID（可选）</span><input v-model="ticketForm.hostId" class="input" maxlength="160" placeholder="host-id" /></label>
        <label class="form-grid-label md:col-span-2"><span>来源记录 ID（可选）</span><input v-model="ticketForm.sourceId" class="input" maxlength="160" placeholder="event-id / inspection-id / agent-plan-id" /></label>
        <label class="form-grid-label md:col-span-2"><span>验收标准（每行一条）</span><textarea v-model="ticketForm.acceptanceCriteria" class="input min-h-20" placeholder="有明确证据证明检查范围完整&#10;提交结构化报告并等待人工验收" /></label>
        <div class="md:col-span-2 flex flex-wrap justify-end gap-2"><button type="button" class="btn-secondary" @click="showTicketForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving || !ticketForm.title.trim()"><Plus class="h-4 w-4" />创建任务</button></div>
      </form>
    </section>

    <section class="grid min-w-0 gap-4 xl:grid-cols-[330px_minmax(0,1fr)]">
      <aside class="card min-w-0 overflow-hidden">
        <div class="border-b border-surface-800 p-3">
          <form class="space-y-2" @submit.prevent="load">
            <label class="search-field"><Search class="h-4 w-4" /><input v-model="query" aria-label="搜索长期任务" placeholder="搜索任务、项目或 ID" /></label>
            <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <select v-model="statusFilter" class="input min-h-9! text-xs" aria-label="按长期任务状态筛选">
                <option value="">全部状态</option><option value="planning">规划中</option><option value="ready">待派工</option><option value="active">执行中</option><option value="blocked">阻塞</option><option value="review">待验收</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option>
              </select>
              <button type="submit" class="btn-secondary min-h-9! px-3! text-xs!" :disabled="loading">筛选</button>
            </div>
          </form>
          <div class="mt-2 flex items-center justify-between text-[11px] text-surface-500"><span>{{ tickets.length }} 条长期任务</span><span>按需要关注程度排序</span></div>
        </div>
        <div v-if="loading && !tickets.length" class="p-6 text-center text-sm text-surface-500">正在加载…</div>
        <div v-else-if="!tickets.length" class="p-6 text-center">
          <ClipboardList class="mx-auto mb-2 h-7 w-7 text-surface-600" />
          <p class="text-sm font-medium text-surface-300">暂无长期任务</p>
          <p class="mt-1 text-xs text-surface-500">创建 Ticket 后，执行记录将不再依赖某一个聊天会话。</p>
        </div>
        <div v-else class="max-h-[72vh] overflow-y-auto">
          <button v-for="item in tickets" :key="item.id" class="block w-full border-b border-surface-800/80 p-3 text-left transition hover:bg-surface-800/30" :class="{ 'bg-surface-800/55': selectedTicketId === item.id }" @click="selectTicket(item.id)">
            <div class="flex items-start justify-between gap-2">
              <span class="min-w-0 text-sm font-semibold text-surface-100">{{ item.title }}</span>
              <span class="status-badge shrink-0" :class="ticketTone(item.status)">{{ ticketLabel(item.status) }}</span>
            </div>
            <p class="mt-1 line-clamp-2 text-xs text-surface-500">{{ item.description || item.projectId || '未添加说明' }}</p>
            <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-surface-500">
              <span>{{ priorityLabel(item.priority) }}</span><span>{{ item.assignmentCount }} 次派工</span>
              <span v-if="item.pendingReports" class="text-sky-300">{{ item.pendingReports }} 份待验收</span>
              <span v-if="item.attentionEffects" class="text-amber-300">{{ item.attentionEffects }} 项需处理</span>
            </div>
          </button>
        </div>
      </aside>

      <div class="min-w-0 space-y-4">
        <div v-if="!selectedTicket" class="card flex min-h-80 flex-col items-center justify-center p-8 text-center">
          <ClipboardList class="mb-3 h-9 w-9 text-surface-600" />
          <h2 class="text-base font-semibold text-surface-200">选择一个长期任务</h2>
          <p class="mt-1 max-w-md text-sm text-surface-500">查看授权版本、执行派工、结构化报告和持久化副作用意图。一个任务可以经历多个 Session 和 Worker。</p>
        </div>

        <template v-else>
          <section class="card p-4 sm:p-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <span class="status-badge" :class="ticketTone(selectedTicket.status)">{{ ticketLabel(selectedTicket.status) }}</span>
                  <span class="count-badge">{{ priorityLabel(selectedTicket.priority) }}</span>
                  <span class="count-badge">{{ sourceLabel(selectedTicket.sourceType) }}</span>
                </div>
                <h2 class="break-words text-lg font-semibold text-surface-100">{{ selectedTicket.title }}</h2>
                <p class="mt-1 whitespace-pre-wrap text-sm text-surface-400">{{ selectedTicket.description || '暂无任务说明' }}</p>
                <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-surface-500">
                  <span class="font-mono">{{ selectedTicket.id }}</span><span v-if="selectedTicket.projectId">项目 {{ selectedTicket.projectId }}</span>
                  <span v-if="selectedTicket.hostId">Host {{ selectedTicket.hostId }}</span><span>创建于 {{ formatTime(selectedTicket.createdAt) }}</span>
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <select v-model="ticketStatusDraft" class="input min-h-9! w-32 text-xs" aria-label="长期任务状态">
                  <option value="planning">规划中</option><option value="ready">待派工</option><option value="active">执行中</option><option value="blocked">阻塞</option><option value="review">待验收</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option>
                </select>
                <button class="btn-secondary min-h-9! px-3! text-xs!" :disabled="saving || ticketStatusDraft === selectedTicket.status" @click="updateTicketStatus">更新状态</button>
              </div>
            </div>
            <div v-if="selectedTicket.acceptanceCriteria?.length" class="mt-4 rounded-lg border border-surface-800 bg-surface-950/35 p-3">
              <h3 class="text-xs font-semibold text-surface-300">验收标准</h3>
              <ul class="mt-2 space-y-1.5 text-xs text-surface-400"><li v-for="(criterion,i) in selectedTicket.acceptanceCriteria" :key="i" class="flex gap-2"><CheckCircle2 class="mt-0.5 h-3.5 w-3.5 shrink-0 text-surface-500" /><span>{{ criterion }}</span></li></ul>
            </div>
          </section>

          <div class="flex gap-1 overflow-x-auto rounded-xl border border-surface-800 bg-surface-950/50 p-1" role="tablist" aria-label="长期任务工作区">
            <button v-for="tab in tabs" :key="tab.id" class="shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition" :class="activeTab === tab.id ? 'bg-surface-800 text-surface-100' : 'text-surface-500 hover:text-surface-200'" role="tab" :aria-selected="activeTab === tab.id" @click="activeTab = tab.id">{{ tab.label }}<span class="ml-1.5 text-surface-500">{{ tab.count }}</span></button>
          </div>

          <section v-if="activeTab === 'overview'" class="space-y-3">
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="card p-3"><p class="text-[11px] text-surface-500">授权版本</p><p class="mt-1 text-xl font-semibold text-surface-100">{{ activeMandate?.version ? 'v' + activeMandate.version : '未签发' }}</p><p class="mt-1 text-[11px] text-surface-500">{{ activeMandate ? mandateStatus(activeMandate) : '建议先定义授权范围' }}</p></div>
              <div class="card p-3"><p class="text-[11px] text-surface-500">执行派工</p><p class="mt-1 text-xl font-semibold text-surface-100">{{ detail.assignments?.length || 0 }}</p><p class="mt-1 text-[11px] text-surface-500">包含历史交接</p></div>
              <div class="card p-3"><p class="text-[11px] text-surface-500">副作用意图</p><p class="mt-1 text-xl font-semibold text-surface-100">{{ detail.effects?.length || 0 }}</p><p class="mt-1 text-[11px] text-surface-500">批准不等于执行</p></div>
            </div>
            <div class="card p-4">
              <div class="mb-3 flex items-center justify-between"><div><h3 class="text-sm font-semibold text-surface-200">任务活动</h3><p class="mt-0.5 text-xs text-surface-500">跨 Assignment 的连续审计记录</p></div><span class="text-xs text-surface-500">{{ detail.activity?.length || 0 }} 条</span></div>
              <div v-if="detail.activity?.length" class="space-y-3">
                <div v-for="item in detail.activity.slice(0,18)" :key="item.id" class="flex gap-3">
                  <span class="mt-1 h-2 w-2 shrink-0 rounded-full bg-surface-500" />
                  <div class="min-w-0 flex-1"><div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-xs text-surface-200">{{ eventLabel(item.eventType) }}</strong><time class="text-[10px] text-surface-500">{{ formatTime(item.createdAt) }}</time></div><p class="mt-0.5 break-words text-[11px] text-surface-500">{{ activitySummary(item) }}</p></div>
                </div>
              </div>
              <p v-else class="text-xs text-surface-500">尚无活动记录</p>
            </div>
            <div class="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 text-xs text-sky-100/80">
              <div class="flex items-center gap-2 font-semibold text-sky-200"><Info class="h-4 w-4" />Observe → Suggest → Approval → Execute</div>
              <p class="mt-1.5">事件和巡检可以成为建议来源；Ticket 负责持续跟踪。Execute 意图经人工审批后由受控 Worker 派发，但生产白名单目前只有两种低风险只读 Docker 检查，不具备任何资源变更能力。</p>
            </div>
          </section>

          <section v-else-if="activeTab === 'mandates'" class="space-y-3">
            <div class="card p-4">
              <div class="mb-3 flex items-center justify-between gap-2"><div><h3 class="text-sm font-semibold text-surface-200">授权快照（Mandate）</h3><p class="mt-0.5 text-xs text-surface-500">范围、允许/禁止动作与策略版本签名；新版本会撤销旧版本</p></div><button class="btn-primary min-h-9! px-3! text-xs!" @click="showMandateForm = !showMandateForm"><Plus class="h-3.5 w-3.5" />签发授权</button></div>
              <form v-if="showMandateForm" class="mb-4 grid gap-3 rounded-lg border border-surface-800 bg-surface-950/35 p-3 md:grid-cols-2" @submit.prevent="issueMandate">
                <label class="form-grid-label"><span>项目范围（每行一个）</span><textarea v-model="mandateForm.projectIds" class="input min-h-16" :placeholder="selectedTicket.projectId || 'project-id'" /></label>
                <label class="form-grid-label"><span>Compose 项目名范围（每行一个，必须精确匹配）</span><textarea v-model="mandateForm.composeProjectNames" class="input min-h-16 font-mono text-xs" placeholder="composeops" /></label>
                <label class="form-grid-label"><span>Host 范围（每行一个）</span><textarea v-model="mandateForm.hostIds" class="input min-h-16" placeholder="host-id" /></label>
                <label class="form-grid-label"><span>资源范围（每行一个）</span><textarea v-model="mandateForm.resourceIds" class="input min-h-16" placeholder="container-id / volume-id" /></label>
                <label class="form-grid-label"><span>有效期（天）</span><input v-model.number="mandateForm.days" type="number" min="1" max="90" class="input" /></label>
                <label class="form-grid-label"><span>允许动作（每行一个）</span><textarea v-model="mandateForm.allowedActions" class="input min-h-20 font-mono text-xs" required /></label>
                <label class="form-grid-label"><span>明确禁止动作（每行一个）</span><textarea v-model="mandateForm.deniedActions" class="input min-h-20 font-mono text-xs" /></label>
                <div class="md:col-span-2 flex justify-end gap-2"><button type="button" class="btn-secondary" @click="showMandateForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving">签发不可变快照</button></div>
              </form>
              <div v-if="detail.mandates?.length" class="space-y-2">
                <article v-for="mandate in detail.mandates" :key="mandate.id" class="rounded-lg border border-surface-800 p-3">
                  <div class="flex flex-wrap items-center justify-between gap-2"><div class="flex items-center gap-2"><strong class="text-sm text-surface-200">Mandate v{{ mandate.version }}</strong><span class="status-badge" :class="mandate.status === 'active' && !isExpired(mandate) ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-800 text-surface-500'">{{ mandateStatus(mandate) }}</span></div><button v-if="mandate.status === 'active'" class="btn-secondary px-2! py-1! text-[11px]!" @click="revokeMandate(mandate)">撤销</button></div>
                  <div class="mt-2 grid gap-2 text-xs md:grid-cols-2"><div><span class="text-surface-500">范围：</span><span class="text-surface-300">{{ scopeLabel(mandate.scope) }}</span></div><div><span class="text-surface-500">到期：</span><span class="text-surface-300">{{ formatTime(mandate.expiresAt) }}</span></div></div>
                  <div class="mt-2 flex flex-wrap gap-1"><span v-for="action in mandate.allowedActions" :key="action" class="count-badge text-emerald-300">{{ action }}</span><span v-for="action in mandate.deniedActions" :key="'deny-'+action" class="count-badge text-rose-300">禁止 · {{ action }}</span></div>
                  <p class="mt-2 break-all font-mono text-[10px] text-surface-600">SHA-256 · {{ mandate.fingerprint }}</p>
                </article>
              </div>
              <p v-else class="text-xs text-surface-500">尚未签发授权。Observe / Suggest 不需要执行授权；真正进入 Execute 意图必须签发受限 Mandate。</p>
            </div>
          </section>

          <section v-else-if="activeTab === 'assignments'" class="space-y-3">
            <div class="card p-4">
              <div class="mb-3 flex items-center justify-between gap-2"><div><h3 class="text-sm font-semibold text-surface-200">执行派工（Assignment）</h3><p class="mt-0.5 text-xs text-surface-500">可关联已有 Agent Session、Plan、后台任务或工作流；交接会创建新派工，不会删除历史</p></div><button class="btn-primary min-h-9! px-3! text-xs!" @click="showAssignmentForm = !showAssignmentForm"><Plus class="h-3.5 w-3.5" />新增派工</button></div>
              <form v-if="showAssignmentForm" class="mb-4 grid gap-3 rounded-lg border border-surface-800 bg-surface-950/35 p-3 md:grid-cols-2" @submit.prevent="createAssignment">
                <label class="form-grid-label"><span>Worker 角色</span><select v-model="assignmentForm.workerRole" class="input"><option value="planner">规划者</option><option value="executor">执行者</option><option value="validator">只读验证者</option><option value="incident_responder">应急响应者</option><option value="manual">人工执行</option></select></label>
                <label class="form-grid-label"><span>关联来源</span><select v-model="assignmentForm.sourceType" class="input"><option value="manual">手动</option><option value="agent-session">Agent Session</option><option value="agent-plan">Agent Plan</option><option value="agent-task">Agent 后台任务</option><option value="workflow">工作流实例</option><option value="batch-job">批量任务</option></select></label>
                <label class="form-grid-label"><span>来源 ID</span><input v-model="assignmentForm.sourceId" class="input" maxlength="160" :required="assignmentForm.sourceType !== 'manual'" placeholder="existing-session / plan / task / workflow ID" /></label>
                <label class="form-grid-label"><span>Session ID（可选）</span><input v-model="assignmentForm.sessionId" type="number" min="1" class="input" placeholder="数字 ID" /></label>
                <label class="form-grid-label"><span>授权版本（可选）</span><select v-model="assignmentForm.mandateId" class="input"><option value="">不关联授权</option><option v-for="mandate in activeMandates" :key="mandate.id" :value="mandate.id">Mandate v{{ mandate.version }}</option></select></label>
                <label class="form-grid-label"><span>接替前序派工（可选）</span><select v-model="assignmentForm.replacesAssignmentId" class="input"><option value="">不接替</option><option v-for="item in handoffableAssignments" :key="item.id" :value="item.id">#{{ item.sequence }} · {{ roleLabel(item.workerRole) }} · {{ item.status }}</option></select></label>
                <label class="form-grid-label md:col-span-2"><span>交接摘要 / 执行边界</span><textarea v-model="assignmentForm.handoffSummary" class="input min-h-16" maxlength="4000" placeholder="交接时必须填写：已经完成什么、未完成什么、证据在哪里、下一步不能做什么。" /></label>
                <div class="md:col-span-2 flex justify-end gap-2"><button type="button" class="btn-secondary" @click="showAssignmentForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving">创建派工记录</button></div>
              </form>
              <div v-if="detail.assignments?.length" class="space-y-2">
                <article v-for="item in detail.assignments" :key="item.id" class="rounded-lg border border-surface-800 p-3">
                  <div class="flex flex-wrap items-start justify-between gap-2"><div><div class="flex flex-wrap items-center gap-2"><strong class="text-sm text-surface-200">#{{ item.sequence }} · {{ roleLabel(item.workerRole) }}</strong><span class="status-badge" :class="assignmentTone(item.status)">{{ assignmentLabel(item.status) }}</span><span v-if="item.sourceType !== 'manual'" class="count-badge">{{ item.sourceType }}</span></div><p class="mt-1 break-all font-mono text-[10px] text-surface-500">{{ item.id }}</p></div><div class="flex flex-wrap gap-1"><button v-if="['assigned','waiting'].includes(item.status)" class="btn-secondary px-2! py-1! text-[11px]!" @click="updateAssignment(item,'running')">标记运行</button><button v-if="['assigned','running'].includes(item.status)" class="btn-secondary px-2! py-1! text-[11px]!" @click="updateAssignment(item,'blocked')">标记阻塞</button><button v-if="['assigned','running','waiting','blocked'].includes(item.status)" class="btn-secondary px-2! py-1! text-[11px]!" @click="prepareHandoff(item)">交接</button><button v-if="['assigned','running','waiting','blocked'].includes(item.status)" class="btn-secondary px-2! py-1! text-[11px]!" @click="updateAssignment(item,'outcome_unknown')">结果不确定</button><button v-if="item.status === 'outcome_unknown'" class="btn-primary px-2! py-1! text-[11px]!" @click="openAssignmentReconcile(item)">核对结果</button></div></div>
                  <div class="mt-2 grid gap-1 text-xs text-surface-500 sm:grid-cols-2"><span>来源：{{ item.sourceId || '人工' }}</span><span>Session：{{ item.sessionId || '—' }}</span><span>尝试：{{ item.attempt }}</span><span>更新时间：{{ formatTime(item.updatedAt) }}</span></div>
                  <p v-if="item.handoffSummary" class="mt-2 whitespace-pre-wrap rounded-md bg-surface-950/45 p-2 text-xs text-surface-400">{{ item.handoffSummary }}</p>
                  <form v-if="reconcileAssignmentId === item.id" class="mt-3 grid gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 sm:grid-cols-[140px_minmax(0,1fr)_auto]" @submit.prevent="reconcileAssignment(item)">
                    <select v-model="reconcileForm.outcome" class="input min-h-9! text-xs"><option value="succeeded">核对成功</option><option value="failed">核对失败</option><option value="cancelled">确认已取消</option></select>
                    <input v-model="reconcileForm.note" class="input min-h-9! text-xs" required placeholder="真实环境核对依据（必填）" />
                    <button class="btn-primary min-h-9! px-3! text-xs!" :disabled="saving || !reconcileForm.note.trim()">提交核对</button>
                  </form>
                </article>
              </div>
              <p v-else class="text-xs text-surface-500">还没有派工记录。先选择已有执行上下文，或创建人工/只读验证派工。</p>
            </div>
          </section>

          <section v-else-if="activeTab === 'reports'" class="space-y-3">
            <div class="card p-4">
              <div class="mb-3 flex items-center justify-between gap-2"><div><h3 class="text-sm font-semibold text-surface-200">结构化报告与验收</h3><p class="mt-0.5 text-xs text-surface-500">报告附带发现项、证据和提交时的验收标准快照</p></div><button class="btn-primary min-h-9! px-3! text-xs!" @click="showReportForm = !showReportForm"><Plus class="h-3.5 w-3.5" />提交报告</button></div>
              <form v-if="showReportForm" class="mb-4 grid gap-3 rounded-lg border border-surface-800 bg-surface-950/35 p-3 md:grid-cols-2" @submit.prevent="submitReport">
                <label class="form-grid-label"><span>关联派工</span><select v-model="reportForm.assignmentId" class="input"><option value="">不指定</option><option v-for="item in detail.assignments" :key="item.id" :value="item.id">#{{ item.sequence }} · {{ roleLabel(item.workerRole) }}</option></select></label>
                <label class="form-grid-label"><span>报告类型</span><select v-model="reportForm.reportType" class="input"><option value="execution">执行报告</option><option value="verification">验证报告</option><option value="incident">事件报告</option><option value="review">复核报告</option></select></label>
                <label class="form-grid-label md:col-span-2"><span>结论摘要</span><textarea v-model="reportForm.summary" class="input min-h-16" required maxlength="4000" /></label>
                <label class="form-grid-label"><span>发现项标题（可选）</span><input v-model="reportForm.findingTitle" class="input" maxlength="200" placeholder="例如镜像版本落后" /></label>
                <label class="form-grid-label"><span>严重程度</span><select v-model="reportForm.findingSeverity" class="input"><option value="info">信息</option><option value="warning">警告</option><option value="danger">严重</option></select></label>
                <label class="form-grid-label md:col-span-2"><span>发现详情 / 建议</span><textarea v-model="reportForm.findingDetail" class="input min-h-16" maxlength="2000" placeholder="现象、影响、证据和建议。" /></label>
                <label class="form-grid-label"><span>证据类型</span><select v-model="reportForm.evidenceKind" class="input"><option value="docker-inspect">Docker Inspect</option><option value="logs">日志</option><option value="http-check">HTTP 检查</option><option value="workflow">工作流记录</option><option value="note">人工记录</option></select></label>
                <label class="form-grid-label"><span>证据来源 ID（可选）</span><input v-model="reportForm.evidenceSourceId" class="input" maxlength="240" placeholder="container-id / event-id" /></label>
                <label class="form-grid-label md:col-span-2"><span>证据摘要</span><input v-model="reportForm.evidenceSummary" class="input" maxlength="1000" placeholder="说明证据实际证明了什么" /></label>
                <div class="md:col-span-2 flex justify-end gap-2"><button type="button" class="btn-secondary" @click="showReportForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving || !reportForm.summary.trim()">提交待验收报告</button></div>
              </form>
              <div v-if="detail.reports?.length" class="space-y-2">
                <article v-for="report in detail.reports" :key="report.id" class="rounded-lg border border-surface-800 p-3">
                  <div class="flex flex-wrap items-center justify-between gap-2"><div class="flex items-center gap-2"><strong class="text-sm text-surface-200">{{ reportTypeLabel(report.reportType) }}</strong><span class="status-badge" :class="report.status === 'accepted' ? 'bg-emerald-500/10 text-emerald-300' : report.status === 'rejected' ? 'bg-rose-500/10 text-rose-300' : 'bg-sky-500/10 text-sky-300'">{{ reportStatus(report.status) }}</span></div><span class="text-[10px] text-surface-500">{{ formatTime(report.createdAt) }}</span></div>
                  <p class="mt-2 whitespace-pre-wrap text-sm text-surface-300">{{ report.summary }}</p>
                  <div v-if="report.findings?.length" class="mt-2 space-y-1"><div v-for="finding in report.findings" :key="finding.title" class="rounded bg-surface-950/40 p-2"><p class="text-xs font-medium text-surface-200">{{ finding.title }} <span class="text-surface-500">· {{ finding.severity }}</span></p><p class="mt-1 text-xs text-surface-400">{{ finding.detail }}</p><p v-if="finding.recommendation" class="mt-1 text-xs text-surface-500">建议：{{ finding.recommendation }}</p></div></div>
                  <div v-if="report.evidence?.length" class="mt-2 space-y-1"><p class="text-[10px] font-semibold text-surface-500">证据</p><div v-for="evidence in report.evidence" :key="evidence.kind + evidence.sourceId" class="text-xs text-surface-400">{{ evidence.kind }} · {{ evidence.sourceId || '无来源 ID' }} · {{ evidence.summary }}</div></div>
                  <div v-if="report.status === 'submitted'" class="mt-3 flex flex-wrap justify-end gap-2 border-t border-surface-800 pt-3"><button class="btn-secondary" :disabled="saving" @click="decideReport(report,false)">退回补充</button><button class="btn-primary" :disabled="saving" @click="decideReport(report,true)">验收通过</button></div>
                  <p v-else class="mt-2 text-xs text-surface-500">验收意见：{{ report.decisionNote || '—' }}</p>
                </article>
              </div>
              <p v-else class="text-xs text-surface-500">尚无报告。任务只有经过人工验收，才适合进入最终完成状态。</p>
            </div>
          </section>

          <section v-else-if="activeTab === 'effects'" class="space-y-3">
            <div class="card p-4">
              <div class="mb-3 flex items-center justify-between gap-2"><div><h3 class="text-sm font-semibold text-surface-200">持久化副作用意图（Effect）</h3><p class="mt-0.5 text-xs text-surface-500">审批、授权复核、受控只读派发与结果留痕</p></div><button class="btn-primary min-h-9! px-3! text-xs!" @click="showEffectForm = !showEffectForm"><Plus class="h-3.5 w-3.5" />新增意图</button></div>
              <div class="mb-3 rounded-lg border border-surface-800 bg-surface-950/40 p-3 text-xs">
                <div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-surface-200">受控 Effect Worker</strong><span class="status-badge" :class="workerStatus?.enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-800 text-surface-400'">{{ workerStatus?.enabled ? '运行中' : '已停止' }}</span></div>
                <div class="mt-2 grid grid-cols-2 gap-2 text-surface-400 sm:grid-cols-4"><span>待派发：{{ workerStatus?.queueDepth ?? '—' }}</span><span>执行中：{{ workerStatus?.executing ?? '—' }}</span><span>租约中：{{ workerStatus?.leased ?? '—' }}</span><span>待核对：{{ workerStatus?.outcomeUnknown ?? '—' }}</span></div>
                <p class="mt-2 text-emerald-200/80">只读白名单：service.inspect、container.inspect。执行前重新验证审批、Mandate 版本、范围和风险。</p>
                <p class="mt-1 text-amber-200/80">明确禁止：image.pull、Compose up/down、容器重启/删除、卷删除、SSH 与任意 Shell。未列入白名单的动作会在开始前拒绝并写入审计。</p>
                <p v-if="workerStatus?.lastError" class="mt-2 break-words text-rose-300">最近错误：{{ workerStatus.lastError }}</p>
              </div>
              <div class="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-100/80"><strong class="text-amber-200">安全边界：</strong>Worker 只执行上方两种只读 Docker 查询，不具备 Docker/Compose 写操作能力；远程 Host 不派发。执行中进程中断会转为 outcome_unknown，不自动重放。</div>
              <form v-if="showEffectForm" class="mb-4 grid gap-3 rounded-lg border border-surface-800 bg-surface-950/35 p-3 md:grid-cols-2" @submit.prevent="createEffect">
                <label class="form-grid-label"><span>动作类型</span><select v-model="effectForm.effectType" class="input font-mono text-xs"><option value="service.inspect">service.inspect · 项目容器列表</option><option value="container.inspect">container.inspect · 单容器详情</option></select></label>
                <label class="form-grid-label"><span>模式</span><select v-model="effectForm.mode" class="input"><option value="observe">Observe · 只记录观察</option><option value="suggest">Suggest · 提出建议</option><option value="execute">Execute · 请求执行授权</option></select></label>
                <label class="form-grid-label"><span>风险等级</span><select v-model="effectForm.risk" class="input"><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option><option value="critical">关键操作</option></select></label>
                <label v-if="effectForm.mode === 'execute'" class="form-grid-label"><span>Mandate 授权</span><select v-model="effectForm.mandateId" class="input" required><option value="">选择当前有效授权</option><option v-for="mandate in activeMandates" :key="mandate.id" :value="mandate.id">Mandate v{{ mandate.version }}</option></select></label>
                <label class="form-grid-label"><span>项目 ID（用于 Mandate 范围匹配）</span><input v-model="effectForm.projectId" class="input" maxlength="160" :placeholder="selectedTicket.projectId || 'project-id'" /></label>
                <label class="form-grid-label"><span>Compose 项目名（精确匹配 Docker Label）</span><input v-model="effectForm.composeProject" class="input font-mono" maxlength="128" required placeholder="compose-project-name" /></label>
                <label v-if="effectForm.effectType === 'container.inspect'" class="form-grid-label md:col-span-2"><span>容器 ID（12–64 位十六进制）</span><input v-model="effectForm.resourceId" class="input font-mono" maxlength="64" required placeholder="Docker container ID" /></label>
                <label class="form-grid-label"><span>Host ID（当前本机 Worker 不支持远程 Host）</span><input v-model="effectForm.hostId" class="input" maxlength="160" :placeholder="selectedTicket.hostId || '留空：本机 Docker'" /></label>
                <label class="form-grid-label md:col-span-2"><span>动作参数（JSON 对象）</span><textarea v-model="effectForm.payload" class="input min-h-20 font-mono text-xs" /></label>
                <div class="md:col-span-2 flex justify-end gap-2"><button type="button" class="btn-secondary" @click="showEffectForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving">持久化意图</button></div>
              </form>
              <div v-if="detail.effects?.length" class="space-y-2">
                <article v-for="effect in detail.effects" :key="effect.id" class="rounded-lg border border-surface-800 p-3">
                  <div class="flex flex-wrap items-center justify-between gap-2"><div class="flex items-center gap-2"><strong class="font-mono text-sm text-surface-200">{{ effect.effectType }}</strong><span class="status-badge" :class="effectTone(effect.status)">{{ effectLabel(effect.status) }}</span><span class="count-badge">{{ effect.mode }} · {{ effect.risk }}</span></div><span class="text-[10px] text-surface-500">{{ formatTime(effect.createdAt) }}</span></div>
                  <p class="mt-1 break-all font-mono text-[10px] text-surface-600">{{ effect.id }} <span v-if="effect.mandateId">· {{ effect.mandateId }}</span></p>
                  <pre class="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-950/50 p-2 text-[11px] text-surface-400">{{ JSON.stringify({ target: effect.target, payload: effect.payload, result: effect.result, error: effect.error }, null, 2) }}</pre>
                  <div class="mt-3 flex flex-wrap justify-end gap-2"><button v-if="effect.status === 'awaiting_approval'" class="btn-primary" :disabled="saving" @click="approveEffect(effect)">批准并入队</button><button v-if="['proposed','awaiting_approval','queued'].includes(effect.status)" class="btn-secondary" :disabled="saving" @click="cancelEffect(effect)">取消</button><button v-if="effect.status === 'outcome_unknown'" class="btn-secondary" @click="openEffectReconcile(effect)">人工核对</button></div>
                  <form v-if="reconcileEffectId === effect.id" class="mt-3 grid gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 sm:grid-cols-[140px_minmax(0,1fr)_auto]" @submit.prevent="reconcileEffect(effect)">
                    <select v-model="reconcileForm.outcome" class="input min-h-9! text-xs"><option value="succeeded">核对成功</option><option value="failed">核对失败</option><option value="cancelled">确认已取消</option></select>
                    <input v-model="reconcileForm.note" class="input min-h-9! text-xs" required placeholder="真实环境核对依据（必填）" />
                    <button class="btn-primary min-h-9! px-3! text-xs!" :disabled="saving || !reconcileForm.note.trim()">提交核对</button>
                  </form>
                </article>
              </div>
              <p v-else class="text-xs text-surface-500">暂无副作用意图。建议先以 Observe 或 Suggest 模式记录，执行模式必须有有效 Mandate 并经人工审批。</p>
            </div>
          </section>
        </template>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client.js';
import {
  Activity, CheckCircle2, ClipboardList, Info, Plus, RefreshCw, Search, X,
} from 'lucide-vue-next';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const tickets = ref([]);
const stats = ref({});
const detail = ref({ ticket: null, mandates: [], assignments: [], reports: [], effects: [], activity: [] });
const workerStatus = ref(null);
const selectedTicketId = ref('');
const query = ref('');
const statusFilter = ref('');
const activeTab = ref('overview');
const showTicketForm = ref(false);
const showMandateForm = ref(false);
const showAssignmentForm = ref(false);
const showReportForm = ref(false);
const showEffectForm = ref(false);
const reconcileAssignmentId = ref('');
const reconcileEffectId = ref('');
const reconcileForm = reactive({ outcome: 'failed', note: '' });
const ticketStatusDraft = ref('planning');

const ticketForm = reactive({ title: '', description: '', priority: 'normal', sourceType: 'manual', sourceId: '', projectId: '', hostId: '', acceptanceCriteria: '' });
const mandateForm = reactive({
  projectIds: '', composeProjectNames: '', hostIds: '', resourceIds: '', allowedActions: 'service.inspect', deniedActions: 'volume.delete\ndatabase.drop', days: 7,
});
const assignmentForm = reactive({
  workerRole: 'executor', sourceType: 'manual', sourceId: '', sessionId: '', mandateId: '', replacesAssignmentId: '', handoffSummary: '',
});
const reportForm = reactive({
  assignmentId: '', reportType: 'execution', summary: '', findingTitle: '', findingSeverity: 'info',
  findingDetail: '', evidenceKind: 'note', evidenceSourceId: '', evidenceSummary: '',
});
const effectForm = reactive({
  effectType: 'service.inspect', mode: 'suggest', risk: 'low', mandateId: '',
  projectId: '', composeProject: '', resourceId: '', hostId: '', payload: '{}',
});

const tabs = computed(() => [
  { id: 'overview', label: '任务总览', count: detail.value.activity?.length || 0 },
  { id: 'mandates', label: '授权', count: detail.value.mandates?.length || 0 },
  { id: 'assignments', label: '派工与交接', count: detail.value.assignments?.length || 0 },
  { id: 'reports', label: '报告验收', count: detail.value.reports?.length || 0 },
  { id: 'effects', label: 'Effect 队列', count: detail.value.effects?.length || 0 },
]);
const selectedTicket = computed(() => detail.value.ticket);
const activeMandates = computed(() => (detail.value.mandates || []).filter((m) => m.status === 'active' && !isExpired(m)));
const activeMandate = computed(() => activeMandates.value[0] || null);
const handoffableAssignments = computed(() => (detail.value.assignments || []).filter((a) => ['assigned', 'running', 'waiting', 'blocked'].includes(a.status)));

function splitLines(value) { return [...new Set(String(value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean))]; }
function isExpired(mandate) { return !Number.isFinite(Date.parse(mandate.expiresAt)) || Date.parse(mandate.expiresAt) <= Date.now(); }
function formatTime(value) { if (!value) return '—'; const time = new Date(value.includes?.(' ') && !value.includes('T') ? value.replace(' ', 'T') + 'Z' : value); return Number.isNaN(time.getTime()) ? String(value) : time.toLocaleString(); }
function ticketLabel(status) { return ({ planning: '规划中', ready: '待派工', active: '执行中', blocked: '阻塞', review: '待验收', succeeded: '成功', failed: '失败', cancelled: '已取消' })[status] || status; }
function ticketTone(status) { return ({ planning: 'bg-surface-800 text-surface-300', ready: 'bg-sky-500/10 text-sky-300', active: 'bg-blue-500/10 text-blue-300', blocked: 'bg-amber-500/10 text-amber-300', review: 'bg-violet-500/10 text-violet-300', succeeded: 'bg-emerald-500/10 text-emerald-300', failed: 'bg-rose-500/10 text-rose-300', cancelled: 'bg-surface-800 text-surface-500' })[status] || 'bg-surface-800 text-surface-400'; }
function priorityLabel(value) { return ({ low: '低优先级', normal: '普通优先级', high: '高优先级', urgent: '紧急' })[value] || value; }
function sourceLabel(value) { return ({ manual: '手动', event: '事件', inspection: '巡检', agent: 'Agent', workflow: '工作流' })[value] || value; }
function mandateStatus(m) { return m.status === 'active' && !isExpired(m) ? '有效' : m.status === 'active' ? '已过期' : m.status === 'revoked' ? '已撤销' : m.status; }
function scopeLabel(scope = {}) { return [['项目', scope.projectIds], ['Compose 项目', scope.composeProjectNames], ['Host', scope.hostIds], ['资源', scope.resourceIds]].filter(([, values]) => values?.length).map(([label, values]) => label + ' ' + values.join(', ')).join('；') || '未限定'; }
function roleLabel(role) { return ({ planner: '规划者', executor: '执行者', validator: '只读验证者', incident_responder: '应急响应者', manual: '人工' })[role] || role; }
function assignmentLabel(status) { return ({ assigned: '已派工', running: '执行中', waiting: '等待中', blocked: '阻塞', handed_off: '已交接', succeeded: '成功', failed: '失败', outcome_unknown: '结果待核对', cancelled: '已取消' })[status] || status; }
function assignmentTone(status) { return ({ assigned: 'bg-sky-500/10 text-sky-300', running: 'bg-blue-500/10 text-blue-300', waiting: 'bg-violet-500/10 text-violet-300', blocked: 'bg-amber-500/10 text-amber-300', outcome_unknown: 'bg-amber-500/10 text-amber-300', succeeded: 'bg-emerald-500/10 text-emerald-300', failed: 'bg-rose-500/10 text-rose-300' })[status] || 'bg-surface-800 text-surface-500'; }
function reportTypeLabel(type) { return ({ execution: '执行报告', verification: '验证报告', incident: '事件报告', review: '复核报告' })[type] || type; }
function reportStatus(status) { return ({ submitted: '待验收', accepted: '已通过', rejected: '已退回' })[status] || status; }
function effectLabel(status) { return ({ proposed: '建议待处理', awaiting_approval: '等待审批', queued: '等待派发', leased: '已被领取', executing: '执行中', succeeded: '成功', failed: '失败', outcome_unknown: '结果待核对', cancelled: '已取消', rejected: '已拒绝' })[status] || status; }
function effectTone(status) { return ({ proposed: 'bg-surface-800 text-surface-300', awaiting_approval: 'bg-amber-500/10 text-amber-300', queued: 'bg-sky-500/10 text-sky-300', leased: 'bg-blue-500/10 text-blue-300', executing: 'bg-blue-500/10 text-blue-300', succeeded: 'bg-emerald-500/10 text-emerald-300', failed: 'bg-rose-500/10 text-rose-300', outcome_unknown: 'bg-amber-500/10 text-amber-300' })[status] || 'bg-surface-800 text-surface-500'; }
function eventLabel(type) { return ({ ticket_created: '任务创建', ticket_updated: '任务更新', mandate_issued: '签发授权', mandate_revoked: '撤销授权', assignment_created: '创建派工', assignment_handoff: '执行交接', assignment_updated: '派工状态更新', assignment_reconciled: '派工结果核对', report_submitted: '提交报告', report_accepted: '验收通过', report_rejected: '报告退回', effect_proposed: '提出副作用意图', effect_approved_queued: '批准并入队', effect_claimed: '执行器领取', effect_execution_started: '进入执行阶段', effect_completed: '执行完成', effect_outcome_unknown: '执行结果不确定', effect_reconciled: '人工核对副作用', effect_cancelled: '取消意图', effect_rejected_before_dispatch: '白名单校验拒绝', effect_lease_requeued_before_execution: '未开始的租约已安全回队列' })[type] || type; }
function activitySummary(item) { const d = item.details || {}; return d.note || d.reason || d.title || d.summary || d.effectType || d.workerRole || d.to || d.from || d.mandateId || d.reportId || '记录已写入审计时间线'; }

async function refreshDetail(id = selectedTicketId.value) {
  if (!id) { detail.value = { ticket: null, mandates: [], assignments: [], reports: [], effects: [], activity: [] }; return; }
  const result = await api.getOpsTicket(id);
  detail.value = result;
  if (detail.value.ticket) ticketStatusDraft.value = detail.value.ticket.status;
}
async function loadWorkerStatus() {
  try { workerStatus.value = await api.getOpsEffectWorkerStatus(); }
  catch { workerStatus.value = null; }
}
async function load({ preserve = true } = {}) {
  if (loading.value) return;
  loading.value = true; error.value = '';
  try {
    const result = await api.getOpsTickets({ ...(statusFilter.value ? { status: statusFilter.value } : {}), ...(query.value.trim() ? { query: query.value.trim() } : {}), limit: 200 });
    tickets.value = result.tickets || []; stats.value = result.stats || {};
    await loadWorkerStatus();
    if (!preserve || !tickets.value.some((item) => item.id === selectedTicketId.value)) selectedTicketId.value = tickets.value[0]?.id || '';
    await refreshDetail();
  } catch (e) { error.value = e.message || '读取长期任务失败'; }
  finally { loading.value = false; }
}
async function selectTicket(id) {
  if (selectedTicketId.value === id) return;
  selectedTicketId.value = id; activeTab.value = 'overview'; error.value = '';
  try { await refreshDetail(id); } catch (e) { error.value = e.message || '读取任务详情失败'; }
}
async function mutate(action, success) {
  if (saving.value) return;
  saving.value = true; error.value = ''; notice.value = '';
  try {
    await action();
    notice.value = success;
    await load();
  } catch (e) { error.value = e.message || '操作失败'; }
  finally { saving.value = false; }
}
async function createTicket() {
  await mutate(async () => {
    const result = await api.createOpsTicket({
      title: ticketForm.title.trim(), description: ticketForm.description, priority: ticketForm.priority,
      sourceType: ticketForm.sourceType, sourceId: ticketForm.sourceId.trim(), projectId: ticketForm.projectId.trim(), hostId: ticketForm.hostId.trim(),
      acceptanceCriteria: splitLines(ticketForm.acceptanceCriteria),
    });
    selectedTicketId.value = result.ticket.id;
    Object.assign(ticketForm, { title: '', description: '', priority: 'normal', sourceType: 'manual', sourceId: '', projectId: '', hostId: '', acceptanceCriteria: '' });
    showTicketForm.value = false;
  }, '长期任务已创建；尚未启动任何 Agent 或外部操作。');
}
async function updateTicketStatus() {
  await mutate(() => api.updateOpsTicket(selectedTicketId.value, { status: ticketStatusDraft.value }), '任务状态已更新。');
}
async function issueMandate() {
  const projectIds = splitLines(mandateForm.projectIds || selectedTicket.value.projectId || '');
  const composeProjectNames = splitLines(mandateForm.composeProjectNames);
  const allowedActions = splitLines(mandateForm.allowedActions);
  if (allowedActions.some((action) => ['service.inspect', 'container.inspect'].includes(action)) && !composeProjectNames.length) {
    error.value = 'service.inspect / container.inspect 必须在 Mandate 中明确填写 Compose 项目名范围。';
    return;
  }
  await mutate(async () => {
    await api.issueOpsMandate(selectedTicketId.value, {
      scope: { projectIds, composeProjectNames, hostIds: splitLines(mandateForm.hostIds), resourceIds: splitLines(mandateForm.resourceIds) },
      allowedActions, deniedActions: splitLines(mandateForm.deniedActions),
      expiresAt: new Date(Date.now() + Math.max(1, Math.min(90, Number(mandateForm.days) || 7)) * 86400000).toISOString(),
    });
    showMandateForm.value = false;
  }, '已签发新的 Mandate 快照；旧版本已撤销。');
}
async function revokeMandate(mandate) {
  const reason = window.prompt('填写撤销原因（必填）');
  if (!reason?.trim()) return;
  await mutate(() => api.revokeOpsMandate(selectedTicketId.value, mandate.id, reason.trim()), '授权已撤销。');
}
async function createAssignment() {
  await mutate(async () => {
    await api.createOpsAssignment(selectedTicketId.value, {
      workerRole: assignmentForm.workerRole, sourceType: assignmentForm.sourceType,
      sourceId: assignmentForm.sourceId.trim(), sessionId: assignmentForm.sessionId ? Number(assignmentForm.sessionId) : undefined,
      mandateId: assignmentForm.mandateId || undefined, handoffSummary: assignmentForm.handoffSummary.trim(),
      replacesAssignmentId: assignmentForm.replacesAssignmentId || undefined,
    });
    Object.assign(assignmentForm, { workerRole: 'executor', sourceType: 'manual', sourceId: '', sessionId: '', mandateId: '', replacesAssignmentId: '', handoffSummary: '' });
    showAssignmentForm.value = false;
  }, '已创建 Assignment；Ticket 身份保持不变。');
}
function prepareHandoff(item) {
  Object.assign(assignmentForm, {
    workerRole: 'validator', sourceType: 'manual', sourceId: '', sessionId: '', mandateId: activeMandate.value?.id || '',
    replacesAssignmentId: item.id, handoffSummary: '',
  });
  showAssignmentForm.value = true;
}
async function updateAssignment(item, status) {
  await mutate(() => api.updateOpsAssignment(selectedTicketId.value, item.id, { status }), '派工状态已更新。');
}
function openAssignmentReconcile(item) {
  reconcileAssignmentId.value = item.id; reconcileForm.outcome = 'failed'; reconcileForm.note = '';
}
async function reconcileAssignment(item) {
  await mutate(async () => {
    await api.reconcileOpsAssignment(selectedTicketId.value, item.id, { outcome: reconcileForm.outcome, note: reconcileForm.note.trim() });
    reconcileAssignmentId.value = '';
  }, '派工结果已人工核对并留痕。');
}
async function submitReport() {
  await mutate(async () => {
    const findings = reportForm.findingTitle.trim() ? [{
      title: reportForm.findingTitle.trim(), severity: reportForm.findingSeverity,
      detail: reportForm.findingDetail, recommendation: '',
    }] : [];
    const evidence = reportForm.evidenceSummary.trim() ? [{
      kind: reportForm.evidenceKind, sourceId: reportForm.evidenceSourceId.trim(),
      summary: reportForm.evidenceSummary.trim(),
    }] : [];
    await api.createOpsReport(selectedTicketId.value, {
      assignmentId: reportForm.assignmentId || undefined, reportType: reportForm.reportType,
      summary: reportForm.summary.trim(), findings, evidence,
    });
    Object.assign(reportForm, { assignmentId: '', reportType: 'execution', summary: '', findingTitle: '', findingSeverity: 'info', findingDetail: '', evidenceKind: 'note', evidenceSourceId: '', evidenceSummary: '' });
    showReportForm.value = false;
    activeTab.value = 'reports';
  }, '报告已提交，任务进入待验收视图；尚未自动标记完成。');
}
async function decideReport(report, accepted) {
  const note = window.prompt(accepted ? '验收意见（可留空）' : '退回原因（建议填写）', accepted ? '证据完整，验收通过。' : '');
  if (note === null) return;
  await mutate(() => api.decideOpsReport(selectedTicketId.value, report.id, { accepted, note }), accepted ? '报告已验收通过。' : '报告已退回补充。');
}
async function createEffect() {
  let payload;
  try { payload = JSON.parse(effectForm.payload || '{}'); } catch { error.value = '动作参数必须是有效 JSON 对象'; return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { error.value = '动作参数必须是 JSON 对象'; return; }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(effectForm.composeProject.trim())) { error.value = '请填写有效的 Compose 项目名'; return; }
  if (effectForm.effectType === 'container.inspect' && !/^[a-f0-9]{12,64}$/i.test(effectForm.resourceId.trim())) { error.value = '请输入 12–64 位十六进制容器 ID'; return; }
  await mutate(async () => {
    await api.createOpsEffect(selectedTicketId.value, {
      effectType: effectForm.effectType.trim(), mode: effectForm.mode, risk: effectForm.risk,
      mandateId: effectForm.mode === 'execute' ? effectForm.mandateId : undefined,
      target: { projectId: effectForm.projectId.trim() || selectedTicket.value.projectId || '', composeProject: effectForm.composeProject.trim(), resourceId: effectForm.effectType === 'container.inspect' ? effectForm.resourceId.trim() : '', hostId: effectForm.hostId.trim() },
      payload,
    });
    Object.assign(effectForm, { effectType: 'service.inspect', mode: 'suggest', risk: 'low', mandateId: '', projectId: '', composeProject: '', resourceId: '', hostId: '', payload: '{}' });
    showEffectForm.value = false;
    activeTab.value = 'effects';
  }, '副作用意图已持久化；Execute 需要人工审批，Worker 仅支持低风险只读检查。');
}
async function approveEffect(effect) {
  if (!window.confirm('批准后由受控 Worker 按只读白名单派发；只读检查不会修改资源，其他动作将被拒绝。继续吗？')) return;
  await mutate(() => api.approveOpsEffect(selectedTicketId.value, effect.id), '审批已记录，意图已进入等待派发队列。');
}
async function cancelEffect(effect) {
  if (!window.confirm('取消这条尚未执行的意图？')) return;
  await mutate(() => api.cancelOpsEffect(selectedTicketId.value, effect.id, '由管理员在长期任务工作台取消'), '意图已取消。');
}
function openEffectReconcile(effect) { reconcileEffectId.value = effect.id; reconcileForm.outcome = 'failed'; reconcileForm.note = ''; }
async function reconcileEffect(effect) {
  await mutate(async () => {
    await api.reconcileOpsEffect(selectedTicketId.value, effect.id, { outcome: reconcileForm.outcome, note: reconcileForm.note.trim() });
    reconcileEffectId.value = '';
  }, '副作用结果已人工核对并留痕。');
}

onMounted(() => {
  if (route.query.create === '1') {
    ticketForm.title = String(route.query.title || '事件跟进任务');
    ticketForm.description = String(route.query.description || '');
    ticketForm.sourceType = ['event', 'inspection', 'agent', 'workflow'].includes(String(route.query.sourceType)) ? String(route.query.sourceType) : 'manual';
    ticketForm.sourceId = String(route.query.sourceId || '');
    ticketForm.projectId = String(route.query.projectId || '');
    showTicketForm.value = true;
    router.replace({ path: '/tickets', query: {} });
  }
  load({ preserve: false });
});
</script>
