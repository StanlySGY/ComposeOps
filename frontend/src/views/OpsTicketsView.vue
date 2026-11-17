<template>
  <div class="page-shell ops-ticket-workspace" :aria-busy="loading || saving">
    <div class="page-header">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="page-title">长期运维任务</h1>
          <span class="rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-sky-300">任务 · 授权 · 验收</span>
        </div>
        <p class="page-subtitle">任务独立于 Agent 会话；执行可交接、授权可追溯、结果必须经过证据验收。</p>
      </div>
      <div class="page-actions flex-wrap">
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新</button>
        <button class="btn-secondary" @click="router.push('/ops-center')"><Activity class="h-4 w-4" />执行态势</button>
        <button :disabled="saving" class="btn-primary" @click="showTicketForm = !showTicketForm"><Plus class="h-4 w-4" />新建长期任务</button>
      </div>
    </div>

    <div v-if="error || notice" ref="feedbackRef" tabindex="-1" class="ticket-feedback"><div v-if="error" class="alert-error" role="alert">{{ error }}</div><div v-else class="ticket-notice" role="status"><CheckCircle2 class="h-4 w-4 shrink-0" />{{ notice }}</div></div>

    <section class="ticket-metrics" aria-label="全部长期任务概况">
      <div class="card p-3 sm:p-4"><p class="text-xs text-surface-400">进行中任务</p><p class="mt-1 text-2xl font-semibold tabular-nums text-surface-100">{{ statsLoaded ? (stats.open || 0) : '—' }}</p></div>
      <div class="card p-3 sm:p-4"><p class="text-xs text-surface-400">阻塞等待</p><p class="mt-1 text-2xl font-semibold tabular-nums text-status-warn">{{ statsLoaded ? (stats.blocked || 0) : '—' }}</p></div>
      <div class="card p-3 sm:p-4"><p class="text-xs text-surface-400">等待验收</p><p class="mt-1 text-2xl font-semibold tabular-nums text-sky-300">{{ statsLoaded ? (stats.review || 0) : '—' }}</p></div>
      <div class="card p-3 sm:p-4"><p class="text-xs text-surface-400">已结束任务</p><p class="mt-1 text-2xl font-semibold tabular-nums text-surface-300">{{ statsLoaded ? (stats.terminal || 0) : '—' }}</p></div>
    </section>

    <section v-if="showTicketForm" class="section-panel">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div><h2 class="section-title">创建独立任务</h2><p class="mt-1 text-muted">先定义目标和验收标准，不会自动启动 Agent 或执行操作。</p></div>
        <button :disabled="saving" class="icon-btn" aria-label="关闭创建表单" @click="showTicketForm = false"><X class="h-4 w-4" /></button>
      </div>
      <form class="grid gap-3 md:grid-cols-2" @submit.prevent="createTicket"><fieldset :disabled="saving" class="contents">
        <label class="form-grid-label md:col-span-2"><span>任务标题</span><input v-model="ticketForm.title" class="input" maxlength="200" required placeholder="例如：检查 staging 所有 Compose 服务并形成更新计划" /></label>
        <label class="form-grid-label md:col-span-2"><span>目标与背景</span><textarea v-model="ticketForm.description" class="input min-h-20" maxlength="8000" placeholder="说明要解决的问题、边界和已知情况。" /></label>
        <label class="form-grid-label"><span>优先级</span><select v-model="ticketForm.priority" class="input"><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label>
        <label class="form-grid-label"><span>来源</span><select v-model="ticketForm.sourceType" class="input"><option value="manual">手动创建</option><option value="event">事件</option><option value="inspection">巡检</option><option value="agent">Agent</option><option value="workflow">工作流</option></select></label>
        <label class="form-grid-label"><span>项目 ID（可选）</span><input v-model="ticketForm.projectId" class="input" maxlength="160" placeholder="project-id" /></label>
        <label class="form-grid-label"><span>节点 ID（可选）</span><input v-model="ticketForm.hostId" class="input" maxlength="160" placeholder="host-id" /></label>
        <label class="form-grid-label md:col-span-2"><span>来源记录 ID（可选）</span><input v-model="ticketForm.sourceId" class="input" maxlength="160" placeholder="event-id / inspection-id / agent-plan-id" /></label>
        <label class="form-grid-label md:col-span-2"><span>验收标准（每行一条）</span><textarea v-model="ticketForm.acceptanceCriteria" class="input min-h-20" placeholder="有明确证据证明检查范围完整&#10;提交结构化报告并等待人工验收" /></label>
        <div class="md:col-span-2 flex flex-wrap justify-end gap-2"><button :disabled="saving" type="button" class="btn-secondary" @click="showTicketForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving || !ticketForm.title.trim()"><Plus class="h-4 w-4" />创建任务</button></div>
      </fieldset></form>
    </section>

    <section class="ticket-columns">
      <aside ref="listRef" tabindex="-1" class="card ticket-list min-w-0 overflow-hidden" aria-label="长期任务列表">
        <div class="border-b border-surface-800 p-3">
          <form class="space-y-2" @submit.prevent="applyFilters"><fieldset :disabled="saving" class="contents">
            <label class="search-field"><Search class="h-4 w-4" /><input v-model="query" aria-label="搜索长期任务" maxlength="120" placeholder="搜索任务、项目或 ID" /></label>
            <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <select v-model="statusFilter" class="input input-sm" aria-label="按长期任务状态筛选">
                <option value="">全部状态</option><option value="planning">规划中</option><option value="ready">待派工</option><option value="active">执行中</option><option value="blocked">阻塞</option><option value="review">待验收</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option>
              </select>
              <button type="submit" class="btn-secondary btn-sm" :disabled="loading">筛选</button>
            </div>
          </fieldset></form>
          <div class="mt-2 flex items-center justify-between text-[11px] text-surface-400"><span>当前 {{ tickets.length }} 条任务</span><span>优先展示需关注的任务</span></div>
        </div>
        <p v-if="listError" class="alert-error m-3" role="alert"><span class="min-w-0 flex-1">{{ listError }}<span v-if="tickets.length">，保留上次列表。</span></span><button class="text-link shrink-0" :disabled="loading" @click="loadList">重试列表</button></p>
        <div v-if="loading && !tickets.length" class="p-6 text-center text-sm text-surface-400">正在加载…</div>
        <EmptyState v-else-if="!listError && !tickets.length && (appliedQuery || appliedStatus)" compact icon="Search" title="没有符合条件的任务" description="可以清空筛选，继续查看其他任务。" action-label="清空筛选" @action="clearFilters" />
        <EmptyState v-else-if="!listError && !tickets.length" compact title="暂无长期任务" description="创建任务，持续记录目标、授权与验收结果。" action-label="新建长期任务" @action="showTicketForm = true" />
        <div v-else class="max-h-[72vh] overflow-y-auto">
          <button v-for="item in tickets" :key="item.id" class="ticket-list-item" :class="{ 'bg-surface-800/55': selectedTicketId === item.id }" :disabled="saving" :aria-current="selectedTicketId === item.id ? 'true' : undefined" @click="selectTicket(item.id)">
            <div class="flex items-start justify-between gap-2">
              <span class="min-w-0 text-sm font-semibold text-surface-100">{{ item.title }}</span>
              <span class="status-badge shrink-0" :class="ticketTone(item.status)">{{ ticketLabel(item.status) }}</span>
            </div>
            <p class="mt-1 line-clamp-2 text-xs text-surface-400">{{ item.description || item.projectId || '未添加说明' }}</p>
            <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-surface-400">
              <span>{{ priorityLabel(item.priority) }}</span><span>{{ item.assignmentCount }} 次派工</span>
              <span v-if="item.pendingReports" class="text-sky-300">{{ item.pendingReports }} 份待验收</span>
              <span v-if="item.attentionEffects" class="text-status-warn">{{ item.attentionEffects }} 项需处理</span>
            </div>
          </button>
        </div>
      </aside>

      <div ref="detailRef" tabindex="-1" class="ticket-detail min-w-0 space-y-4" aria-label="任务详情">
        <div v-if="selectedTicketId" class="ticket-detail-navigation"><button class="text-link xl:hidden" @click="backToList"><ArrowLeft class="h-3.5 w-3.5" />返回任务列表</button><span v-if="!loading && !listError && !tickets.some(item => item.id === selectedTicketId)" class="text-xs text-surface-400">当前详情不在列表结果中，仍可继续查看</span><button class="text-link ml-auto" :disabled="detailLoading" @click="refreshDetail()"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': detailLoading }" />刷新详情</button></div>
        <p v-if="detailError" class="alert-error" role="alert"><span class="min-w-0 flex-1">{{ detailError }}<span v-if="selectedTicket">，保留上次详情。</span></span><button class="text-link shrink-0" :disabled="detailLoading" @click="refreshDetail()">重试详情</button></p>
        <div v-if="detailLoading && !selectedTicket" class="card flex min-h-80 items-center justify-center gap-3 text-sm text-surface-400" role="status"><span class="loading-mark"></span>正在加载任务详情…</div>
        <div v-else-if="!selectedTicket && !detailError" class="card flex min-h-80 flex-col items-center justify-center p-8 text-center">
          <ClipboardList class="mb-3 h-9 w-9 text-surface-400" />
          <h2 class="text-base font-semibold text-surface-200">选择一个长期任务</h2>
          <p class="mt-1 max-w-md text-sm text-surface-400">从左侧选择任务，查看目标、授权、派工和验收证据；手机上可随时返回任务列表。</p>
        </div>

        <template v-else-if="selectedTicket">
          <section class="card ticket-summary p-4 sm:p-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <span class="status-badge" :class="ticketTone(selectedTicket.status)">{{ ticketLabel(selectedTicket.status) }}</span>
                  <span class="count-badge">{{ priorityLabel(selectedTicket.priority) }}</span>
                  <span class="count-badge">{{ sourceLabel(selectedTicket.sourceType) }}</span>
                </div>
                <h2 class="break-words text-lg font-semibold text-surface-100">{{ selectedTicket.title }}</h2>
                <p class="mt-1 whitespace-pre-wrap text-sm text-surface-400">{{ selectedTicket.description || '暂无任务说明' }}</p>
                <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-surface-400">
                  <span class="font-mono">{{ selectedTicket.id }}</span><span v-if="selectedTicket.projectId">项目 {{ selectedTicket.projectId }}</span>
                  <span v-if="selectedTicket.hostId">节点 {{ selectedTicket.hostId }}</span><span>创建于 {{ formatTime(selectedTicket.createdAt) }}</span>
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <select v-model="ticketStatusDraft" :disabled="saving" class="input w-32 input-sm" aria-label="长期任务状态">
                  <option value="planning">规划中</option><option value="ready">待派工</option><option value="active">执行中</option><option value="blocked">阻塞</option><option value="review">待验收</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option>
                </select>
                <button class="btn-secondary btn-sm" :disabled="saving || ticketStatusDraft === selectedTicket.status" @click="updateTicketStatus">更新状态</button>
              </div>
            </div>
            <div v-if="selectedTicket.acceptanceCriteria?.length" class="mt-4 rounded-lg border border-surface-800 bg-surface-950/35 p-3">
              <h3 class="text-xs font-semibold text-surface-300">验收标准</h3>
              <ul class="mt-2 space-y-1.5 text-xs text-surface-400"><li v-for="(criterion,i) in selectedTicket.acceptanceCriteria" :key="i" class="flex gap-2"><CheckCircle2 class="mt-0.5 h-3.5 w-3.5 shrink-0 text-surface-400" /><span>{{ criterion }}</span></li></ul>
            </div>
          </section>

          <div class="flex gap-1 overflow-x-auto rounded-xl border border-surface-800 bg-surface-950/50 p-1" role="tablist" aria-label="长期任务工作区" @keydown="handleTicketTabKeydown">
            <button v-for="tab in tabs" :key="tab.id" class="shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition" :class="activeTab === tab.id ? 'bg-surface-800 text-surface-100' : 'text-surface-400 hover:text-surface-200'" role="tab" :data-tab="tab.id" :tabindex="activeTab === tab.id ? 0 : -1" :disabled="saving" :aria-selected="activeTab === tab.id" @click="activeTab = tab.id">{{ tab.label }}<span class="ml-1.5 text-surface-400">{{ tab.count }}</span></button>
          </div>

          <section v-if="activeTab === 'overview'" class="space-y-3">
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="card p-3"><p class="text-[11px] text-surface-400">授权版本</p><p class="mt-1 text-xl font-semibold text-surface-100">{{ activeMandate?.version ? 'v' + activeMandate.version : '未签发' }}</p><p class="mt-1 text-[11px] text-surface-400">{{ activeMandate ? mandateStatus(activeMandate) : '建议先定义授权范围' }}</p></div>
              <div class="card p-3"><p class="text-[11px] text-surface-400">执行派工</p><p class="mt-1 text-xl font-semibold text-surface-100">{{ detail.assignments?.length || 0 }}</p><p class="mt-1 text-[11px] text-surface-400">包含历史交接</p></div>
              <div class="card p-3"><p class="text-[11px] text-surface-400">待执行动作</p><p class="mt-1 text-xl font-semibold text-surface-100">{{ pendingEffectsCount }}</p><p class="mt-1 text-[11px] text-surface-400">批准不等于执行</p></div>
            </div>
            <div class="card p-4">
              <div class="mb-3 flex items-center justify-between"><div><h3 class="text-sm font-semibold text-surface-200">任务活动</h3><p class="mt-0.5 text-xs text-surface-400">从创建、交接到验收的完整记录</p></div><span class="text-xs text-surface-400">{{ detail.activity?.length || 0 }} 条</span></div>
              <div v-if="detail.activity?.length" class="space-y-3">
                <div v-for="item in detail.activity.slice(0,18)" :key="item.id" class="flex gap-3">
                  <span class="mt-1 h-2 w-2 shrink-0 rounded-full bg-surface-500" />
                  <div class="min-w-0 flex-1"><div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-xs text-surface-200">{{ eventLabel(item.eventType) }}</strong><time class="text-[10px] text-surface-400">{{ formatTime(item.createdAt) }}</time></div><p class="mt-0.5 break-words text-[11px] text-surface-400">{{ activitySummary(item) }}</p></div>
                </div>
              </div>
              <p v-else class="text-xs text-surface-400">尚无活动记录</p>
            </div>
            <div class="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 text-xs text-sky-100/80">
              <div class="flex items-center gap-2 font-semibold text-sky-200"><Info class="h-4 w-4" />观察 → 建议 → 审批 → 执行</div>
              <p class="mt-1.5">事件和巡检可生成跟进建议。任务持续记录目标、授权与证据；请求执行的动作经人工审批后进入队列。支持只读检查；AI 值守产生的单次重启处置使用独立身份校验和恢复验收。</p>
            </div>
          </section>

          <section v-else-if="activeTab === 'mandates'" class="space-y-3">
            <div class="card p-4">
              <div class="ticket-section-heading"><div><h3 class="text-sm font-semibold text-surface-200">授权快照</h3><p class="mt-0.5 text-xs text-surface-400">范围、允许/禁止动作与策略版本签名；新版本会撤销旧版本</p></div><button :disabled="saving" class="btn-primary btn-sm" @click="showMandateForm = !showMandateForm"><Plus class="h-3.5 w-3.5" />签发授权</button></div>
              <form v-if="showMandateForm" class="mb-4 grid gap-3 rounded-lg border border-surface-800 bg-surface-950/35 p-3 md:grid-cols-2" @submit.prevent="issueMandate"><fieldset :disabled="saving" class="contents">
                <label class="form-grid-label"><span>项目范围（每行一个）</span><textarea v-model="mandateForm.projectIds" class="input min-h-16" :placeholder="selectedTicket.projectId || 'project-id'" /></label>
                <label class="form-grid-label"><span>Compose 项目名范围（每行一个，必须精确匹配）</span><textarea v-model="mandateForm.composeProjectNames" class="input min-h-16 font-mono text-xs" placeholder="composeops" /></label>
                <label class="form-grid-label"><span>节点范围（每行一个）</span><textarea v-model="mandateForm.hostIds" class="input min-h-16" placeholder="host-id" /></label>
                <label class="form-grid-label"><span>资源范围（每行一个）</span><textarea v-model="mandateForm.resourceIds" class="input min-h-16" placeholder="container-id / volume-id" /></label>
                <label class="form-grid-label"><span>有效期（天）</span><input v-model.number="mandateForm.days" type="number" min="1" max="90" class="input" /></label>
                <label class="form-grid-label"><span>允许动作（每行一个）</span><textarea v-model="mandateForm.allowedActions" class="input min-h-20 font-mono text-xs" required /></label>
                <label class="form-grid-label"><span>明确禁止动作（每行一个）</span><textarea v-model="mandateForm.deniedActions" class="input min-h-20 font-mono text-xs" /></label>
                <div class="md:col-span-2 flex justify-end gap-2"><button :disabled="saving" type="button" class="btn-secondary" @click="showMandateForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving">签发不可变快照</button></div>
              </fieldset></form>
              <div v-if="detail.mandates?.length" class="space-y-2">
                <article v-for="mandate in detail.mandates" :key="mandate.id" class="rounded-lg border border-surface-800 p-3">
                  <div class="flex flex-wrap items-center justify-between gap-2"><div class="flex min-w-0 flex-wrap items-center gap-2"><strong class="text-sm text-surface-200">授权 v{{ mandate.version }}</strong><span class="status-badge" :class="mandate.status === 'active' && !isExpired(mandate) ? 'bg-status-ok/10 text-status-ok' : 'bg-surface-800 text-surface-400'">{{ mandateStatus(mandate) }}</span></div><button v-if="mandate.status === 'active'" class="btn-secondary btn-sm" @click="revokeMandate(mandate)">撤销</button></div>
                  <div class="mt-2 grid gap-2 text-xs md:grid-cols-2"><div><span class="text-surface-400">范围：</span><span class="text-surface-300">{{ scopeLabel(mandate.scope) }}</span></div><div><span class="text-surface-400">到期：</span><span class="text-surface-300">{{ formatTime(mandate.expiresAt) }}</span></div></div>
                  <div class="mt-2 flex flex-wrap gap-1"><span v-for="action in mandate.allowedActions" :key="action" class="count-badge text-status-ok">{{ action }}</span><span v-for="action in mandate.deniedActions" :key="'deny-'+action" class="count-badge text-status-error">禁止 · {{ action }}</span></div>
                  <p class="mt-2 break-all font-mono text-[10px] text-surface-400">SHA-256 · {{ mandate.fingerprint }}</p>
                </article>
              </div>
              <p v-else class="text-xs text-surface-400">尚未签发授权。Observe / Suggest 不需要执行授权；真正进入 Execute 意图必须签发受限 Mandate。</p>
            </div>
          </section>

          <section v-else-if="activeTab === 'assignments'" class="space-y-3">
            <div class="card p-4">
              <div class="ticket-section-heading"><div><h3 class="text-sm font-semibold text-surface-200">执行派工（Assignment）</h3><p class="mt-0.5 text-xs text-surface-400">可关联已有 Agent Session、Plan、后台任务或工作流；交接会创建新派工，不会删除历史</p></div><button :disabled="saving" class="btn-primary btn-sm" @click="showAssignmentForm = !showAssignmentForm"><Plus class="h-3.5 w-3.5" />新增派工</button></div>
              <form v-if="showAssignmentForm" class="mb-4 grid gap-3 rounded-lg border border-surface-800 bg-surface-950/35 p-3 md:grid-cols-2" @submit.prevent="createAssignment"><fieldset :disabled="saving" class="contents">
                <label class="form-grid-label"><span>Worker 角色</span><select v-model="assignmentForm.workerRole" class="input"><option value="planner">规划者</option><option value="executor">执行者</option><option value="validator">只读验证者</option><option value="incident_responder">应急响应者</option><option value="manual">人工执行</option></select></label>
                <label class="form-grid-label"><span>关联来源</span><select v-model="assignmentForm.sourceType" class="input"><option value="manual">手动</option><option value="agent-session">Agent Session</option><option value="agent-plan">Agent Plan</option><option value="agent-task">Agent 后台任务</option><option value="workflow">工作流实例</option><option value="batch-job">批量任务</option></select></label>
                <label class="form-grid-label"><span>来源 ID</span><input v-model="assignmentForm.sourceId" class="input" maxlength="160" :required="assignmentForm.sourceType !== 'manual'" placeholder="existing-session / plan / task / workflow ID" /></label>
                <label class="form-grid-label"><span>Session ID（可选）</span><input v-model="assignmentForm.sessionId" type="number" min="1" class="input" aria-label="数字 ID" placeholder="数字 ID" /></label>
                <label class="form-grid-label"><span>授权版本（可选）</span><select v-model="assignmentForm.mandateId" class="input"><option value="">不关联授权</option><option v-for="mandate in activeMandates" :key="mandate.id" :value="mandate.id">授权 v{{ mandate.version }}</option></select></label>
                <label class="form-grid-label"><span>接替前序派工（可选）</span><select v-model="assignmentForm.replacesAssignmentId" class="input"><option value="">不接替</option><option v-for="item in handoffableAssignments" :key="item.id" :value="item.id">#{{ item.sequence }} · {{ roleLabel(item.workerRole) }} · {{ item.status }}</option></select></label>
                <label class="form-grid-label md:col-span-2"><span>交接摘要 / 执行边界</span><textarea v-model="assignmentForm.handoffSummary" class="input min-h-16" maxlength="4000" aria-label="交接时必须填写：已经完成什么、未完成什么、证据在哪里、下一步不能做什么。" placeholder="交接时必须填写：已经完成什么、未完成什么、证据在哪里、下一步不能做什么。" /></label>
                <div class="md:col-span-2 flex justify-end gap-2"><button :disabled="saving" type="button" class="btn-secondary" @click="showAssignmentForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving">创建派工记录</button></div>
              </fieldset></form>
              <div v-if="detail.assignments?.length" class="space-y-2">
                <article v-for="item in detail.assignments" :key="item.id" class="rounded-lg border border-surface-800 p-3">
                  <div class="flex flex-wrap items-start justify-between gap-2"><div><div class="flex flex-wrap items-center gap-2"><strong class="text-sm text-surface-200">#{{ item.sequence }} · {{ roleLabel(item.workerRole) }}</strong><span class="status-badge" :class="assignmentTone(item.status)">{{ assignmentLabel(item.status) }}</span><span v-if="item.sourceType !== 'manual'" class="count-badge">{{ item.sourceType }}</span></div><p class="mt-1 break-all font-mono text-[10px] text-surface-400">{{ item.id }}</p></div><div class="flex flex-wrap gap-1"><button v-if="['assigned','waiting'].includes(item.status)" class="btn-secondary btn-sm" @click="updateAssignment(item,'running')">标记运行</button><button v-if="['assigned','running'].includes(item.status)" class="btn-secondary btn-sm" @click="updateAssignment(item,'blocked')">标记阻塞</button><button v-if="['assigned','running','waiting','blocked'].includes(item.status)" class="btn-secondary btn-sm" @click="prepareHandoff(item)">交接</button><button v-if="['assigned','running','waiting','blocked'].includes(item.status)" class="btn-secondary btn-sm" @click="updateAssignment(item,'outcome_unknown')">结果不确定</button><button v-if="item.status === 'outcome_unknown'" class="btn-primary btn-sm" @click="openAssignmentReconcile(item)">核对结果</button></div></div>
                  <div class="mt-2 grid gap-1 text-xs text-surface-400 sm:grid-cols-2"><span>来源：{{ item.sourceId || '人工' }}</span><span>Session：{{ item.sessionId || '—' }}</span><span>尝试：{{ item.attempt }}</span><span>更新时间：{{ formatTime(item.updatedAt) }}</span></div>
                  <p v-if="item.handoffSummary" class="mt-2 whitespace-pre-wrap rounded-md bg-surface-950/45 p-2 text-xs text-surface-400">{{ item.handoffSummary }}</p>
                  <form v-if="reconcileAssignmentId === item.id" class="mt-3 grid gap-2 rounded-lg border border-status-warn/20 bg-status-warn/5 p-3 sm:grid-cols-[140px_minmax(0,1fr)_auto]" @submit.prevent="reconcileAssignment(item)"><fieldset :disabled="saving" class="contents">
                    <select v-model="reconcileForm.outcome" class="input input-sm" aria-label="人工核对结果"><option value="succeeded">核对成功</option><option value="failed">核对失败</option><option value="cancelled">确认已取消</option></select>
                    <input v-model="reconcileForm.note" class="input input-sm" required aria-label="真实环境核对依据（必填）" placeholder="真实环境核对依据（必填）" />
                    <button class="btn-primary btn-sm" :disabled="saving || !reconcileForm.note.trim()">提交核对</button>
                  </fieldset></form>
                </article>
              </div>
              <p v-else class="text-xs text-surface-400">还没有派工记录。先选择已有执行上下文，或创建人工/只读验证派工。</p>
            </div>
          </section>

          <section v-else-if="activeTab === 'reports'" class="space-y-3">
            <div class="card p-4">
              <div class="ticket-section-heading"><div><h3 class="text-sm font-semibold text-surface-200">结构化报告与验收</h3><p class="mt-0.5 text-xs text-surface-400">报告附带发现项、证据和提交时的验收标准快照</p></div><button :disabled="saving" class="btn-primary btn-sm" @click="showReportForm = !showReportForm"><Plus class="h-3.5 w-3.5" />提交报告</button></div>
              <form v-if="showReportForm" class="mb-4 grid gap-3 rounded-lg border border-surface-800 bg-surface-950/35 p-3 md:grid-cols-2" @submit.prevent="submitReport"><fieldset :disabled="saving" class="contents">
                <label class="form-grid-label"><span>关联派工</span><select v-model="reportForm.assignmentId" class="input"><option value="">不指定</option><option v-for="item in detail.assignments" :key="item.id" :value="item.id">#{{ item.sequence }} · {{ roleLabel(item.workerRole) }}</option></select></label>
                <label class="form-grid-label"><span>报告类型</span><select v-model="reportForm.reportType" class="input"><option value="execution">执行报告</option><option value="verification">验证报告</option><option value="incident">事件报告</option><option value="review">复核报告</option></select></label>
                <label class="form-grid-label md:col-span-2"><span>结论摘要</span><textarea v-model="reportForm.summary" class="input min-h-16" required maxlength="4000" /></label>
                <label class="form-grid-label"><span>发现项标题（可选）</span><input v-model="reportForm.findingTitle" class="input" maxlength="200" placeholder="例如镜像版本落后" /></label>
                <label class="form-grid-label"><span>严重程度</span><select v-model="reportForm.findingSeverity" class="input"><option value="info">信息</option><option value="warning">警告</option><option value="danger">严重</option></select></label>
                <label class="form-grid-label md:col-span-2"><span>发现详情 / 建议</span><textarea v-model="reportForm.findingDetail" class="input min-h-16" maxlength="2000" placeholder="现象、影响、证据和建议。" /></label>
                <label class="form-grid-label"><span>证据类型</span><select v-model="reportForm.evidenceKind" class="input"><option value="docker-inspect">Docker Inspect</option><option value="logs">日志</option><option value="http-check">HTTP 检查</option><option value="workflow">工作流记录</option><option value="note">人工记录</option></select></label>
                <label class="form-grid-label"><span>证据来源 ID（可选）</span><input v-model="reportForm.evidenceSourceId" class="input" maxlength="240" placeholder="container-id / event-id" /></label>
                <label class="form-grid-label md:col-span-2"><span>证据摘要</span><input v-model="reportForm.evidenceSummary" class="input" maxlength="1000" placeholder="说明证据实际证明了什么" /></label>
                <div class="md:col-span-2 flex justify-end gap-2"><button :disabled="saving" type="button" class="btn-secondary" @click="showReportForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving || !reportForm.summary.trim()">提交待验收报告</button></div>
              </fieldset></form>
              <div v-if="detail.reports?.length" class="space-y-2">
                <article v-for="report in detail.reports" :key="report.id" class="rounded-lg border border-surface-800 p-3">
                  <div class="flex flex-wrap items-center justify-between gap-2"><div class="flex min-w-0 flex-wrap items-center gap-2"><strong class="text-sm text-surface-200">{{ reportTypeLabel(report.reportType) }}</strong><span class="status-badge" :class="report.status === 'accepted' ? 'bg-status-ok/10 text-status-ok' : report.status === 'rejected' ? 'bg-status-error/10 text-status-error' : 'bg-sky-500/10 text-sky-300'">{{ reportStatus(report.status) }}</span></div><span class="text-[10px] text-surface-400">{{ formatTime(report.createdAt) }}</span></div>
                  <p class="mt-2 whitespace-pre-wrap text-sm text-surface-300">{{ report.summary }}</p>
                  <div v-if="report.findings?.length" class="mt-2 space-y-1"><div v-for="finding in report.findings" :key="finding.title" class="rounded bg-surface-950/40 p-2"><p class="text-xs font-medium text-surface-200">{{ finding.title }} <span class="text-surface-400">· {{ finding.severity }}</span></p><p class="mt-1 text-xs text-surface-400">{{ finding.detail }}</p><p v-if="finding.recommendation" class="mt-1 text-xs text-surface-400">建议：{{ finding.recommendation }}</p></div></div>
                  <div v-if="report.evidence?.length" class="mt-2 space-y-1"><p class="text-[10px] font-semibold text-surface-400">证据</p><div v-for="evidence in report.evidence" :key="evidence.kind + evidence.sourceId" class="text-xs text-surface-400">{{ evidence.kind }} · {{ evidence.sourceId || '无来源 ID' }} · {{ evidence.summary }}</div></div>
                  <div v-if="report.status === 'submitted'" class="mt-3 flex flex-wrap justify-end gap-2 border-t border-surface-800 pt-3"><button class="btn-secondary" :disabled="saving" @click="decideReport(report,false)">退回补充</button><button class="btn-primary" :disabled="saving" @click="decideReport(report,true)">验收通过</button></div>
                  <p v-else class="mt-2 text-xs text-surface-400">验收意见：{{ report.decisionNote || '—' }}</p>
                </article>
              </div>
              <p v-else class="text-xs text-surface-400">尚无报告。任务只有经过人工验收，才适合进入最终完成状态。</p>
            </div>
          </section>

          <section v-else-if="activeTab === 'effects'" class="space-y-3">
            <div class="card p-4">
              <div class="ticket-section-heading"><div><h3 class="text-sm font-semibold text-surface-200">动作队列</h3><p class="mt-0.5 text-xs text-surface-400">审批、授权复核、受控派发与结果留痕</p></div><button :disabled="saving" class="btn-primary btn-sm" @click="showEffectForm = !showEffectForm"><Plus class="h-3.5 w-3.5" />新增意图</button></div>
              <div class="mb-3 rounded-lg border border-surface-800 bg-surface-950/40 p-3 text-xs">
                <p v-if="workerError" class="alert-error mb-3" role="alert"><span class="min-w-0 flex-1">{{ workerError }}</span><button class="text-link shrink-0" :disabled="workerLoading" @click="loadWorkerStatus">重试执行器</button></p>
                <div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-surface-200">执行器状态</strong><span class="status-badge" :class="workerStatus?.enabled ? 'bg-status-ok/10 text-status-ok' : 'bg-surface-800 text-surface-400'">{{ workerError ? '状态未知' : workerLoading && !workerStatus ? '读取中' : workerStatus?.enabled ? '运行中' : workerStatus ? '已停止' : '尚未读取' }}</span></div>
                <div class="mt-2 grid grid-cols-2 gap-2 text-surface-400 sm:grid-cols-4"><span>待派发：{{ workerStatus?.queueDepth ?? '—' }}</span><span>执行中：{{ workerStatus?.executing ?? '—' }}</span><span>租约中：{{ workerStatus?.leased ?? '—' }}</span><span>待核对：{{ workerStatus?.outcomeUnknown ?? '—' }}</span></div>
                <p class="mt-2 leading-5 text-surface-300">通用意图支持本机只读检查；故障处置由 AI 值守生成。批准只是入队，结果需要单独验证。</p>
                <p v-if="workerStatus?.lastError" class="mt-2 break-words text-status-error">最近错误：{{ workerStatus.lastError }}</p>
                <details class="ticket-technical-details"><summary>查看执行范围与审批规则</summary><div class="mt-2 space-y-2 text-xs leading-5"><p>动作范围：service.inspect、container.inspect，以及 AI 值守生成的 incident.restart。执行前重新验证审批、授权版本、范围和风险。</p><p>通用意图不能执行拉取、部署、删除和任意命令。单容器重启仅接受 AI 值守的固定流程、完整身份快照与单次审批。</p><p>故障处置固定到发现故障的节点；执行结果不明时需要人工核对，不会自动重放。</p></div></details>
              </div>
              <form v-if="showEffectForm" class="mb-4 grid gap-3 rounded-lg border border-surface-800 bg-surface-950/35 p-3 md:grid-cols-2" @submit.prevent="createEffect"><fieldset :disabled="saving" class="contents">
                <label class="form-grid-label"><span>动作类型</span><select v-model="effectForm.effectType" class="input font-mono text-xs"><option value="service.inspect">service.inspect · 项目容器列表</option><option value="container.inspect">container.inspect · 单容器详情</option></select></label>
                <label class="form-grid-label"><span>模式</span><select v-model="effectForm.mode" class="input"><option value="observe">只记录观察</option><option value="suggest">提出建议</option><option value="execute">请求执行授权</option></select></label>
                <label class="form-grid-label"><span>风险等级</span><select v-model="effectForm.risk" class="input"><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option><option value="critical">关键操作</option></select></label>
                <label v-if="effectForm.mode === 'execute'" class="form-grid-label"><span>授权版本</span><select v-model="effectForm.mandateId" class="input" required><option value="">选择当前有效授权</option><option v-for="mandate in activeMandates" :key="mandate.id" :value="mandate.id">授权 v{{ mandate.version }}</option></select></label>
                <label class="form-grid-label"><span>项目 ID（用于授权范围匹配）</span><input v-model="effectForm.projectId" class="input" maxlength="160" :placeholder="selectedTicket.projectId || 'project-id'" /></label>
                <label class="form-grid-label"><span>Compose 项目名（精确匹配 Docker Label）</span><input v-model="effectForm.composeProject" class="input font-mono" maxlength="128" required placeholder="compose-project-name" /></label>
                <label v-if="effectForm.effectType === 'container.inspect'" class="form-grid-label md:col-span-2"><span>容器 ID（12–64 位十六进制）</span><input v-model="effectForm.resourceId" class="input font-mono" maxlength="64" required placeholder="Docker container ID" /></label>
                <label class="form-grid-label"><span>节点 ID（当前仅支持本机）</span><input v-model="effectForm.hostId" class="input" maxlength="160" :placeholder="selectedTicket.hostId || '留空：本机 Docker'" /></label>
                <label class="form-grid-label md:col-span-2"><span>动作参数（JSON 对象）</span><textarea v-model="effectForm.payload" class="input min-h-20 font-mono text-xs" /></label>
                <div class="md:col-span-2 flex justify-end gap-2"><button :disabled="saving" type="button" class="btn-secondary" @click="showEffectForm = false">取消</button><button type="submit" class="btn-primary" :disabled="saving">记录动作</button></div>
              </fieldset></form>
              <div v-if="detail.effects?.length" class="space-y-2">
                <article v-for="effect in detail.effects" :key="effect.id" class="rounded-lg border border-surface-800 p-3">
                  <div class="flex flex-wrap items-center justify-between gap-2"><div class="flex min-w-0 flex-wrap items-center gap-2"><strong class="break-all font-mono text-sm text-surface-200">{{ effect.effectType }}</strong><span class="status-badge" :class="effectTone(effect.status)">{{ effectLabel(effect.status) }}</span><span class="count-badge">{{ effectModeLabel(effect.mode) }}</span><RiskBadge :risk="effect.risk" /></div><span class="text-[10px] text-surface-400">{{ formatTime(effect.createdAt) }}</span></div>
                  <p class="mt-1 break-all font-mono text-[10px] text-surface-400">{{ effect.id }} <span v-if="effect.mandateId">· {{ effect.mandateId }}</span></p>
                  <p class="mt-2 break-words text-xs text-surface-300">目标：{{ effect.target?.composeProject || effect.target?.projectId || '未指定项目' }}<span v-if="effect.target?.resourceId"> · {{ effect.target.resourceId }}</span></p><p v-if="effect.error" class="mt-2 break-words text-xs text-status-error">{{ effect.error }}</p><details class="ticket-technical-details"><summary>查看参数与执行结果</summary><pre>{{ JSON.stringify({ target: effect.target, payload: effect.payload, result: effect.result, error: effect.error }, null, 2) }}</pre></details>
                  <div class="mt-3 flex flex-wrap justify-end gap-2"><button v-if="effect.status === 'awaiting_approval'" class="btn-primary" :disabled="saving" @click="approveEffect(effect)">批准并入队</button><button v-if="['proposed','awaiting_approval','queued'].includes(effect.status)" class="btn-secondary" :disabled="saving" @click="cancelEffect(effect)">取消</button><button v-if="effect.status === 'outcome_unknown'" class="btn-secondary" @click="openEffectReconcile(effect)">人工核对</button></div>
                  <form v-if="reconcileEffectId === effect.id" class="mt-3 grid gap-2 rounded-lg border border-status-warn/20 bg-status-warn/5 p-3 sm:grid-cols-[140px_minmax(0,1fr)_auto]" @submit.prevent="reconcileEffect(effect)"><fieldset :disabled="saving" class="contents">
                    <select v-model="reconcileForm.outcome" class="input input-sm" aria-label="人工核对结果"><option value="succeeded">核对成功</option><option value="failed">核对失败</option><option value="cancelled">确认已取消</option></select>
                    <input v-model="reconcileForm.note" class="input input-sm" required aria-label="真实环境核对依据（必填）" placeholder="真实环境核对依据（必填）" />
                    <button class="btn-primary btn-sm" :disabled="saving || !reconcileForm.note.trim()">提交核对</button>
                  </fieldset></form>
                </article>
              </div>
              <p v-else class="text-xs text-surface-400">暂无待执行动作。可先记录观察或提出建议；请求执行时必须关联有效授权并经人工审批。</p>
            </div>
          </section>
        </template>
      </div>
    </section>
    <BaseModal :show="!!decision" :title="decisionTitle" :close-disabled="saving" size-class="sm:max-w-lg flex max-h-[85dvh] flex-col" body-class="min-h-0 overflow-y-auto p-4 space-y-4" @close="decision = null">
      <template v-if="decision">
        <div class="ticket-decision-target"><p class="text-xs text-surface-400">当前任务</p><p class="mt-1 break-words font-medium">{{ decision.ticketTitle }}</p><p class="mt-2 break-all font-mono text-[10px] text-surface-400">{{ decision.item.id }}</p></div>
        <template v-if="decision.kind === 'revoke'"><p class="text-sm leading-6 text-surface-300">撤销授权 v{{ decision.item.version }} 后，关联的待审批、排队或尚未开始执行的动作将被拒绝。已经完成的操作不会撤销。</p><p class="break-words text-xs text-surface-400">{{ scopeLabel(decision.item.scope) }}</p></template>
        <template v-else-if="decision.kind === 'report'"><p class="whitespace-pre-wrap break-words text-sm text-surface-300">{{ decision.item.summary }}</p><p class="text-xs leading-5 text-surface-400">{{ decision.accepted ? '确认报告证据与验收标准相符。报告通过后，任务仍需单独更新最终状态。' : '报告将退回补充；已有内容与验收意见继续保留。' }}</p></template>
        <template v-else><p class="text-sm text-surface-200">{{ decision.item.effectType }} · {{ decision.item.target?.composeProject || decision.item.target?.projectId || '未指定目标' }}</p><p class="break-all text-xs text-surface-400" v-if="decision.item.target?.resourceId">容器 {{ decision.item.target.resourceId }}</p><p class="text-sm leading-6 text-surface-300">{{ decision.kind === 'approve' ? '批准后进入待派发队列，执行器仍会检查授权范围与版本。故障重启还会核对节点和容器身份；批准并不代表执行成功。' : '仅取消尚未领取或执行的动作。如果执行器已开始处理，服务端会拒绝此次取消。' }}</p></template>
        <label v-if="['revoke','report'].includes(decision.kind)" class="form-grid-label"><span>{{ decision.kind === 'revoke' ? '撤销原因（必填）' : '验收意见' }}</span><textarea v-model="decisionNote" class="input min-h-24" :disabled="saving" :maxlength="decision.kind === 'revoke' ? 500 : 2000" /></label>
        <p v-if="decisionError" class="alert-error" role="alert">{{ decisionError }}</p>
      </template>
      <template #footer><button class="btn-secondary" :disabled="saving" @click="decision = null">取消</button><button class="btn-primary" :disabled="saving || (decision?.kind === 'revoke' && !decisionNote.trim())" @click="confirmDecision"><LoaderCircle v-if="saving" class="h-4 w-4 animate-spin" />{{ saving ? '提交中…' : decisionTitle }}</button></template>
    </BaseModal>
  </div>
