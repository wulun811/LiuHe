# RELEASING — npm 发布操作手册（给 CI 维护团队）

LiuHe 的 npm 发布链：打 `v*` 标签 → 4 平台 runner 构建 → 发 npm 平台包 → 发 npm 主包。
主包 `@jieai/dsh-malong-bridge` 已在 npmjs 发布（linux-x64 平台包 + 主包，0.4.5-post5）。
darwin-x64 / darwin-arm64 / win32-x64 三个平台包待本流水线首次跑通后自动发布。

## 1. 前置配置（一次性）

| 项 | 值 | 说明 |
|---|---|---|
| CI runner | gitea act runner 或 GitHub Actions | release.yml / ci.yml 的 `runs-on` label 按 GitHub 书写（`ubuntu-latest` / `macos-15-intel` / `macos-15` / `windows-latest`）；**换 gitea 时需同步修改 label 或给 runner 注册对应 label** |
| secrets `NPM_TOKEN` | npmjs 发布 token | 账号 `jieai`，scope `@jieai`，权限 **Publish**；账号 2FA 若开启，token 必须勾 **bypass 2FA**（账号关闭 2FA 后旧 token 仍带需-2FA 标记，会 403——必须重新生成） |
| npm registry | 发布命令已显式 `--registry https://registry.npmjs.org` | 勿依赖本机 ~/.npmrc（可能是 npmmirror 只读镜像） |

## 2. 发布流程（tag 触发，全自动）

```bash
# 1. 升版本（唯一手动步骤）：三方同步
#    malong/package.json  ← 权威版本号（CI 从这里读取）
#    malong/dsh/bundle/package.json 的 version 与 optionalDependencies（CI 会自动 sed 对齐，手动改也可，以 malong/package.json 为准）
#    dev 侧 CHANGELOG / docs
# 2. 全链测试门禁：cd malong && npm test（54 文件，0 失败）
# 3. 打标签推送
git tag v0.4.5-post6 && git push origin v0.4.5-post6
```

release.yml 自动执行：
1. **build job**（4 runner 并行）：`cargo build --release` → `package-full.sh`（GitHub Release tarball）→ **stage 二进制进 `npm-platform/<os>-<arch>/bin/` + 版本 sed 对齐 → `npm publish` 平台包**
2. **release job**（needs: build，保证 4 平台包先发）：`reprep.sh` 重建主包 → sed 对齐 version + optionalDependencies → `npm publish` 主包 → GitHub Release 发布 tarball

## 3. 必须知道的约束

- **发布顺序**：平台包必须先于主包（主包 optionalDependencies 引用平台包版本；release job `needs: build` 已保证）。缺某个平台包时该平台用户安装不炸（optional 自动跳过），但解析功能不可用——首次发布务必确认 4 个平台包都在 npmjs 上。
- **主包不含二进制**（esbuild 式）：二进制全在 `@jieai/malong-parse-<os>-<arch>` 平台包，安装时 npm/pnpm 按当前 os/cpu 自动只拉本平台包。
- **二进制解析链**（`malong/parse-bin.js`，mcp-server/parse-client/code-index 三处统一）：`MALONG_PARSE_BIN` env → 平台包 `require.resolve` → 包内 `server/bin/`（旧版兼容）→ `~/.local/bin` → dev 树 `target/release`。
- **版本号必须合法 semver**：`0.4.5-postN`（prerelease）合法；`0.4.5.postN`（点号）不合法。postN 会被 npm 视为 prerelease，`latest` tag 语义注意。
- **better-sqlite3 原生依赖**：pnpm 10 默认拦 build 脚本，用户安装后需 `pnpm approve-builds` 或 profile 的 `pnpm-workspace.yaml` 配 `onlyBuiltDependencies: [better-sqlite3]`（bundle README 已注明）。
- **Windows 平台包**：`bin/malong-parse.exe`（模板 `main` 已指向 .exe；parse-bin.js 的 win32 分支兼容）。

## 4. 常见失败排查

| 现象 | 原因 |
|---|---|
| `npm publish` 403 "Two-factor authentication ... required" | token 无 bypass 2FA 或账号 2FA 未关——重新生成 token 勾 bypass 2FA |
| `EADDRINUSE 0.0.0.0:3456`（dsh web 侧） | 旧 dsh web 进程未杀干净；`pkill -f "[d]sh web"` 后再启动 |
| runner 报 label 找不到 | `macos-15-intel` 是 GitHub 特定 label（Intel runner）；gitea 需配等价 label 或改用 `macos-13` |
| 平台包缺失但主包已发 | optional 缺失只 warn；补发平台包即可（同版本，npm 允许晚发） |

## 5. 验证清单（发布后）

```bash
npm view @jieai/dsh-malong-bridge@<ver> --registry https://registry.npmjs.org
npm view @jieai/malong-parse-<os>-<arch>@<ver> --registry https://registry.npmjs.org
# 真实安装冒烟（任意一台目标平台机器）：
dsh plugin --profile web add @jieai/dsh-malong-bridge
pkill -f "[d]sh web"; dsh web --port 3456 --host 0.0.0.0
# 日志应含：registered 44 tools + health 检查 parse bin=node_modules/@jieai/malong-parse-<os>-<arch>/bin/malong-parse connected=yes
```

## 6. 生态侧（非阻塞）

- awesome-dsh-plugins 雷达每 8h 扫 topic（`dsh-plugin` + `dsh-plugins` 已加）；1-2 天未收录再走提交流程（分类 💻 编码开发）
- 官网 wulun811.github.io/LiuHe 可补「DSH 接入」板块（一行安装命令指向 bundle README）
