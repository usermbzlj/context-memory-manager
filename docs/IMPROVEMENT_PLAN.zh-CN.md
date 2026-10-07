# CMM 整体评估与改造方案

评估日期：2026-10-02 至 2026-10-03（Asia/Shanghai）。对象：当前 `0.3.0-rc.1` 源码包、schema v4。

本轮按用户选择完成评估与方案，不实施运行时修复，不接入个人 Agent 配置、不使用真实私有档案、不调用付费模型。验证运行了项目构建及隔离测试；本文是新增交付物。当前目录没有 Git 元数据，后续实施前应保留这一份输入快照并建立可审查的改动基线。

## 1. 整体判断

项目已经有可用的核心实现：精确归档、来源记录、分块检索、分页召回、压力门控、稳定投影凭据、可逆配置接入及 RTK 只读导入。现有分层基本适合产品定位，建议保留，而不是整体推倒重写。

目前影响完成度的主要问题是三个层次：

1. **正确性仍有缺口。** Windows 工作区身份不稳定、跨会话链关联串用、恢复范围判断不充分、派生文本不一定能精确往返、宿主截断信息丢失。
2. **验证链条不完整。** Windows 完整测试失败并挂起，诊断命令会漏报一类投影凭据损坏。包验证通过和历史 Linux 测试通过不能替代当前平台回归。
3. **实际价值尚未建立证据。** 真实宿主是否按预期捕获/投影，以及长任务质量、实际 token、缓存成本和延迟，仍待独立验收。

建议以“可靠的证据归档与可恢复的工具上下文投影”为目标，先修边界与验证，再验证真实宿主，最后决定是否调整压力策略。当前没有证据支持增加 GUI、向量数据库、自动代理、云端服务或另一套命令过滤器。

## 2. 本轮证据与限制

已阅读 `README.md`、`docs/ARCHITECTURE.md`、`docs/INTEGRATIONS.md`、`docs/RELEASE_VALIDATION.md`、`AGENTS.md`，并追踪 storage、evidence、runtime、core、chains、integrations、MCP 和相关测试。审查结合主审复核与三个并行分项审查；不是每一行代码或所有第三方实现的完整审计。

| 项目 | 本轮实际观察 |
| --- | --- |
| 平台与运行时 | Windows；Node `v24.19.0`；npm `11.17.0` |
| 已安装宿主版本 | OpenCode `1.18.29`；Codex CLI `0.159.0-alpha.12.1`；Kimi `2.1.1`，仅执行版本查询 |
| Claude / 独立 Bun | 本轮 PATH 探测未找到对应命令；不能据此断言整机未安装。OpenCode 内部运行时未做真实会话验证 |
| `npm test` | 构建成功；测试最终报告 `137 tests / 109 pass / 27 fail / 1 skipped`，退出码 1 |
| 完整测试退出情况 | 在测试已报错后，bridge/serve/proxy 子进程残留使进程不能正常退出；约 260 秒后手动结束本轮所属残留子进程，才获得完整报告。不是一次自然完成的成功运行 |
| 失败堆栈分类 | 21 项为路径、查询或相关断言失败；6 项显示临时目录删除 `EPERM`。清理错误可能掩盖更早错误，不能据此将 27 项全部认定为独立运行时缺陷 |
| `npm run test:pack` | 通过：实际 tarball 离线安装、help/version、demo、四种接入配置的 setup/uninstall、独立 MCP 握手 |
| `scripts/windows-smoke.ps1` | 通过：带空格路径、隔离 CLI、demo、setup/uninstall、verify；输出明确 `liveAgentTested: false` |
| 单独并发写入检查 | 三个 Node writer、共 60 次写入的既有测试单独通过；并行审查额外 10 轮轻量 writer 检查未复现写入失败。全套失败栈停在目录清理，尚无证据将其归因于 blob 发布损坏 |
| 缺陷复现 | 临时档案中实际复现下列边界问题；主审独立重复了工作区、input restore、Unicode、source hash、跨会话链及 OpenCode 截断 metadata 问题 |
| 官方契约核对 | 核对 OpenCode `v1.18.29` 固定标签的工具源码；属于源码契约证据，不等于真实 OpenCode 会话通过 |

此前 `docs/RELEASE_VALIDATION.md` 的 137 项全通过属于历史 Linux 环境记录，应保留其日期与环境，不能改写成 Windows 已通过。合成 demo 的 95.51% 字符减少仍只说明该样例的字符变化。

