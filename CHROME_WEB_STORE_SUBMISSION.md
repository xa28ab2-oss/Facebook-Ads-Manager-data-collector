Chrome Web Store 提交材料

一、单一用途说明

本扩展仅用于在用户主动点击后，采集 Facebook Ads Manager 报表数据并同步到 Lark 多维表格。

二、权限用途说明

1. storage
- 保存项目名称、投手名称、上传模式、界面状态与结果历史，便于下次继续使用。

2. activeTab / tabs
- 获取当前活动标签信息，并仅在 Ads Manager 相关页面启用扩展操作。

3. scripting
- 向当前 Ads Manager 页面注入内容脚本，用于执行页面内刷新按钮点击等必要交互。

4. debugger
- 连接当前 Ads Manager 标签页的网络调试通道，读取报表接口响应数据。
- 仅用于解析广告报表数据字段，不用于读取账号凭据或与用途无关内容。

5. host_permissions
- 仅声明并访问 Facebook Ads Manager 相关页面与接口域名：
  - *.facebook.com/adsmanager*
  - *.business.facebook.com/adsmanager*
  - *.adsmanager.facebook.com/*
  - *.adsmanager-graph.facebook.com/*

三、隐私说明摘要

1. 仅在用户点击“开始采集数据”后执行采集与上传。
2. 不采集密码、聊天消息等无关数据。
3. 采集结果通过 HTTPS 上传至业务接口并写入 Lark。
4. 不出售用户数据。

四、审核备注（可直接粘贴到 Reviewer Notes）

Review steps:
1. Open Facebook Ads Manager page.
2. Click extension icon and select project and buyer.
3. Click “开始采集数据”.
4. Extension captures Ads Manager report response from current tab and uploads to configured endpoint.
5. Open extension popup again to verify upload status in status/history panel.

Single purpose:
This extension only syncs Facebook Ads Manager report data to Lark Bitable for business reporting.

五、图标说明

本扩展已生成符合 Chrome Web Store 要求的图标：
- `chrome-extension/icons/icon16.png` (16x16)
- `chrome-extension/icons/icon48.png` (48x48)
- `chrome-extension/icons/icon128.png` (128x128) - 用于商店展示

图标设计结合了 Facebook 蓝色调、数据报表（柱状图）以及同步符号，直观展示了“广告报表同步”的核心功能。

Why debugger is required:
Ads Manager report data is rendered from dynamic network responses. The extension must use chrome.debugger Network domain to read report payload reliably from the current Ads Manager tab.
