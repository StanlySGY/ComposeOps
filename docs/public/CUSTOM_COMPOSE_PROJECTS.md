# 从零创建自定义 Compose 项目

ComposeOps 可以直接使用你自己的 Docker Compose YAML 创建新项目，不必先把服务写成应用市场模板，也不必先手工登录服务器建目录。

## 使用方式

1. 打开 **服务总览 → 新建 Compose**。
2. 选择项目名称与项目根目录。
3. 粘贴 docker-compose.yml 内容；需要环境变量时可展开 .env 输入区。
4. 点击 **创建并部署**。
5. 页面会实时展示目录准备、Compose 校验、镜像拉取和启动输出。

创建后的项目会进入服务列表，可以继续使用现有 Compose 编辑、启停、日志、镜像更新、升级与回滚流程。

如果 Compose 校验、镜像拉取或启动失败，Compose 文件和项目登记会保留，用户可以进入项目配置修复后再操作。命令返回成功只代表 Compose 启动命令完成，不等于应用健康；仍需检查服务健康状态和日志。

## 项目根目录白名单

默认仅允许在 Docker 宿主机的 /projects 下创建：

~~~dotenv
COMPOSEOPS_PROJECT_ROOTS=/projects
~~~

管理员可以在部署环境的 .env 中追加经过确认的绝对路径，使用逗号分隔：

~~~dotenv
COMPOSEOPS_PROJECT_ROOTS=/projects,/opt/compose-projects
~~~

修改 .env 后重新创建或更新 ComposeOps 容器，使环境变量生效。额外根目录必须是你明确允许 ComposeOps 创建项目的宿主机目录；不要将 /、/home、/root、/var 等宽泛目录加入白名单。

界面只会列出白名单中的目录，API 也会在服务端再次校验。创建前会校验根目录真实路径；项目子目录必须不存在，已有目录或符号链接均不会被覆盖。

## 节点与文件安全

- 支持本地 Docker 节点和通过 SSH 管理的 Docker 主机。
- 仅有 Docker API 的 TCP 节点不支持创建宿主机目录；请切换为 SSH 节点。
- 创建流程使用短生命周期隔离 helper，只挂载选定的项目根目录；helper 不挂载 Docker Socket、不接入网络，根文件系统只读。
- 项目名仅允许小写字母、数字、下划线和连字符，且必须以字母或数字开头。
- Compose YAML 必须包含至少一个服务，最大 1 MiB；.env 最大 512 KiB。
- Compose 与 .env 文件创建权限为 0600；项目目录创建过程不覆盖任何已有目录。
- 创建请求绑定当前 Docker 节点 ID，切换节点后旧请求不能写入新节点。

## 拉取与启动行为

服务端先执行 docker compose config --quiet 验证配置。存在远端 image: 且不是 build: 的服务时，先执行 docker compose pull --ignore-buildable；随后统一执行 docker compose up -d --build。纯本地构建服务跳过独立 pull 阶段。

.env 和 Compose 文件都位于项目目录中，Compose 相对路径按项目目录解析。自定义项目使用输入的项目名作为 Compose project name，避免目录或 YAML 中的 name: 造成栈名称漂移。
