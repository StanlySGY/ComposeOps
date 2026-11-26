<template>
  <label class="theme-select" :class="{ 'theme-select-compact': compact }" title="界面主题">
    <component :is="themePreference === 'system' ? Monitor : resolvedTheme === 'dark' ? Moon : Sun" class="h-4 w-4 shrink-0" aria-hidden="true" />
    <span class="sr-only">界面主题</span>
    <select class="input" aria-label="界面主题" :value="themePreference" @change="setTheme($event.target.value)">
      <option value="light">浅色</option>
      <option value="dark">深色</option>
      <option value="system">跟随系统</option>
    </select>
  </label>
</template>

<script setup>
import { Monitor, Moon, Sun } from 'lucide-vue-next';
import { useTheme } from '../../lib/theme.js';
defineProps({ compact: Boolean });
const { themePreference, resolvedTheme, setTheme } = useTheme();
</script>
