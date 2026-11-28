# 运行依赖与静态文件边界（2026-11-29）

## 实际发现

`npm audit --omit=dev` 初始报告 6 个受影响运行依赖节点（1 high、4 moderate、1 low）：Fastify、静态托管链路的 glob/minimatch、Nodemailer 和 Undici。审计严重度只描述公告，不意味着本项目使用了公告中每一种受影响 API。

在原工作区已安装依赖的只读副本路径上执行了本地复现（没有修改该工作区）：

- Undici 8.11.2 对六层 content-encoding 且 body 提前截断的本地响应，fetch 拒绝后仍产生未处理 error，子进程退出码 1。8.14.0 捕获拒绝后继续运行、退出码 0。
- Nodemailer 10.0.15 将嵌套注释内 `unexpected@example.test` 解析为信封收件人；10.6.1 正确保留 `approved@example.test`。只使用内存 streamTransport，无 SMTP 连接和实际邮件。
- 静态插件默认 `dotfiles: allow`。最初测试假设默认忽略隐藏文件，在旧版和升级后均失败；读取官方插件文档与源码确认默认值后，产品显式设置 ignore。生产使用同一注册函数，针对临时目录验证隐藏文件、URL 编码路径和 `.env.gz` 均不返回内容，普通 SPA、预压缩资源与 HEAD 保持可用。
- URL 解析器会先规范化 `/%2e%2e/package.json`，最初断言必须 404 不符合现有 SPA 回退行为。最终检查返回 SPA 内容，且不会读取静态根之外的 package.json。该失败记录原样保留。

## 改动

| 运行依赖 | 原安装版本 | 本次版本 |
| --- | --- | --- |
| fastify | 5.12.5 | 5.12.8 |
| @fastify/static | 10.1.5 | 10.1.12 |
| nodemailer | 10.0.15 | 10.6.1 |
| undici | 8.11.2 | 8.14.0 |

静态托管的传递依赖更新为 glob 14.0.6、minimatch 11.0.9。安装仅在根目录执行 workspace 安装，保留唯一根 lockfile。没有跨主版本升级这四个直接依赖，也没有全局安装或修改系统 Node。

本机 Node 22.23.5 内置 Undici 6.29.1，单独执行同一恶意响应验证也能存活；不能把外部 Undici 升级误当成替换 Node 内置 fetch 的实现。

## 验证

- 运行依赖审计：0 个已报告漏洞；这是当次公告数据库结果，不等于绝对不存在缺陷。
- 针对性后端回归 40 项通过：真实本地 HTTP、邮件信封、静态资源、镜像仓库代理、通知重试、路由与鉴权。
- 前端全量 161 文件、1251 项通过；lint、生产构建通过。
- 后端全量：1279 项通过、1 项跳过、0 失败；本轮静态边界改动的针对性 40 项也通过。
- 含开发依赖的审计仍有 7 个 moderate 节点，来自 ESLint 和测试格式化依赖的 glob/minimatch 链路，尚未在本轮升级；不得将运行依赖的 0 报告写成整个仓库 0 报告。
- 全浏览器矩阵：1037 项通过、11 项按设备能力跳过、0 失败（Chromium/WebKit 桌面与手机）。
- 候选镜像首轮构建因 Docker 默认网桥访问 npm/Debian 超时，已停止并保留日志；隔离网络探测确认宿主网络与清华 HTTPS 源可达，现使用相同 Dockerfile 的 build 参数重新构建。镜像安装/升级检查尚未完成，因此本轮不部署生产。

证据位于 `~/.local/state/composeops/overnight-20261128/`：`runtime-dependency-*`、`security-dependencies-*`，包括升级前失败。构建候选镜像使用单独标签，生产容器、原数据卷和外置密钥不变。

## 官方资料

通过 npm 官方 registry 核对版本与 engines，通过 GitHub 官方项目发布 API/安全公告确认修复。浏览器搜索工具未返回结果，因此不提供伪造的搜索引用。

- https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c
- https://github.com/nodejs/undici/releases/tag/v8.14.0 （2026-11-27 发布）
- https://github.com/nodemailer/nodemailer/security/advisories/GHSA-8c8m-p3m8-cjg8
- https://github.com/nodemailer/nodemailer/releases/tag/v10.6.1
- https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8
- https://github.com/fastify/fastify/releases/tag/v5.12.8
- https://github.com/fastify/fastify-static/releases/tag/v10.1.12
- https://github.com/fastify/fastify-static/blob/v10.1.12/README.md#dotfiles
