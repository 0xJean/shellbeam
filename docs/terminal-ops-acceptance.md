# Terminal + Ops 验收矩阵

对应 [产品 PRD](./prd-terminal-ops.md)，核查日期 2026-10-18。本文记录实现证据和剩余验收，不以阶段名称或已有页面数量作为完成证明。

## Phase 0：连接与采集底座

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| 直连、单跳、独立认证与主机密钥 | `src-tauri/src/ssh/transport.rs`；主机 `jumpHostId` 引用同 Vault 独立凭据 | 真实双 sshd 夹具，分别验证目标与跳板；认证失败、密钥变化、超时有独立原因 |
| Terminal、命令、SFTP、端口转发、浏览器使用同一传输 | `ssh/{interactive,commands,forward}.rs`、`net/{sftp,port_forward}.rs`、`browser.rs` | 真实命令/SFTP和本地、远程、SOCKS、HTTP CONNECT/POST往返；保留已验证跳板隧道租约 |
| 凭据在 Rust/Vault 解析 | 保存主机仅传 `vaultId/hostId`；握手后再次检查锁库 | Workspace/Files/监控/MCP使用保存主机引用；手工连接保留显式凭据兼容 |
| 逐端点信任决定 | 指纹确认绑定地址和端口，单次使用；密钥变更不能直接接受 | 有效已验证主机密钥身份附在成功采集的 HostIdentity；未知身份不伪造 |
| 统一采集与解析语义 | `shared/probe-collector.sh`、`unified-probe.ts`、MCP `remote.rs` | TS/Rust共用Linux帧夹具；默认Provider一次命令返回指标和资产；不完整帧拒绝，空值保留unknown |
| Provider来源、TTL、恢复和错误 | `probe-provider.ts`、`probe-scheduler.ts`、`probe-persistence.ts` | 保留已有持久化/重试回归；新结果不得被过期成功或旧失败覆盖 |

## Phase 1：主机诊断与操作闭环

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| 运维列表、健康、告警、筛选 | `host-ops-view.ts`、`host-ops-filters.ts`、HostCard/HostsDashboard | Provider、OS、严重级别、能力、资源阈值、新鲜度；显示TTL、跳板、最后错误 |
| 文件写操作确认和审计 | `file-operation.ts`、`remote-fs.ts`、Files/SFTP组件 | 只读亦有审计；创建/上传/覆盖/删除/重命名/权限统一确认，后态stat验证；高风险强确认；路径哈希，无内容入审计；取消零执行 |
| 进程、服务和日志稳定诊断 | `workspace-diagnostics.ts` 和相应Workspace应用 | 有界读取/分页/筛选；进程终止、服务启停及enable/disable后态验证；无法观察结果记unknown；日志跟随可停止且有时限 |
| 真实异常到处理结果 | 实际desktop/mobile Overview的RecommendationsPanel | 流程测试：真实本地规则告警→日志诊断→确认重启→后态观察→OperationJob；取消不执行 |
| HTTP/TCP检查与本地规则 | `health-check-scheduler.ts`、`local-alert-*.ts`、`local-ops-store.ts` | 应用级有界调度，历史、持续时间、滞回、unknown不恢复、失败与恢复通知 |
| 跨会话告警审计 | `data/local_ops.rs`、`local-ops-persistence.ts`、`local-alert-actions.ts` | 原生按Vault/host/kind隔离、revision CAS；确认/关闭关联同scope已确认OperationJob；MCP返回安全历史和关联任务 |
| 超时/断线/信号/输出过量 | 原生公共command执行器、OperationJob结果映射 | 不推断远端动作已停止；不确定结果为unknown，无自动重放写操作 |

## Phase 2：Komari Adapter

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| endpoint/token、节点发现和映射 | `komari.ts`、`komari-mapping.ts`、配置页面 | 保留已有配置、权限、映射冲突和回退测试 |
| 同步TTL、并发、快照和告警 | `komari-sync.ts`、原生Komari persistence | 保留既有告警去重、确认/关闭、恢复通知和OperationJob跨会话关联 |
| 历史时序、范围查询和可视化 | `data/provider_history.rs`、`provider-history.ts`、ProviderHistoryPanel | Vault/provider/host/node隔离；7天/每series10080点/总计100000点；1h/6h/24h/7d视图，来源选择、null/停采断线、原始采样时间和TTL |
| API契约兼容 | `shared/fixtures/komari*` 和Komari契约测试 | 依据官方Komari源码记录支持的endpoint/版本；测试权限、flat/nested记录、乱序/重复/无时间/未来时间；不宣称所有版本兼容 |

