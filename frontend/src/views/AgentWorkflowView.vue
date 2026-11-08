<!-- eslint-disable vue/no-v-html -- 内容统一经过 AgentMarkdown 渲染器的 DOMPurify 清理。 -->
<template>
  <div class="page-shell page-shell-workspace agent-page">
    <div class="page-header">
      <div><h1 class="page-title">AI 智能运维 Agent</h1><p class="page-subtitle hidden sm:block">在独立会话中查看纳管项目、分析资料并执行运维操作</p></div>
      <div class="agent-header-actions">
        <button class="btn-secondary btn-sm agent-session-settings-toggle" :aria-expanded="showSessionOptions" aria-controls="agent-session-options" @click="showSessionOptions = !showSessionOptions"><SlidersHorizontal class="h-3.5 w-3.5" />会话设置</button>
        <button v-if="running" class="btn-secondary border-status-error/60! text-status-error btn-sm" title="中断当前 Agent 执行" @click="interrupt"><Square class="h-4 w-4" />中断</button>
      </div>
      <div id="agent-session-options" class="page-actions flex-wrap agent-session-options" :class="{ 'is-open': showSessionOptions }">
        <select v-model="workerRole" class="input w-full sm:w-auto max-w-40 input-sm" :title="selectedWorkerDescription" aria-label="选择本轮 Agent Worker"><option v-for="worker in workerRoles" :key="worker.id" :value="worker.id">{{ worker.label }}</option></select>
        <select v-model="projectId" class="input w-full sm:w-auto max-w-52 input-sm" title="可选的当前项目上下文" aria-label="选择 Agent 当前项目上下文"><option value="">自动识别项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select>
        <button class="btn-secondary btn-sm" :disabled="loading" title="刷新纳管项目" @click="loadProjects"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />刷新</button>
        <select class="input w-full sm:w-auto input-sm" :value="approvalMode" :disabled="composerBlocked || running && !sessionId" title="高危操作确认策略(本会话生效)" aria-label="选择本会话操作审批策略" @change="changeApprovalMode($event.target.value)">
          <option value="ask">逐次确认</option>
          <option value="allow_writes">放行非高危</option>
          <option value="full">仅极高危确认</option>
        </select>
      </div>
    </div>
    <p v-if="projectsError" class="alert-error" role="alert">{{ projectsError }}<button class="text-link" :disabled="loading" @click="loadProjects">重试项目</button></p>
    <div class="agent-layout">
      <aside class="agent-sessions card"><AgentSessionList v-bind="sessionListProps" v-model:query="sessionQuery" v-model:rename-title="editingTitle" @refresh="loadSessions" @new="newSession" @select="selectSession" @toggle="toggleSession" @toggle-all="toggleAllSessions" @rename="beginRename" @save-rename="saveRename" @cancel-rename="cancelRename" @delete="deleteSession" @delete-selected="deleteSelectedSessions" /></aside>
      <main class="agent-chat card"><div class="agent-chat-head">
          <button ref="mobileSessionsTrigger" class="agent-mobile-session-btn" title="打开会话" aria-label="打开会话列表" @click="mobileSessionsOpen = true"><MessageSquare class="h-4 w-4" /></button>
          <div class="agent-head-id"><Bot class="h-4 w-4 shrink-0 text-cyan-400" /><div class="agent-head-text"><strong>{{ activeTitle }}</strong><span class="agent-status">{{ webSearchEnabled ? '联网资料已开启' : '仅使用本地工具' }}</span></div></div>
          <div class="agent-head-menu" @focusout="onHeadMenuBlur">
            <button ref="headMenuTrigger" aria-haspopup="menu" aria-controls="agent-session-menu" class="icon-btn" title="更多操作" aria-label="更多操作" :disabled="!messages.length || loadingHistory" :aria-expanded="headMenuOpen" @click="headMenuOpen = !headMenuOpen"><MoreHorizontal class="h-4 w-4" /></button>
            <div v-if="headMenuOpen" id="agent-session-menu" ref="headMenuRef" class="agent-head-dropdown" role="menu" aria-label="当前会话操作" @keydown="onHeadMenuKeydown">
              <button role="menuitem" :disabled="!messages.length" @click="exportSession(); closeHeadMenu()"><Download class="h-3.5 w-3.5" />导出已加载消息</button>
              <button role="menuitem" :disabled="!messages.length || running || composerBlocked" @click="compactCurrentSession"><FoldVertical class="h-3.5 w-3.5" />压缩历史</button>
              <button role="menuitem" :disabled="!messages.length || running || composerBlocked" @click="headMenuOpen = false; clearCurrentSession()"><Eraser class="h-3.5 w-3.5" />删除当前会话</button>
            </div>
            <div v-if="headMenuOpen" class="agent-head-menu-backdrop" @click="closeHeadMenu(false)"></div>
          </div>
        </div>
        <div v-if="sessionFeedback" class="agent-session-feedback" role="status"><Check class="h-3.5 w-3.5 shrink-0" /><span>{{ sessionFeedback }}</span><button aria-label="关闭会话操作提示" @click="sessionFeedback = ''"><X class="h-3.5 w-3.5" /></button></div>
        <div class="agent-search-bar"><Search class="h-3.5 w-3.5" /><input v-model="messageQuery" type="text" placeholder="搜索已加载消息…" aria-label="搜索会话消息" class="agent-search-input" /><button v-if="messageQuery" class="agent-search-clear" title="清除搜索" aria-label="清除搜索" @click="messageQuery = ''"><X class="h-3 w-3" /></button></div>
<div ref="scrollEl" class="agent-messages" role="log" aria-live="polite" aria-label="Agent 对话记录" @scroll.passive="onScroll" @click="handleRichBlockClick"><button v-if="historyHasMore && !messageQuery" class="agent-load-history" :disabled="loadingOlderHistory" @click="loadOlderHistory">{{ loadingOlderHistory ? '正在加载…' : '加载更早消息' }}</button><p v-if="olderHistoryError" class="agent-history-error" role="alert">{{ olderHistoryError }}</p><div v-if="loadingHistory" class="agent-loading" role="status">正在恢复会话…</div><div v-else-if="historyError" class="agent-history-state" role="alert"><MessageSquare class="h-7 w-7" /><h2>暂时无法恢复会话</h2><p>{{ historyError }}</p><button class="btn-secondary btn-sm" @click="openSession(sessionId)">重试历史</button><small>草稿仍保留，可以重试或选择其他会话。</small></div><div v-else-if="messageQuery && !filteredMessages.length" class="agent-history-state"><Search class="h-7 w-7" /><h2>当前已加载消息中没有匹配结果</h2><button class="text-link" @click="messageQuery = ''">清除搜索</button></div><div v-else-if="running && !messages.length" class="agent-loading" role="status"><RefreshCw class="h-5 w-5 animate-spin motion-reduce:animate-none" />正在准备会话…</div><div v-else-if="!messages.length" class="agent-welcome"><SceneIllustration kind="assistant" class="agent-welcome-art" sizes="220px" /><h2>这是一段新的运维会话</h2><p>可以先问我有哪些项目，也可以直接描述你要检查或修改的内容。</p><div class="agent-prompts"><button v-for="prompt in prompts" :key="prompt.title" :aria-label="`${prompt.title} ${prompt.hint}`" class="agent-start-card" @click="input = prompt.text; focusInput()"><component :is="prompt.icon" class="agent-start-icon" aria-hidden="true" /><span><strong>{{ prompt.title }}</strong><small>{{ prompt.hint }}</small></span><ChevronRight class="agent-start-arrow" aria-hidden="true" /></button></div></div><article v-for="message in filteredMessages" :key="message.id" class="agent-message" :class="message.role === 'user' ? 'user' : 'assistant'"><div class="agent-avatar"><UserRound v-if="message.role === 'user'" class="h-4 w-4" /><Bot v-else class="h-4 w-4" /></div><div class="agent-message-body"><div v-if="message.tools?.length" class="agent-tool-cards"><div v-for="(tool, index) in message.tools" :key="index" class="agent-tool-card" :data-status="tool.status"><div class="agent-tool-card-header"><component :is="getToolIcon(tool.tool)" class="h-3.5 w-3.5" /><span class="agent-tool-card-name">{{ tool.tool }}</span><span v-if="tool.durationMs" class="agent-tool-card-duration">{{ formatDuration(tool.durationMs) }}</span><span class="agent-tool-card-status">{{ getToolStatusLabel(tool.status) }}</span>
<button v-if="tool.status === 'done' && isStateChangingTool(tool.tool) && toolProjectId(tool)" class="agent-tool-verify" @click="inspectToolProject(tool)">已验证 · 查看项目</button><button v-if="tool.status === 'failed' && toolProjectId(tool)" class="agent-tool-diagnose" @click="diagnoseTool(tool)">诊断并制定修复</button></div><details v-if="tool.paramsText || tool.summary || tool.error" class="agent-tool-card-details"><summary>参数与结果</summary><pre v-if="tool.paramsText && tool.paramsText !== '{}'" class="agent-tool-card-section"><strong>参数</strong>{{ tool.paramsText }}</pre><pre v-if="tool.error" class="agent-tool-card-section is-error"><strong>错误</strong>{{ tool.error }}</pre><pre v-else-if="tool.summary" class="agent-tool-card-section"><strong>结果</strong>{{ tool.summary }}</pre></details></div></div><template v-if="message.role === 'assistant'"><AgentThinking :thinking="message.thinking" :live="!!message.thinkingStreaming" />
<div v-if="message.streaming && !message.content" class="agent-typing" role="status" aria-live="polite"><i></i><i></i><i></i><span>正在处理</span></div><div v-else-if="!message.content && !message.streaming" class="agent-empty-reply">(未返回内容)</div><div v-else class="agent-markdown" v-html="renderMarkdown(message.content)"></div><div v-if="message.content" class="agent-message-actions"><button class="agent-message-action-btn" title="复制" aria-label="复制回复" @click="copyMessage(message)"><Copy class="h-3 w-3" /></button><button v-if="message.planId" class="agent-message-action-btn is-up" :class="{ active: message.rating === 5 }" title="回答有帮助" aria-label="点赞这条回复" @click="rate(message, 5)"><ThumbsUp class="h-3 w-3" /></button><button v-if="message.planId" class="agent-message-action-btn is-down" :class="{ active: message.rating === 1 }" title="回答需要改进" aria-label="点踩这条回复" @click="rate(message, 1)"><ThumbsDown class="h-3 w-3" /></button><button class="agent-message-action-btn" title="重新生成" aria-label="重新生成回复" :disabled="chatBusy || composerBlocked" @click="regenerateSafely(message)"><RefreshCw class="h-3 w-3" /></button></div></template><div v-else class="agent-user-text">{{ message.content }}<div class="agent-message-actions"><button class="agent-message-action-btn" title="编辑并重发" aria-label="编辑并重发" :disabled="chatBusy || composerBlocked" @click="startEdit(message)"><Edit3 class="h-3 w-3" /></button></div></div><div v-if="message.projects?.length" class="agent-project-grid"><div v-for="project in message.projects" :key="project.id" class="agent-project-card"><div class="flex items-center justify-between gap-2"><strong>{{ project.name }}</strong><span :class="project.editable ? 'text-status-ok' : 'text-status-warn'">{{ project.editable ? '可编辑' : '仅控制' }}</span></div><p>{{ project.composeMode || 'containers' }} · {{ project.services?.length || 0 }} 个服务</p><button @click="selectProject(project)">固定为当前项目</button></div></div><div v-if="message.confirmation" class="agent-confirm"><div class="flex items-start gap-2"><ShieldAlert class="mt-0.5 h-4 w-4 shrink-0 text-status-warn" /><div class="min-w-0"><strong>需要确认后执行<span v-if="message.confirmation.tool" class="ml-1.5 font-mono text-[11px] text-status-warn/80">{{ message.confirmation.tool }}</span></strong><p>{{ message.confirmation.description }}</p><p v-if="message.confirmation.error" class="mt-2 text-sm text-status-error" role="alert" aria-live="assertive">{{ message.confirmation.error }}</p><details class="agent-confirm-params" @toggle="initParamsEdit($event, message)"><summary>查看 / 编辑参数</summary><textarea v-model="message.confirmation.paramsText" class="agent-confirm-params-text" aria-label="确认执行参数 JSON" rows="6" spellcheck="false"></textarea><p class="mt-1 text-[10px] text-status-warn/60">JSON 格式;确认时将以此覆盖原参数(敏感值已脱敏显示,未改动的字段会以原值执行)。</p></details></div></div><div class="mt-3 flex flex-wrap gap-2"><button class="btn-primary btn-sm" :disabled="message.confirmation.busy" @click="approveWithParams(message)"><Check class="h-3.5 w-3.5" />确认执行</button><button v-if="message.confirmation.risk !== 'critical'" class="btn-secondary btn-sm" :disabled="message.confirmation.busy" @click="approveWithParams(message, 'call')">确认并本会话不再询问(同参数)</button><button class="btn-secondary btn-sm" :disabled="message.confirmation.busy" @click="reject(message)">拒绝</button></div></div><p v-if="message.error" class="agent-stream-error" role="alert">{{ message.error }}</p><div v-if="message.interrupted && !running" class="agent-continue-row"><button class="agent-continue-btn" :disabled="composerBlocked" @click="continueSafely(message)"><Play class="h-3 w-3" />继续执行</button><span>先核对已执行结果，再继续剩余任务</span></div><div v-if="message.taskNotices?.length" class="agent-task-notice"><Activity class="h-3.5 w-3.5 shrink-0" /><div class="min-w-0"><p v-for="(notice, i) in message.taskNotices" :key="i">{{ notice }}</p></div></div><div v-if="message.usage" class="agent-token-usage"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>{{ message.usage.total_tokens || 0 }} tokens</div><div v-if="message.searchSources?.length" class="agent-sources"><div><Globe2 class="h-3.5 w-3.5" />参考来源</div><a v-for="source in message.searchSources" :key="source.url || source.title" :href="source.url" target="_blank" rel="noreferrer">{{ source.title || source.url || '搜索结果' }}<small>{{ source.snippet }}</small></a></div></div></article></div>
        <button v-if="!atBottom" class="agent-scroll-bottom" title="回到底部" @click="scrollToBottom"><ArrowDownToLine class="h-3.5 w-3.5" />回到底部</button>
        <div class="agent-composer"><AgentPendingQueue :items="pendingQueue" :paused="queuePaused" :busy="chatBusy || composerBlocked" @remove="removeQueued" @resume="resumeQueueSafely" /><div v-if="editingMessageId" class="agent-edit-banner"><Pencil class="h-3.5 w-3.5" /><span>正在编辑已发送的消息,发送后将替换这条消息及后续回复</span><button type="button" @click="cancelEdit">取消</button></div><div v-if="showLogPicker" class="agent-log-panel"><div class="agent-log-panel-head"><span>挂载容器日志</span><button class="text-xs text-surface-400 hover:text-cyan-300" @click="showLogPicker = false">收起</button></div><LogContextPicker :projects="projects" @attach="onAttach" /></div><div v-if="showQuickPrompts" class="agent-log-panel"><div class="agent-log-panel-head"><span>常用指令</span><button class="text-xs text-surface-400 hover:text-cyan-300" @click="showQuickPrompts = false">收起</button></div><div class="grid gap-1.5 sm:grid-cols-2"><button v-for="prompt in quickPrompts" :key="prompt" class="agent-quick-prompt" @click="applyQuickPrompt(prompt)"><Sparkles class="h-3.5 w-3.5 text-cyan-400" />{{ prompt }}</button></div></div><div class="agent-input-wrap"><textarea ref="inputEl" v-model="input" class="agent-input" aria-label="向 Agent 发送消息" rows="3" placeholder="告诉 Agent 你想查看或操作什么…（Enter 发送，Shift+Enter 换行）" :disabled="sessionBusy" @keydown="onComposerKeydown"></textarea><button class="agent-voice-btn" :class="{ recording: voiceRecording }" :title="voiceRecording ? '停止录音' : '语音输入'" :aria-label="voiceRecording ? '停止录音' : '语音输入'" :aria-pressed="voiceRecording" :disabled="composerBlocked" @click="toggleVoiceInput"><Mic class="h-4 w-4" /></button></div>
