# Context Memory Manager

### 保留证据，缩小上下文，需要时找回原文。

给 Coding Agent 使用者的本地上下文记忆层。

一大段构建日志，不应该挤占此后每次请求的上下文；一份简短摘要，也不应该成为这次工具执行唯一留下的记录。CMM 先保存实际观察到的工具输入和结果，再在宿主支持的边界内提供更短的视图，并留下能够找回原文的编号。

**不需要账号，不强制填写模型 Key，没有运行时 npm 依赖，不修改 Agent 的二进制文件。**

[English](README.md) · [接入细节](docs/INTEGRATIONS.md) · [本轮分析与取舍](docs/PROJECT_REVIEW.zh-CN.md) · [实际验证记录](docs/RELEASE_VALIDATION.md)

> **当前版本：0.2.0-rc.1，发布候选版。** 已执行本地回归测试、独立子进程协议测试、真实 Node 桥接和离线安装包验证。尚未完成 Windows 实机以及四个 Agent 的真实交互验收；不能把接口模拟测试当成宿主兼容性认证。

## 先运行一条完整链路

发行源码包附带 `dist/src`。安装 **Node.js 22.13 或更新版本**后，解压即可运行，不必先执行 `npm install`。

```powershell
# 在解压后的项目目录运行：
node .\dist\src\cli.js demo
```

演示会在临时目录中完成：

```text
归档实际字符串 → 生成证据摘要与原文编号 → 搜索 → 分页回读 → 拼接 → 校验 SHA-256
```

本轮可复现的合成日志结果：

| 项目 | 结果 |
| --- | ---: |
| 原始工具结果 | 177,046 个 UTF-16 字符单元 |
| 提供给 Agent 的提取视图 | 7,950 个字符单元 |
| 字符缩减 | 95.51% |
| 找回全部原文 | 15 页 |
| 重组后的 SHA-256 | 与原文一致 |
| 演示网络请求 | 0 |

**这些是合成演示的字符统计，不是实测 API Token、账单节省或任务成功率。** 演示不访问你的归档，结束后清理自己的临时数据。

## 接入你实际工作的项目

先把 CMM 放在一个不再随意移动的目录，再指定你的代码项目路径。安装器使用绝对路径；移动 CMM 或更换 Node 安装位置后，需要重新运行 setup。

以 OpenCode 为例：

```powershell
node .\dist\src\cli.js setup opencode --workspace "D:\MyProject" --dry-run
node .\dist\src\cli.js setup opencode --workspace "D:\MyProject"
```

第一条只预览，第二条写入配置。安装器会保留无关设置，并在修改已有文件前备份；遇到同名但不属于 CMM 的配置会拒绝覆盖。然后重启 Agent，按宿主要求确认插件、Hook 或 MCP 的权限。CMM 不会替你关闭确认、不修改沙箱，也不切换模型。

Claude Code、Codex 对应：

```powershell
node .\dist\src\cli.js setup claude --workspace "D:\MyProject"
node .\dist\src\cli.js setup codex --workspace "D:\MyProject"
```

Kimi 的原生归档使用启动包装器：

```powershell
node .\dist\src\cli.js launch kimi --workspace "D:\MyProject"
```

包装器使用你已安装的 `kimi`，临时合并 Hook 与 MCP 配置，保留原模型设置，正常退出后删除临时文件。`setup kimi` 只提供项目 MCP 配置，**不等于已安装原生工具归档**。硬终止可能留下包含复制凭据的临时配置，详见接入文档。

也可以安装随包提供的本地 `.tgz`，获得 `cmm` 命令：

```powershell
npm install -g .\context-memory-manager-0.2.0-rc.1.tgz --ignore-scripts --no-audit --no-fund
cmm demo
cmm setup opencode --workspace "D:\MyProject" --dry-run
```

这里使用的是本地发行文件，不表示项目已经发布到 npm 或 GitHub。

## 每种接入究竟能做什么

| 接入方式 | 实际归档范围 | 能否缩减 Agent 可见内容 |
| --- | --- | --- |
| OpenCode 插件 | 可识别的已完成文本工具结果 | 可以，在实验性历史消息钩子中替换合适的历史结果 |
| Claude Code Hook + MCP | 宿主传来的工具输入、结果与失败信息 | 可以，但当前仅处理成功且结构符合文档的较大 `Bash.stdout` |
| Codex Hook + MCP | 宿主传来的工具输入与结果 | 原生接入仅归档、搜索和找回；不伪装成历史压缩 |
| Kimi 启动包装器 + MCP | 宿主传来的 `tool_output` 或失败信息 | 原生接入仅归档、搜索和找回 |
| 工具型 MCP 代理 | 经过该代理的上游工具调用 | 可以处理合适的普通文本结果，保留结构化结果、错误、图片等原状 |
| 单独启动记忆 MCP | 已经被其他路径归档的数据 | 不会自动拦截原生工具，也不会自行缩减上下文 |

OpenCode 插件通过常驻 **Node 子进程**访问 SQLite，避免在宿主 Bun 中直接加载 Node SQLite。新结果至少呈现一次后，才进入后续历史压缩；插件不改用户消息、助手正文、工具参数、附件或转录文件。

