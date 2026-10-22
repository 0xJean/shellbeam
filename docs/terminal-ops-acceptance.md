# Terminal + Ops 验收矩阵

对应 [产品 PRD 0.5](./prd-terminal-ops.md)，本次规划修订日期 2026-10-21。0.5 分批实现及本地证据见下文；完整原生接管仍待后续开发。0.4 及更早的 CI 证据不作为本次修改的验证结果。

## 0.5：统一原生客户端与双向同步（分批交付）

目标是 ShellBeam 提供统一客户端，Komari 为可选后端。一次保存及跨端一致性由客户端负责；不以“用户知道去哪一套设置再保存”作为通过标准。规则数量误报已在 `bfe6b674982fea524fb6f2b4d5b724a66abd07c2` 基线上用合成响应隔离复现，复现通过只证明缺陷存在。事实与建议见 [集成体验审计](./komari-integration-experience-audit.md)。

下表是完整 0.5 要求；仅分批实现记录明确列出的范围已取得本地证据，其余仍待实现或平台验收。

### 2026-10-22 第九批：安装包迁移与跨会话异常恢复

首轮安装包验收发现并保留三类失败：新增 React 回归未等待 `onPending` 被动 effect（已等待真实回调）；故障注入 HTTP 代理漏转发 CORS 头（已透传真实预检与响应，两个官方 1.6.0 隔离实例验证通过）；主机摘要异步恢复前漏点展开（已等待真实入口）。随后 `059148d` 成功完成测试 Vault、四条 SSH 连接、两服务接入和四节点绑定，在原生安装预检返回 `KOMARI_AGENT_REMOTE_UNKNOWN`。

原生真实 SSH 复现证实内置 helper 的 exec 参数为 44,163 字节，超过 libssh2 单包限制，直连和 ProxyJump 均返回 `Session(-34)`。改用短的固定 Python 启动器，通过同一受验证 SSH 通道的标准输入依次传输定长编译内置 helper 和 JSON 请求，保留原守卫、大小限制、超时与未知结果处理，不落盘脚本或将凭据放入参数。新增真实直连/跳板回归使用完整 helper、超单包输入和含引号/Unicode 的 JSON，核对真实拒绝结果、完整响应与退出码；安装包完整流程仍须在修复后的 head 单独通过。

`c6626da` 的真实安装包已完成生产安装、跨服务/机器/账号迁移和两次退出后恢复路径，但最终保留验证未通过；同 head 的 arm64 helper 合约在最后历史断言失败。检查发现此前用短期 `/api/recent` 缓存证明历史保留，源端停止后缓存过期不能代表数据丢失。现改为迁移前从真实 `/api/records/load` 记录每个节点的原始历史桶，结束后逐一核对仍存在；原始新样本门禁保持独立不变。负向测试拒绝丢桶、错节点、缺失时间或没有基线。恢复截图通过真实只读状态元素滚动到两端结果，不使用脚本注入。`2ce592f` 安装包实际完整通过（run 39727216629）：正常迁移、两次强退后的只读恢复、恢复来源/完成切换、14 条审计与 4 节点真实历史保留、最终卸载和清理/退出。收尾继续收紧报告为 14 个不同审计 ID（10 completed / 4 unknown），在卸载后重新核验凭据/历史，并等待原生滚动绘制、核验两端状态在视口内后捕获单张证据；最新提交须重新通过全部 CI。

收尾复测 `f90c489` 在第四个主机表单保存后未关闭，`1bcd702` 的无敏感值回读进一步确认部分字段在保存前就未正确录入（表单无错误，未进行 Vault 写入），不是迁移恢复失败。初次将组合键放入 `/value` 文本导致 `79fe438` 在 Vault 密码回读失败，已撤回。独立 Ubuntu 22.04 / WebKit 2.50.4 + React 每 25ms 重绘复现：clear 有 10/60 次不一致，文本组合键 3/3 次失败；标准 `/actions` 显式按下和释放 Ctrl+A/Backspace 60/60 一致，真实 `OpsUiDriver` 实现另 60/60 一致。仅主机资料字段选择键盘清空，其他输入保持原行为；逐字段及私钥回读、单次保存和原超时保留。协议回归验证修饰键释放、无 JS 注入/日志泄漏。隔离浏览器容器清理；证据 `/tmp/shellbeam-webkit-input-diagnosis.log` 和 `/tmp/shellbeam-webkit-driver-verified.log`，最新 App 安装包仍单独核验。

新增独立 `Packaged probe migration acceptance` 工作流：普通用户运行真实安装的 Debian App 和外部标准 WebDriver，私有 XDG/DBus/X11，两个不同 machine-id 的 systemd 容器和两套固定官方 1.6.0 服务。Vault、四个 SSH 主机/凭据、两套服务 API 凭据与节点关联全部从原生 UI 保存，不直接调用产品 IPC、不写入应用数据库、不替换产品远程执行返回值。探针使用内置生产信任；独立 observer 读取实际进程哈希、原始新样本及私有文件哈希。

场景包含：App 内默认签名安装；取消迁移无远端变更；正常跨服务/机器/账号迁移；两次目标已启动而实际 HTTP 上报读取挂起时杀死隔离 App，重启同一 Vault 后证明不重放，再从目标主机只读核验并分别明确恢复来源/完成切换。取消恢复不能改状态；14 个来源/目标迁移审计在再次重启后保持，旧 unknown 不改写为成功；最终 App 内卸载保留原配置、节点、Token 和历史。仅合成隔离凭据可进入 UI，截图只在离开凭据页面且敏感字段为空时导出；临时容器、网络、进程、数据目录和安装包均清理。

产品补齐：读取迁移状态失败时保留恢复入口、显式重读并阻止新的变更；IPC 响应丢失后读回持久化意图而不重复提交；从目标主机恢复也刷新来源；显示两端上次核验状态和双语阶段文案。前端全量 1554 通过（17 Linux 限定跳过），Node 协议/验收报告门禁 162 通过；生产构建与修改文件 ESLint 通过。新工作流真实结果尚待提交后核验，不以组件测试或前一批 14 项绿色代替。此批不修改运行中的本机验收 App、真实 Vault/凭据、生产签名私钥或用户图标；Linux 安装包证据不外推其他桌面/移动平台与多设备竞争。

### 2026-10-22 第八批：跨服务、机器与账号的双端探针迁移

原生表单选择现有主机/连接/监控节点；目标使用自己的 Token 与目标架构的可信制品。准备目标文件 → 停止来源 → 激活目标 → 核验新原始样本与进程哈希 → 双端回执。SQLite 意图、双主机锁与两端 OperationJob 原子保存，来源完整记录和私有配置/制品保留。同主机迁移持久化所选连接而不改默认连接；跨服务历史保留在原服务，不声称搬迁指标数据库。

中断保持未知与互斥锁；只读检查不发送远端写入，显式完成可补齐半完成回执，显式恢复必须先证明目标停止，再核验来源新上报。恢复创建新的确认与审计，不改写之前终态；重新建立作用域允许名称等非身份元数据变化，但实际节点/主机创建身份、所选连接、SSH 指纹、机器与账号仍须核验一致。

本地前端 1549 通过、17 项 Linux 限定跳过；Rust 库 234 通过、3 项 opt-in 忽略；Node 协议 139 通过；Python 文件系统及显式假 systemd 40 通过。生产构建、修改文件 ESLint、Rust 格式和 diff 检查通过。中英文 × 390/768/1440px × 未接入/新部署/运行/待恢复/已完成，共 30 组隔离浏览器布局无横向溢出或 iframe，已目视窄屏表单；fixture 只有 favicon 404。