<div class="agent-composer-foot"><span class="flex min-w-0 items-center gap-2"><button class="agent-log-btn" :class="{ active: attachedCount }" title="选择容器日志,作为排障证据随消息发送" @click="showLogPicker = !showLogPicker"><ScrollText class="h-3.5 w-3.5" />挂载日志<em v-if="attachedCount">{{ attachedCount }}</em></button><button class="agent-log-btn" title="常用指令" @click="showQuickPrompts = !showQuickPrompts"><Wand2 class="h-3.5 w-3.5" />常用指令</button><button class="agent-log-btn" :class="{ active: webSearchEnabled }" title="开启后 Agent 可以检索 Docker、Compose 和软件官方资料" @click="webSearchEnabled = !webSearchEnabled"><Globe2 class="h-3.5 w-3.5" />联网搜索</button><span class="truncate agent-composer-hint">{{ loadingHistory ? '正在恢复会话，请稍候' : historyError ? '恢复历史后即可继续发送' : running ? (pendingQueue.length ? '执行中,已排队 ' + pendingQueue.length + ' 条' : '执行中,可继续输入并自动排队') : '会话与上下文会自动保存' }}</span></span><button class="btn-primary" :disabled="!input.trim() || composerBlocked" :title="running ? '加入队列,当前执行结束后自动发送' : '发送消息'" @click="submit"><Send class="h-4 w-4" />{{ running || queuePaused && pendingQueue.length ? '排队发送' : '发送' }}</button></div></div>
      </main>
      <aside class="agent-inspector"><section class="card agent-inspector-card"><div class="agent-inspector-title"><span>当前上下文</span><button v-if="projectId" class="text-xs text-surface-400 hover:text-cyan-300" @click="projectId = ''">清除</button></div><p v-if="selectedProject" class="text-sm text-cyan-300">{{ selectedProject.projectName }}</p><p v-else>未固定项目，Agent 会先从纳管项目中识别。</p></section><section class="card agent-inspector-card agent-activity-panel">
            <div class="agent-inspector-title">
              <span><span v-if="running" class="agent-activity-live"></span>执行动态</span>
              <span class="agent-activity-tools">
                <em v-if="running">运行中</em>
                <button v-if="activity.length" class="agent-activity-clear" title="清空执行动态" aria-label="清空执行动态" @click="clearActivity"><Trash2 class="h-3 w-3" /></button>
              </span>
            </div>
            <div v-if="!activity.length" class="agent-activity-empty">
              <Activity class="h-5 w-5" />
              <strong>等待执行</strong>
              <span>Agent 的每一步都会在这里留下可回看的记录。</span>
            </div>
            <div v-else class="agent-activity-groups">
              <section v-for="group in activityGroups" :key="group.sessionId" class="agent-activity-group" :class="{ 'is-active': group.sessionId === sessionId }">
                <button class="agent-activity-group-head" :aria-expanded="group.open" @click="toggleActivityGroup(group.sessionId)">
                  <ChevronRight class="h-3.5 w-3.5 agent-activity-caret" :class="{ open: group.open }" />
                  <span class="agent-activity-group-title">{{ group.title }}</span>
                  <span class="agent-activity-group-count">{{ group.total }}</span>
                  <span v-if="group.last" class="agent-activity-time">{{ group.last.time }}</span>
                </button>
                <div v-if="group.open" class="agent-activity-group-body">
                  <div v-for="turn in group.turns" :key="turn.turnId" class="agent-activity-turn">
                    <button class="agent-activity-turn-head" :aria-expanded="!collapsedTurns.includes(turnKey(group.sessionId, turn.turnId))" @click="toggleTurn(group.sessionId, turn.turnId)">
                      <ChevronRight class="h-3 w-3 agent-activity-caret" :class="{ open: !collapsedTurns.includes(turnKey(group.sessionId, turn.turnId)) }" />
                      <span>第 {{ turn.turnId }} 轮提问</span>
                      <em>{{ turn.items.length }} 步</em>
                      <span v-if="turn.last" class="agent-activity-time">{{ turn.last.time }}</span>
                    </button>
                    <ol v-show="!collapsedTurns.includes(turnKey(group.sessionId, turn.turnId))" class="agent-activity-timeline">
                      <li v-for="item in turn.items" :key="item.id" class="agent-activity-step" :data-status="item.status || ''" :data-tone="item.status || 'neutral'">
                        <div class="agent-activity-top">
                          <span class="agent-activity-icon"><component :is="activityIcon(item)" class="h-3 w-3" /></span>
                          <span class="agent-activity-label">{{ item.label }}</span>
                          <span class="agent-activity-time">{{ item.time }}</span>
                        </div>
                        <div class="agent-activity-meta">
                          <span v-if="item.tool" class="agent-activity-chip" :data-tone="item.status === 'failed' ? 'danger' : 'muted'">{{ item.tool }}</span>
                          <span v-if="item.durationMs != null" class="agent-activity-chip" :data-tone="item.status === 'failed' ? 'danger' : 'success'">{{ formatDuration(item.durationMs) }}</span>
                          <span v-if="item.status === 'rejected'" class="agent-activity-chip" data-tone="warn">已拒绝</span>
                        </div>
                        <div v-if="item.text" class="agent-activity-detail" :class="{ expanded: expandedActivity.includes(item.id) }">{{ item.text }}</div>
                        <button v-if="item.text && item.text.length > 90" class="agent-activity-more" @click="toggleActivityDetail(item.id)">{{ expandedActivity.includes(item.id) ? '收起' : '展开' }}</button>
                      </li>
                    </ol>
                  </div>
                </div>
              </section>
            </div>
          </section><section class="card agent-inspector-card"><div class="agent-inspector-title"><span>长期记忆</span><button class="text-xs text-cyan-400 hover:text-cyan-300" :disabled="memoriesLoading" @click="loadMemories">{{ memoriesLoading ? '读取中…' : '刷新' }}</button></div><p v-if="memoriesError" class="agent-history-error" role="alert">{{ memoriesError }}</p><p v-else-if="!memoriesLoading && !memories.length" class="flex items-start gap-2"><Brain class="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>还没有保存的长期记忆。只有你明确要求“记住”时才会保存。</span></p><div v-for="memory in memories.slice(0, 5)" :key="memory.memoryKey" class="agent-memory"><strong>{{ memory.memoryKey }}</strong><span>{{ memory.value }}</span><small class="agent-memory-meta">重要度 {{ Math.round((memory.importance ?? 0.5) * 100) }}% · {{ memory.veracity || 'stated' }}<template v-if="memory.recallCount"> · 已召回 {{ memory.recallCount }} 次</template></small></div></section></aside>
    </div>
    <ConfirmDialog :show="deleteDialog.show" title="删除会话" :message="`删除“${deleteDialog.title}”及全部消息？`" :busy="sessionMutationBusy" tone="danger" confirm-text="删除会话" @confirm="confirmDeleteSession" @cancel="deleteDialog.show = false"><p class="text-xs text-surface-400">消息与用量记录将移除；已执行的系统操作不会撤销。</p><p v-if="sessionMutationError" class="alert-error" role="alert">{{ sessionMutationError }}</p></ConfirmDialog>
    <ConfirmDialog :show="bulkDeleteDialog" title="批量删除会话" :message="`删除已选中的 ${bulkDeleteIds.length} 个会话及全部消息？`" :busy="sessionMutationBusy" tone="danger" confirm-text="批量删除" @confirm="confirmDeleteSelected" @cancel="bulkDeleteDialog = false"><p class="text-xs text-surface-400">已执行的系统操作不会撤销。</p><ul class="agent-delete-targets"><li v-for="id in bulkDeleteIds" :key="id">{{ sessions.find(session => session.sessionId === id)?.title || `会话 #${id}` }}</li></ul><p v-if="sessionMutationError" class="alert-error" role="alert">{{ sessionMutationError }}</p></ConfirmDialog>
    <ConfirmDialog :show="clearDialog" title="删除当前会话" :message="`删除“${clearTarget?.title || ''}”及全部消息，并开始新会话？`" :busy="sessionMutationBusy" tone="danger" confirm-text="删除并新建" @confirm="confirmClearSession" @cancel="clearDialog = false"><p class="text-xs text-surface-400">消息与用量记录将移除；已执行的系统操作不会撤销。</p><p v-if="sessionMutationError" class="alert-error" role="alert">{{ sessionMutationError }}</p></ConfirmDialog>
    <teleport to="body"><div v-if="mobileSessionsOpen" class="agent-mobile-sheet-mask" @click.self="mobileSessionsOpen = false"><aside ref="mobileSessionsDialog" class="agent-mobile-sheet" role="dialog" aria-modal="true" aria-label="会话列表" tabindex="-1" @keydown="trapMobileSessionsTab"><AgentSessionList v-bind="sessionListProps" v-model:query="sessionQuery" v-model:rename-title="editingTitle" @refresh="loadSessions" @new="newSession" @select="selectSession" @toggle="toggleSession" @toggle-all="toggleAllSessions" @rename="beginRename" @save-rename="saveRename" @cancel-rename="cancelRename" @delete="deleteSession" @delete-selected="deleteSelectedSessions"><template #close><button class="icon-btn" aria-label="关闭会话列表" @click="mobileSessionsOpen = false"><X class="h-4 w-4" /></button></template></AgentSessionList></aside></div></teleport>
    <teleport to="body">
      <div v-if="zoomOpen" class="rich-zoom-mask" @click.self="closeZoom()" @wheel.prevent="onZoomWheel">
        <div ref="zoomDialogEl" class="rich-zoom-card agent-markdown" role="dialog" aria-modal="true" aria-label="放大预览" tabindex="-1" @keydown="trapZoomTab" :style="{ transform: `scale(${zoomScale})` }">
          <button class="rich-zoom-close" title="关闭(Esc)" aria-label="关闭放大预览" @click="closeZoom">×</button>
          <div class="rich-zoom-content" v-html="zoomContent"></div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import SceneIllustration from '../components/common/SceneIllustration.vue';
