# 原生负载规则、静默与渠道配置

PRD 0.5 C，2026-10-22。监控服务仍是可选能力；未接入的用户不需要安装任何扩展。

## 使用路径

设置 → 监控与通知 → 已保存的监控服务 → 服务管理：

1. 选择“服务端负载规则与静默”，点击“启用服务端负载告警”。确认后，App 上传其内置扩展并校验三个源文件的实际字节；已核验的 0.1.0 或 0.2.0 可启用；升级通过独立的生命周期操作完成，未知内容的同名扩展拒绝覆盖。
2. “读取配置”后添加 CPU、内存、磁盘百分比或一分钟系统负载规则。选定监控主机，设置超限/恢复阈值与各自持续时间，确认一次保存。规则绑定服务实例及节点创建身份。
3. 添加一次性静默（输入本地时区的绝对时间），或每周 UTC 计划（支持跨午夜，星期指开始日）。可选择全部扩展规则或指定规则。
4. 服务设置中选择已安装通知渠道，打开“通知渠道”编辑其声明的原生字段。Webhook、Javascript 及 managed 配置的插件渠道无需打开网页；文本默认隐藏，脚本仅作为文本编辑，不在 App 执行。

扩展固定支持官方 **Komari 1.6.0**，每 15 秒在服务端评估，App 关闭后继续。其他服务配置沿用已核验的 1.6.x 契约。版本不匹配会阻止安装，而不是推测兼容性。来源是 App 内嵌的固定 ZIP，没有插件地址、路径、名称或权限的用户输入入口；可复现打包和 CI 字节检查确保 ZIP 对应仓库源文件。它并非新的独立签名发布渠道。

## 实际作用和投递语义

- 静默只抑制本扩展的负载通知。现有离线、到期、登录、流量和第三方通知继续采用原设置；不是全服务静默，也不改本设备提醒。
- 扩展调用服务的当前全局通知渠道，不复制渠道凭据，不新建另一套邮件/Webhook 设置。全局通知关闭或选择 none 时保留告警事实，记录“通知已关闭”，不冒充发送成功。
- 规则依据原始 `updated_at` 样本，不使用 App 读取时间。未来、重复和超过 180 秒的样本不能推进持续/恢复计时；观测中断会重置持续计时，不能制造恢复。
- 恢复阈值必须低于告警阈值，避免阈值附近反复切换。静默期间仍显示异常；静默结束后只有新鲜的新样本才能通知当前仍存在的异常，不补发旧队列。
- 在发送前持久化尝试标记。服务已受理不等于接收方送达；响应丢失为未知，重启/读状态不会重放。该策略可能丢失通知，不能承诺恰好一次投递。配置变更后取消尚未发送的旧计划；已发请求不能撤回。
- 每服务最多 64 条规则、64 条静默。扩展保留最近 500 条事件与 500 条配置回执，界面显示最近 50 条事件；这不是无限期审计存储。已有监控指标、节点历史和 ShellBeam OperationJob 不裁剪。

## 数据、恢复与权限

所有配置更改沿用加密 `monitoring_service_intents` 和 OperationJob：明确确认、事务保存意图、写前读取、三方合并、唯一发送、读回核验。进程中断后的恢复只读，重试必须再次确认。渠道配置包含敏感字段，基线/期望/读回值仍加密；错误和审计仅保留固定状态，不记录凭据或脚本正文。切换 Vault 或服务配置会撤销旧上下文，丢弃晚到结果。

扩展策略另外带持久化实例标识与 CAS revision；相同字段冲突需显式处理，重建实例/节点不能继续写入旧意图。服务文件以临时文件原子替换；失败不发送通知。它使用管理员 RPC、认证路由和插件自身文件目录；不申请 shell、系统执行、任意文件目录或额外监听端口。管理员 RPC 是上游较宽的权限，安装确认明确显示这一点。私有/公开站点均要求管理员访问策略和状态。

渠道配置仍受上游无条件整包写入限制：App 先读后合并、校验声明身份及只修改已声明支持的字段，但无法排除其他管理员在最后读取与写入之间的竞争。节点/探测任务选择按上游协议编码为 JSON 字符串，读回为类型化数组；上游已过滤的删除引用不能从此接口恢复。未知字段和未支持格式保留，raw/redirect HTML 配置不执行、不开放编辑。

扩展安装先检查不存在、上传后再次检查，再合并并校验字节；已有扩展只在字节一致时可启用。上游安装接口没有 create-only/CAS，仍有最后检查与合并间第三方同名安装的竞争窗口；首次安装时不要在其他管理端同时安装同名插件。原始安装不覆盖已有扩展；升级与保留备份的卸载通过下述独立生命周期完成，不提供清除恢复状态入口。

## 验证边界

`scripts/monitoring-extension-live.mjs --binary <official-1.6.0-binary>` 创建独立回环服务和独立 HTTP 接收端，使用随机测试凭据并清理数据。验证真实插件审批/启用、公开与私有站点认证、规则 CAS、节点身份、内置脚本及已安装插件渠道读写/选择器、关闭通知、负载/恢复、静默、重启与无重放。

这是官方服务协议/运行时验收；不是打包 App 的安装协调器端到端证明，也不代表所有第三方通知插件均已验收。原生 Rust 及组件测试分别覆盖 schema 绑定、数据合并、意图/审计事务、作用域撤销和确认流程。主机页已订阅当前服务端负载事实，确认与归档复用本地 OperationJob。外部处置同步、历史事件回填仍未实现；PRD C 阶段整体仍有后续工作。


## 主机统一告警与处置（2026-10-23）

