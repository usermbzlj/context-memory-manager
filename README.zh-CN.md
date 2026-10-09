# Context Memory Manager

当前版本 **0.3.0-rc.2**，发布候选版。这是一个本地工具证据归档与历史上下文管理层，不是另一套 RTK 命令过滤器。

默认不需要模型 Key、账号或云服务；先保存实际观察到的结果，保留首次使用，历史压力出现后再生成可找回的精简视图。

[English / 完整说明](README.md) | [平台接入](docs/INTEGRATIONS.md) | [验证记录](docs/RELEASE_VALIDATION.md) | [最新复审](docs/PROJECT_REVIEW.zh-CN.md) | [2026-10-05 完善报告（历史）](docs/IMPLEMENTATION_REPORT.zh-CN.md)

## 先运行离线演示

需要 **Node.js 22.16 或更新版本**（Node 22 中首个 `node:sqlite` 内置 FTS5 的版本），推荐 Node 24 LTS 及以上；CMM 进程会屏蔽 Node 22 的 SQLite 实验性警告，Hook 不向宿主 stderr 输出，其他警告照常显示。解压带预构建程序的 ZIP，在项目目录打开 PowerShell：

```powershell
node .\dist\src\cli.js demo
```

演示使用临时存储，不访问你的真实归档，不调用付费 API。它验证首次保留、低压力不修改、历史批处理、视图稳定、日志中段搜索、完整找回和固定后恢复。

## 本地管理面板

选择已有的 CMM 存储目录启动：

```powershell
node .\dist\src\cli.js dashboard --storage "C:\已有的CMM存储目录" --open
```

提供实时活动看板、证据检索与精确下载、会话与链、模型配置与调用账本、策略和诊断维护。
只监听 `127.0.0.1`；启动链接包含一次性凭据，请保持私密。Ctrl+C 同时停止服务与数据库工作进程（再按一次强制退出）。
面板不会隐式创建空归档，也不会自动调用付费模型。[操作与边界说明](docs/DASHBOARD.md)。

## 接入一个项目

当前历史压缩主路径是 **OpenCode**：

```powershell
node .\dist\src\cli.js setup opencode --workspace "D:\MyProject" --dry-run
node .\dist\src\cli.js setup opencode --workspace "D:\MyProject"
```

先预览，再写入配置。安装后重启 Agent，按宿主要求确认权限。不要移动安装目录；移动后需重新 setup。


| 平台 | 默认行为 | 边界 |
| --- | --- | --- |
| OpenCode | 归档、首次保留、压力触发历史投影 | 使用实验性接口 |
| Claude Code | 归档与 MCP 找回 | 入口 Bash 压缩需显式开启 |
| Codex | 原生归档与 MCP 找回 | 不声称原生历史改写 |
| Kimi Code 2.x | 用户级 Hook 按工作区归档，MCP 找回 | Kimi 只传前 2,000 个 UTF-16 单元，达到上限的结果标为 partial；不改写 |
| MCP 代理 | 转发一次、归档、保留输出 | 压缩需显式开启且工具声明只读 |

仅安装记忆 MCP 服务器不等于自动观察原生工具。搜索和诊断时必须使用相同 agent、workspace 和 storage。

## 本轮的核心改进

**完整性不再混同于哈希校验。** 普通观察、上游过滤、截断片段和 RTK 导入都有来源标记。校验通过只证明本地保存的字节没有变，不会把摘要冒充完整原文。

**不再为压缩而压缩。** 默认关闭首次入口压缩；只处理当前请求真正包含的历史，低压力不改写，小收益不批处理。生成后的投影按字节复用，但不承诺模型缓存命中或账单节省。

**日志中段可搜索。** 每个输入或输出字段最多索引 8 Mi UTF-16 单元，返回索引覆盖范围。搜索不到不代表原文没有；`recall --find` 仍可定位超出索引的部分。

**评分默认确定性，模型可选。** 保留评分默认使用本地保守规则；可为 retention、capsule、chain 三种角色分别配置 OpenAI 兼容、Anthropic 或 Gemini 服务，retention 还可用本地原生 `systemone` 评分器。失败或超时统一回到保守回退，原文归档不受影响。见 [配置说明](docs/OPERATIONS.md#configuration)。

**RTK 可选互操作。** 只读导入 v0.50.0 格式的恢复数据，不执行日志提示中的命令。截断片段保留为 partial；提示关联不等于已证明的调用关系。不需要安装 RTK 才能运行 CMM。

## 升级和真实限制

升级前停止 Agent，备份整个存储目录，包括数据库侧文件和 blobs。本版迁移到 schema v4，旧可执行程序不能再写入。使用 `verify` 校验、`reindex` 重建旧数据索引。旧投影标记不会被自动当成可信凭据。

2026-10-10 Windows 全套结果：302 项：301 通过、0 失败、1 项 Windows 文件符号链接跳过，包含原版回归、真实旧结构迁移、字节损坏、面板 HTTP/worker 测试和实际 CLI 子进程；数字与边界见 [验证记录](docs/RELEASE_VALIDATION.md)。离线安装包与 PowerShell 5.1/7 的 `scripts/windows-smoke.ps1` 均实际执行生成的 Codex Hook，完成原文召回和哈希校验。旧 Windows 接入须重新运行 `setup codex`，再在 Codex 审阅并信任变更后的命令。已安装的 Kimi Code 2.1.1 在隔离目录中配合本地脚本化模型实测通过（Hook 归档、2,000 字符截断标 partial、MCP 找回、卸载还原）。已安装的 Codex 0.162.0-alpha.2 能读取本项目配置并发现 5 个 MCP 工具；捕获 hook 仍需用户信任，原生捕获闭环尚待验收。**真实模型下的 Kimi、Claude、Codex、OpenCode/Bun、RTK 实际二进制、远程 CI、真实任务质量/账单对照、原生/远程评分的真实模型质量，以及用户对面板的浏览器验收仍未完成。**

归档是本地明文，可能含源码和密钥，不要提交到 GitHub。默认不自动删除原文。演示的 **95.51%** 只是合成日志的字符缩减，不是任务费用或质量证明。
