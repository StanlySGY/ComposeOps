<template>
  <main class="login-page min-h-dvh relative isolate grid place-items-center overflow-hidden px-4 py-8 sm:px-6">
    <div class="login-glow login-glow-one" aria-hidden="true"></div>
    <div class="login-glow login-glow-two" aria-hidden="true"></div>
    <div class="login-layout relative z-10 grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16">
      <section class="login-intro hidden lg:block">
        <div class="mb-7 flex items-center gap-3">
          <span class="login-brand-mark"><Boxes class="h-6 w-6" /></span>
          <div>
            <p class="text-lg font-semibold tracking-tight text-surface-100">ComposeOps</p>
            <p class="mt-0.5 text-xs text-surface-400">DOCKER OPERATIONS WORKSPACE</p>
          </div>
        </div>
        <p class="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">一处掌控，清晰运维</p>
        <h2 class="max-w-xl text-4xl font-semibold leading-[1.2] tracking-tight text-surface-50 xl:text-5xl">
          让复杂的容器运维，<span class="login-headline-accent">回归简单。</span>
        </h2>
        <p class="mt-5 max-w-lg text-sm leading-7 text-surface-400">集中查看服务状态、管理 Compose 配置、追踪日志与自动化任务。先看清状态，再安全地执行操作。</p>
        <picture class="login-illustration" aria-hidden="true">
          <source media="(min-width: 1024px)" :srcset="`${clusterSmall} 720w, ${clusterLarge} 1200w`" sizes="512px" type="image/webp" />
          <img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" width="1200" height="516" alt="" decoding="async" draggable="false" />
        </picture>
        <div class="login-features grid max-w-lg grid-cols-3 gap-4">
          <div v-for="feature in features" :key="feature.title" class="login-feature">
            <component :is="feature.icon" class="mb-2.5 h-4 w-4 text-blue-300" />
            <p class="text-xs font-medium text-surface-200">{{ feature.title }}</p>
            <p class="mt-1 text-[11px] leading-4 text-surface-400">{{ feature.description }}</p>
          </div>
        </div>
        <div class="mt-7 flex items-center gap-2 text-xs text-surface-400">
          <ShieldCheck class="h-4 w-4 text-status-ok" />
          <span>个人运维控制台 · 管理员身份验证</span>
        </div>
      </section>

      <section class="login-card w-full rounded-2xl border border-surface-700/70 bg-surface-900/90 p-6 shadow-2xl backdrop-blur-xl sm:p-8" aria-labelledby="login-title">
        <div class="mb-7 lg:hidden">
          <div class="flex items-center gap-2.5 text-surface-100">
            <span class="login-brand-mark login-brand-mark-small"><Boxes class="h-5 w-5" /></span>
            <p class="text-xl font-semibold tracking-tight">ComposeOps</p>
          </div>
          <p class="mt-2 text-sm text-surface-400">个人 Docker 运维控制台</p>
        </div>
        <div class="mb-6 flex items-start justify-between gap-4">
          <div>
            <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-300">SECURE WORKSPACE</p>
            <h1 id="login-title" class="mt-2 text-2xl font-semibold tracking-tight text-surface-50">{{ auth.setupRequired ? '创建管理员' : '欢迎回来' }}</h1>
            <p class="mt-2 text-sm leading-6 text-surface-400">
              {{ auth.setupRequired ? '设置管理员密码，完成控制台初始化。' : '验证身份后，继续管理你的容器服务。' }}
            </p>
          </div>
          <span class="login-lock-icon grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-surface-700/70 bg-surface-950/70 text-surface-300"><ShieldCheck class="h-5 w-5" /></span>
        </div>
        <form class="space-y-5" :aria-busy="loading" @submit.prevent="submit">
          <div>
            <label for="admin-password" class="mb-1.5 block text-xs font-medium text-surface-300">管理员密码</label>
            <div class="password-field"><input id="admin-password" v-model="password" class="input w-full" :type="showPassword ? 'text' : 'password'" :autocomplete="auth.setupRequired ? 'new-password' : 'current-password'" :aria-invalid="!!error" :aria-describedby="error ? 'login-error' : capsLock ? 'caps-lock-hint' : undefined" required minlength="10" autofocus :placeholder="auth.setupRequired ? '至少 10 个字符' : '输入管理员密码'" @keydown="updateCapsLock" @keyup="updateCapsLock" @blur="capsLock = false" /><button type="button" class="password-visibility" :aria-label="showPassword ? '隐藏密码' : '显示密码'" :aria-pressed="showPassword" @click="showPassword = !showPassword"><EyeOff v-if="showPassword" :size="17" /><Eye v-else :size="17" /></button></div>
            <p v-if="capsLock" id="caps-lock-hint" class="mt-2 flex items-center gap-1.5 text-xs text-status-warn" role="status"><ArrowUp :size="13" />大写锁定已开启</p>
          </div>
          <label v-if="auth.setupRequired" class="block">
            <span class="mb-1.5 block text-xs font-medium text-surface-300">确认密码</span>
            <input v-model="confirm" class="input w-full" type="password" autocomplete="new-password" required minlength="10" aria-label="再次输入管理员密码" placeholder="再次输入管理员密码" />
          </label>
          <label v-if="auth.setupRequired" class="block">
            <span class="mb-1.5 block text-xs font-medium text-surface-300">引导令牌 <span class="font-normal text-surface-400">（如服务端已配置）</span></span>
            <input v-model="setupToken" class="input w-full" type="password" autocomplete="one-time-code" aria-label="未配置时可留空" placeholder="未配置时可留空" />
            <span class="mt-1.5 block text-[11px] leading-5 text-surface-400">如需令牌，请从服务端配置或启动日志中获取。</span>
          </label>
          <p id="login-error" v-if="error" class="rounded-lg border border-status-error/25 bg-status-error/15 px-3 py-2.5 text-sm text-status-error" role="alert" aria-live="polite">{{ error }}</p>
          <button class="login-submit btn-primary min-h-11 w-full justify-center rounded-xl" :disabled="loading">
            <span v-if="loading" class="loading-mark login-loading-mark" aria-hidden="true"></span>
            <LogIn v-else class="h-4 w-4" />
            {{ loading ? '正在验证…' : (auth.setupRequired ? '完成初始化' : '安全登录') }}
          </button>
        </form>
        <p class="mt-6 border-t border-surface-800 pt-4 text-center text-[11px] leading-5 text-surface-400">访问受管理员密码保护。请勿在共享设备上保存凭据。</p>
      </section>
    </div>
    <p class="absolute bottom-3 left-0 right-0 px-4 text-center text-[10px] tracking-wide text-surface-400">COMPOSEOPS <span class="mx-1.5">·</span> DOCKER COMPOSE WORKSPACE</p>
  </main>