真实 arm64 双端契约：两个隔离 systemd 容器使用系统生成的不同 machine-id，两套固定官方 1.6.0 服务，生产目录序号 `1792594908584` 与 `compatible-probe-2026-01` 公钥，1.5.11 原始制品。真实 SSH 直连与 ProxyJump、普通与 root 账号共 7 检查、5 新样本、81 helper 请求通过；逐份核对原始时间窗口、节点身份、固定进程哈希，以及源/目标 Token、原配置与历史保留。故障注入在 helper 边界使用不可执行的测试字节，证明先停止失败目标再恢复来源；不绕过或宣称通过原生生产签名校验。两端及网络清理、服务器退出为 true。证据 `/tmp/shellbeam-transfer-live.json`。此测试直接调用生产 helper，原生协调器由 Rust/React 回归验证，不冒充安装包中该新增任务的完整端到端证明。

初次隔离夹具验证发现镜像固化 machine-id、账号 UID 假设及安装后立即登录的就绪问题；修正为启动时生成 ID、读取实际 UID、等待真实版本接口，未放宽身份、样本或服务断言。最终生产 helper 合约已通过。新增真实双端契约加入现有两架构 CI；最新 head 的四份生命周期、两份双端迁移、Linux Ops 和安装包 GUI 报告需提交后独立核验。旧 head 绿色不替代本批。现有 GUI 同帧/OCR、scope/sample/no-replay 条件保持不变，运行中的验收 App、真实 Vault/凭据、生产私钥和 12 个用户图标未改动。

收尾补齐跨主机界面刷新：迁移结果到达后按 Vault 与两端 host ID 广播只读刷新，已打开的部署与待恢复状态同步更新，不重复执行任务；旧读取不会覆盖新结果。25 项定向 UI、最终全量前端 1551 通过（17 Linux 限定跳过）、生产构建和 ESLint 通过。对应前端变更也触发两架构兼容探针 CI，防止用旧 head 的报告替代新提交验证。

### 2026-10-22 第七批：已有探针接管与同节点地址迁移

已有固定官方 1.5.10/1.5.11 同账号 systemd 服务经过显式确认可接管至生产签名版本；不改写原 unit、配置或二进制，保留私有备份、Token、节点及历史。提供独立的同节点上报地址迁移、上一地址恢复和交还原服务。切换需核对新进程启动身份与原始新样本；失败恢复原状态，未知结果跨会话只读核验，不自动重放。旧记录增加可选字段，原有部署、Vault/SSH/API 凭据及历史 OperationJob 不重建。

真实 Linux smoke 新增原服务构建、错节点拒绝、失败接管恢复、生产签名接管、地址迁移与恢复、交还原服务及文件/节点/Token 保留。两架构 × 两服务范围各预期 13 项检查与 9 份新样本；GitHub Actions 的新 head 报告仍需独立下载核验，前一批绿色不能替代本批。原安装包 GUI 的同帧通知/OCR、真实 Linux Ops、scope/sample/no-replay 条件不变。

本地全量前端 1544 通过（17 项 Linux 限定跳过）、Rust 库 228 通过（3 项 opt-in 忽略）、Node 协议 139 通过；Python 文件系统/真实解析器与显式假服务恢复 31 通过。生产构建、修改文件 ESLint、Rust 格式、diff 检查通过。最终进程身份修正后 18 项原生定向回归通过。中英文 × 390/768/1440px × 未接入/新部署/运行/未知/交还原服务共 30 组合隔离浏览器布局通过，无横向溢出或 iframe，目视检查手机迁移视图；仅 fixture favicon 404，不代表真实安装包任务验收。新 head CI 在提交后单独核验。第七批交付时不包括其他安装脚本/服务布局、跨监控服务/节点/机器/账号迁移、完整多设备竞争或移动端安装包；双端迁移后续证据见第八批。详细约束见 [兼容监控探针](./compatible-monitoring-agent.md)。运行中的本机验收 App、真实 Vault/凭据和 12 个用户图标保持不变。

第七批首轮 CI：`70340d7` 的兼容探针 run `39699746286` 两架构均完成原 7 项检查、4 份新样本后，在原服务预检的进程环境检查失败；两份报告 cleanup/serverStopped 为 true，系统服务步骤尚未执行。预检错误地拒绝全部 `AGENT_*` 前缀，包含 CI 运行器的非配置元数据。修正按固定上游 Config 的实际 env tag 检查，继续拒绝 Token、Endpoint、配置文件、采集参数及 HOST_PROC 等所有已支持覆盖；增加元数据允许/真实覆盖拒绝回归。32 项 Python 与 18 项原生定向通过；真实系统重验仍须新 head 报告，未把失败改写为成功。

### 2026-10-21 第六批：内置生产签名与稳定发布源

默认源包含编译公钥、目录和允许域名，无需客户端录入密钥；老配置按自定义源完整保留，损坏/禁用配置不偷偷改变。签名目录绑定渠道、架构、版本、时效和序号；独立 SQLite 防目录重放、同序号替换及版本降级。检查、回滚和卸载继续使用原部署审计与保留制品。

新增回归覆盖 Node → Rust 目录验签、生产/测试根区分、官方仓库 URL 约束、过期及未来目录、SQLite 重开防回退、旧设置字节不变、默认安装零公钥输入、高级切换确认及过期时保留清理入口。原生显式网络验收使用编译默认设置匿名读取生产目录并核验两个实际制品，不访问真实用户 Vault。Linux 生命周期 CI 的升级步骤使用真实生产签名版本，仍保留两架构 × 用户/系统服务、原始新采样、失败回滚、无重放及卸载数据保留断言。

生产环境、首发及最新 head 的实际 CI/artifact 结果在 PR 验证栏记录；前一批绿色证据不替代本批。GitHub 后续发布工作流仍须 PR 合并后才能从受保护 main 运行；首次引导发布不是该工作流执行记录。

本地全量：1540 项前端通过（17 项 Linux 限定跳过）、224 项 Rust 库通过（3 项显式 opt-in 忽略）、139 项 Node 协议通过；另显式执行原生默认生产目录与双架构下载验签 1 项通过。生产构建、修改文件 ESLint、Rust 格式与 diff 检查通过。真实发布恢复读取复用原目录字节，完整发布重试保持目录提交不变；临时私钥已删除。新增工作流无尚未执行的生产运行记录。

### 2026-10-21 第五批：兼容监控探针生命周期

实现与边界见 [兼容监控探针](./compatible-monitoring-agent.md)。增加原生安装/升级/回滚/卸载、独立签名制品、SSH/ProxyJump、确认及 OperationJob、保留数据卸载和跨会话只读核验。不会覆盖已有 ShellBeam Agent 或非托管 Komari Agent；生产签名环境尚未配置，不用测试密钥代替生产发布。

本地定向：79 项主机/探针 UI、7 项 Python 文件系统/失败恢复、2 项 Node 发布器通过；全量 Rust 219 通过、2 显式忽略，包括新增跨语言验签和审计恢复。中英文 × 390/768/1440px × 未接入/新部署/运行/未知/发布设置共 30 组隔离浏览器布局通过，已目视手机发布设置。未接入主机无新增入口，无 iframe、横向溢出或组件错误；仅有 fixture favicon 404。

首次全量前端并行运行遇到两个既有实际进程测试超时（network-ops、shellbeam-agent-artifact-activation），7 项定向复测均通过；没有调整超时或断言，低并发全量 1538 通过、17 Linux 限定跳过；134 项 Node 协议测试、生产构建、修改文件 ESLint 与格式检查通过。amd64/arm64 官方探针真实 systemd 与新 head CI 的最终结果在提交后补记。Docker 本地镜像下载不可达，没有据此声称真实服务测试通过；新增专门的 Linux CI 报告要求保留进程、原始新上报、回滚、数据保留和清理证据。

### 第五批首次 CI 的协议与最终进程核验修正

`f683d30` 新生命周期 run `39606266821` 的两个架构均在初始化测试服务阶段失败，报告中 cleanup/serverStopped 为 true。原因是 smoke 将版本接口误按裸对象读取、将 flat 新增节点接口误按 data 读取，尚未进入真实 Agent 安装。隔离官方 macOS 1.6.0 实例已确认版本使用 data 包装、节点新增为 flat、RPC 节点 UUID/创建时间正常，服务已退出清理；修复只规范响应解包并细分诊断阶段，不改等待期限或断言。