</template>

<script setup>
import RiskBadge from '../components/common/RiskBadge.vue';
import EmptyState from '../components/common/EmptyState.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import BaseModal from '../components/common/BaseModal.vue';
import { formatTimestamp } from '../lib/date-time.js';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client.js';
import {
  Activity, ArrowLeft, CheckCircle2, ClipboardList, Info, LoaderCircle, Plus, RefreshCw, Search, X,
} from 'lucide-vue-next';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const tickets = ref([]);
const stats = ref({});
const statsLoaded = ref(false);
const listError = ref('');
const detailError = ref('');
const workerError = ref('');
const workerLoading = ref(false);
const feedbackRef = ref(null);
const listRef = ref(null);
const detailRef = ref(null);
const emptyDetail = () => ({ ticket: null, mandates: [], assignments: [], reports: [], effects: [], activity: [] });
const detail = ref(emptyDetail());
const workerStatus = ref(null);
const selectedTicketId = ref(typeof route.query.ticket === 'string' ? route.query.ticket : '');
const query = ref(String(route.query.q || '').slice(0, 120));
const ticketStates = ['planning','ready','active','blocked','review','succeeded','failed','cancelled'];
const statusFilter = ref(ticketStates.includes(route.query.status) ? route.query.status : '');
const appliedQuery = ref(query.value);
const appliedStatus = ref(statusFilter.value);
const ticketTabs = ['overview', 'mandates', 'assignments', 'reports', 'effects'];
const activeTab = ref(ticketTabs.includes(route.query.tab) ? route.query.tab : 'overview');
const detailLoading = ref(false);
let detailRequest = 0;
let listRequest = 0;
let workerRequest = 0;
let writeRequest = 0;
let contextVersion = 0;
let disposed = false;
let routeSync = Promise.resolve();
function syncRoute() {
  if (disposed || route.path !== '/tickets') return;
  const next = { ...route.query };
  for (const [key, value] of Object.entries({ ticket: selectedTicketId.value, tab: activeTab.value === 'overview' ? '' : activeTab.value, q: appliedQuery.value, status: appliedStatus.value })) {
    if (value) next[key] = value; else delete next[key];
  }
  if (JSON.stringify(next) !== JSON.stringify(route.query)) routeSync = router.replace({ path: '/tickets', query: next });
  return routeSync;
}
watch([selectedTicketId, activeTab], syncRoute);
watch(() => [route.query.ticket, route.query.tab, route.query.q, route.query.status], ([id, tab, q, status]) => {
  if (disposed || route.path !== '/tickets') return;
  activeTab.value = ticketTabs.includes(tab) ? tab : 'overview';
  if (typeof id === 'string' && id !== selectedTicketId.value) {
    changeTicketContext(id);
    void refreshDetail(id);
  }
  const nextQuery = String(q || '').slice(0, 120), nextStatus = ticketStates.includes(status) ? status : '';
  if (nextQuery !== appliedQuery.value || nextStatus !== appliedStatus.value) {
    query.value = appliedQuery.value = nextQuery;
    statusFilter.value = appliedStatus.value = nextStatus;
    void loadList();
  }
});
onBeforeUnmount(() => { disposed = true; invalidateContext(); window.removeEventListener('composeops:host-changed', onHostChanged); });
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
  { id: 'effects', label: '动作队列', count: detail.value.effects?.length || 0 },
]);
function handleTicketTabKeydown(event) { if (!saving.value) handleTablistKeydown(event, value => { activeTab.value = value; }); }
const selectedTicket = computed(() => detail.value.ticket);
const activeMandates = computed(() => (detail.value.mandates || []).filter((m) => m.status === 'active' && !isExpired(m)));
const activeMandate = computed(() => activeMandates.value[0] || null);
const handoffableAssignments = computed(() => (detail.value.assignments || []).filter((a) => ['assigned', 'running', 'waiting', 'blocked'].includes(a.status)));

