> Historical v0.1 reference. The current implementation and verified boundaries are documented in the root README and docs/RELEASE_VALIDATION.md.

# 通用 Coding Agent Context Memory Manager
## V1 开发需求文档（启发式 / 建设性版本）

> 面向：Claude Code CLI、OpenAI Codex CLI、Kimi Code CLI、OpenCode CLI  
> 平台：Windows 10 / Windows 11  
> 技术栈：TypeScript / Node.js  
> 文档定位：明确目标、底线、关键行为和交付边界；不把内部实现细节定死，允许工程团队继续调研、替换和优化实现。

---

# 1. 项目背景

当前 Coding Agent 在长任务中普遍存在一个问题：

随着 Tool Call / Tool Result 不断积累，Working Context 会迅速膨胀。大量已经完成、未来可能不再需要、或者只需要保留结论的信息，会持续占据上下文。

宿主 Agent 最终通常只能选择：

- 整段压缩；
- 摘要历史；
- 丢弃旧工具结果；
- 触发原生 Compaction；
- 或在上下文接近上限时退化。

这些方案通常存在两个问题：

1. **压缩决策不够精细**：大量 Tool Result 被一视同仁处理；
2. **历史恢复能力不足**：一旦从 Working Context 消失，原始事实可能再也无法精确找回。

本项目希望构建一个独立于具体 Coding Agent 的 **Context Memory Manager**，专门管理 Tool Call / Tool Result 的生命周期。

项目核心思想：

> **Never destroy history. Manage visibility.**

更具体地说：

> **Compaction 永远不直接等价于删除事实，而只是改变事实在 Working Context 中的可见层级。**

本项目不试图成为完整的通用长期记忆系统，也不在 V1 中重写 User / Assistant 对话历史。

V1 聚焦一件事：

> **用尽量低的成本，对 Tool Context 做可逆、智能、分层的管理。**

---

# 2. 项目定位

这是一个全新的独立项目。

现有 `fast-jev-compaction` 只作为：

- 原型参考；
- Jev 相关思路参考；
- Claude Code 接入经验参考；

不承担兼容其旧项目结构、API 或内部设计的义务。

本项目从一开始按照“通用 Context Manager”设计。

---

# 3. V1 必须实际支持的平台

V1 必须真实支持以下四个本机 Coding Agent CLI：

1. Claude Code CLI
2. OpenAI Codex CLI
3. Kimi Code CLI
4. OpenCode CLI

要求：

- 不是仅仅预留 Adapter 接口；
- 四个平台都必须有实际可运行的 Adapter；
- 以各平台“当前稳定最新版”为目标；
- 不要求兼容历史版本；
- 不要求支持网页端、云端 Agent 或远程托管任务。

如果某个平台官方扩展机制不足：

- 优先使用官方 Hook / Plugin / MCP / 生命周期能力；
- 允许 wrapper、launcher、会话监听等外围接管方式；
- 不修改 Agent 本体；
- 不做二进制注入；
- 不依赖脆弱的内存 Hook；
- 不为了追求“统一接入方式”而显著增加项目复杂度。

---

# 4. 核心产品目标

V1 的主要目标不是“压得越狠越好”，而是：

1. 减少 Tool Context 对 Working Context 的长期占用；
2. 尽量避免重要信息被错误移出当前上下文；
3. 所有被压缩或驱逐的 Tool 原始数据仍可恢复；
4. 在宿主 Agent 自己进行全局 Compaction 之前，优先通过 Tool Context 管理释放空间；
5. 保持额外模型成本可控；
6. 在 Claude Code / Codex / Kimi Code / OpenCode 之间保持统一的核心逻辑；
7. 不为了理论完整性过度复杂化实现。

优先级：

> **正确性 > 可逆性 > 任务连续性 > 压缩率**

V1 不设置“至少压缩 50%”之类硬 KPI。

压缩率只是结果指标，不是驱动系统冒险的目标。

---

# 5. V1 非目标

以下内容明确不属于 V1 的核心交付范围：

- 不压缩 User 消息；
- 不压缩 Assistant 普通自然语言消息；
- 不保存完整 User / Assistant 会话灾备快照；
- 不建设向量数据库；
- 不做复杂跨 Agent 共享记忆；
- 不做自动跨 Agent Recall；
- 不做复杂 Web Dashboard；
- 不做成熟安装器；
- 不做一键部署工具；
- 不做重型 Benchmark 平台；
- 不做自动学习阈值；
- 不做极端断电级强一致性设计；
- 不做复杂高并发服务端架构；
- 不要求 macOS / Linux 支持；
- 不要求历史版本 Agent 兼容；
- 不要求自动关键词检索历史；
- V1 Recall 不需要做分页、局部片段搜索、向量搜索。

