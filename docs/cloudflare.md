# 部署到你自己的 Cloudflare

本引导使用 Cloudflare Pages Functions、`public/` 和 D1。账户、项目、数据库、主管邮箱与 Access 应用都由你配置，仓库不提供可复用的线上账户或数据。先在自己的机器运行 `npm install`，以下命令均在项目根目录执行。已验证 Wrangler 4.127.1。

直接运行 `node tools/cloudflare.mjs` 只显示步骤，不联网、不读取登录账户，也不发布。

## 1. 填写本地项目配置

```powershell
node tools/cloudflare.mjs configure
```

按提示填写你的账户 ID、项目名、正式分支与独立的预览分支。账户 ID 可在 [Cloudflare 控制台](https://dash.cloudflare.com/?to=/:account/workers-and-pages)查看。新项目默认正式分支 `main`，预览分支 `template-preview`。脚本始终显式指定发布分支，不使用当前 Git 分支推断环境。

既有项目的 CLI 列表可能不提供真实正式分支。首次识别到这种项目时，命令会在任何写操作前停止，要求先运行 `node tools/cloudflare.mjs adopt`：从控制台复制实际正式分支，并输入确认接管的项目名。新建项目因创建时明确指定分支而自动记录。该确认绑定账户、项目与正式分支；之后可以重入，变更这些配置会要求重新确认。`adopt` 只保存你的核对声明，不会替你查询控制台设置。

配置保存在已忽略的 `.local/cloudflare/local.json`，可参考根目录 `cloudflare.example.json`。不要提交 `.local/`、授权文件或包含账户信息的日志。若更换账户或项目，重新运行 `configure` 会清空旧资源 ID 与权限配置。

预览与正式环境分别使用 `<项目名>-preview`、`<项目名>-production` 两个 D1。可在本地配置中调整名称；名称和 ID 均不得相同。引导不会使用仓库作者的数据库。

## 2. 由你授权 Wrangler

```powershell
node tools/cloudflare.mjs login
```

在浏览器完成你自己账户的 OAuth 授权。脚本不接收或保存 API Token。若浏览器不能连接本机回调，可使用 `login --device`；Wrangler 4.119.0 起支持此模式。需要手动打开授权地址时添加 `--no-browser`。[官方登录说明](https://developers.cloudflare.com/workers/wrangler/commands/general/#login)

后续操作会核对当前授权是否能访问本地配置明确指定的账户；不会打印 `whoami` 的原始账户资料。若你在系统中设置了 API Token 等环境变量，Wrangler 可能优先使用它们，请自行核对授权账户。

## 3. 准备预览资源与迁移

```powershell
node tools/cloudflare.mjs setup
```

确认终端显示的环境、项目、数据库和分支后输入 `yes`。脚本只会：

1. 检查授权和项目，缺少时创建 Direct Upload 项目。
2. 查找或创建预览 D1，把它明确绑定为 `DB`。
3. 在预览 D1 上应用尚未执行的 `migrations/` 迁移。

此步不发布网页，也不创建或迁移正式数据库。再次执行会复用已有项目、D1 与迁移记录。失败后可以重试；已找到的 D1 ID 会保留，失败的迁移不会触发后续发布。

已有 Git 集成项目不由此引导接管，请使用独立的 Direct Upload 项目，避免另一条自动发布链路更改环境。[Pages Direct Upload 说明](https://developers.cloudflare.com/pages/get-started/direct-upload/)

## 4. 在控制台保护管理入口

在 Workers & Pages 选择自己的项目，在 Cloudflare Access 中配置应用和允许登录的身份。至少保护 `/admin` 与 `/admin/*`，后者包含 `/admin/api/*`。配置应用时检查实际使用的全部主机名，包括预览地址、分支别名、`pages.dev` 和自定义域名。

- 预览环境可先使用 Pages 的“Enable access policy”，再进入生成的 Access 应用查看 AUD。内置开关只覆盖预览，不自动保护正式 `pages.dev` 或自定义域名。[预览保护说明](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
- 正式环境应配置管理路径的 Access 保护，公开的假条分享路径保持可访问。可参考 [Pages 域名的 Access 配置](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain)及 [Access 应用配置](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。不要把只保护预览的开关当成正式环境已受保护。
- 每个环境的后端只接受一个 AUD。同一环境应使用同一 Access 应用覆盖所需入口；若使用不同应用，请统一管理入口，避免登录后 AUD 不匹配。

确认策略后运行：

```powershell
node tools/cloudflare.mjs access
```

填写该环境的主管邮箱、团队地址 `https://你的团队.cloudflareaccess.com` 和应用 AUD，并确认管理路径已受保护。预览与正式环境分别保存权限配置。若未输入 `yes`，本地会标记该环境为未确认，后续部署将停止。此命令只记录本地配置，不能代替控制台策略，也不会自动修改 Access。

发布前强制要求 `OWNER_EMAILS`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 完整，并确认路径保护。它们只写入临时 Wrangler 配置的服务端变量，不会放入 `public/`；不会启用本地管理身份绕过。

## 5. 本地检查与预览发布

```powershell
node tools/cloudflare.mjs build
node tools/cloudflare.mjs check
node tools/cloudflare.mjs deploy
```

`build` 只在本地编译 Functions；`check` 只读取远程资源并核对所选 D1。`deploy` 在你确认后先应用该环境迁移，再明确发布到预览分支。发布后用无痕窗口核对管理入口需要登录、后台权限正确、分享链接可用。

脚本在 `.local/cloudflare/` 内创建临时工作区，仅复制 `public/`、`functions/`、`migrations/`，并生成对应环境的 `wrangler.jsonc`。结束时清理这一工作区，不覆盖仓库中的 Wrangler 文件。Pages 的 Dashboard 拖放不会编译 `functions/`，不要用拖放 `public/` 代替此流程。

## 6. 明确选择正式环境

```powershell
node tools/cloudflare.mjs setup --production
node tools/cloudflare.mjs access --production
node tools/cloudflare.mjs check --production
node tools/cloudflare.mjs deploy --production
```

这些命令只使用正式环境独立的 D1 与权限配置。正式发布不会自动沿用预览数据库；如果两环境指向同一数据库，命令会停止。若在控制台更改了正式分支，请先同步本地配置，不能继续使用旧分支声明。

远程写操作默认要求交互确认。只有你明确决定继续且需要非交互执行时，才给 `setup` 或 `deploy` 添加 `--yes`。该参数不代替 Cloudflare 授权，也不会绕过权限、绑定和素材检查。

## 自备素材的发布选择

默认不发布 `public/local-theme/`。如果已通过素材导入工具启用主题，普通 `deploy` 会停止，避免生成断链页面；你可以先恢复默认外观，或显式选择：

```powershell
node tools/cloudflare.mjs deploy --include-local-theme
```

正式发布同样需要同时写明 `--production`。脚本调用本地素材核对工具，仅复制 `manifest.json` 固定清单中识别的文件，并再次核对复制后的大小和 SHA256；未知文件、符号链接、缺失或篡改都会阻止发布。不会顺带上传原始素材目录、未识别文件或 `.local/`。素材授权仍由你负责。

## 失败与重入

如果命令失败，后续迁移或发布不会继续。修正本地配置、网络或账户权限后，重新执行同一命令即可；不会为重试生成新的数据库名称。若 D1 名称与保存的 ID 不匹配，先到控制台核对，不能随意替换 ID。

CLI 账户列表和原始错误输出不会写入公共文件。需要进一步诊断时，在自己机器运行相应 Wrangler 命令查看完整输出；请勿把带有邮箱、账户资料或授权参数的日志粘贴到公开 Issue。

在项目根目录可运行 `node --test test/cloudflare.test.mjs`。测试的远程操作全部使用模拟 CLI；真实 Wrangler 仅进行本地 Functions 构建与 `--local` 预览迁移重入，不查询或修改任何线上资源。

## 由你执行的云端验收

本地构建与模拟测试不代表已在云端发布。以下检查需要你完成自己的授权和部署后，在自己机器执行；不要把真实假条链接或登录凭据用于公开演示。

先把 `$site` 换为终端打印的部署地址。下面都是只读请求，不传 Cookie、Token 或个人记录 ID：

```powershell
$site = 'https://你的部署地址'
curl.exe --silent --show-error --location --max-time 20 --head "$site/wec-counselor-leave-apps/leave/share/index.html"
curl.exe --silent --show-error --max-time 20 --output NUL --write-out '%{http_code}\n' "$site/admin/"
curl.exe --silent --show-error --max-time 20 --output NUL --write-out '%{http_code}\n' "$site/admin/api/session"
curl.exe --silent --show-error --max-time 20 --output NUL --write-out '%{http_code}\n' "$site/api/leave/00000000000000000000000000000000"
```

- 分享 HTML 应最终返回 `200`，并保持不缓存个人页面的响应头。
- 未登录的管理入口应进入 Access 登录或被拒绝，例如 `302`、`401`、`403`；若直接返回管理页 `200`，先复查路径保护。只有后台 API 返回拒绝仍不能证明管理页面已受 Access 保护。
- 新的空数据库中，全零合成 ID 应得到 `404`；`503` 通常需要检查 `DB` 绑定和迁移。此检查不验证真实记录内容。
- 在无痕浏览器检查 `/admin/` 要求登录，再用主管身份登录确认角色。使用你已有的合成测试记录，检查分享页、状态时间和附件；不把这些链接写入公开日志。
- 分别核对 preview 与 production 实际绑定的数据库 ID，预览创建的测试数据不应出现在正式后台。正式环境与预览环境要各自执行验收，不能用预览结果替代正式结果。

如果你选择整站保护预览，未登录的分享与 API 请求也会先得到 Access 响应。先核对策略范围，再在已登录的浏览器完成预览验收；不要把这类响应误判为 D1 故障。
