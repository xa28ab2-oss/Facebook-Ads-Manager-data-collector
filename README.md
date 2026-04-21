# Facebook Ads Manager 数据采集系统

## 项目结构

```text
Facebook_data_Chrome_Extension/
├── api/                      # Vercel 后端 API（根目录部署路径 /api/upload）
│   ├── upload.js             # 上传接口（根目录部署）
│   └── options.js            # 项目/投手下拉选项接口（根目录部署）
├── chrome-extension/         # Chrome 插件
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.js
│   ├── content.js
│   └── background.js
├── vercel-api/               # 备用 API 目录（可单独部署）
│   └── api/
│       ├── upload.js
│       └── options.js
└── README.md
```

## 一、插件使用

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 点击“加载已解压的扩展程序”，选择 `chrome-extension` 目录
4. 打开 Ads Manager 页面后点击插件图标
5. 选择项目名称、投手名称、上传模式
6. 点击“开始采集数据”

## 二、后端部署与环境变量

### 1) 前提

- Node.js 18+
- Vercel 账号
- Lark 开放平台应用

### 2) 必填环境变量

| 变量名 | 说明 |
|---|---|
| `LARK_APP_TOKEN` | 多维表格 App Token |
| `LARK_APP_ID` | Lark 应用 App ID |
| `LARK_APP_SECRET` | Lark 应用 App Secret |
| `LARK_TABLE_ID` | 当日消耗表 Table ID |
| `LARK_REFLUX_TABLE_ID` | 回流消耗表 Table ID |
| `LARK_BUYER_TABLE_ID` | 投手表 Table ID |
| `LARK_PROJECT_TABLE_ID` | 项目表 Table ID |

兼容说明：
- 如果未配置 `LARK_BUYER_TABLE_ID`，会回退使用 `LARK_CONFIG_TABLE_ID` 作为投手表。

## 三、选项表结构（已改为双表）

### 1) 投手表

- 只保留一列：`投手名称`
- `/api/options` 会读取该列作为投手下拉

### 2) 项目表

- 可按“列名=商务，单元格=项目名”的结构维护
- `/api/options` 会聚合所有列中的项目值并去重，不区分商务归属
- 同时会尝试读取字段选项里的项目名

## 四、上传模式与写入规则

- 上传模式：
  - `当日消耗`
  - `回流消耗`
- 账号编号：
  - 从请求 URL 的 `act_XXXXXXXX` 提取
  - 写入 `广告账户编号`（或 `ad_account_id/account_id` 匹配列）
- 消耗来源：
  - 优先使用 `objective=MULTIPLE` 汇总行的 `spend`
  - 若当前批次没有 `MULTIPLE`，允许使用非 `MULTIPLE` 行

## 五、日期规则

- 所有模式统一强校验：
  - 每条记录 `date_start` 与 `date_stop` 必须为同一天
  - 一个上传批次内只允许单日数据（不能混多天）
- 在 `ENFORCE_DATE_VALIDATION=true` 时继续执行额外校验：
  - `当日消耗`：要求为昨天
  - `回流消耗`：禁止今天和昨天

## 六、缺字段拦截

上传前会校验以下字段是否“存在”（键存在即可，值可为空）：

- 消耗：`spend`
- 成效：`results`（或 header 中存在 `result_columns.results`）
- 覆盖人数：`reach`
- 展示量：`impressions`
- 点击量（全部）：`clicks`
- 完成注册次数：`omni_complete_registration` / `complete_registrations` / `complete_registration` / `actions:omni_complete_registration`

缺任一字段会直接拦截上传并在前端提示。

## 七、隐私与安全

- 请勿将 `access_token`、Cookie、用户凭据写入代码或提交到仓库。
- `.env` 文件和本地日志应保持在本地，不上传到 Git。
- 仅上传业务代码、静态资源和文档。