import AgentSessionList from '../components/agent/AgentSessionList.vue';
import AgentPendingQueue from '../components/agent/AgentPendingQueue.vue';
import { useRoute, useRouter } from 'vue-router';
import { Activity, ArrowDownToLine, Bot, Brain, Check, ChevronRight, Copy, Download, Edit3, Eraser, FileEdit, FileText, FoldVertical, FolderKanban, FolderOpen, Globe2, MessageSquare, Mic, MoreHorizontal, Pencil, Play, RefreshCw, ScrollText, Search, Send, SlidersHorizontal, ThumbsDown, ThumbsUp, ShieldAlert, Sparkles, Square, Terminal, Trash2, UserRound, Wand2, Wrench, X } from 'lucide-vue-next';
import { api } from '../api/client.js';
import { stripAgentProtocol } from '../lib/agent-text.js';
import { renderAgentMarkdown } from '../lib/agent-markdown.js';
import { useAgentChat } from '../composables/useAgentChat.js';
import { useEscapeKey } from '../composables/useEscapeKey.js';
import { useToastStore } from '../stores/toast.js';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import LogContextPicker from '../components/agent/LogContextPicker.vue';
import AgentThinking from '../components/agent/AgentThinking.vue';

const toast = useToastStore();
const route = useRoute();
const router = useRouter();
function renderMarkdown(content) { return renderAgentMarkdown(content); }

const projects = ref([]); const sessions = ref([]); const memories = ref([]); const activity = ref([]); const loading = ref(false); const loadingOlderHistory = ref(false); const historyHasMore = ref(false); const webSearchEnabled = ref(false); const projectId = ref(''); const inputEl = ref(null); const editingSessionId = ref(null); const editingTitle = ref('');
const workerRole = ref('auto');
const workerRoles = ref([
  { id: 'auto', label: '自动分配', description: '按明确意图进行确定性路由；不确定时交给规划师' },
  { id: 'planner', label: '运维规划师', description: '理解需求、梳理影响范围并制定可验证的执行计划' },
  { id: 'executor', label: '执行者', description: '严格按用户目标逐步执行，并验证每一步结果' },
  { id: 'validator', label: '只读验证者', description: '只读取证、检查状态、验证配置，不修改系统' },
  { id: 'incident_responder', label: '应急响应者', description: '围绕故障快速收集证据、控制影响并验证恢复' },
]);
const selectedWorkerDescription = computed(() => workerRoles.value.find((worker) => worker.id === workerRole.value)?.description || '选择本轮负责的 Agent Worker');
async function loadWorkerRoles() {
  try {
    const data = await api.getAgentRoles();
    if (Array.isArray(data.roles) && data.roles.length) workerRoles.value = data.roles;
  } catch { /* 离线或旧后端时保留兼容的内置选项。 */ }
}
const compacting = ref(false);
const attachedLogs = ref('');
const attachedCount = ref(0);
const showLogPicker = ref(false);
const showQuickPrompts = ref(false);
const headMenuOpen = ref(false);
const headMenuTrigger = ref(null), headMenuRef = ref(null);
function closeHeadMenu(restoreFocus = true) { headMenuOpen.value = false; if (restoreFocus) void nextTick(() => headMenuTrigger.value?.focus()); }
useEscapeKey({ active: headMenuOpen, layer: 'event', onClose: () => closeHeadMenu() });
watch(headMenuOpen, async open => { if (open) { await nextTick(); headMenuRef.value?.querySelector('button:not([disabled])')?.focus(); } });
function onHeadMenuKeydown(event) {
  const items = [...(headMenuRef.value?.querySelectorAll('button:not([disabled])') || [])];
  if (!items.length || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault(); const index = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}
function onHeadMenuBlur(event) { if (!event.currentTarget.contains(event.relatedTarget)) closeHeadMenu(false); }

const showSessionOptions = ref(false);
const mobileSessionsOpen = ref(false);
const sessionQuery = ref('');
const quickPrompts = ['列出我可以操作的项目和状态', '帮我生成一个带健康检查的 compose 文件', '检查各容器资源占用并给出优化建议', '查看异常退出容器的日志并分析原因', '检查有哪些镜像可以更新', '磁盘空间不足时该怎么安全清理'];
const deleteDialog = reactive({ show: false, id: 0, title: '' });
const clearDialog = ref(false);
const bulkDeleteDialog = ref(false);
const selectedSessions = ref([]);
const sessionsLoading = ref(false), sessionsError = ref(''), olderHistoryError = ref('');
const projectsError = ref(''), memoriesError = ref(''), memoriesLoading = ref(false);
const sessionMutationBusy = ref(false), sessionMutationError = ref(''), sessionFeedback = ref('');
const renameBusy = ref(false), renameError = ref('');
const bulkDeleteIds = ref([]), clearTarget = ref(null);
const sessionBusy = computed(() => sessionMutationBusy.value || renameBusy.value || compacting.value || !!chatOperation.value || modeBusy.value);
const composerBlocked = computed(() => sessionBusy.value || loadingHistory.value || !!historyError.value);
let disposed = false, sessionListRequest = 0, historyRequest = 0, olderHistoryRequest = 0, projectRequest = 0, memoryRequest = 0, sessionWriteRequest = 0;
const sessionDrafts = new Map();

useEscapeKey({ active: mobileSessionsOpen, layer: 'drawer', onClose: () => { mobileSessionsOpen.value = false; }, lockBody: true });
const mobileSessionsTrigger = ref(null);
const mobileSessionsDialog = ref(null);
let previousMobileSessionsFocus = null;
const MOBILE_SESSIONS_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

watch(mobileSessionsOpen, async (isOpen) => {
  if (isOpen) {
    const activeElement = document.activeElement;
    previousMobileSessionsFocus = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : mobileSessionsTrigger.value;
    await nextTick();
    mobileSessionsDialog.value?.focus({ preventScroll: true });
    return;
  }

  const previousFocus = previousMobileSessionsFocus;
  previousMobileSessionsFocus = null;
  await nextTick();
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});

function trapMobileSessionsTab(event) {
  if (event.key !== 'Tab') return;
  const dialog = mobileSessionsDialog.value;
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll(MOBILE_SESSIONS_FOCUSABLE)].filter((element) => {
    if (element.closest('[hidden]') || element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });

  if (!focusable.length) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

const chat = useAgentChat({
  onEventExtra: (event) => {
    if (event.type === 'confirmation_required') appendActivity('需要确认', '请确认这项变更', { status: 'running' });
    else if (event.type === 'trace' && event.content) {
      // tool_* 事件已单独展示,trace 只保留 loop 阶段避免重复
      const toolPhases = ['tool_requested', 'tool_executing', 'tool_executed', 'tool_error', 'tool_rejected'];
      if (toolPhases.includes(event.phase)) return;
      const phaseLabels = {
        loop_started: '开始', loop_iteration: event.round ? `第 ${event.round} 轮` : '循环',
        worker_selected: '分配 Worker',
        interrupted: '已中断', loop_completed: '完成',
        channel_selected: '选择渠道', channel_failed: '渠道故障', channel_skipped: '跳过渠道',
      };
      const statusByPhase = { loop_started: 'running', loop_iteration: 'running', interrupted: 'failed', loop_completed: 'done' };
      appendActivity(phaseLabels[event.phase] || event.phase, event.content, {
        status: statusByPhase[event.phase] || '',
      });
    } else if (event.type === 'tool_requested') appendActivity('请求工具', event.tool || '', { tool: event.tool, status: 'running' });
    else if (event.type === 'tool_executing') appendActivity('执行工具', event.tool || '', { tool: event.tool, status: 'running' });
    else if (event.type === 'tool_result') appendActivity('工具完成', event.tool || '', { tool: event.tool, durationMs: event.durationMs, status: 'done' });
    else if (event.type === 'tool_error') appendActivity('工具失败', event.tool || '', { tool: event.tool, status: 'failed' });
    else if (event.type === 'tool_rejected') appendActivity('已拒绝', event.tool || '', { tool: event.tool, status: 'rejected' });
  },
  onApproval: (message, kind) => { if (kind === 'approved') appendActivity('已确认', '变更继续执行', { status: 'done' }); else appendActivity('已拒绝', '变更未执行', { status: 'rejected' }); },
});
const { busy: chatBusy, operation: chatOperation, lockSession, modeBusy, historyLoading: loadingHistory, historyError, queuePaused, removeQueued, resumeQueue, messages, input, running, sessionId, approvalMode, setApprovalMode, scrollEl, atBottom, onScroll, scrollBottom, scrollToBottom, nextMessageId, resetSession, sendMessage, regenerate, editAndResend, continueAfterInterrupt, rateMessage, pendingQueue, approve, reject, interrupt, handleRichBlockClick, zoomOpen, zoomContent, zoomScale, zoomReturnFocus, onZoomWheel, closeZoom } = chat;
const zoomDialogEl = ref(null);
let zoomOpener = null;
const ZOOM_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])';

watch(zoomOpen, async (isOpen) => {
  if (isOpen) {
    const activeElement = zoomReturnFocus.value || document.activeElement;
    zoomOpener = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null;
    await nextTick();
    const closeButton = zoomDialogEl.value?.querySelector('.rich-zoom-close');
    (closeButton || zoomDialogEl.value)?.focus({ preventScroll: true });
    return;
  }
  const opener = zoomOpener;
  zoomOpener = null;
  await nextTick();
  if (opener?.isConnected) opener.focus({ preventScroll: true });
});