---

# 6. 核心概念

建议至少存在以下逻辑层级。

注意：名称可以调整，但语义必须保持。

## 6.1 HOT

仍然以完整形式存在于 Working Context 中的 Tool 信息。

典型包括：

- 当前正在使用的信息；
- 最近生成的信息；
- 被 Pin 的信息；
- 刚 Recall 回来的信息；
- Jev / Retention Scorer 判断未来仍明显有价值的信息。

---

## 6.2 CAPSULE

不再保留完整 Tool Result，但在 Working Context 中保留高信息密度语义摘要。

Capsule 不是原始事实源。

Capsule 只是：

- 工作记忆；
- 高密度压缩表示；
- Recall 导航线索；
- 当前任务继续推理时的最小足够信息。

原始数据仍然存在 Archive 中。

---

## 6.3 EVICT

Tool Interaction 从当前 Working Context 中完全退出。

注意：

> EVICT ≠ DELETE

EVICT 只代表：

> 不再占据当前 Working Context。

原始历史仍存在 Archive。

---

## 6.4 ARCHIVE

持久保存 Tool 原始信息。

Archive 是原始历史的唯一可信来源。

Capsule、Descriptor、Scorer 结果、Chain 摘要等都不能替代 Archive。

---

# 7. 核心系统不变量

以下应视为整个系统真正的底线。

## 7.1 Archive 成功后才能压缩

任何 Tool Interaction 只有在确认 Archive 写入成功后，才允许：

- CAPSULE；
- EVICT；
- 从 Working Context 移走完整原文。

如果 Archive 写入失败：

> **必须 KEEP。**

---

## 7.2 Capsule 不是事实源

任何 Capsule：

- 都可能不完整；
- 都可能被 Cheap Model 概括；
- 都可能存在信息损失。

因此：

> Archive 原始数据始终具有最高优先级。

---

## 7.3 Recall 后自动重新 HOT

一旦 Agent 主动 Recall 某段历史：

- 视为它重新重要；
- 自动提升为 HOT；
- 进入最短保护期；
- 之后根据是否继续被使用动态延长或解除保护。

---

## 7.4 有副作用的工具至少保留 Capsule

以下类型操作不能无痕 EVICT：

- Write；
- Edit；
- Patch；
- Delete；
- git commit；
- 部署；
- 数据库写入；
- 创建/修改外部资源；
- 发送消息；
- 修改环境；
- 其他明显产生外部状态变化的行为。

即使 Retention Scorer 给出极高 `safeToEvict`：

> 仍至少保留 Capsule。

原因：

这类 Tool Call 的价值不只是输出文本，而是“发生过某件事”。

---

## 7.5 Context Manager 自己的内部工具不进入普通管理链

例如：

- `context_recall`
- `context_pin`
- `context_unpin`
- 内部诊断工具
- 状态查看工具

它们可以进入审计日志，但：

- 不参与 Tool Chain；
- 不参与 KEEP / CAPSULE / EVICT；
- 不再次被归档和压缩；
- 避免自递归污染。

---

# 8. 生命周期总流程

推荐整体逻辑如下：

```text
Tool Call 完成
   ↓
立即 Archive
   ↓
生成 Descriptor
   ↓
记录基础关系 / Chain 信息
   ↓
暂时保留完整内容
   ↓
持续观察 Context Pressure
   ↓
达到整理时机
   ↓
规则层预判断
   ↓
Retention Scorer（默认 Jev）
   ↓
KEEP / CAPSULE / EVICT
   ↓
如需 Capsule：
确定性信息抽取 + Cheap Model
   ↓
更新 Working Context
   ↓
未来必要时 context_recall
   ↓
恢复完整原始 Tool Interaction
   ↓
重新进入 HOT
```

关键设计原则：

> **不要 Tool 一结束就立刻调用多个模型。**

Tool 完成时最重要的是：

1. Archive；
2. Descriptor；
3. 建立必要关系。

真正的模型判断应主要发生在 Context Pressure 出现时。

---

# 9. Context Pressure

V1 不应简单写死：

```text
70% 开始压缩
50% 停止压缩
```

应采用“自适应压力管理”。

系统可综合：

- 当前模型 Context Window；
- 当前已使用 Token；
- 剩余 Token；
- 最近 Tool Result 增长速度；
- 是否连续产生大结果；
- 当前 HOT 占用；
- CAPSULE 占用；
- 最近任务活跃程度；
- 宿主 Agent 原生 Compaction 的接近程度；
- 当前策略档位。

