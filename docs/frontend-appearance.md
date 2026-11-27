# 前端样式与主题

运行 `npm start` 后，打开「演示假条」即可看到内置的彩色状态栏、条纹时间条、圆形头像和请假详情。加载时显示转圈，有效记录就绪后展示内容。个人信息和销假规则可点开查看。管理页有独立的表格、表单和移动端布局。[本地预览](local-preview.md)

| 想调整的部分 | 对应入口 |
| --- | --- |
| 分享页的基础样式 | [基础样式表](../public/theme-placeholder/)和[分享页模板](../public/wec-counselor-leave-apps/leave/share/index.html) |
| 管理页的外观 | [管理页样式表](../public/admin/admin.css)和[管理页模板](../public/admin/index.html) |
| 使用自备的授权主题 | [原主题文件清单与导入、恢复步骤](local-theme.md) |

授权主题使用固定清单中的 12 个文件，涵盖分享页样式、字体、审批图和管理页背景。导入前先运行指南中的 `source-check` 核对文件。导入后执行 `node tools/local-theme.mjs verify` 查看启用状态；需要切回基础展示时执行 `node tools/local-theme.mjs restore`。

分享链接的生成方式、页面脚本与服务端渲染接口见[界面接口](ui-interfaces.md)。管理学生记录和设置成员权限见[后台管理](admin-management.md)。
