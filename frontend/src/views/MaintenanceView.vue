<template>
  <div class="page-shell" :aria-busy="busy || loading">
    <header class="page-header">
      <div>
        <h1 class="page-title">完整备份</h1>
        <p class="page-subtitle">镜像检查、应用完整备份、隔离恢复与异地同步</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          v-if="!plan && tab === 'containers'"
          class="btn-secondary"
          @click="openProxySettings"
        >
          代理设置
        </button>
        <button
          v-if="!plan && tab === 'containers'"
          class="btn-secondary"
          :disabled="loading"
          @click="checkingUpdates ? stopUpdateChecks() : checkUpdates(true)"
        >
          <RefreshCw
            v-if="checkingUpdates"
            class="h-4 w-4 animate-spin motion-reduce:animate-none"
          />
          {{ checkingUpdates ? '停止检查' : '重新检查镜像' }}</button
        ><button class="btn-secondary" :disabled="loading || busy" @click="refresh">
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新
        </button>
      </div>
    </header>
    <p v-if="error" class="alert-error break-words" role="alert">{{ error }}</p>
    <p v-if="notice" class="text-sm text-accent" role="status" aria-live="polite">{{ notice }}</p>
    <p v-if="loading" class="sr-only" role="status">正在加载运维信息</p>
    <p v-if="preparing" class="text-sm text-muted" role="status" aria-live="polite">
      正在预检完整范围；已暂停本页镜像检查，等待所选应用工作区空闲…
    </p>

    <details class="section-panel mb-4" @toggle="scopeVisible = $event.target.open"><summary class="cursor-pointer text-sm">只读查看应用备份范围</summary><FullBackupPlanPanel v-if="scopeVisible" class="mt-4" /></details>
    <template v-if="plan">
      <div class="flex items-center justify-between gap-3">
        <h2 class="section-title">
          完整备份确认
        </h2>
        <button class="btn-ghost" :disabled="busy" @click="plan = null">返回列表</button>
      </div>
      <section class="section-panel space-y-4">
        <div>
          <h3 class="section-title">备份保存路径</h3>
          <label class="mt-3 block text-sm"
            >当前节点的宿主机目录<input
              v-model="backupPath"

              class="input mt-2 w-full"
              aria-label="本次备份保存路径"
          /></label>
          <p class="mt-2 break-all text-xs text-muted">本次清单使用：{{ plan.backupPath }}</p>
          <button
            class="btn-secondary mt-3"
            :disabled="busy"
            @click="
              prepare(
                plan.action,
                plan.selected.map((c) => c.id)
              )
            "
          >
            重新预检路径及范围
          </button>
        </div>
        <label v-if="plan.action === 'backup'" class="flex items-center gap-2 text-sm"
          ><input v-model="makeDefault" type="checkbox" />同时设为默认保存路径</label
        >
      </section>
      <section class="section-panel space-y-3">
        <h3 class="section-title">完整范围 · {{ plan.members.length }} 个容器</h3>
        <p class="text-sm break-words">{{ plan.members.map((c) => c.name).join('、') }}</p>
        <p v-if="plan.members.length > plan.selected.length" class="text-sm text-amber-400">已自动纳入同应用关联容器，一起协调停写。</p>
        <ul class="space-y-2 text-sm">
          <li>部署配置、全部 env / secret 引用及构建资料</li>
          <li>宿主机目录和单文件挂载、命名卷及匿名卷</li>
          <li>原始镜像、容器可写层镜像、网络及完整容器重建参数</li>
          <li>属主、权限、ACL、扩展属性、软硬链接与恢复清单</li>
        </ul>
        <details>
          <summary class="text-sm text-accent">查看具体路径和数据卷</summary>
          <ul class="mt-3 space-y-1 text-xs text-muted">
            <li v-for="source in plan.sources" :key="source.kind + source.source" class="break-all">
              {{ source.kind === 'volume' ? 'Docker 卷' : '宿主机路径' }}：{{ source.source }}
            </li>
          </ul>
        </details>
      </section>
      <section class="section-panel space-y-3">
        <h3 class="section-title">停机与空间影响</h3>
        <p class="text-sm">{{ plan.downtime }}</p>
        <p class="text-sm">
          预计原始备份量 {{ bytes(plan.estimatedBytes) }}；可用空间
          {{ bytes(plan.freeBytes) }}。镜像先保存，再进入数据停机归档。
        </p>
        <p class="text-sm">
          所有原运行容器必须干净退出，备份后恢复原启停状态并检查健康。无法覆盖的项会阻止执行。
        </p>
        <p class="text-sm">
          每个文件使用 AES-256-GCM 加密并解密读回校验；文件校验通过后仍需另做实际恢复演练。
        </p>
        <ul class="space-y-2 text-xs text-muted">
          <li v-for="warning in plan.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </section>
      <section v-if="plan.blockers.length" class="alert-error" role="alert">
        <h3>预检未通过，不能开始</h3>
        <ul class="mt-2 list-disc pl-5">
          <li v-for="blocker in plan.blockers" :key="blocker">{{ blocker }}</li>
        </ul>
      </section>
      <section v-if="plan.action === 'backup'" class="section-panel space-y-4">
        <a
          class="btn-secondary inline-flex"
          href="/api/v1/maintenance/recovery-key"
          download="composeops-recovery.key"
          ><Download class="h-4 w-4" />下载恢复密钥</a
        >
        <p class="text-xs text-muted">
          密钥应单独保存到本机或密码管理器，不放进备份目录或同一网盘。丢失密钥无法解密备份。
        </p>
        <label class="flex items-start gap-2 text-sm"
          ><input v-model="keySaved" type="checkbox" class="mt-1" />恢复密钥已单独保存</label
        >
        <label class="flex items-start gap-2 text-sm"
          ><input
            v-model="confirmed"
            type="checkbox"
            class="mt-1"
          />已确认完整范围及停机影响，并确保没有其他程序继续写入</label
        >
        <button class="btn-primary" :disabled="!canExecute" @click="execute">
          <Archive class="h-4 w-4" />{{
            busy ? '提交中…' : '开始完整备份'
          }}
        </button>
      </section>
    </template>

    <template v-else>
      <div class="tabs flex-wrap" role="tablist" aria-label="运维页签">
        <button
          v-for="item in tabs"
          :id="'maintenance-tab-' + item.id"
          :key="item.id"
          role="tab"
          :class="{ active: tab === item.id }"
          :aria-selected="tab === item.id"
          aria-controls="maintenance-panel"
          @click="setTab(item.id)"
          @keydown="tabKeydown"
        >
          {{ item.name }}
        </button>
      </div>
      <div
        id="maintenance-panel"
        role="tabpanel"
        :aria-labelledby="'maintenance-tab-' + tab"
        class="space-y-5"
      >
        <template v-if="tab === 'containers'">
          <div class="toolbar-panel maintenance-filters">
            <label class="search-field"><Search class="h-4 w-4" /><input
              v-model="query"
              placeholder="搜索容器、应用或镜像"
              aria-label="搜索容器、应用或镜像"
            /></label>
            <select v-model="updateFilter" class="input sm:w-40" aria-label="镜像更新筛选">
              <option value="all">全部应用</option>
              <option value="updatable">可更新</option>
            </select>
            <label class="toggle-label whitespace-nowrap"><input type="checkbox"
              :checked="allSelected" :indeterminate.prop="someSelected && !allSelected"
              :disabled="!selectable.length || busy" @change="toggleSelection($event.target.checked)"
            />选择当前应用</label>
            <span class="ml-auto whitespace-nowrap text-muted" role="status">显示 {{ maintenanceGroups.length }} / {{ allMaintenanceGroups.length }} 个应用</span>
            <label v-if="helperCount" class="toggle-label whitespace-nowrap text-muted">
              <input v-model="showHelpers" type="checkbox" />显示辅助容器（{{ helperCount }}）
            </label>
          </div>
          <div class="maintenance-check-summary" role="status" aria-live="polite">
            <span v-if="checkingUpdates" class="flex items-center gap-2">
              <RefreshCw class="h-4 w-4 animate-spin motion-reduce:animate-none" />
              正在检查镜像 · 已完成 {{ updateProgress.done }} / {{ updateProgress.total }} 个应用
            </span>
            <span v-else>{{ checkSummary }}</span>
            <span class="text-xs text-muted"
              >{{ proxyUrl ? '通过代理检查镜像' : '直连检查镜像，可配置代理' }} ·
              只检查，不拉取或重建容器</span
            >
          </div>
          <div class="section-panel flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-4">
              <span class="text-xs text-muted">当前列表已选 {{ selectedGroupCount }} 个应用 · {{ selectedForAction.length }} 个容器</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                class="btn-secondary"
                :disabled="busy || !selectedForAction.length"
                @click="prepare('backup', selectedForAction)"
              >
                备份所选应用</button
              >
            </div>
          </div>
          <div class="maintenance-groups" aria-label="Compose 运维列表">
            <article
              v-for="group in maintenanceGroups"
              :key="group.key"
              class="maintenance-group"
              :class="{ 'maintenance-group-expanded': groupExpanded(group), 'maintenance-selected': groupSomeSelected(group) }"
              :aria-label="group.name + ' 运维'"
            >
              <header class="maintenance-group-header">
                <input
                  type="checkbox"
                  :checked="groupSelected(group)"
                  :indeterminate.prop="groupSomeSelected(group) && !groupSelected(group)"
                  :disabled="!!groupReason(group)"
                  :aria-label="'选择应用 ' + group.name"
                  :title="groupReason(group)"
                  @change="toggleGroupSelection(group, $event.target.checked)"
                />
                <button
                  type="button"
                  class="maintenance-group-toggle"
                  :aria-expanded="groupExpanded(group)"
                  :aria-controls="'maintenance-group-' + group.key"
                  :aria-label="(groupExpanded(group) ? '收起 ' : '展开 ') + group.name"
                  @click="toggleGroup(group)"
                >
                  <Layers class="maintenance-group-icon h-5 w-5" />
                  <span class="maintenance-group-identity">
                    <span class="maintenance-group-name" :title="group.name">{{ group.name }}</span>
                    <span class="text-xs text-muted">{{ group.kind }} · {{ group.members.length }} 个容器</span>
                  </span>
                  <span class="maintenance-group-summary">
                    <span :class="group.members.some((c) => updates[c.id]?.hasUpdate) ? 'text-amber-400' : 'text-muted'">
                      {{ groupUpdateLabel(group) }}
                    </span>
                    <span class="maintenance-state" :class="group.members.every((c) => c.state === 'running') ? 'maintenance-running' : 'text-muted'">
                      <span class="maintenance-state-dot" aria-hidden="true"></span>{{ groupRuntimeLabel(group) }}
                    </span>
                  </span>
                  <ChevronDown class="maintenance-group-chevron h-4 w-4" :class="{ 'rotate-180': groupExpanded(group) }" />
                </button>
                <div class="maintenance-row-actions">
                  <button
                    class="btn-secondary"
                    :disabled="busy || !!groupReason(group)"
                    :title="groupReason(group) || '完整备份整个 Compose'"
                    @click="prepare('backup', groupIds(group))"
                  >备份</button>
                </div>
              </header>
              <div v-if="groupExpanded(group)" :id="'maintenance-group-' + group.key" class="maintenance-table-wrap">
                <table class="data-table maintenance-table" :aria-label="group.name + ' 容器明细'">
                  <colgroup><col /><col class="maintenance-col-update" /></colgroup>
                  <thead><tr><th>容器 / 当前镜像</th><th class="maintenance-status-heading">更新 / 状态</th></tr></thead>
                  <tbody>
                    <tr v-for="container in group.members" :key="container.id">
                      <td class="maintenance-main-cell">
                        <p class="maintenance-container-name" :title="container.name">{{ container.name }}</p>
                        <p class="maintenance-container-image text-muted" :title="container.image">{{ container.image }}</p>
                      </td>
                      <td class="maintenance-status-cell">
                        <div class="maintenance-update-cell">
                          <button
                            type="button"
                            class="maintenance-update-label"
                            :class="updates[container.id]?.hasUpdate ? 'text-amber-400' : 'text-muted'"
                            :title="updateDetail(container)"
                            :aria-label="container.name + '：' + updateLabel(container) + '，查看详情'"
                            @click="updateTarget = container"
                          >{{ updateLabel(container) }}</button>
                          <span class="maintenance-state" :class="container.state === 'running' ? 'maintenance-running' : 'text-muted'">
                            <span class="maintenance-state-dot" aria-hidden="true"></span>{{ stateLabel(container.state) }}
                          </span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </article>
            <p v-if="!maintenanceGroups.length && !loading" class="p-6 text-center text-sm text-muted" role="status">{{ updateFilter === 'updatable' ? (checkingUpdates ? '正在检查镜像，可更新的应用会陆续显示' : '没有符合条件的可更新应用') : '没有匹配应用或容器' }}</p>
          </div>
          <p class="text-xs text-muted">
            镜像检查只报告更新状态；更新需前往项目完成发布评审。完整备份需单独预检并确认停机范围，成功后恢复原启停状态并检查健康。面板自身、临时辅助容器或无法完整保存的数据会在备份预检中明确阻止。
          </p>
        </template>

        <template v-if="tab === 'backups'">
          <section class="section-panel space-y-3">
            <h2 class="section-title">默认备份保存路径</h2>
            <label class="block text-sm"
              >当前节点的宿主机目录<input
                v-model="backupPath"
                class="input mt-2 w-full"
                aria-label="默认备份保存路径"
                placeholder="/vol1/1000/backups/composeops"
            /></label>
            <p class="text-xs text-muted">
              目录必须已存在且可写。只保存后续备份，不会移动旧备份；不能与备份源重叠。
            </p>
            <button class="btn-secondary" :disabled="busy || !backupPath" @click="savePath">
              检查并保存
            </button>
          </section>
          <section class="section-panel space-y-3">
            <h2 class="section-title">备份加密与恢复密钥</h2>
            <p class="text-sm text-muted">恢复密钥由面板自动生成并持久保存，用于解密完整备份。请另外下载保存一份，并存放在备份介质之外。</p>
            <a class="btn-secondary inline-flex" href="/api/v1/maintenance/recovery-key" download="composeops-recovery.key"><Download class="h-4 w-4" />下载恢复密钥</a>
          </section>
          <section v-for="backup in data.backups" :key="backup.id" class="section-panel space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 class="section-title">{{ backup.names.join('、') }}</h3>
                <p class="text-xs text-muted mt-1">
                  {{ time(backup.createdAt) }} · {{ bytes(backup.bytes) }}
                </p>
              </div>
              <span class="status-badge text-accent">完整备份 · 文件校验通过</span>
            </div>
            <p class="break-all text-xs text-muted">{{ backup.path }}</p>
            <p class="text-xs text-muted">
              覆盖配置、挂载、全部卷、镜像、可写层及恢复清单；尚未验证实际恢复。
            </p>
            <button
              class="btn-secondary"
              :disabled="busy || !targets.some((t) => t.tested)"
              @click="openSync(backup)"
            >
              同步此备份
            </button>
            <button class="btn-secondary ml-2" :disabled="busy" @click="openRestore(backup)">隔离恢复</button>
          </section>
          <p v-if="!data.backups.length && !loading" class="text-sm text-muted">
            暂无已完成且校验通过的完整备份。未完成的备份只在任务记录中显示。
          </p>
        </template>

        <template v-if="tab === 'sync'">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="section-title">同步目标</h2>
              <p class="mt-1 text-xs text-muted">完整备份产物单向推送；应用恢复运行后上传</p>
            </div>
            <button class="btn-primary" :disabled="busy" @click="editTarget()">
              <Plus class="h-4 w-4" />添加目标
            </button>
          </div>
          <section v-for="target in targets" :key="target.id" class="section-panel space-y-3">
            <div class="flex flex-wrap justify-between gap-3">
              <div>
                <h3 class="section-title">
                  {{ target.name }}
                  <span class="text-xs text-muted">{{
                    target.type === '115' ? '115 官方直连' : 'WebDAV'
                  }}</span>
                </h3>
                <p class="mt-1 text-xs text-muted break-all">{{ target.remotePath }}</p>
              </div>
              <div class="flex flex-wrap gap-2">
                <button class="btn-secondary" :disabled="busy" @click="editTarget(target)">
                  编辑</button
                ><button
                  class="btn-secondary"
                  :disabled="busy || !target.authorized"
                  @click="testTarget(target)"
                >
                  测试连接</button
                ><button
                  v-if="target.type === '115'"
                  class="btn-secondary"
                  :disabled="busy"
                  @click="authorize(target)"
                >
                  {{ target.authorized ? '重新授权' : '扫码授权 115' }}
                </button>
              </div>
            </div>
            <p class="text-xs" :class="target.tested ? 'text-accent' : 'text-amber-400'">
              {{
                target.tested
                  ? '上传及远端校验已通过'
                  : target.authorized
                    ? '已配置认证，待测试上传权限'
                    : '尚未授权或配置密码'
              }}
            </p>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <label class="flex gap-2 items-center text-sm"
                ><input
                  type="checkbox"
                  :checked="target.auto"
                  :disabled="busy || !target.tested"
                  @change="automatic(target, $event.target.checked)"
                />备份成功后自动同步</label
              ><button
                class="btn-primary"
                :disabled="busy || !target.tested || !data.backups.length"
                @click="openSync(null, target)"
              >
                立即同步
              </button>
            </div>
          </section>
          <p v-if="!targets.length" class="text-sm text-muted">尚未配置同步目标。</p>
          <p class="text-xs text-muted">
            保留本地副本。按节点和备份批次保存，失败可独立重试；只有全部文件通过远端校验才显示同步成功。测试连接会写入独立测试文件。
          </p>
        </template>

        <template v-if="tab === 'tasks'">
          <p class="text-xs text-muted">
            在此查看完整备份、隔离恢复、同步及原运行状态恢复的任务记录。
          </p>
          <section v-for="task in data.tasks" :key="task.id" class="section-panel space-y-2">
            <div class="flex flex-wrap justify-between gap-2">
              <h3 class="section-title">
                {{ actionLabel(task.action) }} · {{ task.names.join('、') }}
              </h3>
              <span
                class="status-badge"
                :class="
                  task.status === 'success'
                    ? 'text-accent'
                    : ['failed', 'interrupted'].includes(task.status)
                      ? 'text-rose-400'
                      : 'text-amber-400'
                "
                >{{ taskLabel(task.status) }}</span
              >
            </div>
            <p class="text-sm break-words">{{ task.stage }}<span v-if="task.result?.root" class="block break-all text-xs mt-2">恢复目录：{{ task.result.root }} · {{ task.result.started ? '副本已启动' : '副本未启动' }} · 业务验收待执行</span></p>
            <p class="text-xs text-muted">{{ time(task.createdAt) }}</p>
            <p v-if="task.backupPath" class="break-all text-xs text-muted">{{ task.backupPath }}</p>
            <button
              v-if="
                ['failed', 'interrupted'].includes(task.status) && task.originallyRunning?.length
              "
              class="btn-secondary"
              :disabled="busy"
              @click="recoverTarget = task"
            >
              恢复原运行容器</button
            ><button
              v-if="
                task.action === 'sync' &&
                task.status === 'failed' &&
                targets.some((t) => t.id === task.targetId)
              "
              class="btn-secondary"
              :disabled="busy"
              @click="
                openSync(
                  null,
                  targets.find((t) => t.id === task.targetId)
                )
              "
            >
              重新选择备份并重试
            </button>
          </section>
          <p v-if="!data.tasks.length && !loading" class="text-sm text-muted">暂无任务记录。</p>
          <details class="section-panel" @toggle="legacyOpen = $event.target.open">
            <summary class="text-sm text-accent">原定时运维计划、Agent 后台任务与巡检</summary>
            <p class="mt-3 text-xs text-muted">
              原定时“数据卷备份”只备份命名卷，不属于本页的完整备份。
            </p>
            <OperationsCenterView v-if="legacyOpen" embedded />
          </details>
        </template>
      </div>
    </template>

    <BaseModal :show="!!restoreTarget" title="隔离恢复完整备份" :close-disabled="busy" @close="restoreTarget = null">
      <div class="p-4 space-y-4">
        <p class="text-sm text-muted">在指定父目录下新建唯一恢复目录。数据卷重映射为独立目录，网络与端口隔离，不覆盖原应用。</p>
        <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
        <label class="block text-sm">已存在的宿主机父目录<input v-model="restoreDirectory" class="input mt-2 w-full" placeholder="/srv/restore" /></label>
        <button class="btn-secondary" :disabled="busy || !restoreDirectory" @click="previewRestore">校验备份并预览映射</button>
        <template v-if="restorePlan">
          <p class="text-xs break-all">新目录：{{ restorePlan.root }}</p>
          <ul class="space-y-2 text-xs"><li v-for="entry in restorePlan.mappings" :key="entry.file" class="break-all">{{ entry.source }} → {{ entry.target }}</li></ul>
          <p v-for="blocker in restorePlan.blockers" :key="blocker" class="alert-error">{{ blocker }}</p>
          <label class="flex gap-2 text-sm"><input v-model="restoreStart" type="checkbox" />在隔离网络中启动原先运行的服务并检查状态</label>
          <p class="text-xs text-muted">默认只创建停止的副本。启动检查不代表业务恢复验收；业务 SQL / HTTP 验证请使用可靠性页面的业务恢复演练。</p>
          <label class="flex gap-2 text-sm"><input v-model="restoreConfirmed" type="checkbox" />确认上述新目录与隔离副本范围</label>
          <button class="btn-primary" :disabled="busy || !restoreConfirmed || restorePlan.blockers.length" @click="executeRestore">执行隔离恢复</button>
        </template>
      </div>
    </BaseModal>
    <BaseModal :show="!!updateTarget" title="镜像检查详情" @close="updateTarget = null">
      <div v-if="updateTarget" class="p-4 space-y-4">
        <div>
          <p class="font-medium break-all">{{ updateTarget.name }}</p>
          <p class="mt-1 text-xs text-muted break-all">{{ updateTarget.image }}</p>
        </div>
        <p class="text-sm">{{ updateDetail(updateTarget) }}</p>
        <p v-if="updates[updateTarget.id]?.checkedAt" class="text-xs text-muted">
          检查于 {{ time(updates[updateTarget.id].checkedAt) }}
        </p>
        <button
          v-if="updates[updateTarget.id]?.status === 'failed' && !checkingUpdates"
          class="btn-secondary"
          @click="retryUpdateTarget"
        >
          重试
        </button>
      </div>
    </BaseModal>
    <BaseModal
      :show="proxyOpen"
      title="镜像检查代理"
      :close-disabled="proxyBusy"
      @close="proxyOpen = false"
    >
      <form class="p-4 space-y-4" @submit.prevent="saveProxy">
        <label class="block text-sm"
          >HTTP / HTTPS 代理地址
          <input
            v-model="proxyDraft"
            class="input mt-2 w-full"
            aria-label="镜像检查代理地址"
            placeholder="http://host.docker.internal:7890"
            :disabled="proxyBusy"
          />
        </label>
        <p class="text-xs text-muted">
          留空表示直连。访问宿主机代理可使用 host.docker.internal；容器中的 127.0.0.1 指向面板自身。
        </p>
        <p class="text-xs text-muted">
          此配置用于镜像查询及仓库授权。实际拉取镜像沿用宿主机 Docker 的网络设置。
        </p>
        <p v-if="proxyError" class="alert-error" role="alert">{{ proxyError }}</p>
        <ul v-if="proxyTest" class="space-y-2 text-sm" role="status">
          <li
            v-for="result in proxyTest.results"
            :key="result.name"
            :class="result.ok ? 'text-accent' : 'text-amber-400'"
          >
            {{ result.name }}：{{ result.ok ? '授权及镜像清单读取成功' : result.message }} ·
            {{ (result.milliseconds / 1000).toFixed(1) }} 秒
          </li>
        </ul>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn-secondary" :disabled="proxyBusy" @click="testProxy">
            {{ proxyBusy ? '处理中…' : '测试连接' }}
          </button>
          <button type="submit" class="btn-primary" :disabled="proxyBusy">保存并重新检查</button>
        </div>
      </form>
    </BaseModal>
    <BaseModal :show="!!draft" title="同步目标配置" size-class="sm:max-w-2xl" @close="draft = null">
      <form v-if="draft" class="p-4 space-y-4" @submit.prevent="saveTarget">
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="text-sm"
            >目标名称<input v-model="draft.name" class="input mt-2 w-full" required /></label
          ><label class="text-sm"
            >目标类型<select v-model="draft.type" class="input mt-2 w-full">
              <option value="115">115 网盘（官方直连）</option>
              <option value="webdav">WebDAV</option>
            </select></label
          >
        </div>
        <template v-if="draft.type === '115'"
          ><label class="block text-sm"
            >115 开放平台 Client ID<input
              v-model="draft.clientId"
              class="input mt-2 w-full"
              inputmode="numeric"
              required
          /></label>
          <p class="text-xs text-muted">
            使用你在 115 开放平台申请的应用，保存后在面板中扫码授权，不需要输入 115 密码。
          </p></template
        >
        <template v-else
          ><label class="block text-sm"
            >WebDAV 服务地址<input
              v-model="draft.url"
              type="url"
              class="input mt-2 w-full"
              placeholder="https://dav.example.com/dav"
              required
          /></label>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="text-sm"
              >用户名<input
                v-model="draft.user"
                class="input mt-2 w-full"
                autocomplete="off"
                required /></label
            ><label class="text-sm"
              >密码 / 应用专用密码<input
                v-model="draft.password"
                type="password"
                class="input mt-2 w-full"
                autocomplete="new-password"
                :placeholder="draft.authorized ? '留空保留已保存密码' : ''"
            /></label></div
        ></template>
        <label class="block text-sm"
          >远端保存目录<input
            v-model="draft.remotePath"
            class="input mt-2 w-full"
            placeholder="/ComposeOps"
            required
        /></label>
        <p class="text-xs text-muted">保存修改后需重新测试连接。自动同步开关在测试成功后开启。</p>
        <div class="flex justify-end gap-2">
          <button class="btn-ghost" type="button" @click="draft = null">取消</button
          ><button class="btn-primary" type="submit" :disabled="busy">保存目标</button>
        </div>
      </form>
    </BaseModal>
    <BaseModal :show="!!authSession" title="115 官方扫码授权" @close="stopAuth">
      <div v-if="authSession" class="p-5 space-y-4 text-center">
        <img :src="authSession.qrImage" alt="115 授权二维码" class="mx-auto h-60 w-60 max-w-full" />
        <p class="text-sm" role="status" aria-live="polite">{{ authMessage }}</p>
        <p class="text-xs text-muted">使用 115 App 扫码并确认授权，二维码约三分钟有效。</p>
        <button class="btn-secondary" @click="stopAuth">关闭</button>
      </div>
    </BaseModal>
    <BaseModal :show="!!syncChoice" title="确认同步范围" @close="syncChoice = null">
      <div v-if="syncChoice" class="p-4 space-y-4">
        <label class="block text-sm"
          >同步目标<select v-model="syncChoice.targetId" class="input mt-2 w-full">
            <option
              v-for="target in targets.filter((t) => t.tested)"
              :key="target.id"
              :value="target.id"
            >
              {{ target.name }}
            </option>
          </select></label
        >
        <p class="text-sm">
          推送
          {{ syncChoice.backupIds.length }}
          份完整备份到所选目标，包含加密配置、镜像、数据和恢复清单。本地副本保留。
        </p>
        <p class="text-xs text-muted break-all">
          {{ targets.find((t) => t.id === syncChoice.targetId)?.remotePath }}
        </p>
        <button class="btn-primary" :disabled="busy" @click="syncNow">确认并开始同步</button>
      </div>
    </BaseModal>
    <ConfirmDialog
      :show="!!recoverTarget"
      title="恢复备份前运行状态"
      message="只启动该次备份日志中原来运行、但尚未恢复的容器，不恢复或覆盖任何备份数据。请先确认没有其他人正在操作这些容器。"
      :busy="busy"
      confirm-text="恢复原运行容器"
      @cancel="recoverTarget = null"
      @confirm="recover"
    />
  </div>