默认用户体验可以只暴露：

- 保守；
- 平衡；
- 激进；

V1 默认：

> **平衡**

不要求建立特别复杂的数学模型。

目标是：

> 简单、合理、可调、可观测。

---

# 10. Retention Scorer

## 10.1 抽象

Jev 不是核心依赖。

系统应定义统一的：

```ts
RetentionScorer
```

Jev 是 V1 默认实现。

未来可以替换成：

- 本地小模型；
- 其他 API；
- 规则模型；
- 专门训练的分类模型。

---

## 10.2 单一评分

V1 不使用复杂多维评分。

统一输出：

```ts
safeToEvict: number // 0.0 ~ 1.0
```

语义：

> 在原始 Tool Interaction 已经可靠 Archive、未来可以 Recall 的前提下，将它从当前 Working Context 移出去有多安全？

大致解释：

```text
0.0 → 明显不能移出
0.5 → 不确定
1.0 → 高度安全
```

最终动作不是只由这个数字决定。

还必须结合：

- Pin；
- Tool 副作用；
- 当前 Chain；
- Recall 保护期；
- Context Pressure；
- 确定性规则层；
- 模型可用性；
- Capsule 能力。

---

# 11. Scorer 上下文策略

Scorer 可以读取 User / Assistant 对话作为只读判断依据。

但这些消息：

- 不被本项目压缩；
- 不被本项目改写；
- 不被当作 Tool Memory 管理。

Scorer 应采用分层上下文策略。

## 第一层

默认只发送高信息密度上下文：

- 当前任务状态；
- 最近相关 User / Assistant 内容；
- Tool Descriptor；
- Tool Chain 信息；
- 当前 Tool Interaction；
- 必要约束。

## 第二层

如果第一次判断明显模糊或证据不足：

- 扩大上下文范围；
- 再判断一次。

避免每次评分都发送整个长会话。

---

# 12. KEEP / CAPSULE / EVICT

具体阈值不要在产品要求里写死。

建议 V1 配置为可调整。

参考逻辑：

```text
低 safeToEvict
    ↓
KEEP

中间区域
    ↓
CAPSULE

极高 safeToEvict
    ↓
EVICT
```

但实际策略要被规则层约束。

例如：

```text
PINNED → KEEP

刚 Recall → KEEP

Archive 失败 → KEEP

Capsule 生成失败 → KEEP 或保守降级

有副作用 → 至少 CAPSULE

明显 Error / Failure → 至少 CAPSULE

极高 safeToEvict + 无保护条件 → EVICT
```

---

# 13. 确定性规则层

V1 不希望变成庞大的硬编码规则系统。

只固定真正重要的底线。

可识别的高价值结构包括：

- 文件路径；
- URL；
- ID；
- 版本号；
- 命令与参数；
- exit code；
- error；
- exception；
- traceback；
- stack frame；
- 测试结果；
- build verdict；
- diff file；
- diff hunk；
- 函数名；
- 类名；
- 配置项；
- 数据库对象；
- 外部资源标识；
- 明确决策；
- 明确约束；
- 最终成功/失败状态。

这些信息可以用于：

- Descriptor；
- Capsule；
- Tool Chain 识别；
- 保守规则；
- Scorer 辅助上下文。

规则系统的原则：

> **少而关键。**

---

# 14. Tool Descriptor

每个 Tool Interaction Archive 后，应尽快生成一个轻量 Descriptor。

Descriptor 应尽量通过本地确定性逻辑产生。

示例：

```text
Tool: Bash
Command: npm test
Status: error
Size: 18421 chars

Salient:
- FAIL tests/auth.test.ts
- TypeError: validateToken is not a function
- src/auth/token.ts:417
- 83 passed, 1 failed
```

另一个例子：

```text
Tool: Read
Path: src/auth/token.ts
Range: 350-460
Size: 9.2 KB
```

Descriptor 的价值：

- 让 Retention Scorer 不必看到完整大结果；
- 帮助 Chain 识别；
- 帮助 Capsule；
- 提高模型判断质量；
- 降低 API 成本。

---

# 15. Tool Call / Tool Result 关系

V1 以 Tool Interaction 为主要决策单位。

但允许轻量非对称优化。

例如：

```text
Tool Call:
npm test

Tool Result:
180 KB
```

不需要为了压缩 Result 而把 `npm test` 这几个 Token 也强行丢掉。

允许：

