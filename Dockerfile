# syntax=docker/dockerfile:1

# ---------- Stage 1: build the Vue frontend ----------
FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
# Lockfile 的 resolved URL 指向 npmmirror;容器里没有宿主 ~/.npmrc,故显式写死
# 镜像源。若宿主 shell 设了 HTTP_PROXY/HTTPS_PROXY,BuildKit 透传给 npm 走代理。
RUN npm config set registry https://registry.npmmirror.com \
 && npm config set fetch-timeout 300000 \
 && npm config set fetch-retries 5 \
 && npm ci --no-audit --no-fund
COPY frontend/ ./
# Output: /app/frontend/dist (hash-history SPA, no server rewrites needed)
RUN npm run build


# ---------- Stage 2: install backend deps ----------
# SQLite 已切到 Node 22 内置的 node:sqlite(backend/src/lib/sqlite.js),
# 不再依赖 better-sqlite3 原生模块:无需预编译下载/源码编译,也就不需要 apt
# 装编译器 —— 国内构建最容易被 deb.debian.org 卡住的一整段风险随之消失。
FROM node:22-bookworm-slim AS backend-build

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
 && npm config set fetch-timeout 300000 \
 && npm config set fetch-retries 5 \
 && npm ci --no-audit --no-fund


# ---------- Stage 3: runtime ----------
# Node 22 base (matches local dev v22) + docker CLI + compose plugin
# (compose route spawns `docker compose` as a child process).
FROM node:22-bookworm-slim AS runtime

# docker CLI + compose 插件直接取自官方 docker:cli 镜像。
# 这样 runtime 阶段完全不需要 apt 装 docker-ce-cli —— 也就不会再去访问
# download.docker.com 的 GPG key 和 docker.list 仓库(那是原方案里最容易超时的一步)。
# docker:cli 是 alpine 静态二进制,拷进 debian 基础镜像可直接运行(已验证)。
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

# 这一层仍需 apt,但只装 git / ssh / curl,体量远小于 docker-ce-cli+compose-plugin。
#   - ca-certificates:git 走 https 克隆、curl 访问外部都要它
#   - git / openssh-client:GitOps 仓库同步在执行 `git clone/pull`
#     (backend/src/services/gitops.js),SSH 私钥方式还要 `ssh -i`。
#     此前镜像里两者都缺失,GitOps 在容器内直接 ENOENT。
ARG APT_MIRROR="mirrors.tuna.tsinghua.edu.cn"
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update -o Acquire::Retries=5 -o Acquire::http::Timeout=30 \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 # 构建期断言:任何一项缺失都让构建当场失败,而不是运行到用户点按钮时才报错。
 && docker --version \
 && docker compose version \
 && git --version \
 && ssh -V

WORKDIR /app/backend

# Backend node_modules (纯 JS 依赖,无原生模块) then source
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY backend/ ./

# Built frontend, placed so index.js staticRoot (backend/src/../../frontend/dist) resolves
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

# SQLite lives here by default (DB_PATH = backend/src/lib/../../data/opsdash.db).
# Persist this dir via a volume in docker-compose.yml to keep AI config + history.
RUN mkdir -p /app/backend/data

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    SERVE_FRONTEND=1

EXPOSE 3001

# No API keys in env — AI config is entered via the Settings UI and stored in SQLite.
CMD ["node", "src/index.js"]
