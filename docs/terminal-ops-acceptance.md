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
| Provider来源、TTL、恢复和错误 | `probe-provider.ts`、`probe-scheduler.ts`、`probe-persistence.ts` | TTL到期产生结构化`expiryReason: ttl-expired`，未到期为null；旧持久化和MCP内层观察在读取时重算，采集失败独立保留错误，不伪装TTL到期；新结果不得被过期成功或旧失败覆盖 |
| 状态与主机身份一致 | `host-identity.ts`、原生route identity、unsupported采集契约 | 非Linux SSH采集明确unsupported，不当成offline；可用Agent/Komari观察可优先；身份来自实际解析端点，未解析跳板引用不复用旧复制地址；任务摘要按job最新状态统计 |
| 跨Vault观察隔离 | `host-observation-scope.ts`、monitor/inventory/tool原生持久化、MCP缓存读取 | 内存和持久化均按Vault/host标识；显式Vault与profile冲突在采集前拒绝；MCP按授权Vault读取。旧无scope缓存保留但不猜测归属，需要重新观察；已分scope的ProbeProvider历史保留 |
| 采集预算与架构 | `shared/collection-limits.json`、TS/Rust共享读取、统一Inventory.arch | 并发、采集timeout/输出与历史保留使用一个数值源；普通SSH命令和MCP任务各自的有界预算单独命名；架构从真实采集结果传入，缺失不猜测 |

## Phase 1：主机诊断与操作闭环

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| 运维列表、健康、告警、筛选 | `host-ops-view.ts`、`host-ops-filters.ts`、HostCard/HostsDashboard | Provider、OS、严重级别、能力、资源阈值、新鲜度；显示TTL、跳板、最后错误 |
| 资源摘要与跳板搜索 | HostCard Grid/List、`host-search.ts` | 显式展示RX/TX与uptime，选中Provider仅有metrics时仍可展示；缺失unknown、实际0保持0；跳板引用按同Vault当前配置搜索，编辑/删除不继续匹配旧复制字段 |
| 主机快捷诊断入口 | HostCard/HostsDashboard、SessionsContext、PcLayout | 卡片/列表直达Overview、Files、Services、Logs和健康检查；单主机刷新；同Vault复用会话、补齐UI标签页，右侧会话提升后不重复挂载；跨Vault同名ID不得复用 |
| Workspace观察范围 | `workspace-provider-state.ts`、WorkspaceStatusCards、WorkspaceRecommendationsPanel | 桌面/移动Overview指标与资源建议复用主机列表的Provider选择规则；读取同Vault/host的canonical与Komari持久化，切换Vault/路由拒绝迟到读取，映射重绑立即失效旧来源；未绑定引用按明确活动Vault解析，冲突引用不展示 |
| Overview来源与回退 | WorkspaceProviderSummary、共用`buildHostOpsViews` | 并列显示当前/其他Provider的健康、原始采样/接收/Komari同步时间、TTL、可信程度与实际能力；缺失时间显示未知，不借资产扫描或缓存写入伪造指标时间。Komari过期/不可用时明确显示SSH回退，遥测只属于实际选中的指标观察；资源建议独立检查该指标deadline |
| 文件写操作确认和审计 | `file-operation.ts`、`remote-fs.ts`、Files/SFTP组件 | 只读亦有审计；创建/上传/覆盖/删除/重命名/权限统一确认，后态stat验证；高风险强确认；路径哈希，无内容入审计；取消零执行 |
| 进程、服务和日志稳定诊断 | `workspace-diagnostics.ts` 和相应Workspace应用 | 有界读取/分页/筛选；进程终止、服务启停及enable/disable后态验证；无法观察结果记unknown；日志跟随可停止且有时限 |
| 真实异常到处理结果 | 实际desktop/mobile Overview的RecommendationsPanel | 流程测试：真实本地规则告警→日志诊断→确认重启→后态观察→OperationJob；取消不执行 |
| HTTP/TCP检查与本地规则 | `health-check-scheduler.ts`、`local-alert-*.ts`、`local-ops-store.ts` | 应用级有界调度，历史、持续时间、滞回、unknown不恢复、失败与恢复通知 |
| 跨会话告警审计 | `data/local_ops.rs`、`local-ops-persistence.ts`、`local-alert-actions.ts` | 原生按Vault/host/kind隔离、revision CAS；确认/关闭关联同scope已确认OperationJob；MCP返回安全历史和关联任务 |
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
| 真实Komari实例 | `scripts/komari-live-smoke.mjs`、`docs/komari-live-validation.md` | 未修改的官方1.6.0源码构建：节点/recent、非空真实历史、映射Provider、错误token与桌面Origin CORS头均通过；新节点coarse层为空时最多补查一次1h，保留真实时间，不声称完整24h覆盖；外部部署和实际WebView仍需对应环境验收 |