- 短 Tool Call 保留；
- 大 Tool Result Capsule；
- Tool Input 只做轻量处理。

但：

> 不要给 Tool Call 和 Tool Result 分别建立两套独立复杂评分系统。

---

# 16. Tool Chain

V1 允许把多个相关 Tool Interaction 识别为一个逻辑工作链。

例如：

```text
grep
  ↓
read
  ↓
edit
  ↓
npm test
  ↓
read error
  ↓
edit
  ↓
npm test
```

可以视为：

> “修复 authentication test failure”

---

## 16.1 Chain 识别

采用：

> **规则优先 + Cheap Model 辅助**

明显关系可通过：

- 时间邻近；
- 文件路径；
- 命令关系；
- 前后工具类型；
- 相同错误；
- 同一个目标文件；
- 相同符号；
- 测试 → 修复 → 再测试；
- edit → test；

进行识别。

只有边界模糊时才调用 Cheap Model。

---

## 16.2 Chain Archive

Archive 中仍逐个保存原始 Tool Event。

Chain 只是逻辑关系。

不要为了 Chain 把原始事件重新合并成一个不可拆分的大对象。

---

## 16.3 Chain Capsule

当一条 Chain 被 Capsule 化：

建议：

> **一个总 Capsule + 少量关键子事件**

例如：

```text
Chain:
修复 JWT refresh token failure

Summary:
测试失败被定位到旧 JWT secret 被 refreshToken() 使用。
修改 src/auth/token.ts 后测试恢复通过。

Key facts:
- refreshToken() used JWT_SECRET_OLD
- validateToken() used JWT_SECRET
- src/auth/token.ts modified
- final test: 84 passed, 0 failed

Important sub-events:
- Initial failure
- Critical edit
- Final test result
```

不要给每个 Tool Call 都生成独立 Capsule。

---

## 16.4 Chain 生命周期

同一未完成工作链：

- 可以继续追加新 Tool Event；
- Capsule 可以增量更新。

一旦 Chain 明确结束：

> Capsule 冻结。

后续新任务不要持续修改旧 Capsule。

---

# 17. Cheap Model

Cheap Model 主要承担两个角色：

1. Capsule 语义提炼；
2. 模糊 Tool Chain 边界判断。

默认可共用同一个模型。

但配置上允许分别覆盖：

```text
cheap_model
capsule_model
chain_model
```

---

# 18. Capsule 生成方式

Capsule 不应完全交给 LLM 自由总结。

采用：

> **确定性抽取 + Cheap Model 语义提炼**

流程建议：

```text
原始 Tool Interaction
   ↓
确定性提取硬信息
   ↓
Cheap Model 语义总结
   ↓
合并
   ↓
校验
   ↓
Capsule
```

必须优先保护：

- path；
- symbol；
- error；
- command；
- ID；
- version；
- number；
- constraint；
- decision；
- outcome；
- side effect；
- final state。

---

# 19. Capsule 参考结构

结构可调整，但语义建议类似：

```ts
interface MemoryCapsule {
  summary: string;

  facts: string[];

  anchors: string[];

  outcome?: string;

  importantEvents?: Array<{
    type: string;
    summary: string;
  }>;

  sourceToolIds: string[];
}
```

Source ID、Hash、Archive 引用等：

> 尽量由代码附加，不要让 LLM 自己生成。

避免模型编造：

- tool id；
- hash；
- archive path；
- event id。

---

# 20. Recall

V1 Recall 保持简单。

核心能力：

```text
context_recall(tool_call_id)
```

目标：

> 精确恢复完整原始 Tool Call + Tool Result。

V1 不要求：

- 关键词搜索；
- FTS；
- 向量检索；
- 局部片段检索；
- 分页；
- 智能搜索；
- 自动 Recall。

---

## 20.1 Recall 行为

Recall 后：

```text
Archive
   ↓
完整原文
   ↓
Working Context
   ↓
HOT
   ↓
短暂保护
```

保护采用：

> 最短保护期 + 动态延长/解除

不要写死为必须 3 轮或 5 轮。

只要行为合理即可。

---

## 20.2 跨 Session Recall

同一：

```text
Agent + Workspace
```

默认允许跨 Session Recall。

例如：

昨天 Codex Session A Archive 的 Tool Call，

今天 Codex Session B 仍然可以 Recall。

---

## 20.3 跨 Agent 隔离

默认：

```text
Claude Code Archive
Codex Archive
Kimi Code Archive
OpenCode Archive
```

相互隔离。

未来如果需要跨 Agent 共享，可以另行设计。

不是 V1 默认功能。

