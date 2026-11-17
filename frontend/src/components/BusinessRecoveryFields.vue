<template>
  <div class="space-y-4">
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="form-grid-label"><span>数据库类型</span><select v-model="config.engine" class="input w-full"><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option></select></label>
      <label class="form-grid-label"><span>数据库服务</span><select v-model="config.dbService" class="input w-full" required><option value="" disabled>选择服务</option><option v-for="item in services" :key="item" :value="item">{{ item }}</option></select></label>
      <label class="form-grid-label"><span>无状态应用服务</span><select v-model="config.appService" class="input w-full" required><option value="" disabled>选择服务</option><option v-for="item in services.filter(name => name !== config.dbService)" :key="item" :value="item">{{ item }}</option></select></label>
      <label class="form-grid-label"><span>业务数据库名</span><input v-model.trim="config.database" class="input w-full" required pattern="[A-Za-z_][A-Za-z0-9_]{0,62}" /></label>
      <label class="form-grid-label"><span>导出账号</span><input v-model.trim="config.user" class="input w-full" required pattern="[A-Za-z_][A-Za-z0-9_]{0,62}" /></label>
      <label class="form-grid-label"><span>源容器中的密码变量名</span><input v-model.trim="config.credentialEnv" class="input w-full" required placeholder="POSTGRES_PASSWORD" /><span class="text-xs text-surface-400">只填变量名称；执行时读取，不保存密码。</span></label>
    </div>
    <fieldset class="space-y-3"><legend class="font-semibold text-sm">SQL 业务数据断言</legend><p class="text-xs text-surface-400">核对业务表记录数，可限定某个字段值。所有断言只在还原后的数据库执行。</p>
      <div v-for="(item, index) in config.assertions" :key="index" class="section-panel p-3 space-y-2">
        <div class="grid gap-2 sm:grid-cols-2"><label class="form-grid-label"><span>表名（可含 schema）</span><input v-model.trim="item.table" class="input w-full" placeholder="public.orders" required /></label><label class="form-grid-label"><span>预期记录数</span><input v-model.number="item.expectedRows" class="input w-full" type="number" min="0" max="1000000000000" required /></label><label class="form-grid-label"><span>限定字段（可选）</span><input v-model.trim="item.column" class="input w-full" placeholder="order_id" /></label><label v-if="item.column" class="form-grid-label"><span>字段等于</span><input v-model="item.equals" class="input w-full" maxlength="200" /></label></div>
        <button v-if="config.assertions.length > 1" type="button" class="text-link text-xs" @click="config.assertions.splice(index, 1)">删除该断言</button>
      </div><button type="button" class="btn-secondary btn-sm" :disabled="config.assertions.length >= 10" @click="config.assertions.push({ table: '', expectedRows: 1, column: '', equals: '' })">添加数据断言</button>
    </fieldset>
    <fieldset class="space-y-3"><legend class="font-semibold text-sm">隔离应用的环境变量</legend><p class="text-xs leading-6 text-surface-400">应用只得到这些变量与镜像默认值。数据库连接使用 $DB_URL，或分别使用 $DB_HOST、$DB_PORT、$DB_USER、$DB_NAME、$DB_PASSWORD；恢复时替换为隔离数据库与随机密码。不得填原数据库地址或明文密钥。</p>
      <div v-for="(row, index) in environmentRows" :key="index" class="flex flex-wrap gap-2"><input v-model.trim="row.key" class="input min-w-0 flex-1" placeholder="变量名" aria-label="环境变量名" /><input v-model="row.value" class="input min-w-0 flex-1" placeholder="$DB_URL" aria-label="环境变量值" /><button type="button" class="btn-secondary btn-sm" @click="environmentRows.splice(index, 1)">移除</button></div>
      <button type="button" class="btn-secondary btn-sm" :disabled="environmentRows.length >= 40" @click="environmentRows.push({ key: '', value: '' })">添加环境变量</button>
    </fieldset>
    <fieldset class="grid gap-3 sm:grid-cols-2"><legend class="mb-3 font-semibold text-sm">恢复后的 HTTP 业务检查</legend><label class="form-grid-label"><span>容器内部端口</span><input v-model.number="config.http.port" class="input w-full" type="number" min="1" max="65535" required /></label><label class="form-grid-label"><span>相对路径</span><input v-model.trim="config.http.path" class="input w-full" placeholder="/orders" required /></label><label class="form-grid-label"><span>预期状态码</span><input v-model.number="config.http.expectedStatus" class="input w-full" type="number" min="200" max="299" required /></label><label class="form-grid-label"><span>响应必须包含</span><input v-model="config.http.bodyContains" class="input w-full" maxlength="500" required /></label></fieldset>
    <div class="grid gap-3 sm:grid-cols-3"><label class="form-grid-label"><span>RPO（分钟）</span><input v-model.number="config.rpoMinutes" class="input w-full" type="number" min="1" max="43200" required /></label><label class="form-grid-label"><span>RTO（分钟）</span><input v-model.number="config.rtoMinutes" class="input w-full" type="number" min="1" max="60" required /></label><label class="form-grid-label"><span>定时间隔（小时，0 关闭）</span><input v-model.number="config.scheduleHours" class="input w-full" type="number" min="0" max="720" required /></label></div>
    <p v-if="config.engine !== 'postgres'" class="text-xs leading-6 text-status-warn">MySQL/MariaDB 仅支持全 InnoDB 业务库。备份期间必须避免 ALTER、CREATE、DROP、RENAME、TRUNCATE 等结构变更，非事务表会阻止备份。</p>
  </div>
</template>
<script setup>
import { ref, watch } from 'vue';
const config = defineModel({ type: Object, required: true });
defineProps({ services: { type: Array, default: () => [] } });
const environmentRows = ref(Object.entries(config.value.appEnvironment || {}).map(([key, value]) => ({ key, value })));
watch(environmentRows, rows => { config.value.appEnvironment = Object.fromEntries(rows.filter(row => row.key).map(row => [row.key, row.value])); }, { deep: true });
</script>
