# Docker 构建国内网络优化

## 问题

原先的 Dockerfile 有两处 apt 依赖,在国内直连 `deb.debian.org` 时会失败:

```
Err:4 http://deb.debian.org/debian bookworm/main amd64 Packages
  Connection timed out [IP: 146.75.46.132 80]
E: Package 'ca-certificates' has no installation candidate
```

实测结论(同一容器内):

| 目标 | 结果 |
| --- | --- |
| `deb.debian.org/dists/bookworm/InRelease` | 时好时坏,能通 |
| `deb.debian.org/.../binary-amd64/Packages.gz`(12MB) | **必超时/中断** |
| `mirrors.tuna.tsinghua.edu.cn/.../Packages.gz`(11.5MB) | 4 秒稳定下完 |

所以不是"能不能连上"的问题,而是"大包拉不下来"。

## 现在怎么工作的(已默认修好,直接 build 即可)

```bash
docker compose up -d --build
```

新版 Dockerfile 做了三件事,让构建不再依赖这几个脆弱环节:

1. **apt 源默认就是清华镜像**。`APT_MIRROR` 的默认值已是 `mirrors.tuna.tsinghua.edu.cn`,
   `docker-compose.yml` 的 `build.args` 也显式传了同一个值,不需要你手动加参数。
   走 http 而不是 https:基础镜像里没预装 `ca-certificates`,https 会在
   `apt-get update` 阶段就报 `Certificate verification failed`。
2. **runtime 阶段不再用 apt 装 Docker**。原先要配 `download.docker.com` 的 GPG key
   和 apt 仓库(最容易超时的一步),现在直接从官方 `docker:cli` 镜像拷二进制:
   ```dockerfile
   COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
   COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins/docker-compose ...
   ```
   实测容器内 `docker --version` = 29.8.0、`docker compose version` = v5.5.1。
3. **backend 阶段优先用 better-sqlite3 预编译产物,完全跳过 apt**。
   ```dockerfile
   npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3 npm ci
   ```
   这条路不需要 `python3/make/g++`;只有预编译不可用时才回退到源码编译,
   回退分支才会装编译器(并复用同一个镜像源设置)。

同时补齐了运行期真正需要的系统工具:**`git` 与 `openssh-client` 现在装进镜像了**。
之前镜像里两者都缺失,GitOps 的 `git clone/pull` 会直接 `ENOENT`,
SSH 私钥方式的仓库也没法用。构建结束时会断言:

```
docker --version && docker compose version && git --version && ssh -V
```

任何一项缺失都会让构建当场失败,而不是等你点到按钮才发现。

## 覆盖镜像源

```bash
# 换成中科大源
docker compose build --build-arg APT_MIRROR=mirrors.ustc.edu.cn

# 强制走官方源(你有代理时)
docker compose build --build-arg APT_MIRROR=
```

可用镜像源:

- 清华:`mirrors.tuna.tsinghua.edu.cn`(默认)
- 中科大:`mirrors.ustc.edu.cn`
- 阿里云:`mirrors.aliyun.com`
- 腾讯云:`mirrors.cloud.tencent.com`

## 走代理构建

如果你有代理(例如 Clash):

```bash
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
docker compose build
```

BuildKit 会自动把 `HTTP_PROXY`/`HTTPS_PROXY` 透传到构建阶段,apt 与 npm 都会走代理。

## 仍然构建失败怎么办

按顺序排查:

1. **确认基础镜像能拉到**。`docker pull node:22-bookworm-slim` 与 `docker pull docker:cli`
   如果失败,是镜像仓库的网络问题,配 Docker daemon 的 registry mirror 解决。
2. **看是哪一层失败**。`docker compose build --progress=plain` 会逐层打印,
   错误行会指明 stage(如 `[runtime 5/10]`)。
3. **npm 层卡住**(`npm ci` 或 `npm run build` 慢):Dockerfile 已写死
   `registry.npmmirror.com` 并设了 `fetch-retries 5`;若仍失败,基本是同一条链路的问题,
   设代理重试。
4. **确认没有残留的旧 layer**。`docker builder prune` 后重试;旧构建缓存里可能存着
   失败阶段的中间态。

## 验证镜像

```bash
docker run --rm --entrypoint sh stanly1997/opsdash:latest -c '
  docker --version && docker compose version &&
  git --version && ssh -V &&
  node -e "require(\"better-sqlite3-multiple-ciphers\");console.log(\"encrypted sqlite addon OK\")"'
```

预期输出包含 Docker 29.x、Compose v5.x、git 2.39.x、OpenSSH_9.x、encrypted sqlite addon OK。

要确认 apt 源已切换:

```bash
docker run --rm stanly1997/opsdash:latest cat /etc/apt/sources.list.d/debian.sources | grep URIs
# 应输出: URIs: http://mirrors.tuna.tsinghua.edu.cn/debian
```