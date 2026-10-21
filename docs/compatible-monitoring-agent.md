# 兼容监控探针生命周期与内置可信发布（PRD 0.5 D）

入口为主机详情中现有运维工具下的“监控探针”，复用主机、默认 SSH 连接和可选监控绑定。没有接入且没有托管部署记录的主机不增加界面；纯监控主机先添加真实 SSH 连接。不会打开 Komari 网页、第二个应用或一套远端终端。

## 支持范围与影响

- 远端：Linux amd64 / arm64，systemd，Python 3.9+。兼容 Komari Agent 1.5.x、已核验的服务 1.6.x；固定官方 1.5.10 → 1.5.11 用于生命周期验收。
- root SSH 使用系统服务，普通 SSH 账号使用已有的 systemd 用户服务和 linger。应用不执行 sudo、不自动启用 linger，不覆盖已有非托管 Agent 或 unit。
- 采样间隔 5 秒，复用现有节点与 Agent Token；不重建节点、不旋转 Key、不传输 SSH 私钥到监控服务。禁用兼容 Agent 的自动升级、Web SSH、RCE 和文件控制，日常操作继续走 ShellBeam 的确认和审计。
- 确认预览包含主机、节点、SSH 账号、直连/ProxyJump、系统/用户服务、安装目录、当前/目标版本、制品大小、采样和卸载影响。主机必须能访问监控地址；桌面使用回环隧道时，安装者可填写主机实际可达的地址。已有部署不能通过升级悄悄改变地址或身份。
- 托管 unit 为 `shellbeam-komari-<deployment UUID>.service`；目录为 SSH 用户的 `~/.local/share/shellbeam/komari/<deployment UUID>`。Token 只进入 SSH stdin 和权限 0600 的配置文件，不进入 shell 参数、客户端预览、OperationJob 或日志。

## 生命周期及结果语义

| 动作 | 结果验证与恢复 |
| --- | --- |
| 安装 | 原生校验制品签名、架构、字节数和 SHA-256；通过现有核验主机指纹的 SSH/ProxyJump 会话传输；先落盘再原子切换 current；验证 systemd MainPID 实际二进制哈希及服务端新的原始样本、节点 UUID/创建时间与版本 |
| 升级 | 目录版本必须高于当前版本；保留前一个已验签制品和配置；不能用网页的异步“已排队升级”作为成功 |
| 回滚 | 仅使用本机记录中此前已信任的前一版本、服务器已保留的精确哈希制品；不依赖目录和下载服务；仍核验进程及新上报 |
| 自动失败恢复 | helper 启动失败时恢复此前受管版本；native 核验上报失败时，在原确认与仍有效的作用域内补偿回滚；旧版本的新上报也失败则保留未知结果，不能显示回滚成功；首次安装失败则停止该托管服务 |
| 卸载 | 仅停止、禁用、移除匹配所有权的 unit，验证该部署无运行进程；保留节点、Token、服务端历史、配置、版本文件及审计。已有部署可在服务离线或数据源移除后清理，无需再次读取服务凭据 |
| 跨会话核验 | 点击“检查部署”创建新的只读 OperationJob，检查文件/进程和服务样本；不会自动重发安装、升级或卸载。原终态审计不改写；先前仍 running 的中断任务归为 unknown，恢复结论属于新任务 |

探针成功状态要求 `sample > 操作前 watermark`，采样时间在核验窗口内，且节点身份和 Agent 版本一致。服务在线、HTTP 200、进程存在或本地收到响应的时间均不能独立代表成功。若记录为 prepared/dispatched/unknown，先只读检查；仍允许明确确认的托管服务卸载。

## 作用域与持久化

`operation_jobs.sqlite3` 新增 `komari_agent_deployments`，按 Vault + hostId 保存部署身份、修订、当前/前一/请求制品、机器身份、核验 SSH 指纹、节点身份、配置哈希、观察和 jobId。不会覆盖 `shellbeam_agents`、Komari 映射、快照、目录或旧审计。首次任务与确认审计在同一 SQLite 事务中建立，执行前保存 dispatched；修订 CAS 防止旧预览或并发覆盖。

