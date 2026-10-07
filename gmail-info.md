# Kelivo Gmail

Kelivo Gmail 是这个 kelivo-shim 部署的个人邮箱连接配置，通过 Gmail MCP 将账户所有者的 Gmail 邮箱接入 Kelivo 和 Claude Code。

## 用途

连接后，助手可在账户所有者授予的 Google 权限范围内搜索和读取邮件，并调用 MCP 提供的邮件管理、草稿和发送等功能。实际可用功能取决于授予的权限、MCP 配置和助手调用。

Google 授权用于执行邮箱操作；Kelivo 中的聊天连接与 Google 邮箱授权分别配置。本项目仅供账户所有者个人使用。

## 数据处理

被工具读取的邮件内容可能进入助手的对话上下文，并由该部署所使用的服务器和模型服务处理。授权凭据需要存放在个人部署中，以便服务器访问 Gmail。

详细说明见 [Kelivo Gmail 隐私说明](gmail-privacy.md)。

## 联系与撤销

联系邮箱为 Google 授权页面中显示的用户支持邮箱。账户所有者可以在 Google 账户的第三方应用连接设置中撤销授权，并在自己的部署中移除 Gmail MCP 配置和凭据。
