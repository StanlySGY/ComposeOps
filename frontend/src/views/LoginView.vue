<template>
  <main class="login-page min-h-dvh relative isolate grid place-items-center overflow-hidden px-4 py-8 sm:px-6">
    <div class="login-glow login-glow-one" aria-hidden="true"></div>
    <div class="login-glow login-glow-two" aria-hidden="true"></div>
    <div class="login-layout relative z-10 grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16">
      <section class="login-intro hidden lg:block">
        <div class="mb-8 flex items-center gap-3">
          <span class="login-brand-mark"><Boxes class="h-6 w-6" /></span>
          <div>
            <p class="text-lg font-semibold tracking-tight text-surface-100">ComposeOps</p>
            <p class="mt-0.5 text-xs text-surface-500">DOCKER OPERATIONS WORKSPACE</p>
          </div>
        </div>
        <p class="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">一处掌控，清晰运维</p>
        <h2 class="max-w-xl text-4xl font-semibold leading-[1.2] tracking-tight text-surface-50 xl:text-5xl">
          让复杂的容器运维，<span class="login-headline-accent">回归简单。</span>
        </h2>
        <p class="mt-5 max-w-lg text-sm leading-7 text-surface-400">集中查看服务状态、管理 Compose 配置、追踪日志与自动化任务。先看清状态，再安全地执行操作。</p>
        <div class="mt-10 grid max-w-lg grid-cols-3 gap-3">
          <div v-for="feature in features" :key="feature.title" class="login-feature rounded-xl border border-surface-800/80 bg-surface-900/50 p-3.5">
            <component :is="feature.icon" class="mb-3 h-4 w-4 text-blue-300" />
            <p class="text-xs font-medium text-surface-200">{{ feature.title }}</p>
            <p class="mt-1 text-[11px] leading-4 text-surface-500">{{ feature.description }}</p>
          </div>
        </div>
        <div class="mt-10 flex items-center gap-2 text-xs text-surface-500">
          <ShieldCheck class="h-4 w-4 text-emerald-400" />
          <span>个人运维控制台 · 管理员身份验证</span>
        </div>
      </section>

      <section class="login-card w-full rounded-2xl border border-surface-700/70 bg-surface-900/90 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
        <div class="mb-7 lg:hidden">
          <div class="flex items-center gap-2.5 text-surface-100">
            <span class="login-brand-mark login-brand-mark-small"><Boxes class="h-5 w-5" /></span>
            <h1 class="text-xl font-semibold tracking-tight">ComposeOps</h1>
          </div>
          <p class="mt-2 text-sm text-surface-400">个人 Docker 运维控制台</p>
        </div>
        <div class="mb-6 flex items-start justify-between gap-4">
          <div>
            <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-300">SECURE WORKSPACE</p>
            <h1 class="mt-2 text-2xl font-semibold tracking-tight text-surface-50">{{ auth.setupRequired ? '创建管理员' : '欢迎回来' }}</h1>
            <p class="mt-2 text-sm leading-6 text-surface-400">
              {{ auth.setupRequired ? '设置管理员密码，完成控制台初始化。' : '验证身份后，继续管理你的容器服务。' }}
            </p>
          </div>
          <span class="login-lock-icon grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-surface-700/70 bg-surface-950/70 text-surface-300"><ShieldCheck class="h-5 w-5" /></span>
        </div>
        <form class="space-y-5" @submit.prevent="submit">
          <label class="block">
            <span class="mb-1.5 block text-xs font-medium text-surface-300">管理员密码</span>
            <input v-model="password" class="input w-full" type="password" :autocomplete="auth.setupRequired ? 'new-password' : 'current-password'" :aria-invalid="!!error" :aria-describedby="error ? 'login-error' : undefined" required minlength="10" autofocus placeholder="至少 10 个字符" />
          </label>
          <label v-if="auth.setupRequired" class="block">
            <span class="mb-1.5 block text-xs font-medium text-surface-300">确认密码</span>
            <input v-model="confirm" class="input w-full" type="password" autocomplete="new-password" required minlength="10" placeholder="再次输入管理员密码" />
          </label>
          <label v-if="auth.setupRequired" class="block">
            <span class="mb-1.5 block text-xs font-medium text-surface-300">引导令牌 <span class="font-normal text-surface-500">（如服务端已配置）</span></span>
            <input v-model="setupToken" class="input w-full" type="password" autocomplete="one-time-code" placeholder="未配置时可留空" />
            <span class="mt-1.5 block text-[11px] leading-5 text-surface-500">如需令牌，请从服务端配置或启动日志中获取。</span>
          </label>
          <p id="login-error" v-if="error" class="rounded-lg border border-rose-500/25 bg-rose-950/30 px-3 py-2.5 text-sm text-rose-300" role="alert" aria-live="polite">{{ error }}</p>
          <button class="btn-primary min-h-11 w-full justify-center rounded-xl" :disabled="loading">
            <span v-if="loading" class="loading-mark login-loading-mark" aria-hidden="true"></span>
            <LogIn v-else class="h-4 w-4" />
            {{ loading ? '正在验证…' : (auth.setupRequired ? '完成初始化' : '安全登录') }}
          </button>
        </form>
        <p class="mt-6 border-t border-surface-800 pt-4 text-center text-[11px] leading-5 text-surface-500">访问受管理员密码保护。请勿在共享设备上保存凭据。</p>
      </section>
    </div>
    <p class="absolute bottom-3 left-0 right-0 px-4 text-center text-[10px] tracking-wide text-surface-600">COMPOSEOPS <span class="mx-1.5">·</span> DOCKER COMPOSE WORKSPACE</p>
  </main>