</template>

<script setup>
import FullBackupPlanPanel from '../components/resources/FullBackupPlanPanel.vue';
import { computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Archive, ChevronDown, Download, Layers, Plus, RefreshCw, Search } from 'lucide-vue-next';
import { api } from '../api/client.js';
import BaseModal from '../components/common/BaseModal.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import OperationsCenterView from './OperationsCenterView.vue';

const tabs = [
  { id: 'containers', name: '容器运维' },
  { id: 'backups', name: '备份记录' },
  { id: 'sync', name: '同步' },
  { id: 'tasks', name: '任务记录' },
];
const route = useRoute(),
  router = useRouter();
const normalizeTab = (value) => (tabs.some((t) => t.id === value) ? value : 'containers');
const tab = ref(normalizeTab(route.query.tab));
const data = ref({ containers: [], backups: [], tasks: [], hostId: '', settings: {} });
const targets = ref([]),
  selected = ref([]),
  query = ref(''),
  updateFilter = ref('all'),
  backupPath = ref('');
const updates = ref({});
const updateTarget = ref(null);
const proxyUrl = ref(''),
  proxyDraft = ref(''),
  proxyOpen = ref(false),
  proxyBusy = ref(false),
  proxyError = ref(''),
  proxyTest = ref(null);
watch(proxyDraft, () => {
  proxyTest.value = null;
});
const showHelpers = ref(false),
  checkingUpdates = ref(false),
  updateProgress = ref({ done: 0, total: 0 }),
  checkSummary = ref('镜像检查将在列表加载后开始');