同时补强原生结果：新样本后再次读取进程与同一远端部署记录，返回前再检查样本时效；自动补偿只允许进程 active 状态变化，任何其他 journal、配置或操作 ID 改变都拒绝覆盖。已通过 10 项相关 Rust 回归。被中断但经只读核验健康的 activating journal 可以在新确认后升级，不需要只读恢复偷偷写回。

静态复查另修正已安装程序识别：监控服务本身的 `komari`/`komari.service` 不等于 `komari-agent`，同一服务器允许部署两者；仍拒绝既有 Agent 和其他托管部署。增加官方服务/Agent 文件名及自身/他人部署路径回归，8 项 Python 测试通过。

真实 systemd 暴露 `WorkingDirectory` 被按命令参数加引号的错误，已按目录字段语法修正，Python 回归增至 9 项。`9ab6af4` 的 run `39609174956` 在 amd64/arm64 均完成真实 1.5.10 安装、篡改哈希拒绝、1.5.11 升级及原始新样本/进程哈希核对；后续测试脚本在构建无上传字节的回滚请求时访问空值，尚未发送回滚。脚本已修正可选字节处理，原来的回滚验收条件保持不变。两份失败报告仍记录 failed，cleanup/serverStopped 均为 true；不把部分成功写成完整通过。CI 随后增加两架构各自的 root 系统服务旅程和 checkout/作用域证据，完整最终结果须按最新 head 的报告核对，记录于 PR 验证栏。

### 第四批 CI 修复记录

`ae46f5d` 有 11 项通过，安装包 GUI run `39598625400` 在配置通知策略时失败（`alert-notification-policy / no such element`，artifact `12345686360`）。真实系统通知的可见/暂停/恢复/不可用四场景已通过，清理和应用退出也通过。原因是此前将用户开关明确命名为 “Send reminders from this device”，两个 GUI 流程仍按旧文案定位复选框。修复更新这两个真实 UI 选择器和对应 driver fixture；保留实际点击、状态回读、保存后重新挂载验证及所有截图/OCR/no-replay 断言。修复提交 `0f772ba90f2dcf85f55894069e726753a007c64c` 的 12 项检查已全部成功；这是第五批功能之前的基线，新功能不能借用其绿色结果。

### 2026-10-21 第四批：原生接入、服务配置与通知投递

已实现的用户流程：新增服务 → 原生登录/初始化 → 同次保存凭据并发现主机 → 统一主机规则；现有服务 → 配置访问、Webhook、服务通知及指标保留 → 保存并读回 → 冲突/中断原生恢复。日常设置不再提供整站后台入口；已有可用监控不建议重复安装 Agent。详见 [协议、持久化和边界](./monitoring-service-native.md)。

| 检查 | 本地证据与边界 |
| --- | --- |
| 前端全量 | 1526 通过、17 Linux 限定跳过；包括原生接入双语、初始化确认/拒绝、Vault/配置失效、凭据遮罩、确认与重试、只读恢复，以及未接入/多连接目录旧回归 |
| Rust 库 | 210 通过、2 显式忽略；包含字段白名单、三方合并、相同字段冲突、指标重建身份、禁止零天清空、完整配置指纹、撤销上下文、原子意图/确认审计、Vault 加密隔离、响应重定向/脱敏等 |
| Node 协议 | 132 通过；通知同帧截图、独立标题/正文 OCR、可见性、sample/scope/no-replay 断言未修改 |
| 构建与静态检查 | 生产构建、修改文件 ESLint、cargo fmt 和 diff 检查；仍有既有 Vite chunk-size 提示 |
| Chromium 真实生产组件 | 390/768/1440px × 中文/英文 × 初始化/冲突/Webhook/保留策略/已保存修改，共 30 组合，无文档横向溢出、无 iframe 或渲染错误；另检查手机冲突恢复视口截图。隔离合成 IPC，不代表真实 Vault 或安装包端到端 |
| 官方 1.6.0 原生 HTTP 合约 | 显式运行 `official_service_wire_contract` 忽略测试，通过生产 `exchange`：初始化、登录、保存 Key、受保护读取、Webhook 往返和真实 HTTP 接收、注销、错误认证。随机合成凭据、回环临时实例与自动清理，不接触用户服务器 |
| 官方 1.6.0 完整服务通知 | `scripts/komari-live-smoke.mjs`：保留资料/离线规则旧读写验收，增加指标保留写入读回；实际接收 Test、Offline、Online 各一次。通过 Agent 上报协议提供合成样本，等服务自己的 35 秒在线期限和离线宽限期；没有伪造事件或改数据库。不是实际安装 Agent 的生命周期验收 |

官方服务版本 `1.6.0`，hash `1b76b7ad5bc3de6529bb7f0577069b4ac241fec3`。服务测试 UI 只承诺服务已接受；这次隔离接收端的实际收件证据不能外推到用户的渠道。上游未提供受支持的定时静默/负载规则接口；插件脚本渠道、账户全生命周期和兼容 Agent 生命周期仍有缺口，不宣称 0.5 全部完成。

本次新增提交的 GitHub Actions 和安装包流程需单独验收。此前 `c5007ab` 的 12 项检查已全部通过，Linux artifact `12342006096` 和 GUI artifact `12342516868` 已独立核对：16 项真实 Ops、清理及退出、4 服务/6 Probe 任务恢复、3 inventory、6 metrics 通知、5000ms no-replay、24 PNG 哈希、165 事件和两组同帧独立标题/正文 OCR。merge `c346addf8ddd48bb8ffc0280b3d99eeac78b8eb0` 父提交包含该 head；这些仅为前一提交证据，不能代替本次新代码 CI。本地正在运行的验收 App 未重启。

### 2026-10-21 首批实现与证据

- 告警：规则数（含禁用规则、全局计数）不生成活动事件；旧 `load/offline` 记录补证据标记，保留原 ID、处置状态、关联任务、审计，不伪造恢复或重发通知。当前计数排除旧误报；确认/归档与最近观测分开显示。后端规则和通知写入尚未开放。
- 资料：现有主机编辑器和 VPS 编辑入口共用资料同步区域。显式启用已关联服务后，名称、分组、标签沿用原保存动作；SSH 地址、跳板配置、凭据引用不发送给后端。未关联用户没有新的卡片或接入提示。
- 存储：主机编辑和绑定意图原子提交；外部资料写回同一 `workspace_hosts` 行，保留 ID/凭据引用。新增/删除主机按行事务执行，避免陈旧整表快照覆盖同步结果。旧客户端绕过队列更新/删除已启用同步的主机时，SQLite 触发器拒绝写入；停止同步后可兼容旧客户端。
- 恢复：每 Vault 最多两个并发同步目标，每轮最多 20 条，正常读取 TTL 60 秒；失败指数退避 60–960 秒、最多五次，保留待处理意图并支持手动重试。重启或响应丢失先读回；每字段共同基线三方合并，同字段冲突原生选择。初次不一致先展示冲突，不批量覆盖。
- 授权：锁库会递增原生会话代次；切库、配置/映射修订变化、删除、解绑与节点身份变化阻断旧请求。已经发出的请求不能保证撤回，重启核验实际结果。配置或映射变化后保守停止，需重新启用。
- 审计：本地事务 outbox 向 OperationJob 幂等投影，跨数据库中断通过事件 receipt 恢复。重试沿用任务 ID；同一主机多目标聚合，部分成功不将任务提前置为完成；后续外部编辑建立独立任务。审计只记录字段名、状态和安全代码，不记录值或令牌。

本地验证：