---

# 21. Pin / Unpin

提供：

```text
context_pin
context_unpin
```

Pin 可以针对：

- Tool Event；
- Tool Chain。

默认 Pin：

> 只在当前 Session 生效。

允许显式：

> 持久 Pin。

被 Pin 内容：

- 不参与自动 EVICT；
- 不参与自动 CAPSULE；
- 继续保持 HOT。

---

# 22. Storage

V1 使用：

> **SQLite + 外部 Blob 自动混合存储**

---

## 22.1 SQLite 负责

建议包括：

- Agent；
- Workspace；
- Session；
- Tool Event；
- Tool Chain；
- Capsule；
- Retention Score；
- Decision；
- Recall 记录；
- Pin；
- Provider 调用；
- Provider failure；
- Token 统计；
- Cost 统计；
- Archive policy；
- Blob reference。

---

## 22.2 Blob

大型 Tool Result 存入外部 Blob。

SQLite 保存：

- hash；
- length；
- storage type；
- blob path/ref；
- metadata。

小型结果可直接存在 SQLite。

大小阈值：

> 可配置，不需要产品层写死。

---

## 22.3 Content Addressing

Blob 建议按内容 Hash 管理。

例如：

```text
SHA-256
```

同样的内容：

> 只存一份。

Event 只引用 Blob。

---

# 23. Archive Retention

默认：

> 无限期保存。

但允许用户配置：

- 保留天数；
- 最大容量；
- 清理策略。

系统允许自动清理冷 Archive。

但清理前必须避免破坏：

- 当前 HOT；
- 当前 CAPSULE 所依赖数据；
- PINNED 数据；
- 仍被保护的数据。

不需要 V1 就设计特别复杂的 GC。

---

# 24. Workspace Identity

采用混合识别。

主要依据：

- 规范化绝对路径；
- 持久 Workspace ID；
- Git 信息辅助重关联。

项目移动 / 改名后：

如果能可靠确认是同一项目：

> 重新关联。

如果不能可靠确认：

> 宁可新建 Workspace。

不要做猜测式合并。

---

# 25. 并发

V1 只要求基本并发安全。

场景：

- 同时打开两个 Agent；
- 同时打开两个 Session；
- 同时处理两个项目。

SQLite 应采用合理事务和锁处理。

目标：

> 不损坏数据，不互相踩写。

不需要为高 QPS 服务端并发做复杂架构。

---

# 26. Provider 层

V1 以：

> OpenAI-compatible API

为主要模型调用接口。

同时原生支持：

- Anthropic；
- Gemini。

并定义统一：

```ts
ModelProvider
```

以便未来扩展：

- Ollama；
- LM Studio；
- 本地模型；
- 其他厂商；
- 中转服务。

---

# 27. Provider Failover

V1 支持多 Provider / 多模型备用链。

例如：

```text
Primary
  ↓ failure
Backup 1
  ↓ failure
Backup 2
  ↓ failure
Conservative fallback
```

适用于：

- Retention Scorer；
- Capsule Model；
- Chain Model。

---

## 27.1 顺序

顺序完全由用户配置。

系统不自动重排。

例如：

```text
Qwen
DeepSeek
Gemini
Anthropic
```

就严格按此顺序尝试。

即使某 Provider 最近延迟高：

> 系统只记录，不擅自修改优先级。

---

# 28. 模型失败行为

如果：

- timeout；
- 429；
- 5xx；
- network error；
- JSON invalid；
- schema invalid；
- Provider down；

则：

1. 按用户配置切备用 Provider；
2. 全部失败后进入保守规则降级。

降级原则：

> 只有极高把握能安全处理的内容才继续压缩。

否则：

> KEEP。

---

# 29. Archive 失败行为

这是比模型失败更严格的情况。

如果 Archive 写入失败：

> **无条件 KEEP。**

不允许：

- CAPSULE；
- EVICT；
- 删除原始 Tool Result；
- 只留摘要。

---

# 30. Capsule 失败行为

如果 Cheap Model 最终失败：

优先：

> KEEP 原文。

也允许实现非常保守的规则降级。

但禁止：

> 生成一个不可信 Capsule 后直接丢掉原文。

---

# 31. 宿主原生 Compaction

本项目应尽量：

> 在宿主 Agent 自己进行全局 Compaction 前释放 Tool Context。

目标：

```text
Tool Context Manager
   ↓
释放足够空间
   ↓
延迟/避免原生 Compaction
```

如果 Tool Context 已经没有足够安全空间可释放：

> 允许宿主继续自己的 Compaction。

