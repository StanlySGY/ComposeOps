# ESLint 官方稳定版本更新（2026-11-29）

通过 npm 官方注册表和 ESLint GitHub 官方发布接口核对，最新稳定版本为 10.16.0，发布时间为 2026-11-27T16:20:20Z。Node 引擎范围仍为 ^20.19.0 || ^22.13.0 || >=24，与当前环境兼容。

前后端统一将 ESLint 最低版本提升至 ^10.16.0，根 lockfile 从 10.12.0 更新到 10.16.0，并采用上游配套的 config-array 0.23.7 与 minimatch 11.0.9。没有升级运行时依赖。没有用跨主版本 overrides 强改测试工具依赖。

验证：根目录 npm run lint 成功，前后端均无错误。npm audit 总计由 7 项 moderate 降至 5 项 moderate，high/critical 为 0；npm audit --omit=dev 为 0 项。剩余链为 @vue/test-utils → js-beautify → editorconfig/glob/minimatch，保留真实结果，不宣称全依赖零告警。

官方来源：
- https://github.com/eslint/eslint/releases/tag/v10.16.0
- https://registry.npmjs.org/eslint/latest

原始版本、发布、安装、lint 和前后 audit JSON 位于 ~/.local/state/composeops/overnight-20261128/eslint-*。本轮仅构建检查工具更新，无生产重启。
