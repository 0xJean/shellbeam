# Terminal + Ops 验收矩阵

对应 [产品 PRD](./prd-terminal-ops.md)，核查日期 2026-10-18。本文记录实现证据和剩余验收，不以阶段名称或已有页面数量作为完成证明。

当前隔离 Ubuntu X11 安装包完整 GUI 验收已通过：[第17次运行 39113100124](https://github.com/0xJean/shellbeam/actions/runs/39113100124)，head `11d9f6331a3214c5bb572cd1ff2786a804f6ac32`、合并检出 `48d6212cfb1a8877514030171847adc0a394205c`。[下载核对的报告与受控截图](https://github.com/0xJean/shellbeam/actions/runs/39113100124/artifacts/12131831582)确认服务闭环、独立 Probe 指标告警、三主机资产刷新及两次真实应用重启均通过，清理和最终退出成功。下文历史失败记录保持原结果；其它平台、外部 Komari、正式 Agent 分发和公有 CA 仍按各自边界验收。

## Phase 0：连接与采集底座

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| 直连、单跳、独立认证与主机密钥 | `src-tauri/src/ssh/transport.rs`；主机 `jumpHostId` 引用同 Vault 独立凭据 | 真实双 sshd 夹具，分别验证目标与跳板；认证失败、密钥变化、超时有独立原因 |
| Terminal、命令、SFTP、端口转发、浏览器使用同一传输 | `ssh/{interactive,commands,forward}.rs`、`net/{sftp,port_forward}.rs`、`browser.rs` | 真实命令/SFTP和本地、远程、SOCKS、HTTP CONNECT/POST往返；保留已验证跳板隧道租约 |
| 凭据在 Rust/Vault 解析 | 保存主机仅传 `vaultId/hostId`；握手后再次检查锁库 | Workspace/Files/监控/MCP使用保存主机引用；手工连接保留显式凭据兼容 |
| 逐端点信任决定 | 指纹确认绑定地址和端口，单次使用；密钥变更不能直接接受 | 有效已验证主机密钥身份附在成功采集的 HostIdentity；未知身份不伪造 |
| 统一采集与解析语义 | `shared/probe-collector.sh`、`unified-probe.ts`、MCP `remote.rs` | TS/Rust共用Linux帧夹具；默认Provider一次命令返回指标和资产；不完整帧拒绝，空值保留unknown |
| Provider来源、TTL、恢复和错误 | `probe-provider.ts`、`probe-scheduler.ts`、`probe-persistence.ts` | TTL到期产生结构化`expiryReason: ttl-expired`，未到期为null；旧持久化和MCP内层观察在读取时重算，采集失败独立保留错误，不伪装TTL到期；新结果不得被过期成功或旧失败覆盖 |
| 状态与主机身份一致 | `host-identity.ts`、原生route identity、unsupported采集契约 | 非Linux SSH采集明确unsupported，不当成offline；可用Agent/Komari观察可优先；身份来自实际解析端点，未解析跳板引用不复用旧复制地址；任务摘要按job最新状态统计 |
| 跨Vault观察隔离 | `host-observation-scope.ts`、monitor/inventory/tool原生持久化、MCP缓存读取 | 内存和持久化均按Vault/host标识；显式Vault与profile冲突在采集前拒绝；MCP按授权Vault读取。旧无scope缓存保留但不猜测归属，需要重新观察；已分scope的ProbeProvider历史保留 |
| 采集预算与架构 | `shared/collection-limits.json`、TS/Rust共享读取、统一Inventory.arch | 并发、采集timeout/输出与历史保留使用一个数值源；普通SSH命令和MCP任务各自的有界预算单独命名；架构从真实采集结果传入，缺失不猜测 |
| 通用SSH Provider失败/恢复告警 | `probe-scheduler.ts`、`probe-collection-events.ts`、`probe-alert-lifecycle.ts`、应用级ProbeAlertRuntime与local_ops | 实际采集按Provider/metrics/inventory发布一次事件；无缓存失败可开启内置告警，unknown、缓存读取及`recovered`缓存回退不算恢复，须同配置的新成功采样。先原生持久化再通知；锁库、旧Vault/主机/跳板配置及CAS失败不得投递，主机Grid/List可确认/关闭并关联OperationJob。11d9f63完整打包GUI已实测独立直连/跳板SSHD故障、三profile新指标采样恢复、六条真实metrics OS横幅、六条metadata任务、三次资产刷新排空及第二次真实重启恢复；不代表inventory或Komari系统通知展示已验收 |

## Phase 1：主机诊断与操作闭环

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| 运维列表、健康、告警、筛选 | `host-ops-view.ts`、`host-ops-filters.ts`、HostCard/HostsDashboard | Provider、OS、严重级别、能力、资源阈值、新鲜度；显示TTL、跳板、最后错误 |
| Probe分区采样状态 | `hostProbeEvaluations`、HostCard Grid/List与HostsDashboard | 同Vault/主机canonical metrics/inventory evaluation单独展示健康与原始采样时间，无告警时仍可见；共用180秒新鲜度，过期/缺失/无效/未来时间为unknown，UI刷新不得伪造采样时间。真实SSH告警标题包含主机名以区分多主机系统通知 |
| 资源摘要与跳板搜索 | HostCard Grid/List、`host-search.ts` | 显式展示RX/TX与uptime，选中Provider仅有metrics时仍可展示；缺失unknown、实际0保持0；跳板引用按同Vault当前配置搜索，编辑/删除不继续匹配旧复制字段 |
| 主机快捷诊断入口 | HostCard/HostsDashboard、SessionsContext、PcLayout | 卡片/列表提供可见的一键Services按钮，避免将原生菜单打开/选择少计为一次；打开Services、选择服务、读取真实status为三次实际点击，11d9f63打包GUI已验证直连/跳板两路诊断，后续两次真实重启均恢复原审计与新观察。保留Overview、Files、Logs、健康检查和刷新；同Vault复用会话、补齐UI标签页，右侧会话提升后不重复挂载；跨Vault同名ID不得复用 |
| Workspace观察范围 | `workspace-provider-state.ts`、WorkspaceStatusCards、WorkspaceRecommendationsPanel | 桌面/移动Overview指标与资源建议复用主机列表的Provider选择规则；读取同Vault/host的canonical与Komari持久化，切换Vault/路由拒绝迟到读取，映射重绑立即失效旧来源；未绑定引用按明确活动Vault解析，冲突引用不展示 |
| Overview来源与回退 | WorkspaceProviderSummary、共用`buildHostOpsViews` | 并列显示当前/其他Provider的健康、原始采样/接收/Komari同步时间、TTL、可信程度与实际能力；缺失时间显示未知，不借资产扫描或缓存写入伪造指标时间。Komari过期/不可用时明确显示SSH回退，遥测只属于实际选中的指标观察；资源建议独立检查该指标deadline |
| 文件写操作确认和审计 | `file-operation.ts`、`remote-fs.ts`、Files/SFTP组件 | 只读亦有审计；创建/上传/覆盖/删除/重命名/权限统一确认，后态stat验证；高风险强确认；路径哈希，无内容入审计；取消零执行 |
| 进程、服务和日志稳定诊断 | `workspace-diagnostics.ts` 和相应Workspace应用 | 有界读取/分页/筛选；进程终止、服务启停及enable/disable后态验证；无法观察结果记unknown；日志跟随可停止且有时限 |
| Services窄屏字段展示 | `WorkspaceServicesApp` | 窄屏使用Service/Active/Sub三弹性列，Load字段名和值保留在名称附行；sm恢复原四列。容器允许缩小，长名称/状态可断行，完整选中unit保留。只使用窗口正文纵向滚动；组件验证第二行身份、同Vault status审计及Logs目标，未替代320/375/390px实际渲染或移动设备验收 |
| 真实异常到处理结果 | 实际desktop/mobile Overview的RecommendationsPanel | 流程测试覆盖本地规则告警→日志诊断→确认重启→后态观察→OperationJob；11d9f63隔离Linux打包GUI另验证两路主机卡片→Services诊断、取消零变更、确认后态与同主机审计；移动设备实际展示仍单独验收 |
| HTTP/TCP检查与本地规则 | `health-check-scheduler.ts`、`local-alert-*.ts`、`local-ops-store.ts` | 应用级有界调度，历史、持续时间、滞回、unknown不恢复、失败与恢复通知；复用OperationJob路径判断，仅保存jumpHostId的主机在成功、失败、unknown和取消未发送结果中均保留ProxyJump，持久化历史、服务告警和恢复视图不误标直连 |
| 跨会话告警审计 | `data/local_ops.rs`、`local-ops-persistence.ts`、`local-alert-actions.ts` | 原生按Vault/host/kind隔离、revision CAS；确认/关闭关联同scope已确认OperationJob；MCP返回安全历史和关联任务 |
| 历史任务与审计查询 | `OperationsAuditCenter`、原生`operation_jobs`查询 | 来源和状态在原生筛选，按时间与唯一ID复合游标翻页，每页最多100条；任务与审计独立分页，历史页暂停自动刷新，刷新回到最新。切换Vault/主机/筛选拒绝迟到结果；仍受5000任务/10000审计的既有保留上限约束，不承诺无限历史 |
| Workspace结果未知提示 | `WorkspaceOperationRecoveryNotice`、原生启动recover | 只显示同Vault/主机canonical unknown；正常queued/running留在任务进度，跨应用重启未完成任务由原生转unknown。初始读取无证据不闪警告，可见时15秒及focus/visibility只读刷新、单请求合并；读取失败保留未知证据，成功读到终态才移除；显式Vault冲突不查全局，切scope/卸载清理并拒绝迟到结果，不重放远端动作 |
| 异步操作确认 | `user-confirmation.ts`、应用级`UserConfirmationDialog`、OperationJob/文件/批量入口 | Tauri Dialog 2.6会把`window.confirm`替换为Promise，必须等待严格布尔结果。应用内真实确认窗默认聚焦取消，显示主机、路径和动作摘要；文件保留精确输入token。锁库/切库/主机或跳板变更撤销待确认，作用域guard保留至实际发送前；不可用/忙碌不记为人工拒绝，已同意但未发送的取消保留confirmed。11d9f63打包GUI已证明两路真实取消零变更、确认各只重启一次，四条服务审计在两次应用重启后均恢复；独立Probe另六条确认/取消metadata任务在第二次重启后恢复 |
| MCP本地告警确认/关闭 | `mcp/local_alerts.rs`、协议oneOf与原生local_ops内部事务 | 保留Komari参数兼容；服务、健康检查和独立ProbeProvider告警必须显式`alertSource=local-ops`、ruleId及expectedRevision。复查manageAlerts/同Vault主机授权，规范Job记录客户端授权为not_required，不伪造人工确认；SQLite保证CAS、跨会话与并发幂等，不重放非终态任务。桌面confirmed-only入口保持独立 |
| 超时/断线/信号/输出过量 | 原生公共command执行器、OperationJob结果映射 | 不推断远端动作已停止；不确定结果为unknown，无自动重放写操作 |
| 工具安装与服务动作 | `workspace-tools.ts`、WorkspaceToolManagerApp | 安装/升级/卸载及服务变更先确认，展示主机/路径/命令；独立观察版本、工具存在与服务后态；同一OperationJob记录结果，无法观察为unknown |

## Phase 2：Komari Adapter

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| endpoint/token、节点发现和映射 | `komari.ts`、`komari-mapping.ts`、KomariMappingsPanel、原生映射revision | 主机运维视图可发现节点、选择同Vault主机、解决地址歧义和显式恢复自动匹配；手动绑定缺席节点仍保留，后台同步不得覆盖。SQLite重开、revision冲突、跨Vault拒绝及原子清除旧latest缓存有回归；新同步同时写专用/canonical缓存且旧sample不回退。真实外部部署仍待验收 |
| Komari Web控制台入口 | `komari-console.ts`、Komari设置页、原生`komari_console.rs` | 桌面保留原浏览器窗口，移动端交给系统浏览器；均使用已保存同Vault地址，保留反代basepath、移除query/hash且不传API密钥。移动端仅main WebView可准备/打开/取消短期单次请求，原生在实际OS交接前检查取消、TTL和锁库；切换Vault/集成或迟到prepare不能继续旧导航。请求最多16个、TTL30秒、等待OS回调最多10秒；交接后不声称可撤销或页面已加载。行为/双语/原生状态测试和iOS/Android目标编译检查通过；移动设备实际浏览器展示及外部部署仍待验收 |
| 映射编辑后的运维入口 | HostsDashboard、`komari-probe-link.ts` | 重绑立即失效旧来源视图/按钮，迟到旧Vault刷新不得取消新Vault刷新；检查探针前重新核对最新映射并创建同Vault只读OperationJob。安装入口打开同主机Overview的签名制品审核面板，无Workspace入口时隐藏，不直接执行已有远端binary的legacy安装命令；安装Job由实际签名流程确认后建立 |
| 同步TTL、并发、快照和告警 | `komari-sync.ts`、原生Komari persistence | 主机卡片Grid/List及Overview使用同一成功同步来源：原生`lastSuccessfulSyncAt`仅由完整同步事务设置，普通告警写入不能创建/推进，旧行迁移为NULL、映射变更清空。历史推断时间保持未知，直到真实同步成功；不借采样、映射更新时间或全局刷新时间，不改变既有调度兼容字段或指标TTL。保留既有告警去重、确认/关闭、恢复通知和OperationJob跨会话关联 |
| 历史时序、范围查询和可视化 | `data/provider_history.rs`、`provider-history.ts`、ProviderHistoryPanel | Vault/provider/host/node隔离；7天/每series10080点/总计100000点；1h/6h/24h/7d视图，来源选择、null/停采断线、原始采样时间和TTL |
| API契约兼容 | `src/lib/fixtures/komari-http-contracts.json` 和Komari契约测试 | 依据官方Komari源码记录支持的endpoint/版本；测试权限、flat/nested记录、乱序/重复/无时间/未来时间；不宣称所有版本兼容 |
| 凭据保存与发现反馈 | `VaultProvider`、Komari设置、`KomariMappingsPanel` | 原生凭据写入或随后状态刷新失败必须reject，设置页显示固定双语错误并保留掩码输入；重试复用已创建集成ID，编辑保留已有凭据引用。新建、选择或输入使旧列表失效；保存后离开设置仍完成同一Vault generation的写入，切库/A→B→A/Provider卸载阻断后续阶段，不承诺已发送写入回滚或跨存储原子性。完成持久化及当前列表重载后才显示成功，双语文案区分服务器配置、Vault保存与实际认证。旧Vault刷新在status/keys每次await后核对scope。发现区分缺失凭据、读取失败、权限、连接和超时；只有有效列表可显示成功空态，HTML/非法200响应不转换为零节点。56项聚焦回归及本地官方实例控制台保存路由/受保护认证通过。外部验收随后实际确认服务器保存POST200、有效Key布尔true，75fb7c7新版App保存提示及主窗口受保护admin-list GET200、1真实节点发现；早先失败原因不归为用户漏操作。测试Vault为0主机，映射/实际遥测仍待验收 |
| 真实Komari实例 | `scripts/komari-live-smoke.mjs`、`docs/komari-live-validation.md` | 未修改的官方1.6.0源码构建：节点/recent、非空真实历史、映射Provider、错误token与桌面Origin CORS头均通过；新节点coarse层为空时最多补查一次1h，保留真实时间，不声称完整24h覆盖；外部部署和实际WebView仍需对应环境验收 |

## Phase 3：明确授权的常驻探针

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| 实际独立采集进程 | `agent/` standalone Rust crate | 实际子进程采集、私有有界历史、进程锁、停止/重启历史连续性；桌面退出不影响已启动的用户服务 |
| 重连历史回灌与独立状态 | Agent `history-page`、`shellbeam-agent-history.ts`、原生`provider_history`、Workspace历史面板 | 原采样时间/TTL、稳定node身份、192KiB/100点上限；每主机每次4页/30秒，CAS游标与points同事务，锁库/失败不推进，旧回灌不覆盖已有sample；坏帧整页失败。真实daemon两页经实际TS parser互通，另有SQLite重开/竞争/回滚和跨Vault UI回归；旧Agent明确unavailable |
| 安装、升级、卸载与心跳 | 用户systemd/launchd生命周期、Workspace探针面板 | 不隐式sudo/linger，不监听端口或接收命令；新心跳与真实版本确认成功；不支持平台拒绝安装 |
| 制品分发与签名 | release catalog/native HTTPS下载/Ed25519双签名、SFTP激活 | 首次安装也必须签名；平台/channel/rollout/expiry/hash/size/重定向均受约束 |
| 失败回滚 | 原子备份/替换及激活计划 | 使用真实shell强制新制品失败，验证旧文件hash恢复并重新激活；无法验证的回滚保持unknown |
| 安装阶段的确认作用域 | `OperationExecutionContext`、Agent制品/生命周期操作、探针面板 | 下载、home/旧hash读取、prepare、SFTP和activation之间复查同一持久guard。首次变更前失效为cancelled/confirmed；可能已发送后失效为unknown，不向新路由发清理或回滚。实际已完成activation保留已知Job结果，失效后不投影健康或发后续检查；prepare失败/unknown不继续上传。锁库、主机/跳板修改与卸载面板均纳入scope |
| 发布策略 | `.github/workflows/agent-release.yml`、`docs/agent.md` | 四目标构建与签名草稿流水线；发布入口传入签名灰度比例、每目标前版本hash；拒绝两角色共用签名密钥。PR CI独立验证四目标release构建；正式发布需要仓库配置独立私钥和审核draft，未自动发布 |
| 正式签名方案 | `docs/agent.md`、发布workflow的独立validate任务 | 已选两角色离线保管、环境级密钥、默认分支手动触发、preview 5%和人工draft发布；个人仓库支持单维护者复核，已有可信第二维护者时可加强审批。无密钥publisher测试先于构建/签名，拒绝feature分支及tag；生产环境、密钥、公开制品和真实客户端分发尚未配置或执行 |

## Phase 4：扩展运维

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| Docker、Sites/SSL和有限批量 | 对应Workspace面板、`operation-verification.ts` 和有界批量模型 | 单机与批量Docker按不可变ID执行并inspect后态；服务stop/inactive正确判定；Sites reload验证配置/active/站点重扫；SSL续期按原证书路径检查身份、有效期和不回退，合法未续期明确标unchanged；未知结果不重放写操作 |
| 真实Linux运维组合验收 | `scripts/ci-ops-live.sh`、`ci-ops-acme.sh`、`run-ops-live.mjs`、`ops-live.test.ts`、仅cfg(test)原生桥 | 提交`d0d2b2d`已执行16项真实通过、零跳过/重试，脱敏报告success/cleanup均通过。覆盖独立Docker双目标混合批量、真实私有ACME HTTP-01及产品Certbot dry-run/renewal、双SAN实际HTTPS部署、写后断线unknown和批量审计恢复。只替换IPC/确认输入；两个目标共享Linux内核，本机skip不算通过；后续提交须核对各自CI。边界见`ops-live-validation.md` |
| Network观察 | `network-ops.ts`、NetworkOpsPanel、双端路由 | Linux ss/ip读取监听、连接、接口、主路由；输出有界；同主机Services/Logs/Terminal跳转；复用健康检查调度 |
| 应用级定时操作 | `scheduled-ops-runtime.ts`、ScheduledOpsRuntime、面板 | 启用确认、授权绑定命令+周期，执行关联启用任务；手动/后台原生结构化timeout/disconnect/output-limit均按canonical unknown暂停并撤授权，下一tick不重放；exec前明确未发送的超时保持failed；锁库/重启暂停，不补跑；桌面退出后不调度写操作 |
| 系统/Webhook通知 | 通知策略、平台原生命令和diagnostics | macOS UN权限/发送回调、Windows真实Setting/Show、Linux真实DBus往返；无法查询per-app权限时显示unknown，不使用插件恒Granted/丢弃错误路径。系统API接收不等于OS展示或已读；有界重试不重放远端动作；参见`docs/ops-notifications.md` |

## 验证记录与交付边界

- 旧版base64整文件传输限定64 MiB、90秒读循环预算（底层单次I/O另有15秒超时），大小未知也受限，不支持无界内存下载。
- 本地真实SSH夹具使用私有临时目录、独立端口和两套密钥，保留主机密钥校验；不修改用户SSH配置，不依赖外部服务器。
- Linux采集与user systemd生命周期由GitHub Actions真实Linux runner验收；本机macOS上的跳过不能算Linux验收通过。
- macOS launchd smoke使用唯一测试label、临时state和真实生成plist；不会覆盖默认探针服务。本轮实际启动、重启、历史保留、卸载测试通过（`cargo test --manifest-path agent/Cargo.toml launchd_service_activates_restarts_and_stops_in_isolated_state -- --ignored --nocapture`）。
- GitHub Actions覆盖前端、macOS/Linux/Windows原生测试与MCP stdio，以及独立Agent daemon/systemd检查。以本轮提交对应的状态为准，旧提交绿色检查不代表本轮通过。
- 系统通知仍需逐平台与实际桌面环境检查；helper/mock测试不证明后端接收。11d9f63隔离Ubuntu打包GUI已完整验证测试按钮四状态、两路服务四横幅和首次重启无重放，以及独立Probe六条metrics横幅、最终持久计数和第二次重启无重放。其它Linux桌面环境、macOS/Windows展示、inventory/Komari系统通知仍需对应实测；不宣称用户已读。
- 正式Agent发布密钥配置、release draft审核和生产发布没有执行；测试签名不能替代生产信任根。
- 本文不将多跳、团队RBAC、完整APM/Kubernetes或无人值守自愈加入首期范围。

### 上次已提交验证（c668779）

- 前端全量：136个测试文件，840项通过；1项真实Linux采集测试在macOS跳过，交由Linux CI执行。
- TypeScript及Vite生产构建通过；现有Browserslist与chunk-size提示保留。
- 原生：98项库测试及2项MCP stdio集成通过，含真实SSH路由、信号/超时/输出预算与文件metadata观察。
- Agent：5项单测、实际daemon重启测试、独立macOS launchd smoke、Clippy与签名publisher测试通过。
- 本次收尾检查76个前端/脚本文件：73个文件ESLint无错误；`pc-layout.tsx`、`workspace-asset-inventory-app.tsx`、`project-deployments-panel.tsx`合计27项既存错误，与本次改动前HEAD逐文件比较，规则及数量一致（分别14/7/6）。这些遗留项未被记为通过；本轮没有新增错误。
- Rust格式及Git空白检查通过。GitHub Actions结果在PR中记录，不能由本地检查代替。

## 仍需实际环境完成的验收

4f7ecf0本地收尾检查：139个前端测试文件、877项通过；真实Linux collector一项在macOS跳过。TypeScript/Vite生产构建通过；原生106项库测试通过。独立Agent单测、实际daemon重启、Clippy及publisher实际CLI签名测试通过。修改范围ESLint无错误/警告；MCP stdio、格式与精确提交CI结果记录在PR。

真实Ops验证切片本地回归：前端877项通过，8项实机用例和1项Linux采集在macOS跳过；原生111项通过、真实Ops桥1项按预期ignored，另2项MCP stdio通过；构建、格式、定向ESLint及runner guard测试通过。Linux真实服务组合的执行结果仍需对应提交CI证明，不能由这些跳过替代。

提交`7c98ab0`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39091612213)及[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39091612210)共11项检查通过。Linux真实Ops执行8项、零跳过/重试；下载核对的脱敏摘要为`success: true`、`cleanup: passed`。该结果不证明桌面弹窗、生产Vault或公有CA续期，后续提交须核对各自CI。