本项目不接管 User / Assistant 压缩。

---

# 32. Adapter 设计原则

核心逻辑只有一套。

不同 Agent 的差异只能尽量收敛在：

```text
adapters/
```

每个 Adapter 负责：

- 捕获 Tool Call；
- 捕获 Tool Result；
- 获得 Session 标识；
- 获得 Workspace；
- 获取 Context 使用信息（如可用）；
- 在适当时机触发 Context Manager；
- 将 KEEP / CAPSULE / EVICT 结果应用回宿主；
- 注册 Recall / Pin 工具；
- 处理宿主生命周期。

---

# 33. Library 与 Daemon

Core 应可作为 Library 使用。

Daemon 允许存在，但原则是：

> 不为了“同时支持 Library + Daemon”维护两套复杂系统。

Daemon 应尽量只是：

> Core 的薄封装。

每个 Adapter 可选择最简单、最可靠的接入方式。

不要为了架构统一而强迫所有 Adapter 使用 Daemon。

---

# 34. 所有可观察 Tool 都纳管

只要 Adapter 能观察到：

- 内置 Tool；
- MCP Tool；
- 第三方 Tool；
- 插件 Tool；

都应进入：

```text
Archive
→ Descriptor
→ Chain
→ Retention
```

例外：

> Context Manager 自己的内部 Tool。

---

# 35. 配置

V1 只做：

> 全局配置。

不做：

- Agent 级覆盖；
- Project 级覆盖；
- 多层 merge；
- 复杂 precedence。

配置建议包含：

```yaml
strategy: balanced

storage:
  path:
  retention_days:
  max_size:
  blob_threshold:

retention:
  scorer:
  keep_threshold:
  capsule_threshold:
  evict_threshold:

providers:
  retention:
    - ...
  capsule:
    - ...
  chain:
    - ...

models:
  cheap_model:
  capsule_model:
  chain_model:

logging:
  level:
  structured:
```

具体字段可由开发团队优化。

---

# 36. 隐私

V1 不强制：

> “原始 Tool 内容禁止发远程模型”。

是否信任远程 Provider：

> 由用户决定。

可以提供可选脱敏能力。

但不是系统硬性要求。

不要为了隐私策略把系统做得过度复杂。

---

# 37. CLI

V1 不需要 GUI。

需要一个实用 CLI。

建议至少支持：

```text
status
sessions
events
chains
capsules
scores
recalls
providers
stats
pin
unpin
config
doctor
```

具体命令名可调整。

CLI 应帮助用户回答：

- 现在 Archive 有多大？
- 哪个 Session 占最多？
- 哪些 Tool 被 EVICT？
- 哪些被 Capsule？
- Jev 给了什么分？
- 哪些内容后来被 Recall？
- 哪个 Provider 失败了？
- 当前节省了多少 Context？
- 为此额外用了多少模型 Token / Cost？

---

# 38. Logging

采用结构化日志。

重要事件至少应可记录：

- tool archived；
- descriptor created；
- chain linked；
- retention scored；
- decision made；
- capsule generated；
- evicted；
- recalled；
- promoted to hot；
- pinned；
- unpinned；
- provider failed；
- provider switched；
- archive failed；
- model fallback；
- native compaction approaching；
- context pressure triggered。

---

# 39. Recall Telemetry

V1 记录但不自动学习。

例如：

```text
toolUseId
chainId
safeToEvict
decision
decisionTurn
recalled
recallCount
turnsUntilRecall
lastRecalledAt
```

未来可统计：

```text
safeToEvict 0.90–0.93
后续 Recall 率多少？

0.93–0.95
多少？

0.95–0.97
多少？
```

用于判断：

- 阈值是否过激；
- Capsule 是否过度压缩；
- Jev 是否可靠。

V1：

> 不自动修改阈值。

---

# 40. 成本控制

系统要避免：

> 为了节省 Context Token，反而调用大量模型。

原则：

- 明显情况用规则；
- 不确定情况才用模型；
- 能批处理就批处理；
- Tool 完成时不立即触发大量 AI 调用；
- Context Pressure 出现时再做批量整理。

建议记录：

```text
context tokens saved
scorer tokens spent
capsule tokens spent
chain-model tokens spent
estimated API cost
```

不要求 V1 做复杂财务计算。

---

# 41. 推荐内部模块

以下仅为推荐，不是强制。

