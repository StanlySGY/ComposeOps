# syntax=docker/dockerfile:1

# ---------- Stage 1: build the Vue frontend ----------
FROM node:26-bookworm-slim AS frontend-build

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


# ---------- Stage 2: install backend deps + native modules ----------
# better-sqlite3 自带 N-API 预编译包,优先直接下载预编译产物:这条路不需要
# python3/make/g++,也就不需要 apt —— 国内直连 deb.debian.org 拉 Packages 索引
# 经常超时(实测同一容器里 InRelease 能通、12MB 的 Packages.gz 必断),
# 少一次 apt 就少一个构建失败点。仅当预编译不可用时才回退源码编译。
FROM node:26-bookworm-slim AS backend-build

# apt 源镜像(仅在预编译失败的源码编译回退分支里才会用到 apt)。
# 默认为清华源:实测同一容器里 deb.debian.org 拉 InRelease 能通、但 12MB 的
# Packages.gz 必超时,清华源 4 秒稳定下完 11.5MB。
#   - 覆盖:`--build-arg APT_MIRROR=mirrors.ustc.edu.cn`
#   - 强制走官方源:`--build-arg APT_MIRROR=`
# 走 http 而非 https:裸 debian 镜像里没预装 ca-certificates,
# https 会在 update 阶段直接报 "Certificate verification failed"。
ARG APT_MIRROR="mirrors.tuna.tsinghua.edu.cn"

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# 关键:先在**不装任何编译器**的前提下试预编译产物。这条路走通就一次 apt 都不用碰,
# 也就不可能被 deb.debian.org 卡住。prebuild-install 认的环境变量名规则是
# npm_config_<pkg名去掉非字母数字>_binary_host,所以 better-sqlite3 对应
# npm_config_better_sqlite3_binary_host。
RUN npm config set registry https://registry.npmmirror.com \
 && npm config set fetch-timeout 300000 \
 && npm config set fetch-retries 5 \
 && (npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3 \
      npm ci --no-audit --no-fund \
      && node -e "require('better-sqlite3');console.log('[build] better-sqlite3 预编译产物 OK')") \
 || (echo '[build] 预编译不可用,回退源码编译(需要 apt 装编译器)' \
      && if [ -n "$APT_MIRROR" ]; then \
           sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
         fi \
      && apt-get update -o Acquire::Retries=5 -o Acquire::http::Timeout=30 \
      && apt-get install -y --no-install-recommends python3 make g++ \
      && rm -rf /var/lib/apt/lists/* \
      && npm ci --no-audit --no-fund --build-from-source \
      && node -e "require('better-sqlite3');console.log('[build] better-sqlite3 源码编译 OK')")


# ---------- Stage 3: runtime ----------
# Node 22 base (matches local dev v22) + docker CLI + compose plugin
# (compose route spawns `docker compose` as a child process).
FROM node:26-bookworm-slim AS runtime

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

# Native node_modules (better-sqlite3 预编译或源码编译) then source
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