Freshness/Agent历史回灌本轮本地回归：140个前端文件、900项通过，8项Linux真实Ops和1项Linux采集在macOS跳过；生产构建通过。原生129项通过、真实Ops桥1项ignored，另2项MCP stdio通过；Agent 15项通过、既有独立launchd验收1项ignored；两个Node原生测试套件共6项通过；29个修改范围TS/TSX文件ESLint零错误/警告。Vitest现在仅收集src的TS/TSX测试，Node套件在其实际runner单独执行，避免“0项测试”掩盖TAP结果。对应提交CI结果以PR记录为准。

Komari手动映射/控制台本轮本地回归：前端939项通过，16项Linux真实Ops与1项Linux collector在macOS跳过；原生138项通过、真实Ops桥1项ignored，另2项MCP stdio通过；生产构建及两个Node原生套件6项通过。首轮扩展Linux验收执行16项，其中13项通过、3项在HTTPS证明的错误字段断言失败（原生无错误为null，测试误要求undefined）；修正此契约后必须以新提交CI重跑，不能把已执行过的续期过程等同于完整用例通过。

修正后的提交`d0d2b2d`在[主CI 39095032262](https://github.com/0xJean/shellbeam/actions/runs/39095032262)与[Agent CI 39095032274](https://github.com/0xJean/shellbeam/actions/runs/39095032274)全部11项通过。下载核对的[脱敏报告](https://github.com/0xJean/shellbeam/actions/runs/39095032262/artifacts/12124338103)为16项通过、零跳过、`success: true`、`cleanup: passed`；PR合并检出为`a6870574df8a811811026feb09c82e61855e363b`。前一次失败保留为契约修正记录，不改写成通过；新结果独立证明完整用例已执行。

| 项目 | 完成证据 | 当前边界 |
| --- | --- | --- |
| 桌面系统通知 | 对应安装包中验证允许/拒绝/系统禁用，以及实际横幅或通知中心条目 | 11d9f63隔离Ubuntu X11完整GUI已通过测试按钮四状态、两路服务四横幅与首次重启无重放、独立Probe六条metrics横幅、三次资产刷新、第二次重启后审计/新采样和持久通知计数无重放；其它Linux桌面、macOS/Windows授权/展示、inventory/Komari系统通知仍待实测；不宣称用户已读 |
| Komari部署 | 实际部署的TLS、token权限、节点映射、WebView请求及告警到Workspace跳转 | 已有官方1.6.0本地真实服务HTTP契约证据，尚不覆盖用户外部部署或所有版本 |
| 正式Agent制品 | 受保护签名环境、四目标制品、审核后的HTTPS来源，真实客户端首装/第二版升级/失败回滚/卸载及ProxyJump审计 | 签名方案已选，生产环境和密钥尚未配置，工作流尚未进入默认分支；未生成生产信任根、未发布Agent版本 |
| 主机运维产品指标 | 打包应用从列表发现异常到首次有效诊断不超过3步，再执行确认动作、观察后态与同主机审计 | 11d9f63隔离Linux打包GUI已通过直连/跳板三次实际诊断点击、确认/取消、独立服务后态与跨两次重启审计；隔离Docker/SSL/混合多主机16项命令组合另有证据。用户生产Vault和实际部署环境仍需对应验收，私有ACME不替代公有CA域名控制 |

远端Agent历史在桌面退出期间保留；新版本通过有界分页在重连后回灌，独立Vault/host/provider/node游标与数据同事务提交、CAS检查、锁库不推进，原采样时间和缺口保留。Workspace独立显示会话结果与持久进度；旧Agent不支持分页时明确unavailable，不读取无界历史。此增强仍不能替代正式签名制品和打包实机验收。

Overview统一Provider来源本地回归：8个定向测试文件、86项通过，15个修改范围TS/TSX文件ESLint零错误/警告。覆盖桌面资源卡与实际MobileShell挂载、Komari-only/失败SSH旁的健康Komari、TTL回退、跨Vault迟到读取、映射即时失效、后台缓存刷新，以及资产成功/失败不得更改指标来源、采样时间或遥测。该记录证明数据投影与组件契约，不替代打包应用的真实操作流程与系统通知展示验收；本轮提交对应CI以PR记录为准。

Overview与移动控制台整合本地回归：前端1003项通过，16项Linux真实Ops与1项Linux collector在macOS跳过；TypeScript/Vite生产构建通过，21个修改范围TS/TSX文件ESLint零错误/警告。原生148项库测试及2项MCP stdio通过，既有真实Ops桥1项按约定ignored；原生状态回归包含取消/单次使用/过期/有界注册表及慢OS调用不阻塞取消。iOS真机`aarch64-apple-ios`、模拟器`aarch64-apple-ios-sim`和Android NDK27.1/API24 `aarch64-linux-android`编译检查通过，既有移动browser/notification警告保留，未新增JS opener权限或外部webview能力。编译检查不证明设备上的系统浏览器交接与页面展示，本轮精确提交CI结果另见PR。

提交`a46d341`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39100444751)及[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39100444755)共11项检查通过；下载核对的[Linux真实Ops报告](https://github.com/0xJean/shellbeam/actions/runs/39100444751/artifacts/12126027833)为16项通过、零跳过、`success: true`、`cleanup: passed`，检出合并提交`056790fcb5a7a93f49bad64c2f4162e61cbd2c3e`。同提交的[打包GUI验收](https://github.com/0xJean/shellbeam/actions/runs/39100444727)已通过真实Vault初始化、三个独立私钥的UI完整往返、逐端点指纹确认、直连和ProxyJump连接及两条真实服务规则触发；随后在通知daemon版本检查失败，完整GUI处理和重启恢复未执行。两种验收各自保留结果，不能用原生16项通过替代GUI通过。

提交`238536f`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39101143982)和[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39101143981)共11项通过；[下载核对报告](https://github.com/0xJean/shellbeam/actions/runs/39101143982/artifacts/12126661470)仍为16项真实Ops通过、零跳过，success/cleanup均通过，合并检出`f4aabcaa5356996009bdb6524e32ce635078d169`。同提交GUI已实际编译受校验dunst 1.7.3、通过两条服务告警的直连/跳板路径断言，并产生可见的真实系统测试横幅；自动OCR断言失败，因此[GUI结果](https://github.com/0xJean/shellbeam/actions/runs/39101144044)仍是失败，未到达后续通知状态、运维变更和重启恢复。可见截图不替代完整用例通过。

提交`21187d6`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39101718700)及[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39101718699)共11项通过；[核对的原生报告](https://github.com/0xJean/shellbeam/actions/runs/39101718700/artifacts/12127470286)为16项通过、零跳过、success/cleanup均通过，合并检出`a555a88e8086ac47d770eae1219c1b2ce4b3479a`。[GUI报告](https://github.com/0xJean/shellbeam/actions/runs/39101718712)中的`notifications.passed: true`独立证明测试按钮四状态，完整GUI随后在真实策略保存/重挂载后的诊断计数读取失败；服务告警投递与重启闭环仍未通过。

独立SSH Provider与MCP本地告警闭环本轮本地验证：前端1107项通过，16项真实Linux Ops和1项Linux collector在macOS跳过；TypeScript/Vite生产构建通过，修改范围ESLint通过。原生库161项通过、原Linux Ops桥1项按约定ignored，MCP stdio两项通过；50项Node UI协议/夹具/通知契约测试通过。覆盖实际work单次事件、无缓存失败、缓存不恢复、新采样恢复、跨配置缓存/任务隔离、同毫秒引用跳板变化、迟到写入不清新故障提示、原生CAS与MCP授权/幂等。最终stdio曾发现并保留WouldBlock失败，修正生产accepted socket为阻塞有界读写后，新增真实TCP延迟首帧回归及最终全量验证通过。以上不代替新提交的Linux GUI故障/通知/重启实测，也不代替正式发布。

异步确认、历史审计查询与独立Probe运维视图本轮本地验证：前端1217项通过，16项真实Linux Ops与1项Linux collector在macOS跳过；TypeScript/Vite生产构建通过。原生库163项通过，既有Linux桥1项ignored，MCP stdio两项通过。95项Node UI/故障夹具/通知/分页契约测试通过；修改范围ESLint零错误，Vault页面既有refresh依赖警告保留。测试覆盖Promise未决时零发送、精确token、未同意/失效/不可用审计区分、确认后SQLite等待期间的scope失效、文件与并发批次不重放写入、真实SQLite重开和同毫秒分页，以及无告警/过期Probe采样展示。新增安装包旅程要求独立SSH故障、三profile指标恢复、六条真实OS通知、资产观察排空和第二次真实重启。31f33a5的主/Agent CI共11项通过、真实Linux Ops16项通过且清理成功；GUI已通过直连真实取消/单次重启/恢复通知，但在跳板服务行点击失败，尚未执行后续独立Probe旅程，不能将其记为通过。

Agent分阶段scope检查与GUI几何诊断本地回归：前端1250项通过、17项Linux用例在macOS跳过，TypeScript/Vite生产构建通过；7个Node套件101项通过。新增覆盖确认presenter独立guard、下载/home/旧hash/prepare/upload期间作用域变化、首次变更前取消与发送后unknown、prepare失败停止激活、已知activation结果不被UI变化改写，以及同Vault推断和显式冲突拒绝。这些本地结果不证明生产签名分发或完整GUI闭环，新提交CI需单独核对。

提交`0150e80`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39107634955)和[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39107634945)共11项通过；下载核对的[真实Linux Ops报告](https://github.com/0xJean/shellbeam/actions/runs/39107634955/artifacts/12128743372)确认16项通过、零跳过、success/cleanup均通过，合并检出`d8f5b9e02a7ea16c376bddbc0e71ba588c6ebdfb`。[GUI](https://github.com/0xJean/shellbeam/actions/runs/39107634937)通过测试通知四状态及两条服务开启横幅，随后在直连服务点击前的矩形诊断报`element not interactable`；已导出真实受控Services截图，清理与应用退出通过。本轮没有证明此前跳板点击已修复，也未执行后续Probe旅程；详见`ops-ui-live-validation.md`。

结果未知提示修正本地回归：前端1260项通过、17项Linux用例在macOS跳过，TypeScript/Vite生产构建通过；定向恢复提示/Services/Activity组件29项通过。覆盖当前queued/running不误报、跨Vault二次筛选、显式scope冲突、延迟/失败读保留证据、可见刷新和canonical终态移除、请求合并、切库迟到与卸载清理。未变更远端命令或操作状态，不以此推断Services点击问题已解决。

提交`c21ddf6`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39108198016)和[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39108198109)共11项通过；[核对的真实Ops报告](https://github.com/0xJean/shellbeam/actions/runs/39108198016/artifacts/12129521842)为16项通过、零跳过、success/cleanup通过，合并检出`0327f389e1953b6780cfff6e22b8eb101d710f0a`。[GUI](https://github.com/0xJean/shellbeam/actions/runs/39108198018)再次通过直连取消/一次重启/恢复横幅，随后复现跳板服务行实际点击失败。部分坐标和受控截图证实窗口正文裁切目标行，且有正常queued读取被误显示为待恢复；Services后续改用窗口正文单一纵向滚动，组件27项和生产构建通过，但仍须新提交的安装包实测，不记为完整GUI通过。

提交`2312139`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39108730919)/[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39108730926)共11项通过，[真实Ops报告](https://github.com/0xJean/shellbeam/actions/runs/39108730919/artifacts/12129363399)16项通过、零跳过、清理成功，合并检出`2f16b553dd7f45c91b83d61a205763bf962e9b2f`。[GUI](https://github.com/0xJean/shellbeam/actions/runs/39108730917)已通过完整两路Local Service旅程及首次重启恢复（journey/recovery/alertNotifications均passed），并实际观察独立Probe故障/恢复六条系统横幅及六条metadata任务。最终在资产排空前因runner未等待异步主机摘要而报scope mismatch，未执行Probe第二次重启；GUI总结果仍为failed，清理和应用退出成功。

Services窄屏字段布局本地回归：前端1261项通过、17项Linux用例在macOS跳过，TypeScript/Vite生产构建通过；Services/incident/MobileShell/recovery组件28项通过，修改范围ESLint与空白检查通过。新增用长第二unit选择验证实际状态命令、同Vault审计、Logs原始目标及Load字段保留，不使用class断言代替布局证据；尚无窄屏安装包或设备渲染通过记录。

提交`d636bd8`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39109669939)/[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39109669919)共11项通过，[核对的Ops报告](https://github.com/0xJean/shellbeam/actions/runs/39109669939/artifacts/12130086687)16项通过、零跳过、清理成功，合并检出`7df474da3197412f18970de0a9177d9a467751a7`。[GUI](https://github.com/0xJean/shellbeam/actions/runs/39109669946)再次通过两路服务/首次重启和独立Probe六横幅、六任务，并完成jump与direct两次真实资产刷新、新原始时间及健康观察。第三个via刷新菜单原生点击被拦截；没有失败时坐标或截图能确定遮挡者，最终计数和第二次重启仍未执行，GUI总结果保持failed，清理和应用退出成功。

提交`593c938`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39110943174)/[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39110943161)共11项通过，[核对的Ops报告](https://github.com/0xJean/shellbeam/actions/runs/39110943174/artifacts/12130376995)16项通过、零跳过、清理成功，合并检出`0779f6a07c3508001c6da9ec4861e3e83fa7c1ad`。[GUI](https://github.com/0xJean/shellbeam/actions/runs/39110943186)保留服务/首次重启及Probe既有通过项，仍在via资产刷新失败；新实际几何和受控截图确认固定横向控制条完整覆盖了原生滚动后的菜单。最终计数和Probe第二次重启仍未验收，清理和应用退出通过，不以诊断成功替代GUI成功。

曾尝试保留sticky和既有滚动容器，按实际控件高度加8px为列表内交互目标设置滚动margin。该版本组件验证49/81.25px高度变化、清零、观察器清理及原横向分页/范围/键盘操作；相关55项通过，完整前端1264项通过、17项Linux用例在macOS跳过，生产构建、编译CSS规则、修改范围ESLint和空白检查通过。这些结果未证明原生点击与剩余Probe闭环；后续efb1b38实际GUI失败，该方案已移除。

提交`efb1b38`的[主CI](https://github.com/0xJean/shellbeam/actions/runs/39112417502)/[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39112417497)共11项通过，[核对的Ops报告](https://github.com/0xJean/shellbeam/actions/runs/39112417502/artifacts/12130858839)16项通过、零跳过、清理成功，合并检出`7e6dc376bae330191fefb1142950e2a8725e5bf0`。[GUI](https://github.com/0xJean/shellbeam/actions/runs/39112417494)通过两路服务闭环，但首次重启恢复时的direct主机Network菜单报不可交互；此处无失败像素/几何，不能推断为同一遮挡，原Probe资产刷新也未重测，清理及退出通过。

当前方案将横向控制条放回正常文档流，删除上述测高和margin实现；PRD无常驻要求。已有横向viewport、分页/范围/键盘操作保留，纵向滚动后控制条不再常驻，以结构消除已证实的覆盖条件。相关55项组件、完整前端1264项（macOS跳过17项Linux用例）、生产构建和修改范围lint通过；11d9f63安装包实测已通过相应原生菜单交互及完整GUI闭环。

提交`11d9f6331a3214c5bb572cd1ff2786a804f6ac32`的[第17次GUI运行39113100124](https://github.com/0xJean/shellbeam/actions/runs/39113100124)完整成功，[受控artifact12131831582](https://github.com/0xJean/shellbeam/actions/runs/39113100124/artifacts/12131831582)合并检出`48d6212cfb1a8877514030171847adc0a394205c`，`success: true`、`cleanup: passed`、最终应用退出成功。报告保留161条脱敏事件、28张受控PNG：两路服务各最多3次诊断点击、2条取消零变更、2次确认各重启一次及2条恢复告警；首次重启恢复4条服务Job和2个新观察，四条真实服务系统横幅无重放。

同一运行中，独立直连与保存跳板SSHD故障触发三profile的真实metrics失败和新采样恢复；六条OS开启/恢复横幅的实际窗口、完整标题/正文OCR及下载后PNG hash均已核对。两目标主机各有取消的acknowledge、已确认acknowledge和close三条metadata OperationJob，共六条；保存跳板只观察恢复，不执行告警metadata动作。jump/direct/via三个真实刷新菜单均得到原始采样时间不早于预设整秒边界且严格晚于上一样本的健康资产观察，无开放资产告警。

第二次实际退出和第三次进程启动后，六条Probe metadata任务、三个新指标样本、原有四条服务任务和两个新服务观察均恢复；本地通知账本在重启前后分别观察5秒稳定且不重放。Probe阶段初始总投递数为6，最终为16，其中包含其它合法通知，不能写为仅增加六次；独立metrics daemon的历史恰为6、显示/等待均为0。`probeRecovery`与`probeNotifications`的组合证明该Linux环境中的指标故障、系统展示与重启闭环；`inventoryLifecycleVerified`、`komariLifecycleVerified`及`readReceiptVerified`仍为false，真实资产刷新成功不扩大为资产通知、Komari或已读回执验收。
