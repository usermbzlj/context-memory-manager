> Historical v0.1 reference. The current implementation and verified boundaries are documented in the root README and docs/RELEASE_VALIDATION.md.

# 开发日志 · Context Memory Manager（Core 原型 → 系统性升级 → 冻结）

> 版本：v0.1.0 · 状态：**已冻结**（2026-09-21）
> 这份日志记录的不只是"做了什么"，更重要的是"为什么这样做"——每一次关键决策背后的心路历程。

---

## 1. 背景：一个反直觉的起点

用户上传了一份完整的 V1 PRD《Coding Agent Context Memory Manager》。PRD 的核心主张非常锋利，一句话就能概括：

> **永远不销毁历史，只管理可见性（Never destroy history. Manage visibility.）**

这和市面上大多数"上下文压缩"方案正好相反。常见的做法是截断、摘要、丢弃——看起来省 token，实际上在悄悄销毁调试现场：一次被截断的失败测试输出，可能就是 agent 三轮之后真正需要的证据。PRD 抓住了这个痛点：**先归档（byte-identical），再管理可见性**。归档是事实源，压缩只是视图。

我的第一个心路：PRD 很大（从 SQLite 到四个 CLI Adapter 到 per-agent 配置），但如果一上来就铺全，很容易做出一个"什么都沾一点、什么都不对"的系统。所以我把 PRD 拆成两层：**不变量层**和**能力层**。不变量是这个系统的灵魂（archive 失败 → KEEP；capsule 不是事实源；recall 必须字节一致；副作用不静默驱逐……），能力是血肉。先把不变量钉死，能力可以一层层长。

## 2. 决策一：直接开始搭建 Core 原型

用户给了两个选项：先深入讨论 vs 直接开始搭建 Core。用户选了"直接开始搭建 Core 原型"。

我的心路是：这个决策是对的。PRD 本身已经把 Phase 1 定义得很清楚（§21：先实现 Core，用 Fake/Scripted provider 验证全链路），而且这类系统的风险不在"需求理解"，而在"不变量能不能在代码里真正立住"。纸上谈再多，不如跑一个 `npm run demo` 看 archive → pressure → tidy → recall 全链路转起来。讨论可以并行，但代码必须先行。

**Phase 1 交付（2026-09-21 上午）：**
- SQLite（小数据）+ SHA-256 内容寻址 Blob（大 payload）双层存储
- 生命周期状态机：ARCHIVE → HOT → KEEP / CAPSULE / EVICT
- 确定性 Descriptor（工具类型、副作用标记、token 估计、链路线索）
- RetentionScorer：Jev 形状的模型评分 + 保守的确定性 fallback
- 规则版 Tool Chain 链接（路径重叠、edit→test、failure→fix）
- 精确 Recall、Pin/Unpin、12 个 CLI 命令
- 三个 LLM provider（OpenAI-compatible / Anthropic / Gemini）顺序故障转移
- 自适应压力计算（used/window + growth + hot-load）
- **12 个测试，全部通过**；`npm run demo` 跑通全链路

但这里埋了一个我当时就隐约不安的点：**原型跑得通，不等于 PRD 的承诺兑现了**。有些差距是"写代码时为了先跑起来"主动欠下的技术债，有些则是"以为实现了、其实没实现"的沉默问题。后者最危险——因为它不会报错，只会误导。

## 3. 决策二：主动做差距分析

Phase 1 交付后，我没有直接往下做 Phase 2，而是提议先做一次**源码级的差距分析**：把 PRD 逐条对照实现，找出"说好了但没做到"的地方。

心路：这一步的价值在于**诚实**。原型阶段最容易犯的错误是把 demo 跑通当成"做完了"，然后带着一堆沉默的假设进入下一阶段。到时候每个新功能都建在流沙上。差距分析就是一次"还债盘点"——把每一笔债摆到台面上，标价、排序，再决定还哪些。

分析结果：**8 个差距**，按"沉默危害程度"排优先级：

