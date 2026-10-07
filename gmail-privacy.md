# Kelivo Gmail 隐私说明

更新日期：2026 年 10 月 8 日

本说明适用于账户所有者通过这个 kelivo-shim 个人部署，将 Gmail MCP 接入 Kelivo 和 Claude Code 的配置。它不代表 Kelivo、Google、Anthropic 或 Zeabur 的官方隐私政策。

## 访问的数据和目的

在 Google 账户所有者授权后，Gmail MCP 可以在所授予权限的范围内访问邮件标题、发件人、收件人、正文、附件、标签及其他邮件元数据，并执行相应的邮件操作。实际访问的数据取决于权限、配置及工具调用。

这些数据用于账户所有者的邮箱查询、阅读、整理、草稿、发送和其他已配置的个人助手功能。此个人部署不以出售邮件数据或投放广告为目的。

## 处理和传输

Gmail API 请求由 Gmail MCP 发往 Google。MCP 在账户所有者的 Zeabur 部署中运行；工具返回的邮件数据可能进入 Claude Code 的上下文，并传输至该部署所配置的模型服务。回复中使用的邮件内容会返回 Kelivo。

Google、Zeabur、Anthropic 或其他实际配置的服务商对其服务内的数据处理，受相应服务条款、隐私政策和账户设置约束。邮箱数据不是仅在账户所有者的本地设备上处理。

## 存储与保留

OAuth 客户端配置和授权凭据存放在账户所有者控制的设备及个人服务器配置中。服务器保存授权凭据，以便在后台刷新授权并访问 Gmail。凭据不应上传到公开代码仓库。

进入对话的邮件内容可能被保留在 Kelivo 聊天记录、Claude Code 会话记录，以及部署中配置的日志、备份或记忆系统内。具体保留情况取决于账户所有者的配置和实际调用；撤销 Google 授权不会自动删除此前保存的这些记录。

## 控制、撤销和删除

账户所有者可以在 Google 账户的第三方应用连接设置中撤销本应用的访问权限，并从个人服务器移除 Gmail MCP 配置和授权凭据。已有聊天记录、会话、日志、备份和记忆需在相应设备或服务中另行清理。

## Google 用户数据的使用

本个人部署对从 Google API 获取的数据的使用应遵循 [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)，包括 Limited Use 要求；数据应仅用于已披露的个人邮箱助手功能。

## 联系

如需联系此个人部署的维护者，请使用 Google 授权页面显示的用户支持邮箱。
