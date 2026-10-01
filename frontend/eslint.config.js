import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

/**
 * 前端 lint:只保留能稳定发现真实缺陷的规则,把自动排版/纯风格噪音关到最低。
 *
 * 取舍记录(对比仓库真实代码风格后定):
 *  - eslint-plugin-vue flat/recommended 自带的排版规则(singleline-html-element-content-newline、
 *    max-attributes-per-line、attributes-order、html-self-closing …)在旧组件上产生 ~1800 条
 *    纯格式噪音,既不能自动修干净(自动 --fix 会重排 80+ 文件引入无意义大 diff),也无可读性增益,
 *    故显式关停;只保留能抓真实缺陷的 vue 规则(no-mutating-props、no-use-v-if-with-v-for 等)。
 *  - no-unused-vars 与 no-empty 只做 warn —— 前者大量是渐进式删代码的中间态,后者多为
 *    best-effort 兜底(同后端取舍)。后端 no-unused-vars 用 error 是因为后端纯 JS 更规整。
 *  - globals 用 globals.browser + globals.vitest:TextDecoder/CustomEvent/WebSocket/
 *    location/confirm/Blob 等浏览器 API 此前全报 no-undef,是配置缺漏而非代码问题。
 */
export default [
  {
    ignores: ['dist/**', 'preview-dist/**', 'playwright-report/**', 'test-results/**', 'node_modules/**', 'coverage/**', '.vite/**'],
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.vitest,
        // Node 侧仍需的手写测试/工具文件用到的少量环境值
        process: 'readonly',
      },
    },
    rules: {
      // ---- 只保留能发现真实缺陷的 vue 规则 ----
      'vue/no-mutating-props': 'error',
      'vue/no-use-v-if-with-v-for': 'error',
      'vue/no-v-html': 'warn',
      'vue/require-explicit-emits': 'error',
      'vue/block-order': ['error', {
        order: ['template', 'script', 'style'],
      }],
      // ---- 排版噪音规则:仓库未统一,关停避免假警报淹没真问题 ----
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-closing-bracket-spacing': 'off',
      'vue/html-indent': 'off',
      'vue/html-quotes': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/component-tags-order': 'off',
      'vue/order-in-components': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
      'vue/require-prop-types': 'off',
      'vue/component-api-style': 'off',

      // ---- 通用:能抓缺陷、不制造噪音 ----
      'no-console': 'off',
      'no-debugger': 'warn',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': 'warn',
      'no-throw-literal': 'error',
    },
  },
  {
    // 环境脚本 / vite 配置 / 旧风格测试文件(commonjs 或 node 上下文)
    files: ['**/*.config.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