| 优先级 | 差距 | 为什么这个排序 |
|---|---|---|
| P0 | Capsule/Chain 的 provider 配置是 dead config（配了但业务代码从没读过） | **沉默误导**：`doctor` 会显示"已配置"，用户以为有语义提炼，实际全是截断+去重。这是最坏的一种 bug——不报错，但撒谎。 |
| P0 | 模型全挂时 fallback 评分仍可能驱逐（0.85 上限 vs aggressive 0.8 阈值） | **违背核心承诺**：PRD §28 要求"模型失效时保守降级"。最需要保守的时候反而驱逐了，等于安全气囊在撞车时弹出方向盘。 |
| P1 | tidy 只做单轮，`release` 阈值只记录不参与停止 | **控制循环残缺**：压力没降到 release 以下就停了，等于装了恒温器但不接线。 |
| P1 | workspaceId 直接当路径用，无规范化 | **跨 session recall 的根基不稳**：同一个项目用相对/绝对路径各记一次，recall 就找不到另一半。 |
| P1 | SQLite 无 WAL、无 busy_timeout、归档多步写无事务 | **并发下的正确性**：单进程 demo 没问题，多进程一跑就可能 SQLITE_BUSY 或写一半。 |
| P2 | 评分 N+1（每个事件一次模型调用） | **成本**：长会话直接 N 次 HTTP 调用，又贵又慢。 |
| P2 | Chain 只有规则，无模型辅助 | **智能**：PRD 要的是"规则优先、模糊时模型辅助"。 |
| P2 | 一批小缺口（日志、遥测、pin 作用域、GC、幂等……） | **完整性**：每个都不大，但都是 PRD 白纸黑字写了的。 |

排序的心路：**P0 是"撒谎"和"背叛承诺"，必须先还；P1 是"地基"，不还的话上层越盖越歪；P2 是"优化"，还了更好，不还不致命。** 这个顺序后来在升级中被证明是对的——P0 的两项改动都触及了 retention 引擎的核心判断逻辑，如果留到后面，测试和上层逻辑都要返工。

## 4. 决策三：系统性升级

用户说"系统性地升级+优化"。我的心路：这八个差距不能"逐个打补丁"，因为它们互相牵连（比如批量评分改了 scorer 接口，tidy 循环改了调用方式，fallback 不驱逐改了决策语义——三个都动 retention 引擎）。所以策略是：**一次重构，统一接口，一次性把测试补齐**。分八次改，中间状态会长期处于"半新半旧"，风险更高。

### 4.1 P0：把"撒谎"的地方改成"说真话"

**接通 provider 配置。** 实现了 `ModelBackedCheapModel`：走 `providers.capsule` 的故障转移链做真正的语义提炼，但保留确定性摘要作为降级路径（模型失败 → 确定性摘要 → 再失败 → KEEP）。这里的心路是 PRD §30 给的指引："允许非常保守的规则降级，但禁止生成不可信 Capsule 后直接丢掉原文。" 所以降级链是**三层**而不是两层——每一层失败都有更保守的一层接着，永远不会"为了压缩而撒谎"。没配 provider 时保持纯确定性行为，零配置也能跑。

**fallback 永不驱逐。** 修复点选在 `RetentionEngine.decide` 而不是 scorer 本身。心路：scorer 只负责打分（"这个事件有多大把握可以丢"），"能不能驱逐"是引擎的决策权。把"fallback 来源 ⇒ 上限 capsule"写进引擎，语义更干净——以后换任何 scorer，只要标记为 fallback，自动继承这个保护。这也顺手解耦了"评分"和"策略"的纠缠。

### 4.2 P1：把地基打牢

**tidy 循环到 release。** 改成：每轮整理完重算压力，压力仍高于 release 且上一轮确实释放了东西，就再来一轮，上限 3 轮、每轮 8 个事件，同一轮内已决事件不重评。心路：这里最怕的是**无限循环**（评了分但压力就是降不下来），所以停止条件设计了三重保险：压力达标 / 无状态变化 / 轮数上限。宁可保守停早，不追着 release 死磕——因为 release 是"期望"，不是"必须"。