Claude 的替换保留原结果对象的字段结构。Codex 不使用 `decision: block` 冒充透明压缩。Kimi 不发送宿主不支持的替换字段。

MCP 代理是有界的 **tools-only stdio 子集**，不是通用 MCP 网关：不转发资源、提示模板、采样、elicitation 或 HTTP/SSE，也不宣称完整支持最新协议。只能管理经过它的那一个服务器，不会拦截其他原生工具。官方接口依据、配置位置与具体限制见 [接入说明](docs/INTEGRATIONS.md)。

## Agent 可以怎样找回信息

接入后有五个记忆工具：

```text
context_search   搜索已经归档的证据，返回来源与事件编号
context_recall   分页读取经过校验的原始工具输入或结果
context_pin      固定某条证据，保护后续可兼容视图与清理
context_unpin    解除事件级固定，不删除原文
context_status   查看真实观察到的归档活动和投影视图记录
```

搜索覆盖描述信息及输入、输出的有限头尾片段，不是全文搜索保证，也不是向量检索。没有命中不能证明原文中不存在。需要精确修改、重现报错或核对细节时，应先找回原文。

`context_recall` 返回校验值、总长度、页边界和 `nextOffset`。按这个偏移继续，不要自己把字节数当字符数。部分回读不会把整段大结果重新塞回上下文。宿主在 Hook 之前已经截掉的内容，本项目无法恢复。

归档中的历史文字是**证据数据，不是新的系统指令或授权**。

## 你也可以直接检查

安装 `.tgz` 后：

```powershell
cmm status --agent opencode --workspace "D:\MyProject"
cmm doctor --agent opencode --workspace "D:\MyProject"
cmm search "test failure" --agent opencode --workspace "D:\MyProject"
cmm recall EVENT_ID --agent opencode --workspace "D:\MyProject" --limit 12000
cmm recall EVENT_ID --agent opencode --workspace "D:\MyProject" --out .\original.txt
cmm pin EVENT_ID --agent opencode --workspace "D:\MyProject"
cmm verify --agent opencode --workspace "D:\MyProject"
```

未全局安装时，将 `cmm` 替换为 `node .\dist\src\cli.js`。`EVENT_ID` 使用搜索结果返回的真实编号。完整导出保留捕获字段的 UTF-8 内容，并拒绝覆盖已有文件。

默认按 Agent 和项目隔离。显式 `--shared` 仅允许同一项目内跨 Agent 访问，不允许绕过项目边界。跨 Agent 回读不能通过 `restore` 把外来事件恢复进当前 Agent 会话。

## 保留原文，不等于无限堆积上下文

核心有 `KEEP / CAPSULE / EVICT` 三种决策：保留完整可见内容、保留证据摘要、留下最小可找回表示。**EVICT 是可见性变化，不是删除原文。**

先归档并验证成功，才允许提供更短结果。原文损坏、结果发生变化、形状不支持或压缩收益太小时，保留原结果。相同工具 ID 但内容不同会报冲突，不能把旧归档冒充本次结果。

离线保守策略开箱可用，不必先买一个模型。可选模型能参与评分，但非法 JSON、越界或非有限评分不会被当成成功；失败则切换提供商或保守降级。写入类工具、失败调用和活跃工作链有更严格保护。固定与最近回读也会影响保留决策。

## 数据和卸载

默认目录是 `~/.context-memory-manager`，可通过 `CMM_STORAGE` 或 `--storage` 修改。数据库、Blob 和备份都是本地文件。

**归档可能包含源码、凭据和个人信息，当前不加密。** 不要提交到 Git，不要把真实原文贴进公开 Issue。默认不调用外部模型；配置外部评分或压缩提供商后，相关描述与证据数据会发送给该提供商。错误日志会避免回显 JSON 解析正文和 HTTP 错误正文，但这不等于通用秘密识别器。

原文默认无限期保留。只有明确配置期限/容量并执行 `gc --yes` 才会删除符合条件的冷数据；清理作用于**整个所选存储**，不是单个 Agent。固定或活跃视图会阻止删除，容量限制不是硬磁盘配额。已删除原文不能再找回。

卸载只删除 CMM 标记的接入配置，不删除归档：

```powershell
cmm uninstall opencode --workspace "D:\MyProject" --dry-run
cmm uninstall opencode --workspace "D:\MyProject"
```

升级前停掉相关进程并备份整个存储目录。v0.1 的 schema v1/v2 会前向迁移到 v3；旧可执行文件不能继续写迁移后的数据库。回滚应恢复完整旧备份。

## 开发与验收

```powershell
npm ci --ignore-scripts
npm test
npm run test:pack
```

源码发行 ZIP 已带运行构建，但重新编译需要开发依赖。`test:pack` 验证真正打包、隔离安装后的程序，不只是检查源码目录。

本轮本地验证是 **99 项测试通过、0 失败、0 跳过**，包含独立协议客户端、真实桥接、三个进程并发归档、损坏检测、原始旧版 DDL 升级与可逆安装。多平台 CI 已配置，但未在 GitHub 执行。付费模型调用、真实 Agent 任务质量、账单节省与 Windows 实机仍未验证。

这次不加入账号系统、团队控制台、向量数据库、大型仪表盘或无关功能。优先把“确实接得上、不会丢证据、失败不干扰 Agent、用户能看懂是否生效”做好。