</template>

<script setup>
import { ref } from 'vue';
import { Boxes, LogIn, ShieldCheck, Activity, FileCode2, ScrollText } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const features = [
  { icon: Activity, title: '服务状态', description: '运行情况一目了然' },
  { icon: FileCode2, title: '配置管理', description: '变更前校验与预览' },
  { icon: ScrollText, title: '日志追踪', description: '快速定位异常线索' },
];
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

<style scoped>
.login-page {
  background:
    radial-gradient(ellipse at 16% 18%, rgba(37, 99, 235, 0.11), transparent 38%),
    radial-gradient(ellipse at 88% 82%, rgba(16, 185, 129, 0.07), transparent 34%),
    #10141a;
}

.login-page::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  content: '';
  pointer-events: none;
  background-image: linear-gradient(rgba(148, 163, 184, 0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.025) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: linear-gradient(to bottom, black, transparent 90%);
}

.login-glow {
  position: absolute;
  width: 22rem;
  height: 22rem;
  border-radius: 50%;
  filter: blur(100px);
  opacity: 0.13;
  pointer-events: none;
}

.login-glow-one { top: -14rem; left: 12%; background: #3b82f6; }
.login-glow-two { right: -12rem; bottom: -15rem; background: #10b981; }

.login-brand-mark {
  display: grid;
  width: 44px;
  height: 44px;
  flex: none;
  place-items: center;
  border: 1px solid rgba(96, 165, 250, 0.3);
  border-radius: 13px;
  color: #93c5fd;
  background: linear-gradient(145deg, rgba(37, 99, 235, 0.22), rgba(15, 23, 42, 0.75));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.2);
}

.login-brand-mark-small { width: 36px; height: 36px; border-radius: 10px; }
.login-headline-accent { color: #93c5fd; }
.login-feature { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025); }
.login-card { box-shadow: 0 28px 80px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.035); }
.login-lock-icon { color: #93c5fd; }
.login-loading-mark { width: 15px; height: 15px; }

@media (prefers-reduced-motion: reduce) {
  .login-page *, .login-page *::before, .login-page *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
</style>