**workspace 规范化。** 路径类 ID 做 `resolve + normalize`，顺手把 Git 项目的 remote URL 抓进 `workspaces.git_remote`（这列建表时就留了，一直空着）。心路：PRD §24 要的是"项目搬家/改名后还能重关联"，remote URL 就是干这个的。现在只是 best-effort 采集，为以后做重关联留了钩子——**先把数据攒下来，能力以后长**。

**SQLite 并发。** WAL + 5s busy_timeout + 归档多步写包显式事务。心路：node:sqlite 是同步 API，事务里不能 `await`，这点在实现时要特别小心。选 `BEGIN IMMEDIATE` 而不是 `BEGIN`，是因为多进程场景下延迟拿写锁更容易死锁——**并发问题要在加锁策略上想清楚，而不是靠重试掩盖**。

**Archive 幂等。** 重复 `tool_call_id` 从"报归档失败"改成"返回已有事件"。心路：这其实是分布式系统的经典 lesson——**重试是常态，幂等是义务**。agent 侧重试一次，不应该产生两条记录，更不应该被当成"归档失败"吓用户一跳。

### 4.3 P2：成本、智能与完整性

**批量评分**（一次模型调用评 8 个事件）：心路是 PRD §40 的"能批处理就批处理"。整批失败才整体降级——**批处理不能成为新的单点故障放大器**。

**Chain 模型辅助**（规则优先，模糊边界才问模型，每事件最多一次调用）：心路是"好钢用在刀刃上"。规则能解决的 90% 情况一分钱不花，只有规则拿不准的模糊地带才花模型的钱。失败 → 无链接，**绝不让"智能"环节破坏"记录"环节**。

**小缺口批量修复**：`retention scored` 日志、recall 遥测扩列、pin 按 session 作用域（修了 `UNIQUE` 约束）、recall 支持指定目标 session（re-home，解决"保护期按原 session 的 turn 算、跨 session 后永不过期"的问题）、primary scorer 可配置、archive GC（只删冷数据，HOT/CAPSULE/pin/保护中的一律不动，加 `cmm gc` 命令）。

**数据库迁移**：用 `PRAGMA user_version` 做有序迁移。心路：**不能为了升级丢掉用户已有的数据**。原型阶段的数据库也是数据库，`CREATE TABLE IF NOT EXISTS` 遇到加列/改约束就装死了，必须有真正的迁移机制。

### 4.4 刻意没做的事

- **FTS/向量检索**、**四个 CLI Adapter**、**per-agent 配置覆盖**：都是 PRD 明确划在 V1 范围外的。心路：**克制也是一种决策**。原型阶段把"精确 recall"做扎实，比上一堆半吊子的模糊检索更有价值。README 里如实记录为 deliberate simplifications，不藏着掖着。

## 5. 测试：从 12 到 38

测试从 12 个涨到 38 个（8 个新 suite 覆盖 tidy 循环、fallback 永不驱逐、批量评分、幂等归档、workspace 规范化、GC、pin 作用域、recall re-home、schema 迁移）。心路：**每一个修掉的差距，都应该有一个"如果回退就会变红"的测试钉住它**。否则三个月后没人记得为什么 fallback 不能驱逐，某次重构顺手就改回去了。测试在这里不是"质量保障"，是**决策的化石**——把"为什么这样"编码成"不这样就报错"。

`tsc` 干净，`npm run demo` 全链路正常，`cmm doctor` / `cmm gc` 烟测通过。零运行时依赖（只有 typescript + @types/node 两个 dev 依赖），Windows 路径兼容。

## 6. 冻结

2026-09-21，用户说"先冻住"。当前状态：

- **位置**：`~/workspace/context-memory-manager/`
- **运行**：`npm install && npm run build && npm test`（38/38）/ `npm run demo`
- **PRD §7 不变量**：全部保留，无一松动
- **下一步**（解冻时）：Phase 2 —— 四个 CLI Adapter 调研（Claude Code / Codex / Gemini / OpenCode），把 Core 接到真实 agent 上验证

---

*这份日志写于冻结之时。如果未来解冻继续开发，建议先读一遍 §4 的心路——那些"为什么"比"做了什么"更容易在重构中丢失。*
