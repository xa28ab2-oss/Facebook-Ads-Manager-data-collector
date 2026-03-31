# Facebook Ads Manager 数据采集系统

## 项目结构

```
Facebook_data_Chrome_Extension/
├── api/                      # Vercel 后端 API（根目录部署路径 /api/upload）
│   ├── upload.js             # 上传数据接口
│   └── options.js            # 配置表下拉选项接口
│
├── chrome-extension/         # Chrome 插件目录
│   ├── manifest.json         # Manifest V3 配置
│   ├── popup.html            # 插件 popup 界面
│   ├── popup.js              # Popup 逻辑
│   ├── content.js            # 内容脚本
│   └── background.js         # 后台服务脚本
│
├── vercel-api/               # Vercel API（备用部署方式）
│   ├── package.json
│   └── api/
│       ├── upload.js
│       └── options.js
│
└── README.md
```

---

## 一、Chrome 插件使用

1. 打开 `chrome://extensions/`
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择 `chrome-extension` 目录
4. 打开 Ads Manager 页面后点击插件图标
5. 选择 **项目名称** 与 **投手名称**（必选）
6. 点击 **开始采集数据**，自动上传至多维表格

---

## 二、Vercel 后端部署

### 1. 前提条件
- Node.js 18+
- Vercel 账号
- Lark 开放平台应用

### 2. 环境变量

| 变量名 | 说明 |
|-------|------|
| LARK_APP_TOKEN | 多维表格 App Token |
| LARK_APP_ID | Lark 应用 App ID |
| LARK_APP_SECRET | Lark 应用 App Secret |
| LARK_TABLE_ID | 数据表 Table ID |
| LARK_CONFIG_TABLE_ID | 配置表 Table ID（项目/投手下拉） |

### 3. 部署方式

**推荐：部署仓库根目录**  
Vercel 会识别根目录 `api/`，对外提供：
- `/api/upload`
- `/api/options`

---

## 三、配置表（单表方案）

在多维表格中创建一张 **配置表**，包含以下列：

| 列名 | 说明 |
|------|------|
| 项目名称 | 下拉选项来源 |
| 投手名称 | 下拉选项来源 |

插件会从 `/api/options` 读取该表生成下拉选项。  
点击左上角刷新图标可手动更新选项。

---

## 四、字段写入规则

本插件写入的是 **原始字段**（raw_fields），字段名必须与多维表格列名一致。  
常用字段示例：

- `date_start` / `date_stop`
- `spend` / `impressions` / `reach`
- `unique_clicks` / `unique_ctr` / `cost_per_unique_click`
- `actions:onsite_conversion.messaging_conversation_started_7d`
- `cost_per_action_type:onsite_conversion.messaging_conversation_started_7d`
- `results` / `result_indicator`

---

## 五、日期校验

仅允许上传 **昨天的数据**：  
`date_start` 与 `date_stop` 必须等于昨天，否则直接拒绝上传。

---

## 六、常见问题

### Q: 为什么下拉没有更新？
A: 点击左上角刷新按钮，并检查 `LARK_CONFIG_TABLE_ID` 是否配置正确。

### Q: 为什么无法上传？
A: 项目名称与投手名称必选，且日期必须为昨天。