| 检查 | 结果与范围 |
| --- | --- |
| `npx vitest run` | 1493 通过、17 跳过；macOS 不执行 16 项真实 Linux Ops 和 1 项 Linux collector。覆盖旧误报迁移/通知不重放、同步 worker、原生编辑区、失效与重试入口 |
| `cargo test --lib` | 184 通过、1 忽略。包含 13 项 metadata SQLite 回归：事务回滚、磁盘关闭重开、末次中断恢复、同任务多目标、删除重用 ID、配置/映射失效、冲突与幂等审计 |
| `node --test scripts/*.test.mjs` | 132 通过，保留通知真实同帧截图/OCR/可见性及 no-replay 原有断言 |
| `npm run build`、修改文件 ESLint、diff check | 本轮检查；Vite 既有 chunk-size 建议不影响构建 |
| Chromium 原生编辑区隔离布局 | 390/1280px × 中文/英文 × 未关联/冲突/权限失败，共 12 组合；使用生产组件/CSS，未关联为零同步区域，其余可达，无页面或对话框横向溢出；已检查实际截图。真实点击三个冲突选择并提交，验证仅发送一次含精确 Vault/版本/选择的原生 resolve 调用。仅合成 fixture，不代表安装包/Vault 实机验收 |
| 官方 Komari 1.6.0 隔离实例 | `scripts/komari-live-smoke.mjs` 运行生产 REST 适配器：修改三字段、读回验证、外部修改读回、恢复原资料；同时保留认证/采样/历史/CORS 原验收。自动创建并清理隔离回环实例，不接触用户服务器/Vault |

首批历史边界：此批次针对既有关联主机；纯监控与多连接在下方第二批交付。完整资产字段、跨设备端到端同步、原生规则/通知/服务初始化和探针管理仍未完成。1.6.x 无 ETag/CAS，不能保证任意第三方并发编辑不覆盖；其他版本拒绝写入。桌面安装包本阶段流程及真实 Linux Ops 应以本次新 head 的 CI 报告为准，旧绿色结果不能替代。正在运行的本地验收 App 未重启，用户数据、凭据和图标文件未变动。

### 2026-10-21 第二批：纯监控主机与多连接目录

- 同一原生主机目录和编辑器承接监控导入、共享资料及多个 SSH 连接。导入不创建假地址/用户名/凭据；后续加 SSH 保持同一 hostId、节点绑定、指标历史和审计。当前所有新 SSH 操作使用所选默认连接。
- SQLite 增量列保存连接集合，旧单连接记录与 `secretKeyRef` 继续可用。导入检查 Vault、数据源版本和映射修订，跨同 endpoint 的重复集成也阻止重复节点导入；事务失败不留下未绑定主机或缺失审计的半成品。
- 移除连接是主机保存的一部分，不调用删除主机/凭据/历史。目录创建、修改、导入使用持久化审计 outbox；OperationJob 投影幂等，保留已有共享资料同步任务。缺少多连接字段的旧客户端覆盖、旧默认投影或全量删除丰富记录会被拒绝。
- 主机列表、资产视图、SFTP、转发、扫描、批量操作和 MCP 根据 SSH 能力提供入口。纯监控主机显示“仅监控”，可在原列表展开资源与告警并配置 SSH；不生成因缺少 SSH 凭据而导致的采集故障。
- 地址/名称匹配改为待确认建议，支持非默认连接地址。保留旧自动匹配与历史，但不由建议发起新采集；解绑不会在下次发现时自动复活。已有手动绑定继续工作。
- 默认连接切换保留旧终端；旧会话 Workspace 要求重新连接。自动重连读取最新主机并传递连接身份，原生端再次核对，防止等待期间切换默认连接导致误连。

| 本地检查 | 结果与证据范围 |
| --- | --- |
| 全量前端回归 | 1505 通过、17 项 Linux 限定跳过；新增导入、锁库、跨 Vault 迟到结果、旧凭据、添加/移除连接、旧会话及监控身份连续性用例 |
| Rust 原生回归 | 190 通过、1 忽略；覆盖连接磁盘持久化、旧客户端拒绝、导入去重与回滚、目录审计幂等、重连身份检查及既有真实 SSH/ProxyJump fixtures |
| MCP stdio 集成测试 | 2 通过；隔离进程验证协议桥接和错误响应，不读取真实 Vault |
| Node 协议测试 | 132 通过；未修改真实通知同帧/OCR、原始采样、scope 或 no-replay 验收断言 |
| TypeScript/Vite 构建、ESLint、diff | 生产构建通过（既有 bundle-size 建议）；修改文件 ESLint 对照 HEAD，无新增诊断，保留 21 个既有错误和 18 个警告；新文件通过。diff 检查通过 |
| Chromium 隔离 UI | 390/1280px × 中英文 × 纯监控编辑/多连接编辑/监控导入，共 12 组合；生产组件与 CSS，无页面/对话框横向溢出，已查看截图。实际点击导入、配置 SSH、暂存连接及最终保存，核对同一 hostId 与单次导入；只使用合成数据和模拟 IPC，不代表安装包真实 Vault 验收 |

仍有限制：默认连接通过编辑器选择，尚无临时逐次连接选择；纯监控资料与监控详情在主机页，未做无 SSH 独立 Workspace。endpoint + nodeId 去重不是服务端签名身份。多设备端到端合并、完整资产字段和原生规则/通知/服务/探针生命周期继续后续阶段。新 head 的 Linux Ops 和打包 GUI 以 GitHub Actions 实际报告为准；旧 head 绿色不算本批通过。用户真实 Vault、凭据、运行中的 Acceptance App 及 12 个未跟踪图标文件未改动。