## 3. 已确认问题及修复边界

优先级：P1 表示实施首轮应处理的正确性或发布阻断问题；P2 表示同轮随后处理的可靠性问题。优先级不代表已证明真实用户数据丢失。

### F01：Windows 工作区规范化不幂等（P1）

位置：`src/storage/archive.ts:14`；调用链 `src/core/context-manager.ts:199`、`:472`、`:519`；测试辅助 `tests/util.ts:58`。

本机实测 `normalizeWorkspaceId('/test/ws')` 得到 `D:\test\ws`，再次规范化得到 `d:\test\ws`。`recordToolComplete` 与 archive 重复规范化，而 recall/pin 和部分 scope 查询次数不同。相对、不存在的 workspace 经 `MemoryService.capture` 返回 `archived: true`，但该 service 的 search 返回 0；scope 与存储行仅驱动器字母大小写不同。

**改造：**明确路径身份政策，将“展开相对/家目录路径、Windows 路径处理、可用时 realpath、最终规范化”收敛为单一幂等流程。保持 opaque workspace ID 的既有语义。不要把所有路径组件无条件转小写，以免合并支持大小写敏感的目录。测试使用同一规范化政策，避免通过放宽断言掩盖真实身份分裂。

**兼容：**盘点旧 archive 是否同时存在不同路径拼写，保留既有 event ID、host session 命名空间与来源信息。先设计可验证的旧 scope 兼容规则；存在身份冲突时拒绝静默合并，不能直接重算全部 session ID 或批量改写历史数据。

**验收：**对存在/不存在目录、相对/绝对路径、驱动器大小写、尾分隔符、UNC、opaque ID 检查 `normalize(normalize(x)) === normalize(x)`；同一作用域的 capture→lookup→search→recall→pin 均可用；不同目录仍隔离。

### F02：短 input 的完整页可触发超长 result 恢复（P1）

位置：`src/runtime/memory.ts:119`。

126,000 字符 result 的 input 为 `x`。先形成 7,950 字符历史投影，再调用 `recall({field:'input',limit:1,restore:true})`，返回 `restored:true`。下次低压力 transform 将 result 恢复为 126,000 字符。当前 complete 判断检查的是所选字段，后续恢复却改变整个结果视图。

**改造：**限定恢复资格为完整 result 的单页读取；input 保持精确检索能力，但不改变 result 的工作上下文状态。把资格判断放在共享服务边界，CLI、MCP 和 bridge 均遵守。pin 的显式恢复语义仍保留。

**验收：**input+restore 明确拒绝，且不修改 state、event view、recall protection；result 分页不可 restore；完整小 result 仍可 restore；目标会话显式恢复仍独立于来源会话。

### F03：OpenCode 显式截断 metadata 未进入来源记录（P1）

位置：`src/integrations/opencode.ts:38` 至 capture 请求；`src/evidence/provenance.ts:43`。

after hook 和历史 part 都接受 metadata，但目前仅提取退出码。OpenCode 固定标签 `v1.18.29` 的 Read 工具提供 `metadata.truncated`，并使用 `Output capped ...` / `Showing lines ...` 等提示；当前正则无法覆盖这些提示。本地适配器 fixture 传入 `metadata.truncated:true` 和该提示后，捕获的 completeness 为 unknown；清除 fixture 的首次展示保护并设为 capsule 后，project 返回 `replaced:true`。已知 partial 失去禁止再次压缩的保护。这是实际适配器加临时档案复现，未启动真实宿主。

**改造：**在宿主适配层将明确的截断字段映射为 `completeness:'partial'`，记录字段来源，原始观察文本照常精确归档。正文标记仅作保守补充。没有截断字段不等于完整。已捕获记录缺少 metadata 时，不可凭猜测补造完整性或不可见原文。

**验收：**同一截断样例经 after hook 与 transform 补捕获都标为 partial；高压力下输出不变、无新 projection receipt；recall 精确返回被观察部分。不同版本的未知字段或失败形状应 fail-open。

契约证据：[Read 工具 v1.18.29](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/tool/read.ts)。本轮核对了 `metadata.truncated` 和截断提示；真实宿主验收另列为阶段 C。

### F04：跨会话恢复带入来源链，成员与 turn 计数混用（P1）

位置：`src/storage/sqlite.ts:299`、`:339`；`src/chains/linker.ts:60`、`:226`；`src/core/retention.ts:137`。