## Phase 3：明确授权的常驻探针

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| 实际独立采集进程 | `agent/` standalone Rust crate | 实际子进程采集、私有有界历史、进程锁、停止/重启历史连续性；桌面退出不影响已启动的用户服务 |
| 安装、升级、卸载与心跳 | 用户systemd/launchd生命周期、Workspace探针面板 | 不隐式sudo/linger，不监听端口或接收命令；新心跳与真实版本确认成功；不支持平台拒绝安装 |
| 制品分发与签名 | release catalog/native HTTPS下载/Ed25519双签名、SFTP激活 | 首次安装也必须签名；平台/channel/rollout/expiry/hash/size/重定向均受约束 |
| 失败回滚 | 原子备份/替换及激活计划 | 使用真实shell强制新制品失败，验证旧文件hash恢复并重新激活；无法验证的回滚保持unknown |
| 发布策略 | `.github/workflows/agent-release.yml`、`docs/agent.md` | 四目标构建与签名草稿流水线；正式发布需要仓库配置独立私钥和审核draft，未自动发布 |

## Phase 4：扩展运维

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| Docker、Sites/SSL和有限批量 | 已有对应Workspace面板和有界批量模型 | 保留已有确认、审计、幂等和unknown回归 |
| Network观察 | `network-ops.ts`、NetworkOpsPanel、双端路由 | Linux ss/ip读取监听、连接、接口、主路由；输出有界；同主机Services/Logs/Terminal跳转；复用健康检查调度 |
| 应用级定时操作 | `scheduled-ops-runtime.ts`、ScheduledOpsRuntime、面板 | 启用确认、授权绑定命令+周期，执行关联启用任务；锁库/重启暂停，不补跑；桌面退出后不调度写操作 |
| 系统/Webhook通知 | 已有通知策略、原生命令和diagnostics | 投递接受不等于OS展示或已读；有界重试不重放远端动作；参见`docs/ops-notifications.md` |

## 验证记录与交付边界

- 旧版base64整文件传输限定64 MiB、90秒读循环预算（底层单次I/O另有15秒超时），大小未知也受限，不支持无界内存下载。
- 本地真实SSH夹具使用私有临时目录、独立端口和两套密钥，保留主机密钥校验；不修改用户SSH配置，不依赖外部服务器。
- Linux采集与user systemd生命周期由GitHub Actions真实Linux runner验收；本机macOS上的跳过不能算Linux验收通过。
- macOS launchd smoke使用唯一测试label、临时state和真实生成plist；不会覆盖默认探针服务。本轮实际启动、重启、历史保留、卸载测试通过（`cargo test --manifest-path agent/Cargo.toml launchd_service_activates_restarts_and_stops_in_isolated_state -- --ignored --nocapture`）。
- GitHub Actions覆盖前端、macOS/Linux/Windows原生测试与MCP stdio，以及独立Agent daemon/systemd检查。以本轮提交对应的状态为准，旧提交绿色检查不代表本轮通过。
- 系统通知的打包展示、Windows/macOS/Linux实际通知设置仍需逐平台实机检查；测试仅能证明原生后端接受/拒绝及投递语义。
- 正式Agent发布密钥配置、release draft审核和生产发布没有执行；测试签名不能替代生产信任根。
- 本文不将多跳、团队RBAC、完整APM/Kubernetes或无人值守自愈加入首期范围。

### 本轮本地验证

- 前端全量：128个测试文件，699项通过；1项真实Linux采集测试在macOS跳过，交由Linux CI执行。
- TypeScript及Vite生产构建通过；现有Browserslist与chunk-size提示保留。
- 原生：90项库测试及2项MCP stdio集成通过，含真实SSH路由、信号/超时/输出预算与文件metadata观察。
- Agent：5项单测、实际daemon重启测试、独立macOS launchd smoke、Clippy与签名publisher测试通过。
- 136个本轮前端文件ESLint无错误；另`pc-layout.tsx`有14项既存错误，按相同命令与改动前HEAD比较，规则及数量一致（7项effect、5项memoization、2项空catch），本轮未扩大该遗留重构。
- Rust格式及Git空白检查通过。GitHub Actions结果在PR中记录，不能由本地检查代替。