```text
src/
├─ core/
│  ├─ context-manager.ts
│  ├─ pressure.ts
│  ├─ retention.ts
│  └─ lifecycle.ts
│
├─ storage/
│  ├─ sqlite.ts
│  ├─ blob-store.ts
│  ├─ archive.ts
│  └─ schema.ts
│
├─ scoring/
│  ├─ scorer.ts
│  ├─ jev.ts
│  └─ fallback.ts
│
├─ capsule/
│  ├─ extractor.ts
│  ├─ compressor.ts
│  └─ schema.ts
│
├─ chains/
│  ├─ linker.ts
│  └─ model-linker.ts
│
├─ providers/
│  ├─ provider.ts
│  ├─ openai-compatible.ts
│  ├─ anthropic.ts
│  └─ gemini.ts
│
├─ recall/
│  ├─ recall.ts
│  └─ protection.ts
│
├─ adapters/
│  ├─ claude-code/
│  ├─ codex/
│  ├─ kimi-code/
│  └─ opencode/
│
├─ cli/
│
└─ shared/
```

工程团队可以重构。

要求是：

> 核心逻辑不要和单个 Agent Adapter 深度耦合。

---

# 42. 数据模型建议

不是最终 Schema，仅表达语义。

## ToolEvent

```ts
interface ToolEvent {
  id: string;

  agent: string;
  workspaceId: string;
  sessionId: string;

  toolCallId: string;

  toolName: string;

  input: unknown;

  resultRef: string;

  status: 'ok' | 'error';

  createdAt: number;

  descriptor?: ToolDescriptor;

  chainId?: string;

  pinned?: boolean;

  persistentPin?: boolean;

  state:
    | 'hot'
    | 'capsule'
    | 'evicted';

  safeToEvict?: number;
}
```

---

## ToolChain

```ts
interface ToolChain {
  id: string;

  workspaceId: string;
  sessionId: string;

  eventIds: string[];

  status:
    | 'active'
    | 'completed';

  capsuleId?: string;

  createdAt: number;
  updatedAt: number;
}
```

---

## Capsule

```ts
interface Capsule {
  id: string;

  sourceEventIds: string[];

  summary: string;

  facts: string[];

  anchors: string[];

  outcome?: string;

  frozen: boolean;

  createdAt: number;
  updatedAt: number;
}
```

---

# 43. 状态变化示例

## 普通 Read

```text
Read file
   ↓
Archive
   ↓
HOT
   ↓
Context Pressure
   ↓
safeToEvict = 0.98
   ↓
EVICT
```

---

## 测试失败

```text
npm test
   ↓
error
   ↓
Archive
   ↓
Descriptor:
1 failed / 83 passed
   ↓
safeToEvict = 0.72
   ↓
CAPSULE
```

---

## Edit

```text
Edit src/auth.ts
   ↓
Archive
   ↓
side-effect
   ↓
即使 safeToEvict = 0.99
   ↓
至少 CAPSULE
```

---

## Recall

```text
Agent:
context_recall(tool_call_id)

   ↓
Archive exact original
   ↓
inject
   ↓
HOT
   ↓
minimum protection
   ↓
dynamic release
```

---

# 44. Windows

V1 只考虑：

- Windows 10；
- Windows 11。

不要求：

- macOS；
- Linux；
- WSL 特殊适配。

路径、进程、配置、CLI、SQLite、文件锁等：

> 优先按 Windows 真实使用体验设计。

---

# 45. 安装

V1 只需要开发者型安装。

例如：

```bash
npm install
npm build
npm link
```

允许：

- 手动配置；
- 手动注册 Adapter；
- 手动修改 Agent 配置。

暂不建设：

- MSI；
- EXE Installer；
- 一键安装；
- 自动发现所有 Agent。

---

# 46. 测试

不需要复杂 Benchmark。

至少要求：

## Core

- Archive；
- SQLite；
- Blob；
- KEEP；
- CAPSULE；
- EVICT；
- Recall；
- Pin；
- Provider failover；
- Tool Chain；
- Capsule update；
- Archive failure fallback。

## Adapter

四个平台至少：

- 能捕获 Tool；
- 能 Archive；
- 能应用 Context 决策；
- 能 Recall；
- 能正常运行。

大量真实长会话测试：

> 由用户自己手动验证即可。

---

# 47. 必须测试的关键失败场景

虽然不要求重测试体系，但以下逻辑必须可靠：

### Archive failure

```text
Archive fail
→ KEEP
```

### Scorer failure

```text
Primary fail
→ Backup
→ Backup
→ conservative rule
→ KEEP if uncertain
```

### Capsule failure

```text
Capsule fail
→ KEEP
```

### Recall

```text
Recall exact original
→ HOT
```

### Side-effect Tool