source 会话 Edit→失败测试形成 active chain。把 Edit 恢复到 target，再在 target Read 同一路径，新 Read 加入原 source chain；本轮实测成员数从 2 增至 3，包含两个 session，来源链摘要也可随之更新。另一个临时 fixture 证明 target 的 currentTurn 会与 source chain 的 member turn 相减，导致目标保护期结束后仍被错误地判为 chain-active。

**改造：**严格区分 immutable source event 与 target session view。来源链可作为关联证据展示，但不自动成为目标会话的链成员或活跃保护上下文。新增成员必须与 chain 的 agent/workspace/session 匹配；freshness 只能使用同一会话时间轴。

**推荐首轮：**跨会话 view 不继承可变的链操作身份；目标会话新活动建立自己的链。只有明确需要“view 也成为目标链成员”时，才设计独立的 view-chain 关联和迁移，避免先扩大 schema 再决定语义。

**验收：**source→target restore 后，target 编辑、读取、测试不得改变 source chain 的成员、完成状态、摘要或保护；来源与目标 turn 差距很大时，目标保护按目标时间轴到期；正常同会话失败→修复→通过链仍保留。

### F05：派生摘要截断可破坏 Unicode 与稳定投影（P2）

位置：`src/descriptor.ts:185`；同类截断见 `src/capsule/extractor.ts:19`、`src/capsule/compressor.ts:37`；发布链 `src/runtime/memory.ts:208`。

Read input 为 `'a'.repeat(114)+'🚀'` 时，摘要截断切开代理对。首次 projection 的 `isWellFormed()` 为 false，SQLite 缓存重读为 true，但两份文本不等；下一次投影返回 `output-changed-since-archive`。这破坏稳定识别、复用和 pin 恢复。

**改造：**统一 Unicode 安全截断工具，覆盖所有进入派生摘要、事实和投影的截断点；发布前验证结果可精确表示为 UTF-8。原始档案仍原样保留，不通过替换字符“修正”原文。

**验收：**摘要长度边界与 projection budget 边界附近放置 emoji/非 BMP 字符；首次返回、缓存重读、进程重启后返回的 UTF-8 字节完全一致，pin 能恢复。当前已损坏的派生缓存应报告或失效处理，不修改 source originals。

### F06：评分等待后的活跃链保护未重新检查（P2）

位置：`src/core/retention.ts:381`；`src/runtime/memory.ts:150`、`:215`、`:321`。

评分前一条 active chain 已足够陈旧；等待 scorer 时新工具事件加入该链，使其重新活跃。评分完成后 freshBlock 只重查部分保护，旧事件仍可变为 capsule。分项临时复现中 currentTurn 与最新链成员 turn 都为 17，链 active，旧事件决策仍为 capsule。

**改造：**在 F04 会话语义明确后，提取共享的动态保护判定，覆盖 pin、recall 和同会话活跃链。retention 初筛、等待后重检、project 和原子 batch publication 使用一致政策；事务内复查可变状态。证据 eligibility 单独共用，宿主首次展示门控继续使用适配层实际观察，避免把归档年龄当成已经展示的证明。

**验收：**延迟 scorer 期间加入同链成员、pin、recall 或改变状态，过期结果不能发布；已有投影的同会话链重新活跃时按政策恢复原文；保护变化导致整批撤回而不留下半批凭据。

### F07：verify 漏报投影来源绑定损坏（P2）

位置：`src/runtime/memory.ts:381` 至 receipt 检查；实际 project 校验位于 `:174`。

把有效 receipt 的 `source_sha` 改为 64 个 `0`，`verify` 仍返回 `failed:0 / projectionFailed:0`，但 project 随即拒绝并报告 `Projection receipt integrity mismatch`。运行时保持原输出的保护有效，诊断却给出错误的无故障结论。

**改造：**将 source representation 提取和 receipt 校验收敛为 project/verify 共用的只读逻辑，分别检查 text、stdout、mcp-text 的来源哈希、visible hash 和合法绑定。verify 应报告不支持的 mode/representation、无效目标 scope 等结构问题，不能仅检查缓存文本自身。

**验收：**来源或可见哈希不符、不支持的表示、目标 session 属于错误 scope 或缺少合法 event view 时，可定位具体 receipt，CLI verify/doctor 返回失败；检查过程不改写凭据或重建原始证据。合法三种表示仍通过。现有哈希模型不保证检测同 scope 且拥有合法 view 的会话之间任意迁移凭据，仍遵守同用户进程可改写数据库的既有安全边界。