function splitLines(value) { return [...new Set(String(value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean))]; }
function isExpired(mandate) { return !Number.isFinite(Date.parse(mandate.expiresAt)) || Date.parse(mandate.expiresAt) <= Date.now(); }
function formatTime(value) { return formatTimestamp(value); }
function ticketLabel(status) { return ({ planning: '规划中', ready: '待派工', active: '执行中', blocked: '阻塞', review: '待验收', succeeded: '成功', failed: '失败', cancelled: '已取消' })[status] || status; }
function ticketTone(status) { return ({ planning: 'bg-surface-800 text-surface-300', ready: 'bg-sky-500/10 text-sky-300', active: 'bg-blue-500/10 text-blue-300', blocked: 'bg-status-warn/10 text-status-warn', review: 'bg-violet-500/10 text-violet-300', succeeded: 'bg-status-ok/10 text-status-ok', failed: 'bg-status-error/10 text-status-error', cancelled: 'bg-surface-800 text-surface-400' })[status] || 'bg-surface-800 text-surface-400'; }
function priorityLabel(value) { return ({ low: '低优先级', normal: '普通优先级', high: '高优先级', urgent: '紧急' })[value] || value; }
function sourceLabel(value) { return ({ manual: '手动', event: '事件', inspection: '巡检', agent: 'Agent', workflow: '工作流' })[value] || value; }
function mandateStatus(m) { return m.status === 'active' && !isExpired(m) ? '有效' : m.status === 'active' ? '已过期' : m.status === 'revoked' ? '已撤销' : m.status; }
function scopeLabel(scope = {}) { return [['项目', scope.projectIds], ['Compose 项目', scope.composeProjectNames], ['节点', scope.hostIds], ['资源', scope.resourceIds]].filter(([, values]) => values?.length).map(([label, values]) => label + ' ' + values.join(', ')).join('；') || '未限定'; }
function roleLabel(role) { return ({ planner: '规划者', executor: '执行者', validator: '只读验证者', incident_responder: '应急响应者', manual: '人工' })[role] || role; }
function assignmentLabel(status) { return ({ assigned: '已派工', running: '执行中', waiting: '等待中', blocked: '阻塞', handed_off: '已交接', succeeded: '成功', failed: '失败', outcome_unknown: '结果待核对', cancelled: '已取消' })[status] || status; }
function assignmentTone(status) { return ({ assigned: 'bg-sky-500/10 text-sky-300', running: 'bg-blue-500/10 text-blue-300', waiting: 'bg-violet-500/10 text-violet-300', blocked: 'bg-status-warn/10 text-status-warn', outcome_unknown: 'bg-status-warn/10 text-status-warn', succeeded: 'bg-status-ok/10 text-status-ok', failed: 'bg-status-error/10 text-status-error' })[status] || 'bg-surface-800 text-surface-400'; }
function reportTypeLabel(type) { return ({ execution: '执行报告', verification: '验证报告', incident: '事件报告', review: '复核报告' })[type] || type; }
function reportStatus(status) { return ({ submitted: '待验收', accepted: '已通过', rejected: '已退回' })[status] || status; }
function effectModeLabel(mode) { return ({ observe: '观察', suggest: '建议', execute: '请求执行' })[mode] || mode; }
function effectLabel(status) { return ({ proposed: '建议待处理', awaiting_approval: '等待审批', queued: '等待派发', leased: '已被领取', executing: '执行中', succeeded: '成功', failed: '失败', outcome_unknown: '结果待核对', cancelled: '已取消', rejected: '已拒绝' })[status] || status; }
function effectTone(status) { return ({ proposed: 'bg-surface-800 text-surface-300', awaiting_approval: 'bg-status-warn/10 text-status-warn', queued: 'bg-sky-500/10 text-sky-300', leased: 'bg-blue-500/10 text-blue-300', executing: 'bg-blue-500/10 text-blue-300', succeeded: 'bg-status-ok/10 text-status-ok', failed: 'bg-status-error/10 text-status-error', outcome_unknown: 'bg-status-warn/10 text-status-warn' })[status] || 'bg-surface-800 text-surface-400'; }
function eventLabel(type) { return ({ ticket_created: '任务创建', ticket_updated: '任务更新', mandate_issued: '签发授权', mandate_revoked: '撤销授权', assignment_created: '创建派工', assignment_handoff: '执行交接', assignment_updated: '派工状态更新', assignment_reconciled: '派工结果核对', report_submitted: '提交报告', report_accepted: '验收通过', report_rejected: '报告退回', effect_proposed: '提出待执行动作', effect_approved_queued: '批准并入队', effect_claimed: '执行器领取', effect_execution_started: '进入执行阶段', effect_completed: '执行完成', effect_outcome_unknown: '执行结果不确定', effect_reconciled: '人工核对副作用', effect_cancelled: '取消意图', effect_rejected_before_dispatch: '白名单校验拒绝', effect_lease_requeued_before_execution: '未开始的租约已安全回队列' })[type] || type; }
function activitySummary(item) { const d = item.details || {}; return d.note || d.reason || d.title || d.summary || d.effectType || d.workerRole || d.to || d.from || d.mandateId || d.reportId || '记录已写入审计时间线'; }