已启用监控服务的常规刷新会在指标采集后读取扩展的策略、当前评估与策略复核，沿用已有同步 TTL 和并发限制。未安装、无权限或读取失败不触发安装和写入，也不影响 SSH 功能。只有确认属于当前服务实例、节点创建身份、唯一主机关联与规则语义的原始新鲜样本才能打开事件；规则数量不是异常数量。

- 主机卡片和统一告警中心显示同一条负载记录；纯监控主机无需 SSH 或额外指标快照。界面使用“监控服务”，显示原始采样时间、最近观测和负载静默/渠道关闭状态。
- 确认表示接手，归档表示收起本地记录，两者不恢复故障、不停止服务端通知。复用原有确认流程、OperationJob 和告警审计；服务端不会收到确认/关闭写请求。
- 重复刷新与重启保留本地确认、归档。只有更新的实际恢复样本才记录恢复；归档仍保持归档，随后观察到新的异常才重新打开。静默不等于恢复，结束静默不会导致 App 重复发送服务端消息。
- 陈旧、未来、倒退、缺失或相互矛盾的同一采样不用于恢复。规则停用/移除、服务实例或关联身份改变保留历史并退出当前告警计数；后续读取失败不会把这类历史重新激活。
- 当前订阅不导入服务端旧事件列表：旧行缺少足够的节点创建身份，不能安全回填。沿用现有本地 journal 的 500 条记录、1000 条生命周期审计读取窗口及 OperationJob 存储策略；没有新建或清空凭据/主机/数据库。

通知由服务端负责，App 不为这些负载记录额外投递本地/系统/Webhook 消息，避免绕过静默和重复提醒。现有 Probe 采集故障及本地规则保持原通知策略。外部管理员处置同步、全服务静默和扩展安装协调器完整打包验收仍是后续工作。


## 扩展升级、卸载与恢复（2026-10-23）

在“服务端负载规则与静默”中选择“检查扩展”，即可升级到内置 0.2.0 或“卸载并保留备份”；历史“修改与核验记录”中可读回结果、明确重试或恢复保留的版本，不需打开网页。升级识别的是固定三个源文件的实际字节，不仅是版本号。0.1.0 原始源文件作为不可变恢复版本保留；当前包及旧源均受构建字节检查。

升级先记录停止请求，再停止评估、读回并将完整 `state.json`、保存的扩展 configuration 和原启用状态加密写入现有 Vault 意图；备份与 OperationJob 阶段在同一 SQLite 事务提交后才允许替换或删除。保留实例 identity/revision、规则/静默、评估及未知通知尝试标记、事件/回执和未知 JSON 字段。升级包仅含固定代码、保留状态及操作回执；恢复启用前检查状态哈希、配置读回和加载中版本。原来停用的扩展继续停用，原来启用的扩展恢复评估。

卸载停止本扩展的负载评估和通知，保留本机加密备份及审计；Komari 节点、指标数据库、通知渠道、API/Vault 凭据不删除。上游删除接口实际删除扩展代码、storage 和配置，因此备份仅覆盖本扩展定义的状态/配置，**不包含管理员手工放入插件目录的其他文件**；升级和卸载确认均显示这一范围。没有本机持久备份时不能删除。保留并解锁原 Vault、维持原服务配置身份是恢复的前提。

中断、写响应丢失、App 重开只允许读取结果，不重放写请求。明确重试创建新审计任务并复用原检查点；已经完成同一操作的合并由回执识别，不重复上传覆盖。卸载后恢复，或失败升级后恢复未改变且已停止的结果，使用原审阅版本及备份状态。未知代码、新实例、不同配置/状态或重新运行后的新观测会阻止覆盖；不会把历史备份强行写回正在运行的服务。重新启用可能继续通知，确认会说明这一点。

边界：固定官方 1.6.0、仅本扩展 0.1.0/0.2.0，不是通用插件市场或跨服务备份导入。备份仍受现有服务意图数量上限约束，不做自动清理。上游停用/替换/删除没有 CAS；每个写前检查不能排除最后检查与另一管理员操作之间的竞争，不应在其他管理端同时维护同一扩展。服务身份采用冻结的集成配置和扩展实例，不提供服务端机器的密码学证明。此批原生 HTTP/生命周期引擎在隔离官方实例验收，完整打包 App + 真实 Vault 的此生命周期旅程尚未验证。

## Packaged App lifecycle acceptance

`extension-ui-ci.yml` installs the production release Debian package and drives
only its standard WebDriver surface as an ordinary user. Two disposable official
1.6.0 services cover fresh installation and a reviewed 0.1.0 legacy extension.
A transport gateway holds deletion before dispatch or withholds a merge response
after the real service commits. The App is killed, reopens the same Vault, reads
back without writes for 5 seconds, then retries or restores only after confirmation.
The legacy fixture preserves a disabled rule/silence, event receipts, an unknown
delivery marker, future JSON fields and configuration. Both services have real
stored metric buckets and node credentials whose continuity is checked separately.

The observer opens only the disposable App database in SQLite read-only mode. It
checks encrypted checkpoint shape before mutation and retained audit jobs after
restart. The production App proves decryption and usability by restoring through
its own UI. It does not seed App storage or call IPC directly. The final audit is
also located in the ordinary activity/audit page. Reports omit secrets, request
bodies and state backups; six safe screenshots carry byte counts/dimensions/hashes.
Cleanup requires both official servers and the installed App to exit.

All frontend pages use ShellBeam components. The unused embedded Komari website
component has been removed; an upstream website cannot satisfy this acceptance.
This workflow is Linux installed-package coverage, not evidence of macOS/Windows
GUI coverage, concurrent multi-device CAS, arbitrary plugins or all PRD 0.5 tasks.