### F08：Windows 测试清理次序错误并遗留子进程（P1，验证阻断）

位置：`tests/util.ts:43`；`tests/protocol.test.ts` 中 cleanup 与 peer/client close 的注册顺序；`tests/integrations.test.ts:15`；`tests/schema-migration.test.ts` 初始 manager 的异常退出路径。

当前多个测试先注册删除临时目录，再注册子进程 close。Windows 上 bridge/serve/proxy 持有数据库句柄，删除返回 EPERM。纯 node:test 探针确认本机前一个 after 抛错会使后续 after 未执行，子进程因此残留。`RpcClient.close()` 与 plugin dispose 也没有提供可等待的实际退出完成信号。迁移测试早期失败时 manager 可未关闭，进一步掩盖原失败。

**改造：**把资源生命周期归入可等待的统一 finally：停止接收新请求→关闭本轮子进程并确认 exit→关闭 manager/数据库→删除明确的临时目录；每一步失败仍执行必要清理并保留首个错误。为纯测试子进程设置明确超时和失败诊断。必要时提供内部异步 dispose/closed completion，不改变“不重试上游工具”的约束。

**验收：**故意使断言、请求或归档失败，测试仍在有界时间退出，且不残留本轮进程；只删除明确的临时路径。writer Promise.all 失败时，也应等其他已启动 writer 退出再删除目录。不能靠跳过 Windows 用例或降低并发掩盖问题。

## 4. 建议的改造顺序

```mermaid
flowchart LR
    A[阶段 A：身份与测试基线] --> B[阶段 B：恢复、来源与投影可靠性]
    B --> C[阶段 C：固定版本真实宿主验收]
    C --> D[阶段 D：任务质量与实际成本评估]
```

| 阶段 | 工作包与依赖 | 完成门槛 |
| --- | --- | --- |
| A：恢复可信基线 | F01、F08；输入快照/改动审查；测试 fixture 与 public API 的路径政策一致 | Windows `npm test` 自然退出、无失败或残留子进程；保留明确合理的平台 skip；旧 schema fixture 仍通过 |
| B1：恢复与来源 | F02、F03，可在公共接口约定后并行 | 短 input 不能恢复大 result；已知 partial/filtered 在所有投影入口受保护 |
| B2：会话与动态保护 | F04，然后 F06 | 来源链不被目标会话修改；保护与 freshness 仅使用合法 scope；等待与发布期间的保护竞态回归通过 |
| B3：稳定表示与诊断 | F05、F07，可在 representation 工具约定后并行 | 首次/缓存/重启字节一致；verify 与 project 对同类损坏的结论一致 |
| B：整体回归 | 汇合全部修复，审查迁移和打包边界 | `npm test`、`npm run test:pack`、Windows smoke 通过；清单与日志记录实际环境；完整档案升级备份和回滚说明明确 |
| C：宿主验收 | 优先 OpenCode `1.18.29`，因其承载历史投影；随后 Codex/Kimi 捕获路径；Claude 使用选定真实版本 | 每个通过的版本分别留有真实会话证据，不把一个宿主的成功推广到其他宿主 |
| D：有效性评估 | 阶段 C 通过后做匹配任务比较 | 能说明任务完成、证据恢复、实际 token/cache、延迟和额外开销；证据不足时继续保留 RC 与未认证声明 |

各工作包按共享文件明确负责人，特别是 `runtime/memory.ts`、workspace identity 和链保护接口，避免多路同时编辑。每包先保留最小复现，再修根因和相关调用方，完成后重跑相关测试；汇合后再跑全套。版本号与 schema 升级应跟随实际兼容性变化决定，本文不预设一次大版本重写。

## 5. 阶段 C 的真实宿主验收方案

使用新的可丢弃项目、明确独立 storage，记录宿主、Node、CMM、插件版本及启用政策。以下是待执行验收，不是本轮已经通过的结果。真实模型调用的账号、预算与宿主选择须在实施该阶段前明确。

