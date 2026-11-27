# 界面接口

浏览器界面没有运行时包依赖。使用 ES modules 的 Node 工具要求项目 `package.json` 设置 `"type":"module"`。本地完整预览使用后端提供的 SQLite 适配及 API，不把任何外部实例作为默认数据源。

- 分享页：`/wec-counselor-leave-apps/leave/share/index.html`，同时支持其目录与 `index` 形式。`?id=` 必须为 32 位十六进制分享令牌。
- 管理页：`/admin/`；管理 API 的原路径和权限契约保持不变。
- 本地入口：`/` 为静态说明，`/demo` 由本地预览生成合成记录并跳转；云端不应提供默认个人记录。
- `public/share-card/share.js`：保留 `CARD_TITLE`、`CARD_DESCRIPTION`、`CARD_IMAGE_PATH`、`PUBLIC_SHARE_ORIGIN`、`SHARE_PAGE_PATH`、`recordShareUrl(id, origin?)`、`cardDetails(pageUrl)`。默认来源为空，浏览器自动使用 `location.origin`；无浏览器且未传来源时返回同源相对路径。移除了未使用的外部分享服务 URL 构造器。
- `functions/_shared/share-card.js`：保留 `isSharePage(pathname)`、`renderShareHead(html, pageUrl, bootstrap?, inline?)`、`renderShareHeadStream(body, pageUrl, bootstrap?, inline?)`。分享 middleware 及 `share-assets`、`share-inline`、`share-template` 一并提供；继续依赖后端 `leave-record` 的原导出接口。
- `share-icon-subset.js` 仅保留无操作兼容函数，不附任何原字体子集。授权主题使用完整原字体。

建议合并到项目 scripts：

```json
{
  "theme:verify": "node tools/local-theme.mjs verify",
  "theme:restore": "node tools/local-theme.mjs restore",
  "audit:ui": "node tools/audit-ui.mjs",
  "test": "node --test"
}
```

上述工具只使用 Node 内建模块。`tools/theme-files.mjs` 是有界文件验证/复制原语，`tools/local-theme.mjs` 用固定目录及清单包装它；发布工具只能调用后者的 `verifyLocalTheme`，不能接受调用者提供的任意文件清单。主题路径和显式授权说明见 `local-theme.md`。发布默认排除 `public/local-theme/`，激活却未选带素材时应失败。

`node tools/audit-ui.mjs` 检查无主题公开源包，拒绝本地素材、未知图像/字体、外部固定来源及客服模拟登录残留。这是文件清单和已知内容规则检查，不代替人工隐私及许可审核。测试覆盖当前时钟、原加载状态、同源 URL、流式替换、固定文件校验及 mixed 激活恢复。