function trapZoomTab(event) {
  if (event.key !== 'Tab') return;
  const dialog = zoomDialogEl.value;
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll(ZOOM_FOCUSABLE)].filter((element) => {
    if (element.closest('[hidden]') || element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}
// 审批模式是后端会话级设置(ApprovalGate),这里切换后由 approval_mode 事件回执同步。
async function changeApprovalMode(mode) {
  try {
    const changed = await setApprovalMode(mode);
    if (!changed) return;
    toast.success({ ask: '已切换为逐次确认', allow_writes: '非高危操作将直接执行', full: '仅极高危操作需要确认' }[mode] || '审批模式已更新');
  } catch (error) {
    toast.error(`审批模式切换失败：${error.message}`);
  }
}
const prompts = [
  { title: '了解当前环境', hint: '查看项目、容器与运行状态', icon: FolderKanban, text: '查看我现在可以操作的项目' },
  { title: '排查服务异常', hint: '先读状态与日志，再给出建议', icon: Activity, text: '请先只读检查当前项目的容器状态和近期异常日志，说明可能的原因与建议，不要执行修改。' },
  { title: '记住操作偏好', hint: '让之后的协作更符合习惯', icon: Brain, text: '记住我偏好先查看日志再执行重启' },
];
const sessionQueryLower = computed(() => sessionQuery.value.trim().toLowerCase());
const messageQuery = ref('');
const editingMessageId = ref(null);
const filteredMessages = computed(() => {
  if (!messageQuery.value.trim()) return messages.value;
  const query = messageQuery.value.toLowerCase();
  return messages.value.filter((m) => m.content?.toLowerCase().includes(query));
});
const filteredSessions = computed(() => {
  const keyword = sessionQueryLower.value;
  if (!keyword) return sessions.value;
  return sessions.value.filter((session) => String(session.title || '').toLowerCase().includes(keyword) || String(session.sessionId).includes(keyword));
});
const filteredSessionIds = computed(() => filteredSessions.value.map((session) => session.sessionId));
const allSessionsSelected = computed(() => filteredSessionIds.value.length > 0 && filteredSessionIds.value.every((id) => selectedSessions.value.includes(id)));
const sessionListProps = computed(() => ({
  sessions: sessions.value, activeId: sessionId.value, selected: selectedSessions.value,
  loading: sessionsLoading.value, error: sessionsError.value, busy: sessionBusy.value || running.value,
  renamingId: editingSessionId.value, renameTitle: editingTitle.value, renameBusy: renameBusy.value, renameError: renameError.value,
}));
const selectedProject = computed(() => projects.value.find((project) => project.id === projectId.value)); const activeTitle = computed(() => sessions.value.find((session) => session.sessionId === sessionId.value)?.title || (sessionId.value ? `会话 #${sessionId.value}` : '新会话'));
function focusInput() { void nextTick(() => inputEl.value?.focus()); }
let activitySeq = 0;
// 当前提问轮次:每次"用户发出一条消息"递增,用于把执行动态按轮次分段。
const currentTurnId = ref(0);
// 展开的执行动态会话组(默认只展开当前会话,其余折叠成一行)。
const activityOpen = ref([]);
// 当前"跟随展开"的会话组;会话切换时才重置展开项。
const activeActivityGroup = ref(0);
function nowTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function formatDuration(ms) { if (ms == null) return ''; if (ms < 1000) return `${Math.round(ms)}ms`; return `${(ms / 1000).toFixed(1)}s`; }
function appendActivity(label, text, meta = {}) {
  const item = {
    id: ++activitySeq,
    label,
    text: String(text || ''),
    time: nowTime(),
    tool: meta.tool || '',
    durationMs: meta.durationMs ?? null,
    status: meta.status || '',
    // 会话归属:执行动态必须能按会话收进自己的组里,否则多聊几轮右侧就成一锅粥。
    sessionId: meta.sessionId ?? sessionId.value ?? 0,
    // 轮次归属:同一会话内按"用户的一次提问"再折叠一层。
    turnId: meta.turnId ?? currentTurnId.value,
    round: meta.round ?? 0,
  };
  const prev = activity.value[activity.value.length - 1];
  if (prev && prev.status === 'running' && item.status && item.status !== 'running') prev.status = item.status;
  activity.value.push(item);
  // 有新动态进来时,只展开"产生这条动态的会话",其余折叠成一行。
  // 这样多聊几轮之后,右侧不会变成一条望不到头的流水账。
  if (item.sessionId) setActiveActivityOpen(true, item.sessionId);
  if (activity.value.length > 600) activity.value.splice(0, activity.value.length - 600);
}

/** 清空只清"当前会话"的动态,不动其他会话的历史记录。 */
function clearActivity() {
  const id = sessionId.value;
  activity.value = activity.value.filter((item) => item.sessionId !== id);
  collapsedTurns.value = collapsedTurns.value.filter((key) => !key.startsWith(`${id}:`));
}

/** 会话被删除后,把它的执行动态一并清掉,否则右侧会留下一个无主的"会话 #id"分组。 */
function dropActivityForSessions(ids) {
  const remove = new Set(ids.map(Number));
  activity.value = activity.value.filter((item) => !remove.has(Number(item.sessionId)));
  activityOpen.value = activityOpen.value.filter((value) => !remove.has(Number(value)));
  collapsedTurns.value = collapsedTurns.value.filter((key) => !remove.has(Number(String(key).split(':')[0])));
}

/** 展开/折叠某个会话的执行动态分组。 */
function toggleActivityGroup(id) {
  activityOpen.value = activityOpen.value.includes(id)
    ? activityOpen.value.filter((value) => value !== id)
    : [...activityOpen.value, id];
}
/**
 * 当前会话运行中,自动展开它的分组、折叠其它会话,便于实时看过程。
 * 会话 id 是在发送时惰性创建的,所以调用点可能早于 sessionId 就绪;
 * 默认取当前的 sessionId,也可显式传入(appendActivity 用条目自己的归属)。
 */
function setActiveActivityOpen(open, targetId = null) {
  if (!open) return;
  const id = targetId ?? sessionId.value ?? 0;
  if (!id) return;
  // 只在"切换会话"时重置展开项。同一个会话里持续产生的动态不反复重置,
  // 否则用户手动展开别的会话会被下一条事件立刻收起来。
  if (activeActivityGroup.value === id && activityOpen.value.includes(id)) return;
  activeActivityGroup.value = id;
  if (activityOpen.value.length === 1 && activityOpen.value[0] === id) return;
  activityOpen.value = [id];
}

// 每个会话一个分组、组内按提问轮次分段,新会话自动折叠旧组。
const activityGroups = computed(() => {
  const groups = new Map();
  for (const item of activity.value) {
    const key = item.sessionId || 0;
    if (!groups.has(key)) groups.set(key, { sessionId: key, turns: new Map(), total: 0, last: null });
    const group = groups.get(key);
    group.total += 1;
    group.last = item;
    if (!group.turns.has(item.turnId)) group.turns.set(item.turnId, { turnId: item.turnId, items: [], last: null });
    const turn = group.turns.get(item.turnId);
    turn.items.push(item);
    turn.last = item;
  }
  return [...groups.values()]
    .sort((a, b) => b.sessionId - a.sessionId)
    .map((group) => ({
      ...group,
      title: sessions.value.find((session) => session.sessionId === group.sessionId)?.title
        || (group.sessionId === sessionId.value ? activeTitle.value : '')
        || `会话 #${group.sessionId}`,
      turns: [...group.turns.values()],
      open: activityOpen.value.includes(group.sessionId),
    }));
});
const expandedActivity = ref([]);
function toggleActivityDetail(id) {
  expandedActivity.value = expandedActivity.value.includes(id)
    ? expandedActivity.value.filter((value) => value !== id)
    : [...expandedActivity.value, id];
}
// 组内每个"提问轮次"折叠状态:key = `${sessionId}:${turnId}`;默认展开,点一下收起来。
const collapsedTurns = ref([]);
function turnKey(groupId, turnId) { return `${groupId}:${turnId}`; }
function toggleTurn(groupId, turnId) {
  const key = turnKey(groupId, turnId);
  collapsedTurns.value = collapsedTurns.value.includes(key)
    ? collapsedTurns.value.filter((value) => value !== key)
    : [...collapsedTurns.value, key];
}
/** 执行动态条目图标:按事件类别给出可扫读的视觉锚点,而不是纯文字列表。 */
function activityIcon(item) {
  const label = String(item.label || '');
  if (item.status === 'failed') return ShieldAlert;
  if (item.status === 'rejected') return X;
  if (item.tool) return item.status === 'done' ? Check : item.status === 'running' ? Terminal : Wrench;
  if (label.includes('确认')) return ShieldAlert;
  if (label.includes('思考') || label.includes('轮')) return Brain;
  if (label.includes('完成') || label.includes('结束')) return Check;
  if (label.includes('中断')) return X;
  return Sparkles;
}
function onAttach({ text, count }) { attachedLogs.value = text || ''; attachedCount.value = count || 0; }
function applyQuickPrompt(prompt) { input.value = prompt; showQuickPrompts.value = false; focusInput(); }
function initParamsEdit(event, message) {
  if (event.target.open && message.confirmation && message.confirmation.paramsText === undefined) {
    message.confirmation.paramsText = JSON.stringify(message.confirmation.params || {}, null, 2);
  }
}
function approveWithParams(message, remember = null) {
  let inputOverride = null;
  const confirmation = message.confirmation;
  if (confirmation?.paramsText !== undefined && confirmation.paramsText.trim()) {
    try {
      inputOverride = JSON.parse(confirmation.paramsText);
    } catch {
      toast.error('参数不是合法 JSON,请修正后再确认');
      return;
    }
    if (!inputOverride || typeof inputOverride !== 'object' || Array.isArray(inputOverride)) {
      toast.error('参数必须是 JSON 对象');
      return;
    }
  }
  void approve(message, inputOverride, remember);
}
function exportSession() {
  const header = `# ComposeOps 会话导出\n\n- 会话:${activeTitle.value}\n- 导出时间:${new Date().toLocaleString('zh-CN')}\n`;
  const body = messages.value
    .filter((message) => message.content)
    .map((message) => (message.role === 'user' ? `## 提问\n\n${message.content}` : `## Agent\n\n${message.content}`))
    .join('\n\n---\n\n');
  const blob = new Blob([`${header}\n${body}\n`], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `composeops-session-${sessionId.value || 'export'}.md`;
  link.click();
  URL.revokeObjectURL(url);
  toast.success('会话已导出为 Markdown');
}

/** 会话压缩:把分界前历史折叠成一份交接摘要,模型侧上下文瘦身,界面渲染不受影响。 */
async function compactCurrentSession() {
  if (!sessionId.value || running.value || composerBlocked.value) return;
  const target = sessionId.value;
  const unlock = lockSession('正在压缩历史'); if (!unlock) return;
  compacting.value = true;
  try {
    const result = await api.compactAgentSession(target);
    if (disposed || sessionId.value !== target) return;
    toast.success(`已压缩 ${result.compactedMessages} 条历史${result.fallback ? '(使用确定性摘要)' : ''},模型上下文已瘦身`);
    headMenuOpen.value = false;
  } catch (error) {
    if (!disposed && sessionId.value === target) toast.error(`压缩失败：${error.message}`);
  } finally {
    unlock();
    if (!disposed) compacting.value = false;
  }
}
const TOOL_ICONS = {
  'project.list_managed': FolderKanban,
  'compose.ps': FolderOpen,
  'compose.up': Play,
  'compose.restart': RefreshCw,
  'compose.logs': FileText,
  'compose.exec': Terminal,
  'config.edit': FileEdit,
  'metrics.query': Activity,
  'web.search': Globe2,
  'memory.search': Search,
};
function getToolIcon(toolName) { return TOOL_ICONS[toolName] || Wrench; }
function getToolStatusLabel(status) {
  const labels = { requested: '已请求', executing: '执行中', done: '完成', failed: '失败', rejected: '已拒绝' };
  return labels[status] || status;
}
const STATE_CHANGING_TOOLS = new Set(['compose.up', 'compose.stop', 'compose.restart', 'compose.pull', 'compose.scale', 'config.edit', 'config.rollback', 'environment.set', 'volume.mount', 'volume.restore', 'maintenance.clean', 'maintenance.update', 'app.deploy']);
function isStateChangingTool(toolName) { return STATE_CHANGING_TOOLS.has(toolName); }
function toolProjectId(tool) {
  try {
    const params = JSON.parse(tool.paramsText || '{}');
    return String(params.projectId || params.project_id || '');
  } catch {
    return '';
  }
}
function inspectToolProject(tool) {
  const id = toolProjectId(tool);
  if (!id) return;
  router.push({ path: '/services', query: { focus: id, from: 'agent' } });
}
function diagnoseTool(tool) {
  const id = toolProjectId(tool);
  if (!id) return;
  const containerId = toolContainerId(tool);
  const failure = encodeURIComponent(JSON.stringify({ tool: tool.tool, error: tool.error || '', summary: tool.summary || '' }));
  router.push({ path: '/agent', query: { projectId: id, ...(containerId ? { containerId } : {}), diagnose: '1', failure } });
}
function toolContainerId(tool) {
  try {
    const params = JSON.parse(tool.paramsText || '{}');
    return String(params.containerId || params.container_id || '');
  } catch { return ''; }
}
const voiceRecording = ref(false);
let recognition = null;
function stopVoiceInput() {
  const previous = recognition; recognition = null; voiceRecording.value = false;
  if (previous) { previous.onresult = previous.onerror = previous.onend = null; previous.abort?.(); }
}
function toggleVoiceInput() {
  if (composerBlocked.value) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast.error('浏览器不支持语音输入'); return; }
  if (voiceRecording.value) { stopVoiceInput(); return; }
  const current = new SpeechRecognition(), target = sessionId.value;
  recognition = current;
  current.lang = 'zh-CN'; current.continuous = false; current.interimResults = false;
  const valid = () => !disposed && recognition === current && sessionId.value === target;
  current.onresult = event => {
    if (!valid()) return;
    const transcript = event.results?.[0]?.[0]?.transcript || '';
    input.value += `${input.value && transcript ? ' ' : ''}${transcript}`;
    stopVoiceInput(); focusInput();
  };
  current.onerror = () => { if (valid()) { stopVoiceInput(); toast.error('语音识别失败'); } };
  current.onend = () => { if (valid()) { recognition = null; voiceRecording.value = false; } };
  try { voiceRecording.value = true; current.start(); }
  catch { stopVoiceInput(); toast.error('无法启动语音输入，请检查麦克风权限'); }
}
async function regenerateSafely(message) {
  if (composerBlocked.value) return;
  try {
    await regenerate(requestContext(), message.id);
  } catch (error) {
    toast.error(error);
  }
}
async function rate(message, rating) {
  const next = message.rating === rating ? null : rating;
  if (next === null) { message.rating = null; return; }
  const ok = await rateMessage(message, next);
  if (ok) toast.success(next === 5 ? '已记录：回答有帮助' : '已记录：会据此改进');
  else toast.error('反馈提交失败');
}
function startEdit(message) {
  if (composerBlocked.value) return;
  if (running.value) { toast.info('执行中,请稍后再编辑'); return; }
  editingMessageId.value = message.id;
  input.value = message.content;
  focusInput();
}
function cancelEdit() {
  editingMessageId.value = null;
  input.value = '';
}
async function copyMessage(message) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(message.content);
    else {
      const previous = document.activeElement, area = document.createElement('textarea');
      area.value = message.content; area.style.cssText = 'position:fixed;top:0;left:-9999px';
      document.body.appendChild(area);
      try { area.select(); if (!document.execCommand('copy')) throw new Error('复制不可用'); }
      finally { area.remove(); previous?.focus({ preventScroll: true }); }
    }
    toast.success('已复制到剪贴板');
  } catch { toast.error('复制失败，请选中回复文字后复制'); }
}
async function loadProjects() {
  const request = ++projectRequest; loading.value = true; projectsError.value = '';
  try { const result = await api.getProjects(true); if (!disposed && request === projectRequest) projects.value = (result.projects || []).filter(project => project.managed); }
  catch (error) { if (!disposed && request === projectRequest) projectsError.value = error.message || '读取项目失败'; }
  finally { if (!disposed && request === projectRequest) loading.value = false; }
}
async function loadSessions() {
  const request = ++sessionListRequest; sessionsLoading.value = true; sessionsError.value = '';
  try {
    const data = await api.getAiSessions(50);
    if (disposed || request !== sessionListRequest) return;
    sessions.value = data.sessions || [];
    selectedSessions.value = selectedSessions.value.filter(id => sessions.value.some(session => session.sessionId === id));
  } catch (error) { if (!disposed && request === sessionListRequest) sessionsError.value = error.message || '读取会话列表失败'; }
  finally { if (!disposed && request === sessionListRequest) sessionsLoading.value = false; }
}
async function loadMemories() {
  const request = ++memoryRequest; memoriesLoading.value = true; memoriesError.value = '';
  try { const data = await api.getAiMemories(20); if (!disposed && request === memoryRequest) memories.value = data.memories || []; }
  catch (error) { if (!disposed && request === memoryRequest) memoriesError.value = error.message || '读取长期记忆失败'; }
  finally { if (!disposed && request === memoryRequest) memoriesLoading.value = false; }
}
function saveSessionDraft() {
  sessionDrafts.set(sessionId.value || 'new', { input: input.value, attachedLogs: attachedLogs.value, attachedCount: attachedCount.value, queue: [...pendingQueue.value] });
}
function resetCurrentSession() {
  ++historyRequest; ++olderHistoryRequest;
  resetSession(); resetViewState(); historyHasMore.value = false; loadingHistory.value = loadingOlderHistory.value = false;
  historyError.value = olderHistoryError.value = ''; currentTurnId.value = 0;
  syncSessionRoute(); focusInput();
}
function newSession() {
  if (disposed || running.value || sessionBusy.value) return;
  saveSessionDraft(); resetCurrentSession(); mobileSessionsOpen.value = false;
}
function syncSessionRoute() {
  if (disposed || route.path !== '/agent') return;
  const query = { ...route.query };
  if (sessionId.value) query.sessionId = String(sessionId.value); else delete query.sessionId;
  if (String(route.query.sessionId || '') !== String(query.sessionId || '')) void router.replace({ path: '/agent', query });
}
function mapHistoryMessages(items) {
  return (items || []).filter((item) => ['user', 'assistant'].includes(item.role)).map((item) => ({
    id: nextMessageId(),
    role: item.role,
    content: stripAgentProtocol(item.content),
    persistedId: Number(item.id) || 0,
  }));
}
async function openSession(id) {
  const target = Number(id);
  if (disposed || running.value || sessionBusy.value || !Number.isSafeInteger(target) || target <= 0) return;
  if (loadingHistory.value && sessionId.value === target) return;
  const request = ++historyRequest; ++olderHistoryRequest;
  if (sessionId.value !== target) {
    saveSessionDraft(); resetViewState();
    const draft = sessionDrafts.get(target);
    resetSession();
    input.value = draft?.input || ''; attachedLogs.value = draft?.attachedLogs || ''; attachedCount.value = draft?.attachedCount || 0;
    pendingQueue.value = draft?.queue || []; queuePaused.value = pendingQueue.value.length > 0;
  }
  sessionId.value = target; messages.value = [];
  loadingHistory.value = true; loadingOlderHistory.value = false; historyHasMore.value = false;
  historyError.value = olderHistoryError.value = ''; messageQuery.value = '';
  setActiveActivityOpen(true); syncSessionRoute();
  const current = () => !disposed && request === historyRequest && sessionId.value === target;
  try {
    const data = await api.getAiHistory(target, 200);
    if (!current()) return;
    historyHasMore.value = !!data.hasMore; messages.value = mapHistoryMessages(data.messages);
    approvalMode.value = ['ask', 'allow_writes', 'full'].includes(data.approvalMode) ? data.approvalMode : 'ask';
  } catch (error) { if (current()) historyError.value = error.message || '恢复会话失败'; }
  finally { if (current()) { loadingHistory.value = false; scrollBottom(true); } }
}
async function selectSession(id) { mobileSessionsOpen.value = false; await openSession(id); if (!disposed && !historyError.value) focusInput(); }
async function loadOlderHistory() {
  if (disposed || !sessionId.value || loadingHistory.value || loadingOlderHistory.value || !historyHasMore.value) return;
  const target = sessionId.value, version = historyRequest, request = ++olderHistoryRequest;
  const oldest = messages.value.find(message => message.persistedId)?.persistedId;
  if (!oldest) { historyHasMore.value = false; return; }
  const element = scrollEl.value, previousHeight = element?.scrollHeight || 0;
  loadingOlderHistory.value = true; olderHistoryError.value = '';
  const current = () => !disposed && target === sessionId.value && version === historyRequest && request === olderHistoryRequest;
  try {
    const data = await api.getAiHistory(target, 200, oldest);
    if (!current()) return;
    const existing = new Set(messages.value.map(message => message.persistedId));
    messages.value.unshift(...mapHistoryMessages((data.messages || []).filter(message => !existing.has(Number(message.id)))));
    historyHasMore.value = !!data.hasMore;
    await nextTick(); if (current() && element) element.scrollTop += element.scrollHeight - previousHeight;
  } catch (error) { if (current()) olderHistoryError.value = error.message || '加载更早消息失败'; }
  finally { if (current()) loadingOlderHistory.value = false; }
}
watch(() => route.query.sessionId, id => { const target = Number(id); if (!disposed && route.path === '/agent' && target !== sessionId.value && Number.isSafeInteger(target) && target > 0) void openSession(target); });
function resetViewState() {
  // 注意:这里刻意不清 activity。
  // 以前切页/切会话会把执行动态全部丢掉,切回来右边空一片,像是"记录凭空没了";
  // 执行动态现在按会话分组保留,只重置"当前页面的临时交互状态"。
  attachedLogs.value = '';
  attachedCount.value = 0;
  showLogPicker.value = false;
  showQuickPrompts.value = false;
  editingMessageId.value = null;
  messageQuery.value = '';
  stopVoiceInput();
}
function deleteSession(id) {
  if (running.value || sessionBusy.value || loadingHistory.value) return;
  deleteDialog.id = Number(id); deleteDialog.title = sessions.value.find(session => session.sessionId === Number(id))?.title || `会话 #${id}`;
  sessionMutationError.value = ''; deleteDialog.show = true;
}
async function runSessionMutation(action, apply, message) {
  if (disposed || running.value || sessionBusy.value) return false;
  const request = ++sessionWriteRequest;
  ++sessionListRequest; sessionsLoading.value = false;
  const unlock = lockSession('正在更新会话'); if (!unlock) return false;
  sessionMutationBusy.value = true; sessionMutationError.value = '';
  try {
    await action();
    apply();
    if (disposed || request !== sessionWriteRequest) return false;
    ++sessionListRequest; sessionsLoading.value = false; sessionFeedback.value = message;
    return true;
  } catch (error) { if (!disposed && request === sessionWriteRequest) sessionMutationError.value = error.message || '操作失败，请重试'; return false; }
  finally { unlock(); if (!disposed && request === sessionWriteRequest) sessionMutationBusy.value = false; }
}
function removeSessions(ids) {
  sessions.value = sessions.value.filter(session => !ids.includes(session.sessionId));
  selectedSessions.value = selectedSessions.value.filter(id => !ids.includes(id));
  for (const id of ids) sessionDrafts.delete(id);
  dropActivityForSessions(ids);
  if (ids.includes(sessionId.value)) resetCurrentSession();
}
async function confirmDeleteSession() {
  const id = deleteDialog.id;
  if (!deleteDialog.show || !id) return;
  return runSessionMutation(() => api.clearAiHistory(id), () => { removeSessions([id]); deleteDialog.show = false; }, `已删除“${deleteDialog.title}”及其消息。`);
}
function toggleSession(id) { if (!sessionBusy.value) selectedSessions.value = selectedSessions.value.includes(id) ? selectedSessions.value.filter(value => value !== id) : [...selectedSessions.value, id]; }
function toggleAllSessions() { if (sessionBusy.value) return; const ids = filteredSessionIds.value; selectedSessions.value = allSessionsSelected.value ? selectedSessions.value.filter(id => !ids.includes(id)) : [...new Set([...selectedSessions.value, ...ids])]; }
function deleteSelectedSessions() {
  if (!selectedSessions.value.length || running.value || sessionBusy.value) return;
  bulkDeleteIds.value = [...selectedSessions.value]; sessionMutationError.value = ''; bulkDeleteDialog.value = true;
}
async function confirmDeleteSelected() {
  const ids = [...bulkDeleteIds.value];
  if (!bulkDeleteDialog.value || !ids.length) return;
  return runSessionMutation(() => api.clearAiSessions(ids), () => { removeSessions(ids); bulkDeleteDialog.value = false; }, `已删除 ${ids.length} 个会话及其消息。`);
}
function clearCurrentSession() {
  if (!sessionId.value || !messages.value.length || running.value || composerBlocked.value) return;
  clearTarget.value = { id: sessionId.value, title: activeTitle.value }; sessionMutationError.value = ''; clearDialog.value = true;
}
async function confirmClearSession() {
  const target = clearTarget.value;
  if (!clearDialog.value || !target?.id) return;
  return runSessionMutation(() => api.clearAiHistory(target.id), () => { removeSessions([target.id]); clearDialog.value = false; }, `已删除“${target.title}”及其消息，可以开始新会话。`);
}
function beginRename(session) {
  if (sessionBusy.value || running.value) return;
  editingSessionId.value = session.sessionId; editingTitle.value = session.title || ''; renameError.value = '';
}
function cancelRename() { if (renameBusy.value) return; editingSessionId.value = null; editingTitle.value = ''; renameError.value = ''; }
async function saveRename(session) {
  if (disposed || sessionBusy.value || editingSessionId.value !== session.sessionId) return;
  const target = session.sessionId, title = editingTitle.value.trim();
  if (!title) { renameError.value = '请填写会话标题'; return; }
  if (title === session.title) { cancelRename(); return; }
  const request = ++sessionWriteRequest;
  ++sessionListRequest; sessionsLoading.value = false; renameBusy.value = true; renameError.value = '';
  try {
    await api.renameAgentSession(target, title);
    if (disposed || request !== sessionWriteRequest) return;
    ++sessionListRequest;
    const row = sessions.value.find(item => item.sessionId === target); if (row) row.title = title;
    editingSessionId.value = null; editingTitle.value = ''; sessionFeedback.value = '会话标题已保存。';
  } catch (error) { if (!disposed && request === sessionWriteRequest) renameError.value = error.message || '标题保存失败'; }
  finally { if (!disposed && request === sessionWriteRequest) renameBusy.value = false; }
}
function selectProject(project) { projectId.value = project.id; input.value = `后续操作项目 ${project.name}`; focusInput(); }
const containerId = ref('');
function requestContext() {
  return { role: workerRole.value, projectId: projectId.value || undefined, containerId: containerId.value || undefined, webSearchEnabled: webSearchEnabled.value, attachedLogs: attachedLogs.value || undefined };
}
async function resumeQueueSafely() { try { await resumeQueue(); } catch (error) { toast.error(error); } }
async function continueSafely(message) {
  try { await continueAfterInterrupt(requestContext(), message.id); } catch (error) { toast.error(error); }
}
async function submit() {
  const text = input.value.trim();
  if (!text || disposed || composerBlocked.value) return;
  showLogPicker.value = false; showQuickPrompts.value = false;
  currentTurnId.value += 1; setActiveActivityOpen(true);
  try {
    if (editingMessageId.value) {
      const target = editingMessageId.value;
      const accepted = await editAndResend(target, text, requestContext());
      if (accepted && editingMessageId.value === target) editingMessageId.value = null;
    } else await sendMessage(text, requestContext());
  } catch (error) { if (!disposed) toast.error(error); return; }
  if (!disposed) await Promise.all([loadSessions(), loadMemories()]);
}
async function applyRouteContext() {
  const contextPath = route.fullPath;
  const requestedProjectId = String(route.query.projectId || '');
  const requestedContainerId = String(route.query.containerId || '');
  if (requestedProjectId) projectId.value = requestedProjectId;
  if (requestedContainerId) containerId.value = requestedContainerId;
  if (route.query.diagnose && requestedProjectId) {
    try {
      if (requestedContainerId) {
        const result = await api.getProjectLogs(requestedProjectId, requestedContainerId, 200);
        if (disposed || contextPath !== route.fullPath || projectId.value !== requestedProjectId || containerId.value !== requestedContainerId) return;
        onAttach({ text: result.logs || '', count: result.count || 0 });
      }
      if (disposed || projectId.value !== requestedProjectId) return;
      const failure = route.query.failure ? JSON.parse(decodeURIComponent(String(route.query.failure))) : null;
      input.value ||= (failure ? '刚才 Agent 执行 ' + (failure.tool || '运维操作') + ' 失败。请结合当前项目状态与失败证据分析根因，给出修复方案；如需要修改系统状态，先提出计划并等待我的确认。' + '\n\n失败摘要：' + (failure.error || failure.summary || '未知错误') : '请分析已挂载的容器日志，判断异常原因并给出修复建议');
    } catch (error) {
      if (!disposed && projectId.value === requestedProjectId) toast.error('加载诊断上下文失败：' + error.message);
    }
  }
}
function onAgentPrompt(event) {
  if (event.detail?.prompt) input.value = String(event.detail.prompt);
  focusInput();
}
onMounted(() => {
  window.addEventListener('composeops:agent-prompt', onAgentPrompt);
  window.addEventListener('composeops:agent-focus', focusInput);
});
onBeforeUnmount(() => {
  window.removeEventListener('composeops:agent-prompt', onAgentPrompt);
  window.removeEventListener('composeops:agent-focus', focusInput);
});
function onComposerKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault(); void submit();
}
const handleKeydown = (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.target === inputEl.value) {
      e.preventDefault();
      if (!e.isComposing && input.value.trim()) void submit();
    } else if (e.key === 'Escape' && running.value) {
      e.preventDefault();
      interrupt();
    }
  };
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));
onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  void loadProjects(); void loadMemories(); void loadWorkerRoles(); void applyRouteContext();
  const initialRequest = historyRequest;
  const requested = Number(route.query.sessionId);
  if (Number.isSafeInteger(requested) && requested > 0 && !running.value) void openSession(requested);
  else if (sessionId.value && !messages.value.length && !running.value) void openSession(sessionId.value);
  void loadSessions().then(() => {
    if (disposed || historyRequest !== initialRequest || running.value) return;
    if (!sessionId.value && !input.value && sessions.value.length) void openSession(sessions.value[0].sessionId);
    else if (!messages.value.length) focusInput();
  });
});
onBeforeUnmount(() => {
  disposed = true; ++historyRequest; ++olderHistoryRequest; ++sessionListRequest; ++projectRequest; ++memoryRequest; ++sessionWriteRequest;
  stopVoiceInput();
  if (loadingHistory.value) { loadingHistory.value = false; historyError.value = '会话历史尚未恢复，请回到工作台重试'; }
});
// 订阅者始终有效(本页面不在 keep-alive 白名单,卸载即停止累积):
// 之前 onDeactivated 会把订阅者静音,那一轮的执行动态就整段丢了,
// 切回来右侧空空如也 —— 这正是"切走再切回,执行动态都没了"的原因。
// 下拉刷新只重读侧栏(项目/会话/记忆);Agent 正在执行时不动话面,避免打断这一轮。
usePullRefresh(() => {
  if (running.value) return;
  return Promise.all([loadProjects(), loadSessions(), loadMemories()]);
});
</script>

