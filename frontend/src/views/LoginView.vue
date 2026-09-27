<template>
  <main class="min-h-screen grid place-items-center px-4 bg-surface-950">
    <form class="w-full max-w-sm border border-surface-800 bg-surface-900 rounded-lg p-6 space-y-5" @submit.prevent="submit">
      <div>
        <div class="flex items-center gap-2 text-surface-100">
          <Boxes class="w-6 h-6 text-accent" />
          <h1 class="text-xl font-semibold">ComposeOps</h1>
        </div>
        <p class="text-sm text-surface-400 mt-2">
          {{ auth.setupRequired ? '首次使用，请设置管理员密码。' : '登录个人 Docker 运维台。' }}
        </p>
      </div>
      <label class="block">
        <span class="text-xs text-surface-400">管理员密码</span>
        <input v-model="password" class="input w-full mt-1" type="password" autocomplete="current-password" autofocus />
      </label>
      <label v-if="auth.setupRequired" class="block">
        <span class="text-xs text-surface-400">确认密码</span>
        <input v-model="confirm" class="input w-full mt-1" type="password" autocomplete="new-password" />
      </label>
      <label v-if="auth.setupRequired" class="block">
        <span class="text-xs text-surface-400">引导令牌(仅服务端设置了 SETUP_TOKEN 时需要,见启动日志)</span>
        <input v-model="setupToken" class="input w-full mt-1" type="password" autocomplete="one-time-code" />
      </label>
      <p v-if="error" class="text-sm text-rose-400">{{ error }}</p>
      <button class="btn-primary w-full justify-center" :disabled="loading">
        <LogIn class="w-4 h-4" /> {{ loading ? '处理中...' : (auth.setupRequired ? '完成初始化' : '登录') }}
      </button>
    </form>
  </main>
</template>

<script setup>
import { ref } from 'vue';
import { Boxes, LogIn } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const password = ref('');
const confirm = ref('');
const setupToken = ref('');
const loading = ref(false);
const error = ref('');

async function submit() {
  error.value = '';
  if (password.value.length < 10) return (error.value = '密码至少需要 10 个字符');
  if (auth.setupRequired && password.value !== confirm.value) return (error.value = '两次输入的密码不一致');
  loading.value = true;
  try { await auth.submit(password.value, setupToken.value.trim()); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
</script>