## Phase 3：明确授权的常驻探针

| 要求 | 实现证据 | 验证与状态 |
| --- | --- | --- |
| 实际独立采集进程 | `agent/` standalone Rust crate | 实际子进程采集、私有有界历史、进程锁、停止/重启历史连续性；桌面退出不影响已启动的用户服务 |
| 重连历史回灌与独立状态 | Agent `history-page`、`shellbeam-agent-history.ts`、原生`provider_history`、Workspace历史面板 | 原采样时间/TTL、稳定node身份、192KiB/100点上限；每主机每次4页/30秒，CAS游标与points同事务，锁库/失败不推进，旧回灌不覆盖已有sample；坏帧整页失败。真实daemon两页经实际TS parser互通，另有SQLite重开/竞争/回滚和跨Vault UI回归；旧Agent明确unavailable |
| 安装、升级、卸载与心跳 | 用户systemd/launchd生命周期、Workspace探针面板 | 不隐式sudo/linger，不监听端口或接收命令；新心跳与真实版本确认成功；不支持平台拒绝安装 |
| 制品分发与签名 | release catalog/native HTTPS下载/Ed25519双签名、SFTP激活 | 首次安装也必须签名；平台/channel/rollout/expiry/hash/size/重定向均受约束 |
| 失败回滚 | 原子备份/替换及激活计划 | 使用真实shell强制新制品失败，验证旧文件hash恢复并重新激活；无法验证的回滚保持unknown |
| 发布策略 | `.github/workflows/agent-release.yml`、`docs/agent.md` | 四目标构建与签名草稿流水线；发布入口传入签名灰度比例、每目标前版本hash；拒绝两角色共用签名密钥。PR CI独立验证四目标release构建；正式发布需要仓库配置独立私钥和审核draft，未自动发布 |

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
- 系统通知的打包展示、Windows/macOS/Linux实际通知设置仍需逐平台实机检查；helper/mock测试不能证明系统后端接收，真实Linux DBus测试仅覆盖daemon接收/拒绝，不证明可见展示。
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
| 桌面系统通知 | 对应安装包中验证允许/拒绝/系统禁用，以及实际横幅或通知中心条目 | Linux真实daemon ACK仍不等于展示；macOS/Windows编译与helper测试不等于系统授权或可见通知 |
| Komari部署 | 实际部署的TLS、token权限、节点映射、WebView请求及告警到Workspace跳转 | 已有官方1.6.0本地真实服务HTTP契约证据，尚不覆盖用户外部部署或所有版本 |
| 正式Agent制品 | 受保护签名环境、四目标制品、审核后的HTTPS来源，真实客户端首装/第二版升级/失败回滚/卸载及ProxyJump审计 | 生产密钥来源待决定，工作流尚未进入默认分支；未生成生产信任根、未发布Agent版本 |
| 主机运维产品指标 | 打包应用从列表发现异常到首次有效诊断不超过3步，再执行确认动作、观察后态与同主机审计 | 组件流程及隔离Linux Docker/SSL/混合多主机16项命令组合已通过；仍需真实用户桌面、生产Vault和实际部署环境，私有ACME不替代公有CA域名控制验收 |

远端Agent历史在桌面退出期间保留；新版本通过有界分页在重连后回灌，独立Vault/host/provider/node游标与数据同事务提交、CAS检查、锁库不推进，原采样时间和缺口保留。Workspace独立显示会话结果与持久进度；旧Agent不支持分页时明确unavailable，不读取无界历史。此增强仍不能替代正式签名制品和打包实机验收。

Overview统一Provider来源本地回归：8个定向测试文件、86项通过，15个修改范围TS/TSX文件ESLint零错误/警告。覆盖桌面资源卡与实际MobileShell挂载、Komari-only/失败SSH旁的健康Komari、TTL回退、跨Vault迟到读取、映射即时失效、后台缓存刷新，以及资产成功/失败不得更改指标来源、采样时间或遥测。该记录证明数据投影与组件契约，不替代打包应用的真实操作流程与系统通知展示验收；本轮提交对应CI以PR记录为准。

Overview与移动控制台整合本地回归：前端1003项通过，16项Linux真实Ops与1项Linux collector在macOS跳过；TypeScript/Vite生产构建通过，21个修改范围TS/TSX文件ESLint零错误/警告。原生148项库测试及2项MCP stdio通过，既有真实Ops桥1项按约定ignored；原生状态回归包含取消/单次使用/过期/有界注册表及慢OS调用不阻塞取消。iOS真机`aarch64-apple-ios`、模拟器`aarch64-apple-ios-sim`和Android NDK27.1/API24 `aarch64-linux-android`编译检查通过，既有移动browser/notification警告保留，未新增JS opener权限或外部webview能力。编译检查不证明设备上的系统浏览器交接与页面展示，本轮精确提交CI结果另见PR。