</template>

<script setup>
import { ref } from 'vue';
import { ArrowUp, Boxes, Eye, EyeOff, LogIn, ShieldCheck, Activity, FileCode2, ScrollText } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth.js';
import clusterSmall from '../assets/login-cluster-720.webp';
import clusterLarge from '../assets/login-cluster-1200.webp';

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
const showPassword = ref(false);
const capsLock = ref(false);
function updateCapsLock(event) { capsLock.value = event.getModifierState?.('CapsLock') || false; }

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
  padding-bottom: 3rem;
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
.login-headline-accent { display: block; color: #93c5fd; }
.login-illustration { display: block; margin: 1.25rem -1rem 1rem; pointer-events: none; mask-image: linear-gradient(to right, transparent, #000 10%, #000 90%, transparent), linear-gradient(to bottom, transparent, #000 12%, #000 84%, transparent); mask-composite: intersect; }
.login-illustration img { display: block; width: 100%; height: auto; }
.login-features { padding-top: 1.25rem; border-top: 1px solid rgba(148, 163, 184, 0.13); }
.login-feature + .login-feature { border-left: 1px solid rgba(148, 163, 184, 0.13); padding-left: 1rem; }
.login-card { box-shadow: 0 28px 80px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.035); transition: border-color 180ms ease, box-shadow 180ms ease; }
.login-card:focus-within { border-color: rgba(96, 165, 250, 0.42); box-shadow: 0 28px 80px rgba(0, 0, 0, 0.28), 0 0 0 4px rgba(96, 165, 250, 0.035); }
.login-submit > svg { transition: transform 160ms ease; }
.login-submit:focus-visible > svg { transform: translateX(2px); }
@media (hover: hover) { .login-submit:hover:not(:disabled) > svg { transform: translateX(2px); } }
.login-lock-icon { color: #93c5fd; }
.login-loading-mark { width: 15px; height: 15px; }
.password-field { position: relative; }.password-field input { padding-right: 48px; min-height: 46px; }.password-visibility { position: absolute; right: 3px; top: 3px; bottom: 3px; width: 40px; display: grid; place-items: center; border-radius: 7px; color: var(--color-surface-400); }.password-visibility:hover { color: var(--color-surface-100); background: var(--panel-raised); }

@media (prefers-reduced-motion: reduce) {
  .login-page *, .login-page *::before, .login-page *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
</style>
