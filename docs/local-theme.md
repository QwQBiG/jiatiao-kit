# 本地授权主题

界面样式参考今日校园。本模板仅供学习展示，与相关品牌、学校或机构无隶属、合作或授权关系；页面不能证明任何真实审批，也不能作为请假或通行凭证。来源说明不等于获得素材使用许可。

## 公开范围

公开包内置假条样式、加载动画、自绘图标和管理页布局。分享页根据休假进度显示绿色、橙色或灰色状态栏，详情区显示当前记录和缩略附件。只有审批已通过的记录才显示示例审批标识。

默认界面使用项目自己的 CSS 和图形。第三方字体、原始审批图和管理页背景照片需要使用者自行取得许可。规则和页面提醒使用学习示例，分享链接来自部署者自己的站点。

运行 `npm start` 后，打开 `/demo` 查看默认假条，打开 `/admin/` 管理本机演示数据。下面的导入步骤供需要切换为指定素材的使用者使用。

## 导入自己的授权文件

本工具没有下载功能，不抓取网站、不导入截图、HTML、脚本、账号、配置或记录。请自行取得文件及全部必要许可，将其放在一个本机目录，保持 `tools/theme-catalog.json` 中 `source` 所列的相对路径。该目录对应原资源集合的 `public` 根。文件名、字节数及 SHA-256 必须全部匹配；清单只有 12 个已知文件，不能使用它导入任意素材。

| 本地文件范围 | 用途 |
| --- | --- |
| `share/assets/*.css`（3 个） | 原公共规则、当前页面 vendor 规则、图标规则 |
| `share/assets/*.{ttf,woff,woff2}`（6 个） | 原完整图标字体及兼容格式 |
| `share/assets/common-pass-*.png`（1 个） | 原审批图，仅在有权使用时导入 |
| `admin/assets/*.webp`（2 个） | 桌面、移动端背景 |

先检查文件，不复制：

```powershell
node tools/local-theme.mjs source-check --source="D:/authorized-theme/public"
```

确认对每个文件有权使用后，显式导入：

```powershell
node tools/local-theme.mjs import --source="D:/authorized-theme/public" --authorized
node tools/local-theme.mjs verify
```

`--authorized` 表示使用者已核实许可。工具先验证全部源文件，再将清单内的 CSS、字体和图片按原字节复制至 `public/local-theme/`，最后切换本地页面的资源引用。图标使用完整字体渲染。该目录已由 `public/.gitignore` 排除。

恢复内置样式并保留本地素材：

```powershell
node tools/local-theme.mjs restore
```

恢复后再发布不含素材的包。若确实拥有发布许可，仍须显式选择带入主题，且发布工具必须先调用 `verifyLocalTheme(projectRoot)`；它拒绝未知文件、符号链接、路径变化、内容变化或不完整清单。默认发布排除整个 `public/local-theme/`，不能只靠 `.gitignore` 判断部署内容。`verifyThemeActivation(projectRoot)` 返回 `{active:boolean}`；已激活主题而未选择带素材时应阻止发布，避免断链。

## 原样验证与限制

`source-check` 和 `verify` 证明字节与固定清单一致，不证明法律许可。可在自己的授权环境中比较 390px、1280px 的主页面、个人信息及规则弹窗；固定显示时钟和相同合成记录后，对比截图、图标及计算样式。清理客服入口、规则说明、提醒和元数据的差异是有意的，不能把它们误报为样式重设计。公开仓库不附原版截图作为基准。

需要自定义配色或布局时，可以直接修改项目自有的默认样式。[前端样式与主题](frontend-appearance.md)