- **OpenCode：**在真实 Bun 宿主加载插件与 Node bridge；运行大文本工具，确认首次展示不变；分别获取完整与宿主截断结果；在真实长任务压力下确认只有可见、合格的旧结果进入批次。搜索中段已知事实，精确 recall，pin，重启后复用，再卸载。验证不改用户/助手正文、附件、权限或宿主转录文件。
- **Codex：**用选定版本真实 hook 输入确认 capture，非零退出结果可检索；stdout 静默、工具输出不替换，MCP recall 可用。项目 trust/approval 使用宿主正常流程。
- **Kimi：**从选定现有配置启动临时 wrapper；成功/失败工具均 capture，缺失 tool ID 的观察保持独立；正常退出清理临时文件、原配置不变。硬杀残留只按专门说明检查，不自动删除可能仍在使用的凭据文件。
- **Claude：**默认捕获保持原输出；显式开启 ingress 后，仅合格成功 Bash stdout 可投影且保持 envelope 其余字段；关闭后不再产生新投影。其表现不能用于宣称历史投影能力。
- **RTK：**使用自有同项目真实库，记录 RTK 精确版本；完整和部分条目分别核对，确认只读源库、导入独立；过期、缺失、截断或错误引用均不破坏宿主输出。
- **MCP proxy：**在不产生真实副作用的测试工具上检查超时/取消和归档故障，执行次数仍为一次；不将 tools-only stdio 验收表述为全 MCP 规范认证。

先人工运行一条短 smoke 并记录结果，再决定是否需要自动化长会话。不要为尚未明确的验收下载大型模拟环境、改全局配置或增加常驻服务。

## 6. 阶段 D 如何判断项目是否真正有价值

按宿主能力分别比较，使用同一代码起点、相同模型/版本与任务标准；至少覆盖长测试日志中段定位、多文件失败→修复链、跨会话恢复，以及上游已经过滤/截断的证据。每次运行以独立 storage 和恢复的代码快照控制交叉污染，记录实际配置和任务难度。

| 维度 | 要记录的实际证据 |
| --- | --- |
| 任务质量 | 是否完成预先定义的目标，最终代码/测试结果，错误定位是否正确，遗漏证据是否导致返工 |
| 恢复能力 | 预先植入的中段事实能否找到，精确页/导出哈希是否一致，来源与 completeness 是否正确 |
| 模型使用与缓存 | 宿主或提供方实际报告的 input/output、cache read/write token；估算值另列，不能代替缺失的真实计数 |
| 成本与延迟 | 可核对的实际计费或明确的价格计算依据、整任务时间、capture/search/recall 延迟及额外调用 |
| 本地开销 | archive 与索引体积、后台进程存活、归档失败率；默认无删除期限，GC 仍为明确执行 |

先报告每个配对任务原始结果与差异，再讨论总体趋势。少量探索样例不足以支持统计显著、普遍节省或生产级认证。如果没有质量收益，或缓存/召回开销抵消收益，应调整触发策略或限定适用场景，不能凭合成字符比例继续宣传。

## 7. 实施时必须保留的约束

原始捕获 UTF-8 数据先归档并校验；完整性与本地哈希分离；来源身份不变；agent/workspace/session 隔离；用户和助手正文不改；Codex/Kimi native capture-only；OpenCode 继续使用 Node 子进程；默认 ingress OFF；只处理当前可见项目；已知 partial/filtered 不再次压缩；marker 必须有哈希绑定凭据；RTK 提示不执行且源库只读；hook fail-open；上游工具不重试；默认无自动删除期限，GC 先退役元数据再处理无引用 blob。

不提交私有 archives、配置备份、临时 Kimi 凭据或生成的本机接入配置。发布、真实账号试验与宿主配置修改属于后续阶段，不能由本评估文档自动视为已授权或已完成。

**建议下一轮范围：阶段 A 与 B。** 这能得到一个测试可信、边界可靠、适合交给真实宿主验收的候选版本；阶段 C/D 再决定当前架构的实际收益和适用边界。

## 8. 实施进度（2026-10-05）

阶段 A/B 已完成。F01–F08 按原方案修复，回归中另外发现并修复了并发首次创建
`config.json` 的 Windows EPERM：初始配置完整发布且不覆盖并发获胜者。全局链固定
仍保护同一来源证据，跨会话 view 不继承来源链的可变身份或活跃轮次。
本节不改写上述评估基线；最终实际检查结果见 [验证记录](RELEASE_VALIDATION.md)。
Windows 全套 179 项：177 通过、0 失败、2 项平台跳过，正常退出；离线安装包与
Windows smoke 均通过。实现、兼容性及剩余边界见 [完善报告](IMPLEMENTATION_REPORT.zh-CN.md)。
阶段 C/D 的真实宿主、Bun、RTK 二进制和任务质量/成本验收仍未执行。