const updateControllers = new Set();
let updateGeneration = 0,
  checksStarted = false;
const plan = ref(null),
  confirmed = ref(false),
  keySaved = ref(false),
  makeDefault = ref(false),
  planStale = ref(false);
const busy = ref(false),
  preparing = ref(false),
  loading = ref(false),
  error = ref(''),
  notice = ref(''),
  draft = ref(null),
  syncChoice = ref(null),
  recoverTarget = ref(null),
  legacyOpen = ref(false);
const authSession = ref(null),
  authMessage = ref('等待扫码');
let pollTimer,
  authTimer,
  epoch = 0,
  viewActive = false,
  disposed = false;
const expandedGroups = ref(new Set());
const collapsedSearchGroups = ref(new Set());
const maintenanceGroupKey = (container) => container.helper ? 'helper-' + container.id
  : container.projectId ? 'project-' + container.projectId : 'container-' + container.id;
const allMaintenanceGroups = computed(() => {
  const groups = new Map();
  for (const container of data.value.containers) {
    if (container.helper && !showHelpers.value) continue;
    const key = maintenanceGroupKey(container);
    if (!groups.has(key)) groups.set(key, {
      key,
      name: container.helper ? container.name : container.projectName || container.name,
      kind: container.helper ? '辅助容器' : container.projectName ? 'Compose 应用' : '独立容器',
      members: [],
    });
    groups.get(key).members.push(container);
  }
  return [...groups.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
});
const maintenanceGroups = computed(() => {
  const search = query.value.trim().toLowerCase();
  return allMaintenanceGroups.value.filter(group =>
    (updateFilter.value !== 'updatable' || group.members.some(c => updates.value[c.id]?.hasUpdate === true)) &&
    (!search || group.members.some(c =>
      [c.name, c.image, c.projectName, c.service].filter(Boolean).join(' ').toLowerCase().includes(search))));
});
watch(query, () => { collapsedSearchGroups.value = new Set(); });
function groupExpanded(group) {
  return query.value.trim() ? !collapsedSearchGroups.value.has(group.key) : expandedGroups.value.has(group.key);
}
function toggleGroup(group) {
  const target = query.value.trim() ? collapsedSearchGroups : expandedGroups;
  const next = new Set(target.value);
  if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
  target.value = next;
}
function groupIds(group) { return group.members.map((c) => c.id); }
function groupReason(group) { return group.members.map(operationReason).find(Boolean) || ''; }
function groupSelected(group) { return group.members.every((c) => selected.value.includes(c.id)); }
function groupSomeSelected(group) { return group.members.some((c) => selected.value.includes(c.id)); }
function toggleGroupSelection(group, checked) {
  if (groupReason(group)) return;
  const ids = groupIds(group);
  selected.value = checked ? [...new Set([...selected.value, ...ids])] : selected.value.filter((id) => !ids.includes(id));
}
const selectedGroupCount = computed(() => new Set(selectable.value
  .filter((c) => selectedForAction.value.includes(c.id)).map(maintenanceGroupKey)).size);
function groupRuntimeLabel(group) {
  const running = group.members.filter((c) => c.state === 'running').length;
  if (running === group.members.length) return '全部运行中';
  if (!running) return group.members.every((c) => ['exited', 'created', 'stopped'].includes(c.state))
    ? '全部已停止' : '状态需关注';
  return running + ' / ' + group.members.length + ' 运行中';
}
function groupUpdateLabel(group) {
  const labels = group.members.map(updateLabel);
  const available = group.members.filter((c) => updates.value[c.id]?.hasUpdate).length;
  if (available) return available + ' 个可更新';
  if (labels.includes('检查中…')) return '检查中…';
  if (labels.includes('排队中')) return '排队中';
  if (labels.includes('检查失败')) return '检查失败';
  if (labels.every((label) => label === labels[0])) return labels[0];
  return '查看镜像状态';
}
const helperCount = computed(() => data.value.containers.filter((c) => c.helper).length);
const operationReason = (container) =>
  container.projectId && container.managed === false ? '项目尚未纳管，请先在设置中授权' : container.helper
    ? '临时辅助容器由面板管理，不参与业务备份和更新'
    : container.self
      ? '当前面板不能在自身内部完成停机备份或更新'
      : '';
const selectable = computed(() => maintenanceGroups.value.filter((group) => !groupReason(group)).flatMap((group) => group.members));
// 隐藏的选中项保留勾选，但批量动作只作用于当前筛选列表。
const selectedForAction = computed(() => selectable.value.filter(c => selected.value.includes(c.id)).map(c => c.id));
const allSelected = computed(
  () => !!selectable.value.length && selectable.value.every((c) => selected.value.includes(c.id))
);
const someSelected = computed(() => selectable.value.some((c) => selected.value.includes(c.id)));
function toggleSelection(checked) {
  const ids = selectable.value.map((c) => c.id);
  selected.value = checked
    ? [...new Set([...selected.value, ...ids])]
    : selected.value.filter((id) => !ids.includes(id));
}
const canExecute = computed(
  () =>
    !!plan.value &&
    !busy.value &&
    !planStale.value &&
    !plan.value.blockers.length &&
    plan.value.coverageVerified &&
    confirmed.value &&
    keySaved.value
);
async function load(quiet = false) {
  if (loading.value || disposed || !viewActive) return;
  loading.value = true;
  const current = epoch;
  try {
    const [overview, result] = await Promise.all([api.getMaintenance(), api.getSyncTargets()]);
    if (current !== epoch || disposed) return;
    data.value = overview;
    proxyUrl.value = overview.imageCheck?.proxyUrl || '';
    selected.value = selected.value.filter((id) =>
      overview.containers.some((c) => c.id === id && !operationReason(c))
    );
    for (const id of Object.keys(updates.value)) {
      const container = overview.containers.find((c) => c.id === id);
      if (!container || updates.value[id].imageRef !== container.image) delete updates.value[id];
    }
    targets.value = result.targets;
    if (!backupPath.value) backupPath.value = overview.settings.backupPath || '';
    if (!quiet) error.value = '';
  } catch (e) {
    if (current === epoch && !disposed) error.value = e.message;
  } finally {
    if (current === epoch) loading.value = false;
  }
}
async function perform(fn) {
  if (busy.value || !viewActive) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  const current = epoch;
  try {
    await fn(() => current === epoch && !disposed);
  } catch (e) {
    if (current === epoch && !disposed) error.value = e.message;
  } finally {
    if (current === epoch) busy.value = false;
  }
}
function setTab(value) {
  tab.value = value;
  router.replace({ query: { ...route.query, tab: value } });
}
watch(tab, (value) => {
  if (value === 'containers' && !checksStarted && data.value.containers.length)
    void checkUpdates(false);
});
watch(
  () => route.query.tab,
  (value) => {
    const next = normalizeTab(value);
    if (next === tab.value) return;
    tab.value = next;
    plan.value = null;
    confirmed.value = false;
    keySaved.value = false;
  }
);
function tabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const i = tabs.findIndex((t) => t.id === tab.value),
    next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  setTab(tabs[next].id);
  document.getElementById('maintenance-tab-' + tabs[next].id)?.focus();
}
let backupPlanRevision = 0;
function invalidatePlan() {
  backupPlanRevision++;
  planStale.value = true;
  confirmed.value = false;
}
watch(backupPath, invalidatePlan, { flush: 'sync' });
function prepare(action, ids) {
  if (busy.value) return;
  stopUpdateChecks();
  return perform(async (valid) => {
    preparing.value = true;
    const revision = backupPlanRevision;
    try {
      const result = await api.prepareMaintenance({
        action,
        containerIds: [...ids],
        backupPath: backupPath.value,
      });
      if (!valid()) return;
      if (revision !== backupPlanRevision) {
        notice.value = '目录已修改，请重新预检备份路径及范围。';
        return;
      }
      plan.value = result;
      planStale.value = false;
      confirmed.value = false;
      makeDefault.value = false;
    } finally {
      if (valid()) preparing.value = false;
    }
  });
}
function execute() {
  if (plan.value?.action !== 'backup' || !canExecute.value) return;
  return perform(async (valid) => {
    await api.executeMaintenance({
      token: plan.value.token,
      confirmed: true,
      keySaved: keySaved.value,
      makeDefault: makeDefault.value,
    });
    if (!valid()) return;
    plan.value = null;
    selected.value = [];
    notice.value = '任务已提交，完整备份执行器会独立运行。';
    setTab('tasks');
    await load(true);
  });
}
function savePath() {
  return perform(async (valid) => {
    await api.saveMaintenanceSettings(backupPath.value);
    if (valid()) {
      notice.value = '备份路径已检查并保存。';
      await load(true);
    }
  });
}
async function refresh() {
  await load();
  if (!disposed && tab.value === 'containers' && !checkingUpdates.value) void checkUpdates(false);
}
function openProxySettings() {
  proxyDraft.value = proxyUrl.value;
  proxyError.value = '';
  proxyTest.value = null;
  proxyOpen.value = true;
}
async function testProxy() {
  if (proxyBusy.value) return;
  proxyBusy.value = true;
  proxyError.value = '';
  proxyTest.value = null;
  const current = epoch;
  try {
    const result = await api.testImageCheckProxy({ proxyUrl: proxyDraft.value.trim() });
    if (!disposed && current === epoch) proxyTest.value = result;
  } catch (e) {
    if (!disposed && current === epoch) proxyError.value = e.message;
  } finally {
    if (current === epoch) proxyBusy.value = false;
  }
}
async function saveProxy() {
  if (proxyBusy.value) return;
  proxyBusy.value = true;
  proxyError.value = '';
  const current = epoch;
  try {
    const settings = await api.saveImageCheckSettings({ proxyUrl: proxyDraft.value.trim() });
    if (disposed || current !== epoch) return;
    stopUpdateChecks();
    updates.value = {};
    proxyUrl.value = settings.proxyUrl;
    proxyOpen.value = false;
    void checkUpdates(true);
  } catch (e) {
    if (!disposed && current === epoch) proxyError.value = e.message;
  } finally {
    if (current === epoch) proxyBusy.value = false;
  }
}
function stopUpdateChecks() {
  updateGeneration++;
  for (const controller of updateControllers) controller.abort();
  updateControllers.clear();
  checkingUpdates.value = false;
  for (const item of Object.values(updates.value)) {
    if (item.status === 'checking' || item.status === 'queued') item.status = 'cancelled';
  }
  checkSummary.value = '检查已停止，已完成的结果保留；可重新检查';
}
async function checkUpdates(force = false, projectId = null) {
  if (checkingUpdates.value || disposed || !viewActive) return;
  checksStarted = true;
  const current = ++updateGeneration,
    currentEpoch = epoch;
  const valid = () => !disposed && current === updateGeneration && currentEpoch === epoch;
  const members = data.value.containers.filter(
    (c) =>
      !c.helper &&
      c.projectId &&
      c.updateCheckAvailable !== false &&
      (!projectId || c.projectId === projectId)
  );
  const queue = [...new Set(members.map((c) => c.projectId))];
  updateProgress.value = { done: 0, total: queue.length };
  if (!queue.length) {
    checkSummary.value = '没有可检查的应用，请查看各行的配置或授权提示';
    return;
  }
  checkingUpdates.value = true;
  for (const c of members) updates.value[c.id] = { status: 'queued', imageRef: c.image };
  async function worker() {
    while (valid() && queue.length) {
      const id = queue.shift(),
        projectMembers = members.filter((c) => c.projectId === id);
      const controller = new AbortController();
      updateControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 35_000);
      const writeResult = (c, item) => {
        if (
          valid() &&
          data.value.containers.some((live) => live.id === c.id && live.image === c.image)
        )
          updates.value[c.id] = { ...item, imageRef: c.image };
      };
      for (const c of projectMembers) writeResult(c, { status: 'checking' });
      try {
        const result = await api.getProjectUpdates(id, force, { signal: controller.signal });
        for (const c of projectMembers) {
          const item = result.images?.find((image) => image.service === c.service);
          writeResult(
            c,
            item
              ? {
                  ...item,
                  ...item.containers?.find((member) => member.containerId === c.id),
                  reason: item.reason,
                  checkedAt: result.checkedAt,
                }
              : {
                  status: 'unresolved',
                  reason: result.error || 'Compose 中未找到此容器对应的服务镜像',
                  checkedAt: result.checkedAt,
                }
          );
        }
      } catch (error) {
        for (const c of projectMembers)
          writeResult(c, {
            status: 'failed',
            reason: controller.signal.aborted
              ? '检查超过 35 秒，请检查镜像仓库连接后重试'
              : error.message,
          });
      } finally {
        clearTimeout(timer);
        updateControllers.delete(controller);
        if (valid()) updateProgress.value.done++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
  if (!valid()) return;
  checkingUpdates.value = false;
  const results = members.map((c) => updates.value[c.id]);
  const failed = results.filter((i) => i?.status === 'failed').length;
  const available = results.filter((i) => i?.hasUpdate).length;
  checkSummary.value = `已检查 ${updateProgress.value.done} 个应用 · ${available} 个容器有更新${failed ? ` · ${failed} 个检查失败，可逐项重试` : ''}`;
}
function updateLabel(container) {
  if (container.helper) return '无需检查';
  if (!container.projectId) return '需 Compose 定义';
  if (container.updateCheckAvailable === false) return '目录不可用';
  const item = updates.value[container.id];
  if (!item) return '尚未检查';
  if (item.hasUpdate) return '可更新';
  return (
    {
      current: '已是最新',
      queued: '排队中',
      checking: '检查中…',
      cancelled: '待重新检查',
      up_to_date: '已是最新',
      pinned: '已固定',
      local_build: '本地构建',
      local_only: '本地镜像',
      not_deployed: '尚未部署',
      failed: '检查失败',
      unknown: '无法比较',
      unsupported: '需 Compose 定义',
      needs_policy: '需明确镜像策略',
      unresolved: '未解析',
    }[item.status] || '无法比较'
  );
}
function retryUpdateTarget() {
  const projectId = updateTarget.value?.projectId;
  updateTarget.value = null;
  if (projectId) void checkUpdates(true, projectId);
}
function updateDetail(container) {
  if (container.helper) return '面板临时工作容器';
  if (!container.projectId || container.updateCheckAvailable === false)
    return container.updateCheckReason || '当前节点或项目目录不支持此操作';
  const item = updates.value[container.id];
  if (item?.status === 'checking') return '正在读取配置或访问镜像仓库，单个应用最长 35 秒';
  if (item?.status === 'queued') return '等待前面的应用检查完成';
  return (
    item?.error ||
    item?.reason ||
    (item?.checkedAt ? '检查于 ' + time(item.checkedAt) : '进入页面后自动检查')
  );
}
function editTarget(target = null) {
  draft.value = target
    ? { ...target, password: '' }
    : {
        type: '115',
        name: '',
        remotePath: '/ComposeOps',
        clientId: '',
        url: '',
        user: '',
        password: '',
      };
}
function saveTarget() {
  return perform(async (valid) => {
    const d = draft.value,
      payload = {
        type: d.type,
        name: d.name,
        remotePath: d.remotePath,
        url: d.url || '',
        user: d.user || '',
        password: d.password || '',
        clientId: d.clientId || '',
        auto: false,
      };
    if (d.id) payload.id = d.id;
    await api.saveSyncTarget(payload);
    if (valid()) {
      draft.value = null;
      notice.value = '目标已保存，请授权并测试连接。';
      await load(true);
    }
  });
}
function testTarget(target) {
  return perform(async (valid) => {
    await api.startBackupSync({ targetId: target.id, test: true, confirmed: true });
    if (valid()) {
      notice.value = '已开始测试上传和校验，可在任务记录查看结果。';
      await load(true);
    }
  });
}
function automatic(target, auto) {
  return perform(async (valid) => {
    const result = await api.setSyncAutomatic(target.id, auto);
    if (valid()) targets.value = result.targets;
  });
}
function openSync(backup = null, target = null) {
  const available = targets.value.filter((t) => t.tested);
  if (!available.length) return;
  syncChoice.value = {
    targetId: target?.id || available[0].id,
    backupIds: backup ? [backup.id] : data.value.backups.map((b) => b.id),
  };
}
function syncNow() {
  return perform(async (valid) => {
    await api.startBackupSync({ ...syncChoice.value, confirmed: true });
    if (valid()) {
      syncChoice.value = null;
      setTab('tasks');
      await load(true);
    }
  });
}
function stopAuth() {
  clearTimeout(authTimer);
  authSession.value = null;
}
function authorize(target) {
  return perform(async (valid) => {
    const session = await api.authorize115(target.id);
    if (!valid()) return;
    authSession.value = session;
    authMessage.value = '等待扫码';
    authTimer = setTimeout(pollAuth, 2500);
  });
}
async function pollAuth() {
  const session = authSession.value,
    current = epoch;
  if (!session || disposed) return;
  try {
    const result = await api.pollAuthorize115(session.id);
    if (disposed || current !== epoch || authSession.value?.id !== session.id) return;
    if (result.status === 'authorized') {
      stopAuth();
      notice.value = '115 授权成功，请测试连接。';
      await load(true);
      return;
    }
    if (result.status === 'expired') {
      authMessage.value = '二维码已失效，请关闭后重新授权';
      return;
    }
    authMessage.value = result.status === 'scanned' ? '已扫码，等待 115 App 确认' : '等待扫码';
    authTimer = setTimeout(pollAuth, 2500);
  } catch (e) {
    if (current === epoch && !disposed)
      authMessage.value = '授权状态读取失败，请关闭后重试：' + e.message;
  }
}
function recover() {
  return perform(async (valid) => {
    await api.recoverMaintenanceTask(recoverTarget.value.id);
    if (valid()) {
      recoverTarget.value = null;
      await load(true);
    }
  });
}
function resetContext() {
  expandedGroups.value = new Set();
  collapsedSearchGroups.value = new Set();
  preparing.value = false;
  stopUpdateChecks();
  checksStarted = false;
  epoch++;
  loading.value = false;
  busy.value = false;
  data.value = { containers: [], tasks: [], backups: [], settings: {} };
  targets.value = [];
  selected.value = [];
  updates.value = {};
  updateTarget.value = null;
  restoreTarget.value = null; restorePlan.value = null;
  backupPath.value = '';
  plan.value = null;
  confirmed.value = false;
  keySaved.value = false;
  recoverTarget.value = null;
  draft.value = null;
  syncChoice.value = null;
  stopAuth();
  proxyOpen.value = false;
  proxyBusy.value = false;
  proxyUrl.value = '';
  error.value = '';
  notice.value = '';
}
function hostChanged() {
  query.value = '';
  updateFilter.value = 'all';
  resetContext();
  const current = epoch;
  void load().then(() => {
    if (current === epoch && viewActive && tab.value === 'containers') void checkUpdates(false);
  });
}
function bytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + units[i];
}
function time(value) {
  return value ? new Date(value).toLocaleString() : '—';
}
function stateLabel(state) {
  return (
    {
      running: '运行中',
      exited: '已停止',
      paused: '已暂停',
      restarting: '重启中',
      created: '未启动',
    }[state] || state
  );
}
function taskLabel(state) {
  return (
    { running: '执行中', success: '已完成', failed: '失败', interrupted: '中断待核对' }[state] ||
    state
  );
}
function actionLabel(action) {
  return (
    { backup: '完整备份', restore: '隔离恢复', sync: '远端同步', recovery: '恢复原运行状态' }[
      action
    ] || action
  );
}
function activate() {
  if (pollTimer || disposed) return;
  viewActive = true;
  const current = epoch;
  void load().then(() => { if (current === epoch && viewActive && tab.value === 'containers') void checkUpdates(false); });
  window.addEventListener('composeops:host-changed', hostChanged);
  pollTimer = setInterval(() => { void load(true); }, 5000);
}
function deactivate() {
  viewActive = false;
  resetContext();
  clearInterval(pollTimer); pollTimer = null; clearTimeout(authTimer);
  window.removeEventListener('composeops:host-changed', hostChanged);
}
onMounted(activate);
onActivated(activate);
onDeactivated(deactivate);
onBeforeUnmount(() => { deactivate(); disposed = true; });
const scopeVisible = ref(false);
const restoreTarget = ref(null), restoreDirectory = ref(''), restorePlan = ref(null), restoreStart = ref(false), restoreConfirmed = ref(false);
let restorePlanRevision = 0;
watch([restoreDirectory, restoreTarget], () => {
  restorePlanRevision++;
  restorePlan.value = null;
  restoreConfirmed.value = false;
}, { flush: 'sync' });
function openRestore(backup) {
  error.value = ''; restoreTarget.value = backup; restorePlan.value = null; restoreConfirmed.value = false; restoreStart.value = false;
}
function previewRestore() {
  return perform(async valid => {
    const revision = restorePlanRevision;
    const result = await api.prepareFullRestore({ backupId: restoreTarget.value.id, destination: restoreDirectory.value, expectedHostId: data.value.hostId });
    if (!valid()) return;
    if (revision !== restorePlanRevision) {
      notice.value = '目录已修改，请重新校验备份并预览映射。';
      error.value = notice.value;
      return;
    }
    restorePlan.value = result; restoreConfirmed.value = false;
  });
}
function executeRestore() {
  if (!restoreConfirmed.value || !restorePlan.value || restorePlan.value.blockers.length) return;
  return perform(async valid => {
    await api.executeFullRestore({ token: restorePlan.value.token, confirmed: true, start: restoreStart.value });
    if (valid()) { restoreTarget.value = null; setTab('tasks'); await load(true); }
  });
}

</script>

<style scoped>
.maintenance-filters { flex-wrap: wrap; }
.maintenance-filters .search-field { flex: 1 1 260px; }
@media (max-width: 639px) {
  .maintenance-filters .search-field { flex: 0 0 auto; width: 100%; }
}
.maintenance-check-summary {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 20px;
  font-size: 13px;
  color: var(--text-soft);
}
.maintenance-groups { display: grid; gap: 12px; }
.maintenance-group {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgb(var(--ui-line-rgb) / .23);
  border-radius: 12px;
  background: rgb(var(--ui-panel-rgb));
}
.maintenance-group-expanded { border-color: rgb(37 99 235 / .36); }
.maintenance-group.maintenance-selected { border-color: var(--color-accent); }
.maintenance-group-header { display: flex; align-items: center; gap: 16px; padding: 14px 18px; }
.maintenance-group-header > input { flex: none; }
.maintenance-group-toggle { display: flex; flex: 1; min-width: 0; align-items: center; gap: 12px; text-align: left; }
.maintenance-group-icon { flex: none; color: var(--color-accent); }
.maintenance-group-identity { display: grid; flex: 1; min-width: 0; gap: 4px; }
.maintenance-group-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; color: var(--text-bright); }
.maintenance-group-summary { display: grid; justify-items: end; flex: none; gap: 4px; font-size: 13px; white-space: nowrap; }
.maintenance-group-chevron { flex: none; color: var(--text-faint); transition: transform 150ms; }
.maintenance-group :is(button, input):focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
.maintenance-table-wrap { min-width: 0; border-top: 1px solid rgb(var(--ui-line-rgb) / .23); }
.maintenance-table { table-layout: fixed; width: 100%; }
.maintenance-col-update { width: 156px; }
.maintenance-table th { white-space: nowrap; }
.maintenance-table td { font-family: inherit; padding-block: 12px; height: 66px; }
.maintenance-container-name, .maintenance-container-image { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.maintenance-container-name { font-size: 13px; font-weight: 500; color: var(--text-bright); }
.maintenance-container-image { font-size: 12px; margin-top: 3px; }
.maintenance-status-heading, .maintenance-status-cell { text-align: right; }
.maintenance-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
.maintenance-running { color: light-dark(#087552, #76d8b0); }
.maintenance-state-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.maintenance-update-label { background: none; border: 0; padding: 0; font: inherit; font-size: 13px; min-height: 24px; text-align: right; white-space: nowrap; }
.maintenance-update-label:hover { text-decoration: underline; text-underline-offset: 3px; }
.maintenance-update-cell { display: grid; justify-items: end; gap: 3px; }
.maintenance-row-actions { display: flex; flex-wrap: nowrap; align-items: center; gap: 10px; }
.maintenance-row-actions button { flex: none; min-width: 62px; min-height: 36px; white-space: nowrap; }
@media (max-width: 640px) {
  .maintenance-group-header { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 12px; padding: 14px 12px; }
  .maintenance-group-header > input { margin: 0; }
  .maintenance-group-toggle { gap: 8px; }
  .maintenance-group-icon { display: none; }
  .maintenance-group-summary { font-size: 12px; }
  .maintenance-group-name { font-size: 13px; }
  .maintenance-row-actions { grid-column: 2; justify-content: flex-end; }
  .maintenance-table thead, .maintenance-table colgroup { display: none; }
  .maintenance-table, .maintenance-table tbody { display: block; }
  .maintenance-table tbody tr { display: grid; gap: 8px; padding: 12px; border-top: 1px solid rgb(var(--ui-line-rgb) / .17); }
  .maintenance-table tbody tr:first-child { border-top: 0; }
  .maintenance-table td { display: block; min-width: 0; height: auto; padding: 0; border: 0; }
  .maintenance-update-cell { display: flex; justify-content: space-between; align-items: center; }
}
@media (prefers-reduced-motion: reduce) { .maintenance-group-chevron { transition: none; } }
</style>