const pendingEffectsCount = computed(() => (detail.value.effects || []).filter(effect => ['awaiting_approval', 'queued', 'leased'].includes(effect.status)).length);
const taskDrafts = new Map();
const defaultDrafts = () => ({
  mandate: { projectIds: '', composeProjectNames: '', hostIds: '', resourceIds: '', allowedActions: 'service.inspect', deniedActions: 'volume.delete\ndatabase.drop', days: 7 },
  assignment: { workerRole: 'executor', sourceType: 'manual', sourceId: '', sessionId: '', mandateId: '', replacesAssignmentId: '', handoffSummary: '' },
  report: { assignmentId: '', reportType: 'execution', summary: '', findingTitle: '', findingSeverity: 'info', findingDetail: '', evidenceKind: 'note', evidenceSourceId: '', evidenceSummary: '' },
  effect: { effectType: 'service.inspect', mode: 'suggest', risk: 'low', mandateId: '', projectId: '', composeProject: '', resourceId: '', hostId: '', payload: '{}' },
});
function captureDrafts() {
  if (!selectedTicketId.value) return;
  taskDrafts.set(selectedTicketId.value, {
    mandate: { ...mandateForm }, assignment: { ...assignmentForm }, report: { ...reportForm }, effect: { ...effectForm },
    open: [showMandateForm.value, showAssignmentForm.value, showReportForm.value, showEffectForm.value],
  });
}
function restoreDrafts(id) {
  const draft = taskDrafts.get(id) || defaultDrafts();
  Object.assign(mandateForm, draft.mandate); Object.assign(assignmentForm, draft.assignment);
  Object.assign(reportForm, draft.report); Object.assign(effectForm, draft.effect);
  [showMandateForm.value, showAssignmentForm.value, showReportForm.value, showEffectForm.value] = draft.open || [false, false, false, false];
  reconcileAssignmentId.value = reconcileEffectId.value = '';
}
function changeTicketContext(id, { preserveWrite = false } = {}) {
  captureDrafts();
  if (!preserveWrite) { ++writeRequest; saving.value = false; }
  ++detailRequest;
  selectedTicketId.value = id; detail.value = emptyDetail(); detailLoading.value = false; detailError.value = '';
  error.value = notice.value = ''; decision.value = null; restoreDrafts(id);
}
async function revealFeedback() {
  await nextTick();
  if (disposed) return;
  feedbackRef.value?.focus({ preventScroll: true }); feedbackRef.value?.scrollIntoView?.({ block: 'nearest' });
}
async function revealDetail() {
  await nextTick();
  if (disposed || !window.matchMedia?.('(max-width: 1279px)').matches) return;
  detailRef.value?.focus({ preventScroll: true }); detailRef.value?.scrollIntoView?.({ block: 'start' });
}
function backToList() { listRef.value?.focus({ preventScroll: true }); listRef.value?.scrollIntoView?.({ block: 'start' }); }
async function refreshDetail(id = selectedTicketId.value) {
  if (disposed) return;
  const request = ++detailRequest;
  if (detail.value.ticket?.id !== id) detail.value = emptyDetail();
  detailError.value = ''; detailLoading.value = !!id;
  if (!id) return;
  try {
    const result = await api.getOpsTicket(id);
    if (disposed || request !== detailRequest || id !== selectedTicketId.value) return;
    detail.value = result;
    if (result.ticket) ticketStatusDraft.value = result.ticket.status;
  } catch (cause) {
    if (!disposed && request === detailRequest && id === selectedTicketId.value) detailError.value = cause.message || '读取任务详情失败';
  } finally { if (!disposed && request === detailRequest) detailLoading.value = false; }
}
async function loadWorkerStatus() {
  if (disposed) return;
  const request = ++workerRequest; workerLoading.value = true; workerError.value = '';
  try {
    const result = await api.getOpsEffectWorkerStatus();
    if (!disposed && request === workerRequest) workerStatus.value = result;
  } catch (cause) {
    if (!disposed && request === workerRequest) workerError.value = cause.message || '读取执行器状态失败';
  } finally { if (!disposed && request === workerRequest) workerLoading.value = false; }
}
async function loadList() {
  if (disposed) return;
  const request = ++listRequest; loading.value = true; listError.value = '';
  try {
    const result = await api.getOpsTickets({ ...(appliedStatus.value ? { status: appliedStatus.value } : {}), ...(appliedQuery.value ? { query: appliedQuery.value } : {}), limit: 200 });
    if (disposed || request !== listRequest) return;
    tickets.value = result.tickets || []; stats.value = result.stats || {}; statsLoaded.value = true;
    if (!selectedTicketId.value && tickets.value.length) {
      changeTicketContext(tickets.value[0].id);
      void refreshDetail();
    }
  } catch (cause) { if (!disposed && request === listRequest) listError.value = cause.message || '读取长期任务失败'; }
  finally { if (!disposed && request === listRequest) loading.value = false; }
}
async function load() {
  if (disposed) return;
  const id = selectedTicketId.value;
  await Promise.all([loadList(), loadWorkerStatus(), id ? refreshDetail(id) : Promise.resolve()]);
}
function applyFilters() {
  appliedQuery.value = query.value.trim(); appliedStatus.value = statusFilter.value; syncRoute(); return loadList();
}
function clearFilters() { query.value = statusFilter.value = ''; return applyFilters(); }
async function selectTicket(id) {
  if (saving.value) return;
  if (selectedTicketId.value !== id) { changeTicketContext(id); activeTab.value = 'overview'; await refreshDetail(id); }
  await revealDetail();
}
function upsert(rows, row) {
  const found = rows.findIndex(item => item.id === row.id);
  if (found < 0) rows.unshift(row); else rows[found] = { ...rows[found], ...row };
}
function applyResult(result) {
  if (result?.ticket) {
    upsert(tickets.value, result.ticket);
    if (selectedTicketId.value === result.ticket.id) { detail.value.ticket = result.ticket; ticketStatusDraft.value = result.ticket.status; }
  }
  for (const [key, list] of [['mandate','mandates'],['assignment','assignments'],['report','reports'],['effect','effects']]) {
    if (result?.[key]) upsert(detail.value[list], result[key]);
  }
}
async function mutate(action, success, { after, dialog = false } = {}) {
  if (disposed || saving.value) return false;
  const request = ++writeRequest, version = contextVersion, targetId = selectedTicketId.value;
  const current = () => !disposed && request === writeRequest && version === contextVersion;
  ++listRequest; ++detailRequest; loading.value = detailLoading.value = false;
  saving.value = true; error.value = ''; notice.value = ''; decisionError.value = '';
  try {
    const result = await action(targetId);
    if (!current()) return false;
    ++listRequest; ++detailRequest;
    after?.(result); applyResult(result);
    notice.value = success;
    if (dialog) decision.value = null;
    saving.value = false;
    void loadList(); void refreshDetail(); void loadWorkerStatus();
    await revealFeedback();
    return true;
  } catch (cause) {
    if (current()) {
      if (dialog) decisionError.value = cause.message || '操作失败';
      else { error.value = cause.message || '操作失败'; await revealFeedback(); }
    }
    return false;
  } finally { if (current()) saving.value = false; }
}
async function createTicket() {
  const payload = { ...ticketForm, title: ticketForm.title.trim(), sourceId: ticketForm.sourceId.trim(), projectId: ticketForm.projectId.trim(), hostId: ticketForm.hostId.trim(), acceptanceCriteria: splitLines(ticketForm.acceptanceCriteria) };
  return mutate(() => api.createOpsTicket(payload), '长期任务已创建；尚未启动任何 Agent 或外部操作。', { after: result => {
    changeTicketContext(result.ticket.id, { preserveWrite: true });
    Object.assign(ticketForm, { title: '', description: '', priority: 'normal', sourceType: 'manual', sourceId: '', projectId: '', hostId: '', acceptanceCriteria: '' });
    showTicketForm.value = false;
  } });
}
function updateTicketStatus() {
  const status = ticketStatusDraft.value;
  return mutate(id => api.updateOpsTicket(id, { status }), '任务状态已更新。');
}
function rejectInvalidatedEffects(mandateIds, message) {
  for (const effect of detail.value.effects) if (mandateIds.includes(effect.mandateId) && ['awaiting_approval', 'queued', 'leased'].includes(effect.status)) {
    effect.status = 'rejected'; effect.error = message;
  }
}
async function issueMandate() {
  const payload = {
    scope: { projectIds: splitLines(mandateForm.projectIds || selectedTicket.value?.projectId || ''), composeProjectNames: splitLines(mandateForm.composeProjectNames), hostIds: splitLines(mandateForm.hostIds), resourceIds: splitLines(mandateForm.resourceIds) },
    allowedActions: splitLines(mandateForm.allowedActions), deniedActions: splitLines(mandateForm.deniedActions),
    expiresAt: new Date(Date.now() + Math.max(1, Math.min(90, Number(mandateForm.days) || 7)) * 86400000).toISOString(),
  };
  if (payload.allowedActions.some(action => ['service.inspect','container.inspect'].includes(action)) && !payload.scope.composeProjectNames.length) {
    error.value = '只读检查必须明确填写授权的 Compose 项目名范围。'; await revealFeedback(); return;
  }
  return mutate(id => api.issueOpsMandate(id, payload), '已签发新授权；旧版本已撤销，关联的未执行动作需要重新提出并审批。', { after: () => {
    const previous = detail.value.mandates.filter(m => m.status === 'active');
    rejectInvalidatedEffects(previous.map(m => m.id), '原授权已被新版本替代，请重新提出动作并审批');
    for (const m of previous) m.status = 'revoked';
    showMandateForm.value = false;
  } });
}
function createAssignment() {
  const payload = { workerRole: assignmentForm.workerRole, sourceType: assignmentForm.sourceType, sourceId: assignmentForm.sourceId.trim(), sessionId: assignmentForm.sessionId ? Number(assignmentForm.sessionId) : undefined, mandateId: assignmentForm.mandateId || undefined, handoffSummary: assignmentForm.handoffSummary.trim(), replacesAssignmentId: assignmentForm.replacesAssignmentId || undefined };
  return mutate(id => api.createOpsAssignment(id, payload), '已创建派工，可继续记录执行与交接结果。', { after: () => {
    const previous = detail.value.assignments.find(a => a.id === payload.replacesAssignmentId);
    if (previous) { previous.status = 'handed_off'; previous.handoffSummary = payload.handoffSummary; }
    Object.assign(assignmentForm, defaultDrafts().assignment); showAssignmentForm.value = false;
  } });
}
function prepareHandoff(item) {
  if (saving.value) return;
  Object.assign(assignmentForm, { ...defaultDrafts().assignment, workerRole: 'validator', mandateId: activeMandate.value?.id || '', replacesAssignmentId: item.id });
  showAssignmentForm.value = true;
}
function updateAssignment(item, status) { return mutate(id => api.updateOpsAssignment(id, item.id, { status }), '派工状态已更新。'); }
function openAssignmentReconcile(item) { if (!saving.value) { reconcileAssignmentId.value = item.id; reconcileForm.outcome = 'failed'; reconcileForm.note = ''; } }
function reconcileAssignment(item) {
  const payload = { outcome: reconcileForm.outcome, note: reconcileForm.note.trim() };
  return mutate(id => api.reconcileOpsAssignment(id, item.id, payload), '派工结果已人工核对并留痕。', { after: () => { reconcileAssignmentId.value = ''; } });
}
function submitReport() {
  const payload = {
    assignmentId: reportForm.assignmentId || undefined, reportType: reportForm.reportType, summary: reportForm.summary.trim(),
    findings: reportForm.findingTitle.trim() ? [{ title: reportForm.findingTitle.trim(), severity: reportForm.findingSeverity, detail: reportForm.findingDetail, recommendation: '' }] : [],
    evidence: reportForm.evidenceSummary.trim() ? [{ kind: reportForm.evidenceKind, sourceId: reportForm.evidenceSourceId.trim(), summary: reportForm.evidenceSummary.trim() }] : [],
  };
  return mutate(id => api.createOpsReport(id, payload), '报告已提交，请继续人工验收；任务尚未标记完成。', { after: () => {
    if (['active','ready'].includes(detail.value.ticket?.status)) { detail.value.ticket.status = 'review'; ticketStatusDraft.value = 'review'; }
    Object.assign(reportForm, defaultDrafts().report); showReportForm.value = false; activeTab.value = 'reports';
  } });
}
async function createEffect() {
  let payload;
  try { payload = JSON.parse(effectForm.payload || '{}'); } catch { error.value = '动作参数必须是有效 JSON 对象'; await revealFeedback(); return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { error.value = '动作参数必须是 JSON 对象'; await revealFeedback(); return; }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(effectForm.composeProject.trim())) { error.value = '请填写有效的 Compose 项目名'; await revealFeedback(); return; }
  if (effectForm.effectType === 'container.inspect' && !/^[a-f0-9]{12,64}$/i.test(effectForm.resourceId.trim())) { error.value = '请输入 12–64 位十六进制容器 ID'; await revealFeedback(); return; }
  const input = { effectType: effectForm.effectType.trim(), mode: effectForm.mode, risk: effectForm.risk, mandateId: effectForm.mode === 'execute' ? effectForm.mandateId : undefined,
    target: { projectId: effectForm.projectId.trim() || selectedTicket.value?.projectId || '', composeProject: effectForm.composeProject.trim(), resourceId: effectForm.effectType === 'container.inspect' ? effectForm.resourceId.trim() : '', hostId: effectForm.hostId.trim() }, payload };
  return mutate(id => api.createOpsEffect(id, input), '动作已记录；请求执行的动作仍需人工审批，通用意图只支持低风险只读检查，故障重启需从 AI 值守发起。', { after: () => {
    Object.assign(effectForm, defaultDrafts().effect); showEffectForm.value = false; activeTab.value = 'effects';
  } });
}
const decision = ref(null);
const decisionNote = ref('');
const decisionError = ref('');
let decisionRequest = 0;
async function openDecision(kind, item, accepted = false) {
  if (disposed || saving.value) return;
  const request = ++decisionRequest, version = contextVersion;
  const target = { kind, item: JSON.parse(JSON.stringify(item)), accepted, ticketId: selectedTicketId.value, ticketTitle: selectedTicket.value?.title || '' };
  // 等本页标签的 URL 同步完成，避免新确认窗被迟到的路由清场立即关闭。
  await nextTick(); await routeSync; await nextTick();
  if (disposed || saving.value || request !== decisionRequest || version !== contextVersion || target.ticketId !== selectedTicketId.value) return;
  decision.value = target;
  decisionNote.value = kind === 'report' && accepted ? '证据完整，验收通过。' : ''; decisionError.value = '';
}
const decisionTitle = computed(() => ({ revoke: '撤销授权', report: decision.value?.accepted ? '验收通过' : '退回补充', approve: '批准并入队', cancel: '取消动作' })[decision.value?.kind] || '确认操作');
function revokeMandate(item) { return openDecision('revoke', item); }
function decideReport(item, accepted) { return openDecision('report', item, accepted); }
function approveEffect(item) { return openDecision('approve', item); }
function cancelEffect(item) { return openDecision('cancel', item); }
async function confirmDecision() {
  const target = decision.value;
  if (!target || target.ticketId !== selectedTicketId.value) return;
  const note = decisionNote.value.trim();
  if (target.kind === 'revoke' && !note) { decisionError.value = '请填写撤销原因'; return; }
  const actions = {
    revoke: () => api.revokeOpsMandate(target.ticketId, target.item.id, note),
    report: () => api.decideOpsReport(target.ticketId, target.item.id, { accepted: target.accepted, note }),
    approve: () => api.approveOpsEffect(target.ticketId, target.item.id),
    cancel: () => api.cancelOpsEffect(target.ticketId, target.item.id, '由管理员在长期任务工作台取消'),
  };
  const messages = { revoke: '授权已撤销，关联的未执行动作已拒绝。', report: target.accepted ? '报告已验收通过；可在核对任务整体结果后更新任务状态。' : '报告已退回，请补充证据后重新提交。', approve: '审批已记录，动作已入队；请继续查看执行结果。', cancel: '未执行的动作已取消。' };
  return mutate(actions[target.kind], messages[target.kind], { dialog: true, after: () => {
    if (target.kind === 'revoke') rejectInvalidatedEffects([target.item.id], '原授权已撤销，请重新提出动作并审批');
  } });
}
function openEffectReconcile(effect) { if (!saving.value) { reconcileEffectId.value = effect.id; reconcileForm.outcome = 'failed'; reconcileForm.note = ''; } }
function reconcileEffect(effect) {
  const payload = { outcome: reconcileForm.outcome, note: reconcileForm.note.trim() };
  return mutate(id => api.reconcileOpsEffect(id, effect.id, payload), '动作结果已人工核对并留痕。', { after: () => { reconcileEffectId.value = ''; } });
}
function invalidateContext() {
  ++contextVersion; ++writeRequest; ++listRequest; ++detailRequest; ++workerRequest;
  saving.value = loading.value = detailLoading.value = workerLoading.value = false;
  decision.value = null; error.value = notice.value = '';
}
function onHostChanged() { invalidateContext(); void load(); }

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
  window.addEventListener('composeops:host-changed', onHostChanged);
  void load();
});
</script>