预览保存在原生进程内，5 分钟失效；每台主机最多一个执行任务，每个 Vault 最多两个、全局最多八个。Vault 解锁代次、完整主机与跳板资料、来源配置、绑定修订、节点创建身份、发布策略或 SSH 指纹变化均使旧预览失效。组件离开时撤销上下文；发送前及传输期间检查作用域。SSH helper 请求有字节和总时长限制，外部输出只解析已知结构和错误码。已发送的操作不能承诺撤回，发生中断时保留未知结果供只读核验。

源端没有独立的服务器实例签名身份，节点身份仍采用冻结来源配置 + UUID/创建时间；多个客户端之间用远端文件锁和精确观察比较拒绝变化，但这不能替代跨设备端到端验收。

## 独立发布信任

兼容 Agent 使用独立 Ed25519 信任根和 `shellbeam/komari-agent/v1\n` 签名域，不能混用 ShellBeam Agent 签名。签名覆盖 runtime/version/platform/architecture/URL/SHA-256/sizeBytes；下载目录最大 64 KiB、32 条，制品最大 32 MiB，仅允许明确列出的 HTTPS 域名，重定向逐跳校验。默认公钥、目录地址与精确域名编译进 App，普通用户不配置密钥。设备可明确选择自定义发布者；保存仍需确认，预览期间修改即失效。缺失的旧设置使用官方默认值，已存在的旧设置按自定义配置原样读取，包括禁用状态；损坏配置报错，不偷偷切换信任。

生产公钥在 `src-tauri/src/data/komari_agent/official-trust.json`，key ID 为 `compatible-probe-2026-01`。生产私钥仅存入 GitHub `komari-agent-release` Environment Secret，未进入源码、应用、日志或发布资产；该环境仅允许 `main`，要求维护者审批且禁止管理员绕过。仓库原有 Vault/SSH/API 凭据不变。后续工作流随本 PR 合并后在默认分支手动触发；首次引导发布使用相同发布脚本和上阶段已验证的固定上游制品，不宣称未合并的工作流已经执行。

发布工具仅读取操作者提供的私有密钥文件（权限 0600）和已下载、核对过字节数及 SHA-256 的文件：

```sh
node scripts/publish-komari-agent.mjs --spec release-spec.json --key /private/path/key.pem --out catalog.json
```

`release-spec.json` 为 `{ "artifacts": [...] }`，每项包含 `file`、`version`、`architecture`（amd64/arm64）、`url`、`expectedSha256`、`expectedSize`。制品 URL 必须是最终的 HTTPS 下载地址，不得携带认证查询参数。工具不会覆盖已有目录文件，也不发布到网络；输出只包含制品数量和公开公钥。以上命令仍适用于自定义分发，官方用户无需执行或填写这些字段。历史已信任版本的核验、回滚、卸载不依赖当前发布策略。

## 验收层次

- Rust：签名域、篡改、真实 Node 发布器 → native 验签、原始样本新鲜度、既有配置/部署身份、原子确认审计、CAS、跨会话新只读任务和旧终态保留。
- Python：真实隔离文件系统 + 显式假的服务管理器，覆盖安装/升级/回滚/卸载、坏制品不切换、启动失败回滚、旧预览/机器变化、激活中断只读恢复、非托管服务、配置权限/符号链接与数据保留。此层不冒充 systemd 实机。
- 真实 Linux：`SHELLBEAM_KOMARI_LIFECYCLE_SMOKE=1 node scripts/komari-agent-lifecycle-smoke.mjs` 使用固定官方服务与 Agent、独立随机凭据、回环服务、生产 helper 和真实 systemd。验证 1.5.10 安装、1.5.11 升级、无下载回滚、坏制品拒绝、激活失败补偿、进程哈希与新上报、跨进程只读及卸载保留。CI 在 amd64 和 arm64 分别执行普通用户服务与 root 系统服务；提权仅发生于临时 CI runner 的隔离测试，产品不执行提权。脱敏报告记录 checkout commit、实际服务作用域、新原始样本与进程哈希、清理及服务退出。
- UI：生产组件的确认拒绝、Vault 变更、晚到读结果、组件卸载撤销、并发点击阻止、未知任务只读核验、未接入/纯监控状态和双语布局。隔离 IPC 浏览器截图不是用户 Vault 或打包应用安装探针的证据。