第二批 CI 补验（仅 `38e34485a5f4b8458caefc9c898ec815fb66a1d5`）：[主 CI](https://github.com/0xJean/shellbeam/actions/runs/39585271081)、[Agent CI](https://github.com/0xJean/shellbeam/actions/runs/39585271169) 和 [安装包 GUI](https://github.com/0xJean/shellbeam/actions/runs/39585271059) 共 12 项成功。独立下载 [Linux Ops 报告](https://github.com/0xJean/shellbeam/actions/runs/39585271081/artifacts/12339740228)，16 通过、0 跳过、清理成功；[GUI 报告](https://github.com/0xJean/shellbeam/actions/runs/39585271059/artifacts/12341085156) 确认成功、最终退出和清理、4 条服务任务及 6 条 Probe 任务恢复、3 份新资产观测、6 条真实 metrics 通知和重启后 5 秒无重放。独立核对 24 张 PNG 的 SHA-256/字节数和 165 条事件，查看 via/jump 开启及恢复共享截图：两条通知在首帧分别通过标题/正文 OCR。两个报告的 merge `38f31f8cfc9314e8887ecba9c6ac35a8ca5b2433` 的父提交包含该 head。此证据不替代下面第三批的新提交 CI，也不证明 Komari 通知投递。

### 2026-10-21 第三批：原生主机离线通知规则

- 主机编辑器按需展开规则；监控与通知设置复用同一表单，与设备提醒同页。未接入用户不显示规则入口。读取启用状态/宽限期，显式保存后原生持久化、预检、最小字段 POST 和 GET 核验，不打开原站。
- 事务保存 `host_notification_rules` 和既有审计 outbox，凭据只保留引用；SQLite 版本检查、Vault 会话代次、主机创建时间、服务版本、手动绑定修订、节点创建身份共同阻断陈旧操作。取消修改不要求读取凭据、不修改服务器规则；原有主机、映射、资料、凭据、告警和审计不删除。
- 失败或中断后按 60 秒 TTL 读取，最多两个并发、每轮十条；未核验写入不自动重放。显式重试沿用任务；冲突保留双方值并显式处理，之后的外部变更有独立核对任务。相同读取不追加重复审计；跨数据库投影使用 receipt 恢复。
- “已保存”“正在核验”“需要处理”“冲突”“服务端已核验”分开表达。规则未核验前不生成虚假的观测时间；权限、版本、回读不一致和作用域变化有固定双语说明。规则保存或停用不表示送达/已读、静默已有通知或监控恢复。

| 本地检查 | 结果与范围 |
| --- | --- |
| 全量前端回归 | 1521 通过、17 项 Linux 限定跳过；包括新增协议/worker 8 项、原生规则组件 8 项，覆盖读写字段白名单、版本拒绝、请求并发/TTL、重启只读恢复、冲突、取消、切库/卸载迟到读取和未接入用户零入口 |
| Rust 库 | 198 通过、1 忽略；新增 8 项规则/审计测试覆盖事务失败回滚、磁盘重开、响应丢失、显式重试、身份/映射变化、删除重用 ID、版本竞争与审计幂等。最终观测时间与完成后外部变更调整后，25 项主机模块回归再通过 |
| Node 协议 | 132 通过；未改弱同帧通知、独立标题/正文 OCR、可见性、原始采样、scope 或 no-replay 条件 |
| 构建、ESLint、diff | TypeScript/Vite 生产构建通过；本批所有修改 TS/TSX/MJS 的 ESLint 通过；保留既有 bundle-size 建议；diff 检查通过 |
| Chromium 隔离 UI | 390/1280px × 中英文 × 读取表单/失败/冲突，共 12 组合；生产主机编辑器与 CSS，真实展开并读取规则，无页面或对话框横向溢出，已查看截图。模拟 IPC/服务，不能替代桌面真实 Vault 验收 |
| 官方 Komari 1.6.0 独立实例 | `komari-live-smoke.mjs` 运行生产适配器，核验禁用/启用、宽限期写回及外部修改读取；`offlineRuleWriteReadback`、`externalOfflineRuleReadback` 均通过，节点身份不变。上游 hash 为 `1b76b7ad5bc3de6529bb7f0577069b4ac241fec3`；测试通知全局禁用、没有外部渠道，完成后清理独立实例 |

边界：仅 1.6.x 离线规则，不包括负载规则、渠道编辑/迁移、定时静默或真实 Komari 投递验收。服务无 ETag/CAS，读前检查与读回不能排除任意并发覆盖；结果未知时保留意图，不重放请求。新 head 的 Linux Ops、打包 GUI 尚待 GitHub Actions 验证；上批绿色不能替代。本机运行中的 Acceptance App、真实 Vault/凭据和 12 个用户图标未修改。

### 第三批 CI 修复记录（2026-10-21）

`a8a7fb8` 的[主 CI 39588263487](https://github.com/0xJean/shellbeam/actions/runs/39588263487) 有四项失败：三个原生平台均因新增审计测试未按 rustfmt 排版而失败；前端一个告警回调测试只等待回调开始便点击第二个操作，此时第一个异步确认尚未完成，按钮仍被正确禁用。修复统一测试排版，并用可控 Promise 明确验证确认期间禁用第二个操作、不会触发回调，完成后按钮恢复可用，再点击并核验双方各调用一次及原状态保留。没有修改产品告警互斥行为，没有增大超时、重试点击或弱化通知验收断言。

修复后本地 27 项相关前端回归、全量 1521 项前端（17 项平台限定跳过）、原生审计恢复测试、生产构建、修改测试文件 ESLint、全仓 `cargo fmt --check` 和 diff 检查通过。此失败记录保留；修复提交的 GitHub Actions、Linux Ops 与安装包 GUI 必须独立通过后才能更新为完整 CI 验收。

### 完整阶段验收要求

| 对应阶段 | 场景 | 必须取得的结果与证据 |
| --- | --- | --- |
| A | 离线通知配置含禁用规则、未触发规则或缺少事件协议 | 不生成活动故障；真实有效异常仍能产生事件；旧误报保留审计并准确标记证据状态，不伪造恢复 |
| A/C | 确认、归档、静默和实际恢复 | 故障事实与处置分别验证；有远端写入时验证后态，无对应协议时不伪造远端完成；停止提醒的任务实际影响所选渠道 |
| A/B | 稳定主机身份与能力 | 同一主机的多连接、多来源不产生重复主机；名称/IP 相似不擅自合并；同 Vault 内节点去重，不跨 Vault 合并或暴露关联；实例替换不能继承旧写入授权 |
| B | 原生修改共享主机资料一次 | 本地期望值及任务持久化；已支持字段远端写入并读回；只在所有应同步目标完成后显示已同步，任务结果唯一 |
| B | 后端外部修改资料 | 反向同步到同一主机；目录、资产、Workspace 与 MCP 读取同一结果，自己写入的回声不循环同步 |
| B | 初次接入时双方资料不同 | 预览差异并建立共同基线；不在迁移时自动批量覆盖远端或重复创建节点 |
| B | 同时修改不同字段或同字段，设备时间有偏差 | 不同字段自动合并；同字段在原生界面一次解决；验证版本协议，明确没有条件写入时的并发限制 |
| B | 远端写入成功但响应丢失，随后应用崩溃 | 重启先读回并归并同一 OperationJob；不重复创建、不重放不确定写入、不重复投递通知 |
| B | 离线编辑、部分目标失败、权限不足 | 修改保留；显示同步中或需处理；在原生界面重试/修复权限/解决冲突，无第二套保存流程，无假成功 |
| B | 仅监控主机以后添加 SSH | 复用 hostId、绑定、事件、历史和审计；未配置 SSH 时不伪造连接能力；后续仍覆盖 ProxyJump |
| B/D | 编辑排队后解绑、删除、锁库、切库 A→B→A 或更换后端 | 不写入错误目标、不复活关联；凭据不泄露；取消不冒充已撤销远端效果，补偿不覆盖后续外部修改 |
| B/D | 一个主机绑定多后端，多设备编辑和设备同步 | 每个目标结果可查；共同版本及操作 ID 防止回声；设备同步不自动授权执行远端动作；冲突在一个客户端流程处理 |
| C | 原生接入、初始化、授权和服务管理 | 支持版本的核心任务无需整站 WebView；Key、Agent 身份和 SSH 凭据权限正确，配置保存、认证和首次采样分别验证 |
| C | 原生规则与通知配置 | 规则实际写入并读回；设备提醒与持续通知在同一页面管理；应用关闭后发送行为符合说明；已有渠道迁移不被隐式停用 |
| C | 同一异常有多个采集来源或投递通道 | 事件证据、生命周期、静默范围及投递职责可核对；相关事件不丢失独立故障；真实远端通知不能仅用前端去重测试代替 |
| C | 后端远程任务和外部任务记录 | 应用发起的动作有真实确认、执行与后态；外部记录保留来源，不能补造应用发起过的操作 |
| D | 已有兼容探针、缺少能力、安装/升级/回退/卸载 | 不推荐重复安装；不同制品和身份不混用；原生任务、权限、签名适用范围、真实版本/心跳和回滚分别验证 |
| D | 未接入、SSH-only、仅监控、混合主机，桌面及移动端 | 原有终端/SFTP/转发体验保留；日常无厂商重复导航；同一对象从各入口得到同一编辑与结果；不借原站完成核心任务 |
| B，D 扩展 | 旧 Vault、旧映射、历史、审计及投递账本升级和版本降级 | 首次开放写入前保留配置 ID、hostId、凭据引用和旧记录；无强制重填、重新映射或历史通知重放；迁移失败有可恢复证据；实际旧版本遇到新 schema 时走已验证兼容路径或拒绝不兼容写入，不能覆盖新记录 |

开发次序按 PRD 第 11 节 A–D。B 首次开放写入前必须完成迁移、锁库/解绑/切库失效和旧队列保护；标为 B/D 的条目在 D 扩大覆盖，不能推迟基础保护。第一条完整验证链路为主机资料修改、远端验证、外部修改拉回和失败/冲突恢复；不能以只增加能力接口或调整菜单命名交付。所有运行时与安装包验证必须记录对应新 head，现有 0.4 的测试数与绿色 CI 不覆盖本表。

历史隔离 Ubuntu X11 安装包完整 GUI 验收已通过（不代表本次体验收敛已完成实机验收）：[第17次运行 39113100124](https://github.com/0xJean/shellbeam/actions/runs/39113100124)，head `11d9f6331a3214c5bb572cd1ff2786a804f6ac32`、合并检出 `48d6212cfb1a8877514030171847adc0a394205c`。[下载核对的报告与受控截图](https://github.com/0xJean/shellbeam/actions/runs/39113100124/artifacts/12131831582)确认服务闭环、独立 Probe 指标告警、三主机资产刷新及两次真实应用重启均通过，清理和最终退出成功。下文历史失败记录保持原结果；其它平台、外部 Komari、正式 Agent 分发和公有 CA 仍按各自边界验收。

## 0.4：按主机可选数据源与渐进展示（既有实现记录）

以下保留 0.4 交付时的实现位置与验证边界：改变页面职责和当前来源资格，保留原有数据、凭据、任务与审计。CI、截图、真实 Linux Ops 及安装包结果均只属于所记录提交；组件/状态测试不替代安装包、真实通知或外部 Komari 验收，也不证明新增 0.5 契约已完成。

| 场景 | 实现位置 | 本次验收条件与证据边界 |
| --- | --- | --- |
| 没有 Komari，也没有保存展示偏好 | HostsDashboard、HostGridCard/HostListItem、主机展示偏好 | 默认五列连接视图；终端、SFTP、端口转发与 SSH 运维仍可用。无 Komari/Agent 空模块，无空资源诊断；使用正常组件测试及实际渲染核对，不能以隐藏整个主机功能通过 |
| SSH-only 或已有关联的 Komari | 主机监控摘要开关、共用 Provider 投影 | 用户可显示九列监控摘要；切换只保存展示偏好，不写采集、通知、集成或 Agent 策略。Grid/List 使用同一信息层级，保留有效数据与真实告警 |
| 同 Vault 有集成，但此主机未关联 | `komari-source-eligibility.ts`、`host-ops-view.ts`、`workspace-provider-state.ts` | 只有符合当前集成/节点/主机关联的快照可参与当前状态；不借其他主机节点数据，不为未使用的能力制造故障 |
| 停用、解绑、重绑、endpoint 变化 | 当前源资格与原生映射 revision | 专用与 canonical 缓存使用同一资格检查；空映射不能复活已解除关联。保留历史快照、原始告警、凭据及 OperationJob；历史可查询不代表当前源有效。测试须同时覆盖状态变化、迟到读取和 A→B→A |
| 主机卡详情与批量选择 | HostCard Grid/List、共用摘要与详情 | 默认不展开日志、告警明细、审计、TTL 或重试；摘要保持真实异常可见，展开后原确认/关闭动作及审计可达。主机/Vault/展示模式切换收起；批量选择框的点击、双击和键盘不能打开终端 |
| Workspace 概览 | WorkspaceStatusCards、WorkspaceProviderSummary | 一组资源值、一处来源/原始采样时间；无采样只给一个中性空态，明确 SSH 功能仍可使用。真实中断/过期/回退可见，未知/首报不等于 SSH 故障；诊断中保留原 TTL、能力和重试 |
| Agent 与历史按需打开 | ShellbeamAgentPanel、ProviderHistoryDisclosure | 不默认挂载安装/制品/回灌及指标历史面板；已有记录可管理，实际异常有提示，未安装/退役/不支持不作为当前故障。历史查询只在展开后开始，跨 scope 关闭且拒绝迟到结果；不改变后台采集或安装确认流程 |
| 统一告警中心 | 主机页告警中心、原 Komari/本地操作入口 | 支持主机/来源/生命周期筛选；原始 ID、成员、确认/关闭与 OperationJob 关联保留。中心汇总和当前主机状态按各自口径核对，不能把历史事件重新算作当前来源 |
| 分类设置与接入 | SettingsPanel、KomariSettingsSection | 默认常规；连接与终端、监控与通知、集成、高级分别可达。Komari 只在添加/编辑后展开向导；编辑复用凭据引用和映射，退出/切换后的异步结果不得污染新上下文 |

本地完整验证（本次实现）：

- 前端 **1,476 passed / 17 skipped**；跳过项为本机不具备 Linux 环境的 16 项真实 Ops 与 1 项 collector。覆盖来源资格、endpoint 变化、重命名、最后一个映射解绑、Vault 切换、按需展示、真实确认回调及历史审计。
- GUI/夹具协议脚本 **129/129**；设置导航改为真实点击分类，不放宽同帧系统通知截图、OCR、可见性或重启断言。TypeScript/Vite 生产构建、改动 TS/TSX/MJS 的 ESLint 与差异检查通过。
- 隔离 Chromium 使用实际组件/CSS和合成数据，检查无监控、SSH-only、混合 Komari 的列表/卡片、中英文深浅色、375/1024/1440px 共 36 种组合；最终再真实点击三种宽度下的告警、详情、监控开关、筛选关闭和末尾主机连接入口。未出现页面横向溢出；375px 筛选面板保持在视口内，未观察主机不生成空资源卡。详情展开前后主行高度相同，最终混合数据连接视图在 1440px 为 130px。通过明确的内部滚动容器核验末尾内容可达，早先未设置容器的全页截图不作为纵向可达性证据。
- Workspace 六种宽度/来源组合保持一组资源值；无来源只有中性空态，来源诊断与监控工具按需打开。浏览器截图保存在本地临时验收目录，不替代安装包或真实通知展示。
- 当前提交的 GitHub Actions、真实 Linux Ops 和安装包 GUI 结果在 PR 中按实际 head 单独记录，旧提交绿色不计入本次。

本次未操作用户真实 Vault 或凭据，也未把运行中的 ShellBeam Ops Acceptance 重启为本次版本；该应用之前的构建与界面不构成本次实机证据。

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
| 运维列表、健康、告警、筛选 | `host-ops-view.ts`、`host-ops-filters.ts`、HostCard/HostsDashboard | 默认连接视图，运维摘要与高级筛选按需；Provider、OS、严重级别、能力、资源阈值、新鲜度继续可查，TTL和完整错误归入详情 |
| 紧凑主行与运维详情 | HostGridCard/HostListItem、对应五/九列模板、真实GUI展开导航 | 0.4 默认五列连接视图，用户可选择九列监控摘要；Grid/List 详情显式展开，List 详情在整宽区域按服务/任务、告警、监控分组，表头与主行对齐，展开不改变主行高度。此前隔离Chromium曾验证旧九列重告警主行由938px降至174px、列宽偏差0px，属于旧版证据，不能证明本次五列与Grid行为 |
| Probe分区采样状态 | `hostProbeEvaluations`、HostCard Grid/List与HostsDashboard | 同Vault/主机canonical metrics/inventory evaluation保留在详情，展开后无告警时仍可查真实健康与原始采样时间；共用180秒新鲜度，过期/缺失/无效/未来时间为unknown，UI刷新不得伪造采样时间。真实SSH告警标题包含主机名以区分多主机系统通知 |
| 资源摘要与跳板搜索 | HostCard Grid/List、`host-search.ts` | 显式展示RX/TX与uptime，选中Provider仅有metrics时仍可展示；缺失unknown、实际0保持0；跳板引用按同Vault当前配置搜索，编辑/删除不继续匹配旧复制字段 |
| 主机快捷诊断入口 | HostCard/HostsDashboard、SessionsContext、PcLayout | 卡片/列表提供可见的一键Services按钮，避免将原生菜单打开/选择少计为一次；打开Services、选择服务、读取真实status为三次实际点击，11d9f63打包GUI已验证直连/跳板两路诊断，后续两次真实重启均恢复原审计与新观察。保留Overview、Files、Logs、健康检查和刷新；同Vault复用会话、补齐UI标签页，右侧会话提升后不重复挂载；跨Vault同名ID不得复用 |
| Workspace观察范围 | `workspace-provider-state.ts`、WorkspaceStatusCards、WorkspaceRecommendationsPanel | 桌面/移动Overview指标与资源建议复用主机列表的Provider选择规则；读取同Vault/host的canonical与Komari持久化，切换Vault/路由拒绝迟到读取，映射重绑立即失效旧来源；未绑定引用按明确活动Vault解析，冲突引用不展示 |
| Overview来源与回退 | WorkspaceProviderSummary、共用`buildHostOpsViews` | 来源/原始采样时间只在资源摘要一处显示，四指标卡不重复健康/来源/重试；缺失资源时一个中性空态，无源不显示空 Provider 诊断。其他Provider、接收/Komari同步时间、TTL、可信程度、实际能力及重试折叠到详情；不借资产扫描或缓存写入伪造指标时间。Komari过期/不可用时明确显示SSH回退，遥测只属于实际选中的指标观察；资源建议独立检查该指标deadline |
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
| endpoint/token、节点发现和映射 | `komari.ts`、`komari-mapping.ts`、KomariMappingsPanel、原生映射revision | 设置中的监控数据源接入/管理流程可发现节点、选择同Vault主机、解决地址歧义和显式恢复自动匹配；手动绑定缺席节点仍保留，后台同步不得覆盖。SQLite重开、revision冲突、跨Vault拒绝及原子清除旧latest缓存有回归；新同步同时写专用/canonical缓存且旧sample不回退。真实外部部署仍待验收 |
| Komari Web控制台入口 | `komari-console.ts`、Komari设置页、原生`komari_console.rs` | 桌面高级管理使用主窗口子WebView面板，按Vault/集成稳定标识，关闭/锁库/切库清理；移动端高级管理仍交给系统浏览器；均使用已保存同Vault地址，保留反代basepath、移除query/hash且不传API密钥。移动端仅main WebView可准备/打开/取消短期单次请求，原生在实际OS交接前检查取消、TTL和锁库；切换Vault/集成或迟到prepare不能继续旧导航。请求最多16个、TTL30秒、等待OS回调最多10秒；交接后不声称可撤销或页面已加载。行为/双语/原生状态测试和iOS/Android目标编译检查通过；移动设备实际浏览器展示及外部部署仍待验收 |
| 映射编辑后的运维入口 | HostsDashboard、`komari-probe-link.ts` | 重绑立即失效旧来源视图/按钮，迟到旧Vault刷新不得取消新Vault刷新；检查探针前重新核对最新映射并创建同Vault只读OperationJob。0.4在同主机Overview显式打开探针管理后再进行签名制品审核，不默认铺安装面板，不直接执行已有远端binary的legacy安装命令；安装Job由实际签名流程确认后建立 |
| 同步TTL、并发、快照和告警 | `komari-sync.ts`、原生Komari persistence | 主机卡片Grid/List及Overview使用同一成功同步来源：原生`lastSuccessfulSyncAt`仅由完整同步事务设置，普通告警写入不能创建/推进，旧行迁移为NULL、映射变更清空。历史推断时间保持未知，直到真实同步成功；不借采样、映射更新时间或全局刷新时间，不改变既有调度兼容字段或指标TTL。保留既有告警去重、确认/关闭、恢复通知和OperationJob跨会话关联 |
| 历史时序、范围查询和可视化 | `data/provider_history.rs`、`provider-history.ts`、ProviderHistoryDisclosure/Panel | Vault/provider/host/node隔离；7天/每series10080点/总计100000点；1h/6h/24h/7d视图，来源选择、null/停采断线、原始采样时间和TTL。0.4在用户展开历史后加载并订阅；收起仅卸载视图，不删除持久化历史 |
| API契约兼容 | `src/lib/fixtures/komari-http-contracts.json` 和Komari契约测试 | 依据官方Komari源码记录支持的endpoint/版本；测试权限、flat/nested记录、乱序/重复/无时间/未来时间；不宣称所有版本兼容 |
| 凭据保存与发现反馈 | `VaultProvider`、Komari设置、`KomariMappingsPanel` | 原生凭据写入或随后状态刷新失败必须reject，设置页显示固定双语错误并保留掩码输入；重试复用已创建集成ID，编辑保留已有凭据引用。新建、选择或输入使旧列表失效；保存后离开设置仍完成同一Vault generation的写入，切库/A→B→A/Provider卸载阻断后续阶段，不承诺已发送写入回滚或跨存储原子性。完成持久化及当前列表重载后才显示成功，双语文案区分服务器配置、Vault保存与实际认证。旧Vault刷新在status/keys每次await后核对scope。发现区分缺失凭据、读取失败、权限、连接和超时；只有有效列表可显示成功空态，HTML/非法200响应不转换为零节点。56项聚焦回归及本地官方实例控制台保存路由/受保护认证通过。外部验收随后实际确认服务器保存POST200、有效Key布尔true，75fb7c7新版App保存提示及主窗口受保护admin-list GET200、1真实节点发现；早先失败原因不归为用户漏操作。该轮测试Vault为0主机；后续经用户授权迁入1台主机并验证SSH指标、资产和服务审计，再保存并重新读取手动Komari映射。实际Komari Agent遥测和恢复仍待验收 |
| 真实Komari实例 | `scripts/komari-live-smoke.mjs`、`docs/komari-live-validation.md` | 未修改的官方1.6.0源码构建：节点/recent、非空真实历史、映射Provider、错误token与桌面Origin CORS头均通过；新节点coarse层为空时最多补查一次1h，保留真实时间，不声称完整24h覆盖；外部部署和实际WebView仍需对应环境验收 |

### 2026-10-20：0.3 Komari 集成体验收敛历史记录

以下记录属于此前 PRD 0.3 的实现与验收，不代表 0.4 已通过。该轮调整产品入口，不删除已有集成、Vault 凭据、手动映射、快照或 OperationJob。此前的服务器初始化与独立验收 App 操作保留为历史证据，不作为普通用户接入步骤。

- 主机首页移除映射管理；未接入或无告警时不显示厂商空告警面板。主机和 Overview 的诊断动作、关键健康和真实采样时间保留，技术详情按需展开。
- 设置中提供连接、受保护 API 验证/发现、关联主机和完成流程；读取现有凭据引用，不回显 Key。公开节点列表回退不能作为 Key 认证通过的证据。
- 桌面原站管理降为高级入口并在主窗口展示；正常接入不依赖原站。移动平台的原站浏览器交接边界保留。
- 首次无样本表示等待首报；旧 unknown/metrics-empty/retry-exhausted 三件套以成员保留的事件聚合展示、通知和处理。没有实际新观测不能恢复。
- UI 与 MCP 的旧 alertId 继续可用，同一事件的成员变化关联同一 OperationJob；原始成员审计和通知投递账本保留，升级不因聚合重新投递历史通知。
- 配置版本变化会作废旧认证结果；桌面管理打开前按指定 Vault 核验原生解锁状态。主机告警动作、迟到读取和排队通知覆盖切库/锁库的失效检查；显式归属于旧主机的历史审计仍可处理，只有节点身份的旧记录必须有当前映射。
- 本地完整前端回归 **1,375 passed / 17 skipped**（macOS 跳过 16 项 Linux Ops 与 1 项 Linux collector）；TypeScript/Vite 生产构建、43 个改动 TS/TSX 文件的 ESLint、Rust formatting 和差异检查通过。新增 host action 用例在最终类型调整后单独复验 **19/19**。Rust 库测试 **170 passed / 1 ignored**，MCP stdio **2/2**，运维脚本 **120/120** 通过；本机忽略项为需独立 Linux 环境的原生 bridge。
- 旧三成员升级、历史有效样本基线、真实 critical、独立认证故障、恢复成员兼容、单次恢复通知和跨会话审计均有自动回归。该轮原有安装包 GUI 断言依赖的健康、诊断与告警行尚在折叠区域外；后续主机布局和 0.4 改为真实展开后读取。当前 GUI 必须按实际交互重新验证，不能据旧布局断言推定新版通过。
- 此前 head 的 CI 和实机结果不自动延伸至本轮。真实外部 Komari Agent 上报/恢复、新主窗口管理面板实机交互、移动设备及其他系统通知展示仍按原边界待验收。

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

### 2026-10-22 — 统一下拉菜单

- 所有选择控件使用统一的应用菜单：状态筛选、主机运维入口、告警/审计筛选、设置、跳板主机和探针迁移等；保留真实 select 的值、label、disabled 和 change 事件，移除 macOS 原生渐变/双箭头弹出外观。
- 菜单支持方向键、Home/End、文字定位、Enter/Space、Escape/Tab 与外部点击关闭；选项禁用、受控动作菜单复位、主机行事件隔离保持不变。菜单在当前 dialog 内渲染，限制视口宽高并允许长选项换行。
- 独立 macOS `.app` 使用示例主机验证真实 WKWebView：状态菜单展开/键盘选中、主机运维路由、弹窗层级与长选项均通过。此为原生 UI 控件验收，不作为真实 SSH/迁移证据。
- 本地验证：1559 项前端通过（17 项 Linux 专用跳过）、163 项 Node 协议测试通过，修改文件 ESLint 与 diff 检查通过。安装包 WebDriver 现在点击可见应用菜单，不注入 JS、不改动原有采样、审计、通知同帧/OCR 和 no-replay 断言；新 head CI 另行记录。

### 2026-10-22：SFTP 响应与主机基础信息恢复

- 原因：SFTP 的 SSH 握手、目录枚举及文件传输使用同步 Tauri 命令；慢 I/O 会占住窗口线程。改为异步入口 + blocking worker，保留原有身份校验、ProxyJump、读写确认、路径验证和 OperationJob。初始本地读取立即显示加载状态；读取当前账号真实 home；切换主机/Vault 后丢弃过期读取结果，文件操作期间禁止切换目标；复用日期格式器减少文件列表重复渲染开销。
- 主机页默认恢复地区/旗帜，已有 CPU、内存、磁盘、网络与运行时间直接显示。无资源样本时六列，有样本时七列；详细运维摘要九列，表头与主行一致，告警/诊断/审计仍默认折叠。保留旧展示偏好，开关不再隐藏基础资料，也不改变采集和通知。VPS 资产页无改动，两页继续共用主机资料。
- 验证：1561 项前端测试覆盖（17 项 Linux 限定跳过）；首次全量中两个 shell 子进程测试受同时原生编译负载超时，独立重跑该两文件 7 项通过，未修改超时或断言。最终 SFTP/主机定向 78 项通过，作用域组件调整后另 4 项通过。SFTP 原生 4 项通过（含 worker 让出调用线程和本地文件真实写入/读取/枚举），163 项 Node 协议测试通过，生产构建、修改组件 ESLint、Rust fmt 和 diff 检查通过。
- macOS 隔离安装包 `app.shellbeam.sftpcheck20261022` 使用真实 SFTP IPC 与回环慢 SSH 握手，等待中另一按钮即时更新；截图 `/tmp/shellbeam-sftp-native-responsive.png` 与 `/tmp/shellbeam-host-basics-native-light-grid.png` 核对列表/卡片、暗/亮主题地区和指标。使用合成主机和临时测试端点，未触碰真实 Vault/凭据，验收 App 已退出。此证据验证线程响应和组件显示，不冒充真实 SSH 认证/传输端到端验收。
- 上版 `4e70ed6` 的 GUI run `39736677130` 在 via 主机保存时 `element not interactable`，清理/退出通过。报告 `/tmp/shellbeam-ci-4e70ed6-gui-audit/shellbeam-ops-ui-live-report.json` 无凭据或截图。独立测试提交等待真实菜单消失后再点击下一个表单控件；增加延迟卸载回归，未使用脚本点击、放宽可见性或通知断言。根因仍需最新 head 的安装包 CI 验证，旧 14/15 结果不算本轮通过。

### 2026-10-22：安装包点击失败诊断（尚未解决）

- `78a20a3` 的 15 项检查中 13 项通过，两个打包 GUI 失败：Ops run `39739845820` 在 via 主机 `host-save`；迁移 run `39739845687` 已保存 target 主机，在 `host-connect` 失败。两者均为 `element not interactable`，各自清理与进程退出通过。没有进入后续真实运维或迁移阶段，不能声称本 head 端到端通过。
- 隔离 Linux WebKit 2.50.4 的生产 HostForm 在展开跳板机后，保存按钮位于滚动区外；1280×800 和 1280×900 的标准 WebDriver 点击均能滚动并提交。这证明单纯“按钮屏幕外”不足以解释打包应用失败，菜单关闭等待也未解决 CI，根因仍待确定。
- 新增失败时的只读 W3C 几何诊断：固定控件、视口及最多八层祖先的矩形/滚动数字、显示和启用布尔值。保留原失败，不重试、不滚动、不注入 JavaScript、不读取文本/表单值。两份报告均携带诊断；协议回归验证只点击一次及凭据不进入报告，所有原验收断言保持不变。


2026-10-22 6330239 最新 head 的 15 项 CI 已结束：13 成功，原 GUI `39742103059` 与迁移 GUI `39742103119` 仍在相同原生点击处失败，清理/退出成功。两份独立下载报告的 `clickGeometry.available=false`，不能据此判断裁剪或产品根因。追加诊断将 rect、显示/启用、各数字属性和祖先读取独立隔离，部分 endpoint 不支持时保留其余读数及固定脱敏错误码；不增加点击、滚动、重试、等待、字段内容或 JS。165 项 Node 协议测试通过，其中新增模拟部分 endpoint 拒绝后保留目标几何、仍原样报告唯一一次点击失败。此提交仍是诊断补全，不宣称 GUI 根因已修复。


## MCP 第一批能力（2026-10-22）

新增 7 工具，共 24 工具（按权限过滤）：代码片段查询/读取/受控执行、固定只读运维、目录列表/路径属性、多连接目录。MCP 设置增加独立权限、连接白名单和片段完整内容审阅；新片段权限默认关闭，旧客户端不会扩张到其他账号或新增片段。沿用原 Vault、主机目录、片段文件与 OperationJob，无新业务目录、无凭据迁移。

已验收的本地证据：
- 全量前端 1,563 通过、17 项 Linux 限定跳过；新增 UTF-8 hash 互通后 MCP 定向 19 项通过（1 项新增），未重复计算进全量数字。
- 全量 macOS Rust 库 244 通过、3 项 opt-in 忽略；最终 MCP 定向含默认连接在采集中变化的保护 71 项通过。真实 SFTP 直连/ProxyJump：分页至 EOF、空目录、symlink lstat、缺失路径/父路径拒绝通过。stdio 真二进制桥接 2 项通过。
- 固定只读 Python 采集器 8 项通过：字段脱敏投影、日志参数拒绝、站点/证书 partial、子进程输出/时间边界、失败 JSON；新增 Linux 真实 SSH 两路进程采集及日志注入拒绝纳入原生 CI，本地 macOS 不冒称通过该 Linux 用例。
- Node 协议 165 项、TypeScript/Vite 生产构建、修改范围 ESLint、cargo fmt 和 diff 检查通过。
- 隔离生产组件浏览器：中文暗色/英文亮色，1280/640 宽度，真实点击默认/替代连接与片段选择，均无横向溢出；截图 `/tmp/shellbeam-mcp-phase1-evidence/`。使用合成数据与隔离 IPC，浏览器已关闭，未操作真实 Vault 或运行中的桌面 App。这不替代安装包 MCP 全链路验收。

审计语义：snippet run 按内容 SHA-256 固定授权，无命令替换/参数模板；不依赖任意 execute 权限。OperationJob 保存 actor/host/connection/snippet version，延续 request 去重与重启 unknown，不自动重放，不伪造逐次人工确认。非默认连接及采集中变化的默认连接不覆盖共享默认观察。

范围：inspect 仅 Linux/Python 3 固定只读观察；日志按账号可见范围，站点/证书有限目录发现始终 partial。目录分页非稳定快照；snippet 命令仍具备所选 SSH 账号权限。片段变更需用户重新审阅并重建授权。

基线 `6330239` 13/15 CI 成功、两项原生 GUI 点击失败仍未解决；`661d9e7` 仅补全失败几何诊断，本功能提交需重新核对全部 CI，不能继承旧 head 绿色。