<style scoped>
.agent-stream-error { margin-top: 10px; padding: 9px 11px; border: 1px solid rgb(244 63 94 / .25); border-radius: 8px; background: rgb(244 63 94 / .06); color: #fda4af; font-size: 12px; line-height: 1.6; }
.agent-message-action-btn:disabled { opacity: .4; cursor: not-allowed; }
.agent-page { min-height: 0; }.agent-layout { display: grid; grid-template-columns: 238px minmax(0, 1fr) 260px; min-height: 0; flex: 1; gap: 12px; }.agent-sessions, .agent-chat, .agent-inspector-card { min-height: 0; }.agent-sessions { display: flex; flex-direction: column; overflow: hidden; }.agent-side-head, .agent-chat-head, .agent-inspector-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.agent-side-head { padding: 14px; border-bottom: 1px solid rgba(69,76,91,.55); }.agent-side-head h2 { color: #e5e7eb; font-size: 13px; font-weight: 700; }.agent-side-head span, .agent-status { color: #71717a; font-size: 10px; }.icon-btn { display: inline-grid; width: 30px; height: 30px; place-items: center; color: #a1a1aa; border: 1px solid #3f4653; border-radius: 7px; background: #20252d; }.icon-btn:hover { color: #67e8f9; border-color: #155e75; }.agent-session-list { overflow-y: auto; padding: 6px; }.agent-session-row { display: flex; align-items: center; gap: 3px; border-radius: 7px; color: #a1a1aa; }.agent-session-row.active { background: rgba(8,145,178,.14); color: #cffafe; }.agent-session-open { display: flex; min-width: 0; flex: 1; align-items: flex-start; gap: 9px; padding: 10px 7px; text-align: left; }.agent-session-open strong, .agent-session-open small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.agent-session-open strong { color: inherit; font-size: 12px; font-weight: 600; }.agent-session-open small { margin-top: 3px; color: #71717a; font-size: 10px; }.agent-session-delete { padding: 8px; color: #71717a; }.agent-session-delete:hover { color: #fb7185; }.agent-empty-side { padding: 16px 9px; color: #71717a; font-size: 11px; line-height: 1.6; }.agent-chat { position: relative; display: flex; flex-direction: column; overflow: hidden; }.agent-chat-head { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: 0 0 auto; padding: 13px 16px; border-bottom: 1px solid rgba(69,76,91,.55); }.agent-chat-head strong { color: #e4e4e7; font-size: 13px; }.agent-messages { min-height: 0; flex: 1; overflow-y: auto; padding: 22px clamp(12px,4vw,54px) 56px; }.agent-loading, .agent-welcome { display: grid; min-height: 100%; place-content: center; justify-items: center; text-align: center; }.agent-welcome-mark { display: grid; width: 52px; height: 52px; place-items: center; color: #67e8f9; border: 1px solid #164e63; border-radius: 14px; background: #082f49; }.agent-welcome h2 { margin-top: 14px; color: #f4f4f5; font-size: 17px; }.agent-welcome p { max-width: 430px; margin-top: 7px; color: #71717a; font-size: 13px; line-height: 1.7; }.agent-prompts { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 18px; }.agent-message { display: flex; max-width: 860px; margin: 0 auto 24px; align-items: flex-start; gap: 10px; }.agent-message.user { flex-direction: row-reverse; }.agent-avatar { display: grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; color: #a1a1aa; border: 1px solid #3f4653; border-radius: 8px; background: #20252d; }.agent-message.assistant .agent-avatar { color: #67e8f9; border-color: #155e75; background: #082f49; }.agent-message-body { min-width: 0; max-width: calc(100% - 40px); }.agent-user-text { white-space: pre-wrap; word-break: break-word; padding: 10px 13px; color: #f4f4f5; border: 1px solid #164e63; border-radius: 10px 3px 10px 10px; background: rgba(8,47,73,.55); font-size: 13px; line-height: 1.6; }.agent-markdown { color: #d4d4d8; font-size: 13px; line-height: 1.75; }.agent-markdown :deep(p) { margin: 0 0 10px; }.agent-markdown :deep(p:last-child) { margin-bottom: 0; }.agent-markdown :deep(h1), .agent-markdown :deep(h2), .agent-markdown :deep(h3) { margin: 16px 0 8px; color: #f4f4f5; font-weight: 700; line-height: 1.35; }.agent-markdown :deep(h1) { font-size: 18px; }.agent-markdown :deep(h2) { font-size: 16px; }.agent-markdown :deep(h3) { font-size: 14px; }.agent-markdown :deep(ul), .agent-markdown :deep(ol) { margin: 8px 0; padding-left: 22px; }.agent-markdown :deep(li) { margin: 3px 0; }.agent-markdown :deep(code) { padding: 2px 5px; color: #a5f3fc; border-radius: 4px; background: #181c23; font-size: .9em; }.agent-markdown :deep(pre) { overflow: auto; margin: 10px 0; padding: 12px; border: 1px solid #303641; border-radius: 7px; background: #11151b; }.agent-markdown :deep(pre code) { padding: 0; background: transparent; }.agent-markdown :deep(blockquote) { margin: 10px 0; padding-left: 12px; color: #a1a1aa; border-left: 2px solid #155e75; }.agent-markdown :deep(a) { color: #67e8f9; text-decoration: underline; }.agent-markdown :deep(table) { display: block; width: 100%; margin: 10px 0; overflow-x: auto; border-collapse: collapse; font-size: 12px; }.agent-markdown :deep(th), .agent-markdown :deep(td) { padding: 6px 10px; border: 1px solid #303641; text-align: left; vertical-align: top; }.agent-markdown :deep(th) { color: #e4e4e7; font-weight: 600; background: #11151b; white-space: nowrap; }.agent-markdown :deep(tr:nth-child(even) td) { background: rgba(17,21,27,.4); }.agent-markdown :deep(hr) { margin: 14px 0; border: 0; border-top: 1px solid #303641; }.agent-project-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 8px; margin-top: 12px; }.agent-project-card, .agent-confirm, .agent-sources { margin-top: 10px; padding: 11px; border: 1px solid #303641; border-radius: 8px; background: rgba(17,21,27,.72); }.agent-project-card strong { color: #e4e4e7; font-size: 12px; }.agent-project-card span { font-size: 10px; }.agent-project-card p { margin: 5px 0; color: #71717a; font-size: 11px; }.agent-project-card button { display: inline-flex; align-items: center; gap: 3px; margin-top: 7px; padding: 3px 8px; color: #67e8f9; border: 1px solid rgba(8, 145, 178, 0.4); border-radius: 6px; background: rgba(8, 145, 178, 0.08); font-size: 11px; transition: background 0.15s ease, border-color 0.15s ease; }
.agent-project-card button:hover { background: rgba(8, 145, 178, 0.18); border-color: #0891b2; }.agent-confirm { color: #fde68a; border-color: rgba(146,64,14,.7); background: rgba(69,26,3,.25); }.agent-confirm strong { font-size: 12px; }.agent-confirm p { margin-top: 4px; color: rgba(254,243,199,.7); font-size: 11px; }.agent-confirm pre { max-height: 130px; overflow: auto; margin-top: 8px; padding: 8px; color: #a1a1aa; background: rgba(0,0,0,.3); font-size: 10px; }.agent-sources > div { display: flex; align-items: center; gap: 5px; margin-bottom: 7px; color: #67e8f9; font-size: 11px; font-weight: 700; }.agent-sources a { display: block; overflow: hidden; color: #a1a1aa; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.agent-sources a:hover { color: #67e8f9; }.agent-sources small { display: block; overflow: hidden; margin-top: 2px; color: #52525b; text-overflow: ellipsis; white-space: nowrap; }.agent-activity { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 9px; color: #71717a; font-size: 10px; }.agent-activity b { margin-right: 3px; color: #22d3ee; font-weight: 500; }.agent-composer { flex: 0 0 auto; padding: 12px 16px 14px; border-top: 1px solid rgba(69,76,91,.55); }.agent-input { display: block; width: 100%; resize: vertical; padding: 10px 12px; color: #e4e4e7; border: 1px solid #3f4653; border-radius: 8px; outline: none; background: #181c23; font-size: 13px; line-height: 1.6; }.agent-input:focus { border-color: #0891b2; box-shadow: 0 0 0 2px rgba(8,145,178,.15); }.agent-composer-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; color: #52525b; font-size: 10px; }.agent-inspector { display: flex; min-height: 0; flex-direction: column; gap: 12px; }.agent-inspector-card { padding: 14px; color: #71717a; font-size: 11px; line-height: 1.6; }.agent-inspector-title { margin-bottom: 9px; color: #d4d4d8; font-size: 12px; font-weight: 700; }.agent-inspector-title em { color: #22d3ee; font-size: 10px; font-style: normal; }.agent-activity-panel { min-height: 160px; flex: 1; overflow-y: auto; }.agent-memory { padding: 7px 0; border-top: 1px solid #272c35; }.agent-memory strong, .agent-memory span { display: block; }.agent-memory strong { color: #a5f3fc; font-size: 11px; }.agent-memory span { color: #a1a1aa; font-size: 10px; }.agent-memory-meta { display: block; margin-top: 3px; color: #52525b; font-size: 10px; }.agent-task-notice { display: flex; align-items: flex-start; gap: 7px; margin-top: 10px; padding: 8px 10px; border: 1px solid rgba(37, 99, 235, 0.45); border-radius: 8px; color: #bfdbfe; background: rgba(37, 99, 235, 0.12); font-size: 10px; line-height: 1.6; }.agent-task-notice p { margin: 0; color: #bfdbfe; word-break: break-all; }.agent-task-notice p + p { margin-top: 4px; }
@media (max-width: 1180px) { .agent-layout { grid-template-columns: 210px minmax(0,1fr); }.agent-inspector { display: none; } } @media (max-width: 760px) { .agent-layout { display: flex; flex-direction: column; }.agent-sessions { max-height: 142px; }.agent-session-list { display: flex; overflow-x: auto; gap: 4px; }.agent-session-row { min-width: 190px; }.agent-message-body { max-width: calc(100% - 38px); }.agent-composer-foot span { max-width: 65%; } }
@media (max-width: 760px) { .agent-layout { flex: 1; min-height: 0; }.agent-sessions { display: none; }.agent-chat { min-height: 0; flex: 1; }.agent-chat-head .agent-mobile-session-btn { display: inline-flex; align-items: center; gap: 4px; padding: 5px 8px; color: #a5f3fc; border: 1px solid #155e75; border-radius: 7px; background: rgba(8,47,73,.5); font-size: 11px; }.agent-mobile-sheet-mask { position: fixed; inset: 0; z-index: 51; background: rgba(0,0,0,.58); }.agent-mobile-sheet { position: absolute; inset: auto 0 0; max-height: 78dvh; overflow: hidden; border-top: 1px solid #3f4653; border-radius: 16px 16px 0 0; background: #11151b; box-shadow: 0 -14px 40px rgba(0,0,0,.45); }.agent-mobile-sheet-list { max-height: calc(78dvh - 105px); overflow-y: auto; display: block; }.agent-mobile-sheet-list .agent-session-open { width: 100%; border-bottom: 1px solid #272c35; }.agent-mobile-sheet-list .agent-session-open.active { background: rgba(8,145,178,.14); } }
.agent-session-edit { padding: 8px 3px; color: #71717a; }
.agent-load-history { display: block; margin: 0 auto 10px; padding: 5px 10px; color: #67e8f9; border: 1px solid rgba(8,145,178,.4); border-radius: 6px; background: rgba(8,47,73,.35); font-size: 11px; }
.agent-load-history:disabled { color: #71717a; cursor: wait; }
.agent-session-bulk { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 12px; color: #71717a; border-top: 1px solid #272c35; border-bottom: 1px solid #272c35; font-size: 10px; }
.agent-session-bulk label { display: inline-flex; align-items: center; gap: 6px; }
.agent-session-check { width: 14px; height: 14px; margin: 0 2px 0 6px; accent-color: #06b6d4; }
.agent-session-row.selected { background: rgba(8,145,178,.08); }

/* chat-head 更多操作菜单 */
.agent-head-menu { position: relative; }
.agent-head-id { display: flex; min-width: 0; flex: 1; align-items: center; gap: 9px; }
.agent-head-text { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
.agent-head-text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 移动端的会话入口默认隐藏:桌面端左栏已经常驻,按钮挤在标题旁边是纯噪音。
   之前它只在 @media(max-width:760px) 里有样式,桌面端会以裸 button 形态出现。 */
.agent-mobile-session-btn { display: none; }

/* ===== 执行动态:按会话分组 + 组内按提问轮次折叠 ===== */
.agent-activity-groups { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
.agent-activity-group { border: 1px solid rgba(148, 163, 184, 0.14); border-radius: 9px; background: rgba(17, 21, 27, 0.5); overflow: hidden; }
.agent-activity-group.is-active { border-color: rgba(8, 145, 178, 0.42); background: rgba(8, 47, 73, 0.22); }
.agent-activity-group-head, .agent-activity-turn-head { display: flex; width: 100%; align-items: center; gap: 6px; padding: 7px 9px; color: #a1a1aa; font-size: 10.5px; font-weight: 600; text-align: left; transition: background 0.14s ease, color 0.14s ease; }
.agent-activity-group-head:hover, .agent-activity-turn-head:hover { background: rgba(148, 163, 184, 0.07); color: #e4e4e7; }
.agent-activity-group.is-active .agent-activity-group-head { color: #a5f3fc; }
.agent-activity-caret { flex: 0 0 auto; color: #52525b; transition: transform 0.16s var(--ease-out-soft); }
.agent-activity-caret.open { transform: rotate(90deg); }
.agent-activity-group-title { min-width: 0; overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }
.agent-activity-group-count { padding: 0 6px; color: #a5f3fc; border-radius: 999px; background: rgba(8, 145, 178, 0.2); font-size: 9px; }
.agent-activity-group-body { padding: 2px 8px 8px; }
.agent-activity-turn + .agent-activity-turn { margin-top: 5px; padding-top: 5px; border-top: 1px dashed rgba(148, 163, 184, 0.13); }
.agent-activity-turn-head { padding: 5px 2px; color: #71717a; font-weight: 500; }
.agent-activity-turn-head em { color: #52525b; font-size: 9px; font-style: normal; }
.agent-activity-turn-head .agent-activity-time { margin-left: auto; }
.agent-activity-timeline { padding-left: 12px; }
.agent-head-menu-backdrop { position: fixed; inset: 0; z-index: 30; }
.agent-head-dropdown { position: absolute; top: calc(100% + 6px); right: 0; z-index: 31; min-width: 168px; padding: 5px; border: 1px solid #303641; border-radius: 10px; background: #161b22; box-shadow: 0 14px 40px rgba(0,0,0,.5); animation: fade-rise .15s var(--ease-out-soft); }
.agent-head-dropdown button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 8px 10px; color: #d4d4d8; border-radius: 7px; font-size: 12px; text-align: left; transition: background .12s ease; }
.agent-head-dropdown button:hover:not(:disabled) { background: #1f252e; color: #fff; }
.agent-head-dropdown button:disabled { color: #52525b; cursor: not-allowed; }

/* 正在处理:跳动点 */
.agent-typing { display: inline-flex; align-items: center; gap: 5px; padding: 4px 0; color: #71717a; font-size: 12px; }
.agent-typing i { width: 5px; height: 5px; border-radius: 999px; background: #22d3ee; animation: typing-bounce 1.1s var(--ease-spring) infinite; }
.agent-typing i:nth-child(2) { animation-delay: .14s; }
.agent-typing i:nth-child(3) { animation-delay: .28s; }
@keyframes typing-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }
.agent-empty-reply { color: #52525b; font-size: 12px; font-style: italic; }

/* 确认卡参数编辑 */
.agent-confirm-params { margin-top: 7px; }
.agent-confirm-params summary { color: rgba(254, 243, 199, 0.85); font-size: 11px; cursor: pointer; user-select: none; }
.agent-confirm-params summary:hover { color: #fde68a; }
.agent-confirm-params-text { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; color: #e4e4e7; border: 1px solid rgba(146, 64, 14, 0.5); border-radius: 7px; background: rgba(0, 0, 0, 0.3); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; outline: none; resize: vertical; }
.agent-confirm-params-text:focus { border-color: #b45309; }

/* 工具执行轨迹 */
.agent-tool-track { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
.agent-tool-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; color: #a1a1aa; border: 1px solid #303641; border-radius: 999px; background: #181c23; font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.agent-tool-chip em { color: #52525b; font-style: normal; }
.agent-tool-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 999px; background: #52525b; }
.agent-tool-chip.requested .agent-tool-dot { background: #fbbf24; }
.agent-tool-chip.executing .agent-tool-dot { background: #22d3ee; animation: tool-pulse 1s ease-in-out infinite; }
.agent-tool-chip.done .agent-tool-dot { background: #34d399; }
.agent-tool-chip.failed .agent-tool-dot { background: #fb7185; }
.agent-tool-chip.rejected .agent-tool-dot { background: #a78bfa; }
.agent-tool-verify { margin-left: 4px; padding: 1px 6px; color: #a5f3fc; border: 1px solid rgba(8,145,178,.35); border-radius: 999px; background: rgba(8,47,73,.35); font-size: 9px; }
.agent-tool-verify:hover { color: #fff; border-color: #155e75; background: rgba(8,145,178,.28); }
.agent-tool-diagnose { margin-left: 4px; padding: 1px 6px; color: #fcd34d; border: 1px solid rgba(245,158,11,.35); border-radius: 999px; background: rgba(120,53,15,.25); font-size: 9px; }
.agent-tool-diagnose:hover { color: #fff; border-color: #b45309; background: rgba(120,53,15,.38); }
@keyframes tool-pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }

/* 复制按钮 */
.agent-message-body { position: relative; }
.agent-copy-btn { position: absolute; top: 0; right: 0; display: inline-grid; width: 24px; height: 24px; place-items: center; color: #52525b; border: 1px solid #303641; border-radius: 6px; background: rgba(24,28,35,.85); opacity: 0; transition: opacity .15s ease, color .15s ease; }
.agent-message:hover .agent-copy-btn { opacity: 1; }
.agent-copy-btn:hover { color: #67e8f9; }

/* 回底浮标 */
.agent-scroll-bottom { position: absolute; right: 20px; bottom: 148px; z-index: 15; display: inline-flex; align-items: center; gap: 5px; padding: 7px 12px; color: #a5f3fc; border: 1px solid #155e75; border-radius: 999px; background: rgba(8,47,73,.92); box-shadow: 0 6px 18px rgba(0,0,0,.4); animation: fade-rise .18s ease; font-size: 11px; }
.agent-scroll-bottom:hover { background: #0e7490; color: #fff; }
@keyframes fade-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

/* 常用指令 */
.agent-quick-prompt { display: flex; align-items: center; gap: 7px; padding: 8px 10px; color: #d4d4d8; border: 1px solid #303641; border-radius: 8px; background: #181c23; font-size: 12px; text-align: left; transition: border-color .15s ease, background .15s ease; }
.agent-quick-prompt:hover { border-color: #155e75; background: #10151c; }

/* 日志挂载弹层 */
.agent-composer { position: relative; }
.agent-log-panel { position: absolute; bottom: calc(100% + 8px); left: 8px; right: 8px; z-index: 20; max-height: min(62vh, 480px); overflow-y: auto; padding: 12px 14px; border: 1px solid #303641; border-radius: 10px; background: #151920; box-shadow: 0 14px 40px rgba(0,0,0,.5); }
.agent-log-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; color: #d4d4d8; font-size: 12px; font-weight: 700; }
.agent-log-btn { display: inline-flex; align-items: center; gap: 4px; color: #71717a; font-size: 11px; transition: color .15s ease; }
.agent-log-btn:hover { color: #67e8f9; }
.agent-log-btn.active { color: #22d3ee; }
.agent-log-btn em { min-width: 16px; padding: 0 4px; color: #a5f3fc; border-radius: 999px; background: #164e63; font-size: 10px; font-style: normal; text-align: center; }
.agent-session-edit:hover { color: #67e8f9; }
.agent-session-rename { min-width: 0; flex: 1; margin: 6px; padding: 5px 7px; color: #f4f4f5; border: 1px solid #155e75; border-radius: 5px; background: #11151b; font-size: 12px; outline: none; }
.agent-trace { margin-top: 10px; }
.agent-trace-toggle { display: inline-flex; align-items: center; gap: 5px; color: #71717a; font-size: 10px; }
.agent-trace-toggle:hover { color: #67e8f9; }
.agent-trace-toggle span { min-width: 16px; padding: 1px 4px; color: #a5f3fc; border-radius: 10px; background: #164e63; text-align: center; }
.agent-trace-list { display: grid; gap: 5px; margin-top: 7px; padding: 8px 10px; border-left: 2px solid #155e75; background: rgba(17,21,27,.55); }
.agent-trace-list div { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 7px; font-size: 10px; line-height: 1.5; }
.agent-trace-list b { color: #67e8f9; font-weight: 500; }
.agent-trace-list span { color: #a1a1aa; }
.agent-trace-list small { grid-column: 2; overflow-wrap: anywhere; color: #52525b; }

/* 大屏:让对话内容更充分使用横向空间 */
@media (min-width: 1600px) {
  .agent-messages { padding-left: clamp(24px, 5vw, 76px); padding-right: clamp(24px, 5vw, 76px); }
  .agent-message { max-width: min(1040px, 96%); }
}
@media (min-width: 2200px) {
  .agent-message { max-width: min(1240px, 94%); }
}
.agent-welcome { width: 100%; grid-template-columns: minmax(0, 1fr); }
.agent-welcome p { color: var(--color-surface-400); }
.agent-welcome-art { width: 220px; margin: -22px 0 -14px; }
.agent-welcome .agent-prompts { display: grid; grid-template-columns: minmax(0, 1fr); width: min(100%, 430px); gap: 8px; }
.agent-start-card { display: flex; width: 100%; align-items: center; gap: 12px; padding: 12px 14px; text-align: left; border: 1px solid var(--line-subtle); border-radius: 12px; background: linear-gradient(120deg, rgba(148,163,184,.05), transparent); transition: border-color 160ms ease, background-color 160ms ease; }
.agent-start-card span { min-width: 0; flex: 1; }
.agent-start-card strong { display: block; color: var(--color-surface-200); font-size: 12px; font-weight: 550; }
.agent-start-card small { display: block; color: var(--color-surface-400); font-size: 11px; margin-top: 3px; line-height: 1.5; }
.agent-start-icon { width: 18px; height: 18px; color: #6ee7b7; stroke-width: 1.6; flex: none; }
.agent-start-arrow { width: 14px; height: 14px; color: var(--color-surface-500); flex: none; transition: transform 160ms ease; }
.agent-start-card:focus-visible { outline: 2px solid var(--color-status-info); outline-offset: 3px; }
@media (hover: hover) { .agent-start-card:hover { border-color: rgba(110,231,183,.3); background-color: rgba(110,231,183,.04); }.agent-start-card:hover .agent-start-arrow { transform: translateX(3px); } }
@media (max-width: 639px) {
  .agent-welcome { grid-template-columns: 60px minmax(0, 1fr); align-content: start; align-items: center; text-align: left; gap: 8px; }
  .agent-welcome-art { width: 60px; margin: 0; }
  .agent-welcome h2 { margin: 0; justify-self: start; font-size: 14px; }
  .agent-welcome > p { display: none; }
  .agent-welcome .agent-prompts { grid-column: 1 / -1; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 0; }
  .agent-start-card { flex-direction: column; gap: 6px; min-height: 64px; padding: 10px 4px; text-align: center; }
  .agent-start-card strong { font-size: 11px; }
  .agent-start-card small, .agent-start-arrow { display: none; }
}
@media (prefers-reduced-motion: reduce) { .agent-start-card, .agent-start-arrow { transition: none; }.agent-start-card:hover .agent-start-arrow { transform: none; } }

.agent-session-feedback { display:flex; align-items:center; gap:.5rem; padding:.65rem 1rem; color:var(--color-status-ok); background:rgb(16 185 129 / .055); border-bottom:1px solid rgb(16 185 129 / .16); font-size:.75rem; }
.agent-session-feedback > span { min-width:0; flex:1; }
.agent-session-feedback > button { padding:.25rem; }
.agent-history-state { display:flex; min-height:13rem; flex-direction:column; align-items:center; justify-content:center; gap:.8rem; text-align:center; color:var(--color-surface-400); font-size:.8rem; line-height:1.6; }
.agent-history-state h2 { color:var(--color-surface-100); font-size:.95rem; }
.agent-history-state small { font-size:.7rem; }
.agent-history-error { margin:.65rem 0; color:var(--color-status-error); font-size:.75rem; line-height:1.6; }
.agent-delete-targets { max-height:10rem; overflow:auto; padding:.5rem; border:1px solid var(--color-surface-800); border-radius:.5rem; font-size:.75rem; }
.agent-delete-targets li { padding:.3rem 0; overflow-wrap:anywhere; }
.agent-sessions { border-radius:.9rem; }
.agent-chat { border-radius:.9rem; }
@media(max-width:760px) { .agent-mobile-sheet { display:flex; flex-direction:column; height:min(36rem,78dvh); } .agent-mobile-sheet > .session-browser { min-height:0; flex:1; } }
.agent-input-wrap { position: relative; }.agent-input-wrap .agent-input { padding-right: 46px; }.agent-input-wrap .agent-voice-btn { bottom: 9px; right: 9px; }
.agent-header-actions { display: flex; align-items: center; gap: 6px; order: 2; }
.agent-session-settings-toggle { display: none; }
.agent-session-options { margin-left: auto; }
@media (max-width: 760px) {
  .agent-page > .page-header { display: flex; flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px; padding-bottom: 0; }
  .agent-page .page-title { font-size: 17px; }
  .agent-header-actions { margin-left: auto; order: 0; }
  .agent-session-settings-toggle { display: inline-flex; }
  .agent-session-options { display: none; flex: 0 0 100%; margin: 0; padding: 10px; border: 1px solid var(--line-subtle); border-radius: 10px; background: var(--color-surface-975); }
  .agent-session-options.is-open { display: flex; }
  .agent-chat { min-height: 340px; }
  .agent-messages { min-height: 64px; padding: 12px; }
  .agent-composer { min-height: 130px; max-height: 52dvh; flex: 0 1 auto; overflow-y: auto; padding: 10px; }
  .agent-log-panel { position: static; margin-bottom: 9px; max-height: 220px; }
  .agent-input { height: 62px; min-height: 48px; }
  .agent-composer-hint { display: none; }
  .agent-composer-foot > span { max-width: none; }
  .agent-chat-head { padding: 9px 10px; }
}
</style>
