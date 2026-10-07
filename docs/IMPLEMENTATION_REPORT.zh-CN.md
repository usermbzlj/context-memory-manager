# 本轮完善报告

日期：2026-10-05。范围：已确认方案的阶段 A/B，恢复 Windows 可信基线并修复八项缺陷。
代码、编译输出、回归测试和使用文档已同步；版本仍为 0.3.0-rc.1，schema 仍为 v4。

## 已完成的修复

| 评估项 | 实际变化 |
| --- | --- |
| F01 工作区身份 | 相对/绝对路径及创建前后的身份稳定；兼容唯一旧 Windows/UNC 身份和会话键，发现等价旧身份冲突时拒绝合并 |
| F02 恢复范围 | restore 仅允许完整的单页 result；input 或部分页不能改变恢复状态和保护期限 |
| F03 宿主截断 | OpenCode 两个捕获路径保留 `metadata.truncated=true` 的 partial 来源；RTK 提示不会覆盖该信息 |
| F04 跨会话链 | target view 不加入或修改 source chain，使用自己的轮次；全局及目标会话链固定仍保护同一来源证据 |
| F05 Unicode | 派生描述、摘要和投影按完整字符截取，持久化、重启、缓存及 pin 恢复保持一致 |
| F06 动态保护 | 评分/摘要等待后和事务内共用保护检查；链重新活跃时，低压力下也能恢复已识别的缓存视图 |
| F07 凭据诊断 | 使用与 verify 共用事件、会话、模式、表示类型及原文/可见文本双哈希校验，损坏源凭据不会漏报 |
| F08 退出与清理 | bridge、proxy、plugin dispose、测试、pack 和 Kimi 等待实际 close；清理继续处理所有资源，未确认退出时保留临时文件 |

回归还复现了并发首次创建 `config.json` 的 Windows EPERM。现在完整发布初始配置，
不覆盖另一个 opener 的获胜设置；显式配置修改保留原来的原子替换方式。

## 本机验收结果

Windows 11 Pro x64，Node 24.19.0，npm 11.17.0：

- `npm test`：179 项，177 通过，0 失败，2 项平台跳过，测试进程正常退出。
- 配置首次创建和三个独立 writer 的竞争测试额外重复 5 次，全部通过。
- `npm run test:pack`：真实 tarball 离线安装、demo、四平台配置/卸载、MCP 握手通过。
- `scripts/windows-smoke.ps1`：隔离 CLI、带空格路径、demo、setup/uninstall、verify 通过。

两项跳过分别是 Windows 文件 symlink 权限条件与 POSIX wrapper 信号语义。
Kimi 测试使用本地 Node 假宿主，真实 SQLite 子进程测试确实关闭句柄后再删除存储。
UNC/跨卷别名测试使用可控 realpath 映射，不访问网络，不能当成真实网络共享验收。
完整日志和历史 Linux 记录见 [RELEASE_VALIDATION](RELEASE_VALIDATION.md)。

## 兼容性与回滚

原始事件、工作区、会话、来源及捕获字节不做迁移。旧混合链成员在读取时隔离，
原元数据保留；已有链摘要可能仍包含历史混合内容，本轮没有静默重写它们。
默认 ingress 仍为 OFF，Codex/Kimi native hook 仍 capture-only，上游工具不会重试，
默认保留没有删除期限。未修改用户的真实归档、宿主配置或凭据。

部署前停止宿主与 bridge，备份整个存储，包括数据库侧文件及 blobs。回滚依靠完整备份，
不要只换数据库文件。本轮源码/测试快照另存于系统临时目录；尚未提交或发布。

## 下一阶段仍需取得的证据

阶段 C/D 尚未执行：真实 OpenCode/Bun、Claude、Codex、Kimi、RTK 的精确版本接入，
Windows console Ctrl-C 和 `.cmd` 子进程树，真实长任务质量、token、缓存与费用对照。
当前没有这些能力或收益的认证。合成 demo 的 95.51% 是字符缩减，不能代替真实结果。

旧工作区兼容性会检查所有候选以避免遗漏冲突；大量或失效网络路径的探测延迟尚未量测。
初始配置采用同卷硬链接完整发布，本机已验证；不支持硬链接的文件系统尚未验收。
后续优先取得这些实际证据，再针对复现的缺陷继续完善。