<style scoped>
.form-grid-label { display: flex; flex-direction: column; gap: .35rem; min-width: 0; font-size: .75rem; color: var(--color-surface-400); }
.form-grid-label > .input { width: 100%; min-width: 0; }
.status-badge, .count-badge { white-space: nowrap; }

.ticket-metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: .75rem; }
.ticket-metrics > div { border-radius: .85rem; background: linear-gradient(145deg,rgb(255 255 255 / .025),transparent),var(--color-surface-900); }
.ticket-columns { display: grid; grid-template-columns: 300px minmax(0,1fr); align-items: start; gap: 1.25rem; min-width: 0; }
.ticket-list { border-radius: .9rem; }
.ticket-list-item { position: relative; display: block; width: 100%; padding: 1rem; border-bottom: 1px solid var(--color-surface-800); text-align: left; transition: background 150ms ease; }
.ticket-list-item:hover { background: rgb(255 255 255 / .025); }
.ticket-list-item[aria-current='true'] { background: rgb(16 185 129 / .06); }
.ticket-list-item[aria-current='true']::before { content: ''; position: absolute; inset: 1rem auto 1rem 0; width: 3px; border-radius: 0 3px 3px 0; background: var(--color-status-ok); }
.ticket-list-item:disabled { opacity: .55; }
.ticket-section-heading { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: .75rem; margin-bottom: .75rem; }
.ticket-section-heading > div { flex: 1 1 14rem; min-width: 0; }
.ticket-section-heading > button { flex-shrink: 0; white-space: nowrap; }
.ticket-detail-navigation .text-link { display: inline-flex; align-items: center; gap: .35rem; white-space: nowrap; }
.ticket-detail-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; min-height: 2rem; }
.ticket-summary { border-radius: .9rem; border-top-color: rgb(16 185 129 / .25); }
.ticket-notice { display: flex; gap: .6rem; align-items: start; padding: 1rem; border: 1px solid rgb(16 185 129 / .2); border-radius: .75rem; background: rgb(16 185 129 / .05); color: var(--color-surface-200); font-size: .85rem; }
.ticket-technical-details { margin-top: .75rem; font-size: .7rem; color: var(--color-surface-400); }
.ticket-technical-details summary { cursor: pointer; width: fit-content; padding: .35rem 0; }
.ticket-technical-details pre { margin-top: .5rem; padding: .75rem; max-height: 12rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: .5rem; background: var(--color-surface-950); }
.ticket-decision-target { border: 1px solid var(--color-surface-700); background: var(--color-surface-950); border-radius: .6rem; padding: .85rem; }
.ticket-feedback, .ticket-detail, .ticket-list { scroll-margin-block: 1rem; }
@media (max-width:1279px) { .ticket-columns { grid-template-columns: minmax(0,1fr); } .ticket-list > div:last-child { max-height: 22rem; } }
@media (max-width:639px) { .ticket-metrics { grid-template-columns: repeat(2,minmax(0,1fr)); gap: .5rem; } .ticket-metrics > div { padding: .85rem; } .ticket-list-item { padding: .85rem; } }
@media (prefers-reduced-motion:reduce) { .ticket-list-item { transition: none; } }
</style>
