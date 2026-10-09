# 项目修复与 Codex 接入

日期：2026-10-08。当前源码版本：0.3.0-rc.2，schema v4。

## 本次整体修复结果

已对宿主接入、原文存储、搜索召回、投影/保留/GC、MCP/bridge、配置保存及分发脚本
进行检查。保留开始时已有未提交修改，修复以下确认缺陷：

| 缺陷 | 修复及验证 |
| --- | --- |
| Codex Windows Hook 退出码 1 | 生成命令补 PowerShell `&`，使用单引号字面参数，避免路径变量展开；真实 PS5.1/7 回归验证旧命令升级、原文采集、搜索召回与哈希 |
| 保存后配置无法重开 | 保存前严格检查已知键、必要字段和类型，拒绝非法替换且保留原文件字节；旧版不完整配置仍补默认值 |
| 后续截断观察丢失 | 同一原文的重复观察只增加 partial/filter 限制；OpenCode 缓存不再忽略后续 metadata；原文或双哈希凭据验证后更新限制，已投影视图恢复原文 |
| 分发验证漏过真实命令 | 实际安装包和 Windows smoke 现在执行生成的 Hook，而非仅调用 Node；加入非空归档、精确 Unicode/CRLF 召回和哈希检查 |
| 文档命令错误 | 平台文档中的不存在命令 `cmm mcp` 改为 `cmm serve` |

最新完整测试：**200 项，199 通过、0 失败、1 项 Windows 符号链接权限跳过**。
实际离线安装包验证、PowerShell 5.1 与 7 的 Windows smoke 均通过。完整证据见
[验证记录](RELEASE_VALIDATION.md)。保留 schema v4 和 rc.2 版本；没有执行删除归档、
公开发布或提交私人配置。

当前项目 `.codex/hooks.json` 已升级并备份。独立存储和仅采集配置保留。
Codex **0.162.0-alpha.2** 原始 app-server 重新读取时错误/警告为空，但
**trustStatus=modified**：旧的信任对应旧命令，新定义须用户重新审阅并信任。
用户选择稍后处理，本轮没有改写信任记录。正式归档仍为 0 条，未注入人工测试数据。
因此源码与分发修复已验证，真实会话自动采集仍须重新信任/加载后验收。

以下保留本日较早的检查与准备记录，其 `untrusted` 状态和 188 项测试是当时快照。

## 结论与检查范围

现有架构与本地工作流已经成形，可以开始在当前项目接入 Codex 的归档和召回。
本轮检查存储、证据索引、作用域、恢复与固定、投影凭据、保留与 GC、宿主配置、
原生 hook、MCP 服务及代理、子进程退出、实际打包和 Windows CLI。重点沿输入到原文
归档再到搜索/召回/投影的调用链检查，并用现有全套回归及新增失败复现验证。
没有逐行审计所有历史文档，也没有读取旧私人归档或进行真实模型长任务测试。

原文实际字节先校验 hash/length 再严格解码；来源完整性独立于哈希；agent/workspace/
session 隔离、receipt 双哈希、partial/filter 禁止再次投影、默认无删除期限，以及
GC 先退休元数据再处理无引用 blob 的设计仍保留。Codex 接入只提供捕获及 MCP 召回。

## 本轮发现与修复

| 问题 | 触发及影响 | 修复与回归 |
| --- | --- | --- |
| reindex 与 GC 竞态 | 原文读取等待期间事件退休，随后重新写入已删除事件的全文索引 | 写事务内重验事件；退休时跳过；验证三个索引表不重新出现原文 |
| pin 与 GC 竞态 | 读取等待期间事件退休，随后写入不存在事件的 pin 并报告成功 | 写事务内重验存在和作用域；明确拒绝，不留孤立 pin |
| 活跃链的 GC 保护遗漏 | 已 evict 的证据所属链被新工具调用重新激活，GC 仍可能删除旧证据 | GC 复用运行时保护判断；真实 evict 后重新激活的回归验证原文保留 |
| 代理协议边界偏离 | legacy upstream 代理复用了 memory server 无状态 API，可在无 client 握手时转发调用 | proxy 拒绝 discover 与 per-request 协议版本；实际 CLI 回归确认拒绝时 upstream 零次执行，legacy 正常调用一次 |
| Kimi 配置误删 | TOML 多行字符串内 hook 示例被当作真实表，可能删掉结束引号及其他配置 | setup/uninstall 在写入前保守拒绝三引号值；回归确认配置/MCP 字节不变且无部分写入 |

Kimi 编辑器仍非通用 TOML 解析器。有三引号值的配置须手工维护 hooks；普通单行
字符串及注释中的三引号不受此限制。本次未对真实 Kimi 用户配置执行安装或卸载。
此外补齐本地 Codex 配置的 Git 忽略规则，并纠正操作文档里已移除的 Kimi launch 说明。

## 当前项目的接入实况

按用户确认，范围仅当前 CMM 项目。已生成 `.codex/hooks.json` 和 `.codex/config.toml`；
Node/CLI 使用绝对路径，归档使用用户目录下独立的
`.context-memory-manager/codex-cmm-project`。生成配置不进入 Git。
该归档设置 `captureOnly=true`、`ingressCompression=false`，provider 列表为空，
保留期限及容量上限为 null。现有其他项目及用户级 Codex 配置未被改写。