```text
side-effect
→ never silent EVICT
```

### Internal Tool

```text
context_recall
→ audit only
→ no recursive archive
```

---

# 48. 成功标准

V1 可以认为“成功”的标准不是某个压缩百分比。

而是：

1. 四个 Agent 都能真实接入；
2. Tool 原始历史可以持续 Archive；
3. Archive 成功前不会压缩；
4. Context Pressure 出现时能执行 KEEP / CAPSULE / EVICT；
5. Jev 可以作为默认 Retention Scorer；
6. Cheap Model 可以生成高质量 Capsule；
7. Tool Chain 能明显减少碎片化摘要；
8. 有副作用的 Tool 不会无痕消失；
9. 被 EVICT 的 Tool 可以通过 `tool_call_id` 精确 Recall；
10. Recall 后自动回到 HOT；
11. Provider 故障可以按用户顺序自动切换；
12. 模型全部失败时系统保守降级；
13. 同 Agent + Workspace 可跨 Session Recall；
14. 不同 Agent 默认隔离；
15. 系统不会为了“压缩率”牺牲正确性；
16. 能通过 CLI 和日志解释系统做了什么。

---

# 49. 建议开发顺序

建议不要一开始同时开发四个 Adapter。

## Phase 1：Core

先完成：

- SQLite；
- Blob；
- ToolEvent；
- Archive；
- Descriptor；
- Retention；
- Capsule；
- Recall；
- Pin；
- Provider abstraction。

先用模拟 Tool Event 测通。

---

## Phase 2：一个 Agent 打通

建议选择：

- Claude Code
或
- OpenCode

先完整跑通：

```text
capture
→ archive
→ pressure
→ score
→ capsule/evict
→ recall
```

确保 Core 设计合理。

---

## Phase 3：Tool Chain

加入：

- 规则 linking；
- Cheap Model 辅助；
- Chain Capsule；
- incremental update；
- completed freeze。

---

## Phase 4：剩余 Adapter

依次完成：

- Claude Code；
- Codex；
- Kimi Code；
- OpenCode。

不要为了四个平台“接口统一”牺牲可靠性。

---

## Phase 5：Provider Failover + CLI

完成：

- OpenAI-compatible；
- Anthropic；
- Gemini；
- user-defined fallback order；
- CLI；
- logs；
- stats。

---

## Phase 6：真实使用打磨

用户手动长时间使用。

重点观察：

- 哪类 Tool 总是被错误 EVICT；
- 哪类 Capsule 不够用；
- 哪个 safeToEvict 区间 Recall 率高；
- Chain 是否分得合理；
- Provider 成本；
- Context 是否明显延长。

---

# 50. 未来 V2 可考虑

这些不是 V1 要求。

如果 V1 验证成功，再考虑：

- SQLite FTS5；
- Archive 搜索；
- partial recall；
- pagination；
- `chain_id` recall；
- cross-agent sharing；
- embeddings；
- semantic retrieval；
- automatic proactive recall；
- learned retention model；
- adaptive threshold；
- cross-project memory；
- persistent decision memory；
- Web Dashboard；
- installer；
- daemon-first mode；
- multi-machine archive；
- cloud sync。

---

# 51. 对工程团队的要求

这不是一份“照着字段机械实现”的规格书。

工程团队应主动：

- 调研四个平台当前最新版真实扩展能力；
- 查阅官方 Hook / Plugin / MCP / Session API；
- 验证哪些 Adapter 能真正修改 Working Context；
- 如果某个平台只能外围接管，应提出最简单可靠方案；
- 如果本文某个实现建议明显会增加复杂度，应提出更简单替代；
- 如果发现更好的 Storage / Recall / Hook 设计，可以修改；
- 如果 Jev 接入方式不适合某个平台，可以在保持 `RetentionScorer` 抽象的前提下适配。

但不能破坏以下核心原则：

> Archive before compaction.

> EVICT is not DELETE.

> Capsule is not source of truth.

> Recall restores exact original Tool history.

> Side-effect Tools never disappear silently.

> User / Assistant messages are not modified by V1.

> Core must remain independent from any single Coding Agent.

> Do not add major complexity unless it produces clear real-world value.

---

# 52. 最终一句话

本项目要解决的不是：

> “怎么把上下文摘要得更短？”

而是：

> **“怎么让 Coding Agent 在长期任务里，只把真正需要的 Tool 信息放在眼前，同时又永远有能力找回过去的原始事实。”**

最终系统应该更像：

> **Tool Context 的分层内存管理器**

而不是：

> **一次性的摘要器。**