仍不包括接管第三方已安装服务、变更已有部署账号/地址/节点的迁移、非 Linux 被管主机、移动端安装包、完整多设备竞争。失败时不会借助原站执行未审计的替代操作。

## 生产发布与更新流程

默认目录是 `https://raw.githubusercontent.com/0xJean/shellbeam/monitoring-probe-releases/stable/catalog.json`。该独立分支只存公开签名目录，不修改 main，不包含 Actions 或应用用户数据。制品位于独立版本的 GitHub Release；发布工具拒绝替换已发布资产，始终使用 `--latest=false`，不抢占 ShellBeam 应用最新版。平台管理员仍能修改 GitHub 资产；客户端以签名、大小和哈希拒绝变更，不把版本化 URL 当作平台强制不可变性。

官方目录另有 `shellbeam/komari-agent-catalog/v1` 签名域，覆盖 key ID、stable 渠道、序号、发布时间、过期时间和两种架构的完整制品清单。默认有效期 90 天，最多允许 180 天和 5 分钟时钟偏差；到期拒绝新安装/升级，用户仍可检查、回滚、卸载。必须在到期前发布新修订，客户端不会降低校验或回退到未签名上游。

原生层以独立 SQLite 事务保存最高目录序号、内容指纹和 Agent 版本，重启后拒绝旧序号、同序号异内容或版本降级。显式回滚只使用既有部署里已信任的保留版本，语义不与发布源防回退混用。信任根轮换需要更新签名的 ShellBeam 应用及编译公钥；下载目录不能授权自己的新公钥。

维护者流程：
1. 在 `releases/compatible-probe-pins.json` 审查上游版本、两架构 SHA-256 和大小，通过 PR 提交。原版 MIT 许可证随制品分发。
2. 默认分支手动运行 `Publish trusted compatible probe`，选择已审查版本和新的 release revision。发布环境审批后，先无密钥下载固定制品，再使用环境私钥签名；临时密钥文件退出即删除。
3. `promote-komari-agent-release.mjs` 创建或恢复同目标的草稿，下载回读上传资产逐字节核验，再发布。随后匿名核验两种制品，最后以文件 SHA 的 CAS 原子推进稳定目录。发布资产不包含 spec、私钥、内部日志或凭据。
4. 发布中断可在相同提交和修订上重跑工作流：先找回已上传的目录，核对生产签名、有效期、精确制品 URL、版本、哈希和大小，再复用原字节；未上传目录才重新签名。已上传/已发布字节只核验，不覆盖；已推进的同一目录只读验证。目录并发变化则停止，不能静默覆盖。已公开但尚未推进的版本不会被客户端默认发现；已过期目录必须采用新修订。

首次版本为 `monitoring-probe-v1.5.11-r1`，bootstrap 公共目录副本保存在 `releases/compatible-probe-bootstrap.json` 供跨语言验签回归；它不是离线回退源。正常安装始终读取当前在线目录并验证有效期。

2026-10-21 已完成首次公开发布、两种架构匿名下载和 App 原生默认策略验签；目录序号 `1792594908584`。实际重试确认发布资产未替换、目录提交未改变；本地临时生产私钥已删除，仅保留受保护环境中的 Secret。ShellBeam 应用 latest 仍为 `v0.1.4`。