安装的 Codex **0.162.0-alpha.2** 原始二进制通过 app-server 的 `config/read`、
`hooks/list` 和 `mcpServerStatus/list` 实测：

- 项目 MCP 配置被读取，CMM server 版本为 0.3.0-rc.2。
- 5 个工具均已被宿主发现，`toolsError=null`。
- PostToolUse hook 被解析，errors/warnings 为空、enabled=true。
- hook 的 **trustStatus=untrusted、isManaged=false**。CMM 的受管标记只用于安装卸载，
  不代表 Codex 已批准信任。未调用任何信任修改或绕过接口。
- 该检查未创建模型任务，modelCalls=0。项目归档目前没有捕获事件；空库 verify 成功
  只证明初始化状态，不能证明真实捕获成功。

## 最后一步与验收

在此项目目录运行 `codex`，输入 `/hooks`，审阅并信任上述 PostToolUse 定义。
这是 Codex 对非托管 hooks 的强制规则：新定义须用户审阅并信任，否则跳过执行。
然后重启当前客户端的 MCP/项目会话，使这份配置进入实际聊天的工具目录。
不要启用 hook trust bypass，也无需改动 sandbox 或工具审批设置。

在重新加载的当前项目聊天中，让 Codex 运行 `Write-Output 'CMM_LIVE_SENTINEL_20261008'`，
再调用 `context_search` 搜索这个标记，并用返回的 eventId 调用 `context_recall`。
期望有一次原生捕获、原输出保持不变、召回包含标记及 SHA-256。再检查
`context_status` 的 scope、health 与 events。该步骤完成前，原生 hook 生效仍待验收。

移除接入时，在项目根目录运行：

```powershell
node .\dist\src\cli.js uninstall codex --workspace (Get-Location).Path
```

卸载只删除本项目 CMM 受管配置，保留归档；完成后重启宿主。移动本目录或更换 Node
位置后，需以原独立 storage 重新 setup。若后续真的升级存储 schema，先停止 bridge
并备份完整目录及 SQLite sidecars。本轮没有 schema 变更。

最新测试和日志见 [验证记录](RELEASE_VALIDATION.md)。真实模型任务质量、token/缓存/
账单比较、完整 Codex 捕获闭环、OpenCode/Bun 和远程 CI 仍须分别取得实际证据，
因此继续保留 RC 定位。

官方接入规则：[Hooks](https://learn.chatgpt.com/docs/hooks)、
[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

---

# v0.3.0-rc.1：项目重构与交付说明（历史记录）

日期：2026-10-02

本文保留该日期的 Linux 交付记录。2026-10-05 的 Windows 修复与验收见
[本轮完善报告](IMPLEMENTATION_REPORT.zh-CN.md) 和 [最新验证记录](RELEASE_VALIDATION.md)。

## 核心判断

RTK 已有命令输出过滤和找回能力。本轮不再复制这条路线，而是把 CMM 收敛到真实证据、历史压力管理和可验证的恢复。原有归档、链、固定、可选评分和清理内核保留，不为重写而重写。

## 已落地的代码改进

1. **来源与完整性分离。** 新增 provenance，区分实际观察、上游过滤、截断和 RTK 导入。本地哈希不再被当作上游原文完整的证据。
2. **历史处理改为真正的发布批次。** 只处理当前请求里的结果，检查压力、收益和冷却期，固定或并发保护变化会阻止批次写入。
3. **投影按字节稳定复用。** 用事件、会话、表示类型和双哈希绑定凭据，不再仅凭前缀判断可信。减少无意义改写，但不声称已证明缓存成本优势。
4. **大日志中段索引和精确找回。** 重叠分块、索引覆盖记录、稳定游标和字面查找，超出索引的原文仍可导出或定位。
5. **RTK 只读数据互操作。** 支持指定项目的恢复数据复制，保留截断和来源不确定性，不执行上游命令，不把导入片段冒充某次工具调用的完整结果。
6. **修复真实字节校验漏洞。** 先校验磁盘字节再解码，阻止损坏 UTF-8 被替换字符掩盖。同时修复跨 Agent 固定权限、小分页查找和独立会话视图。

## 验证与交付

基线 99 项回归通过；当前 137 项通过，0 失败、0 跳过。包含真实旧版结构迁移、实际 CLI 子进程和 RTK 格式失败注入。真实打包后离线安装、配置与卸载、MCP 握手和演示均通过。详细证据见 [RELEASE_VALIDATION](RELEASE_VALIDATION.md) 与 [AUDIT](AUDIT.md)。

演示从 177,048 个 UTF-16 单元生成 7,950 个单元的视图，15 页找回原文，SHA-256 一致。这不是真实模型账单或任务质量的对照测试。

## 不冒充已经完成的事

未在 Windows 实机和四个真实 Agent 里验收，未执行 RTK 二进制，未运行远程 CI，未发布到 GitHub/npm。RTK 适配依据固定版本源码和独立数据库样例验证。仍保留 RC 标记。下一个有意义的门槛是用户真实长任务中的成功率、证据找回和缓存成本，不是继续增加功能数。
