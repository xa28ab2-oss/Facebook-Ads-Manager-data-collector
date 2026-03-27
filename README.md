# Facebook Ads Manager 数据采集系统

## 项目结构

```
Facebook_data_Chrome_Extension/
├── api/                      # Vercel 后端 API（推荐，部署后路径 /api/upload）
│   └── upload.js             # 上传数据接口
│
├── chrome-extension/          # Chrome 插件目录
│   ├── manifest.json          # Manifest V3 配置
│   ├── popup.html             # 插件 popup 界面
│   ├── popup.js               # Popup 逻辑
│   ├── content.js             # 内容脚本 (网络拦截)
│   └── background.js          # 后台服务脚本
│
├── vercel-api/               # Vercel 后端 API
│   ├── package.json          # 依赖配置
│   └── api/
│       └── upload.js         # 上传数据接口
│
└── README.md                 # 部署说明文档
```

---

## 一、Chrome 插件部署

### 1. 在 Chrome 中加载插件

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角的 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `chrome-extension` 文件夹

### 2. 使用插件

1. 打开 Facebook Ads Manager 页面 (https://business.facebook.com/adsmanager/)
2. 点击 Chrome 工具栏中的插件图标
3. 首次使用需要配置:
   - **API 端点地址**: 部署 Vercel 后获得的 URL，如 `https://your-api.vercel.app/api/upload`
   - **授权 Token**: 后端设置的 API Token
4. 点击 **开始采集数据** 按钮
5. 等待 3 秒左右，插件会自动收集页面中的广告数据
6. 数据会自动上传到 Lark 多维表格

---

## 二、Vercel 后端部署

### 1. 前提条件

- Node.js 18+ 已安装
- Vercel 账号 (免费注册: https://vercel.com)
- Lark 开放平台应用 (https://open.larksuite.com/)

### 2. 部署步骤

#### 步骤 1: 创建 Lark 开放平台应用

1. 访问 [Lark Open Platform](https://open.larksuite.com/)
2. 点击 **创建企业自建应用**
3. 填写应用名称和描述
4. 获取 **App ID** 和 **App Secret** (在凭证管理页面)

#### 步骤 2: 配置多维表格权限

1. 在 Lark 开放平台应用中，找到 **权限管理**
2. 申请以下权限:
   - `bitable:app` - 访问多维表格
   - `bitable:app:readonly` - 读取多维表格 (可选)

#### 步骤 3: 创建多维表格

1. 打开 Lark (飞书) 应用
2. 创建一个新的 **多维表格 (Bitable)**
3. 设置以下字段:
   | 字段名称 | 字段类型 |
   |---------|---------|
   | campaign_name | 文本 |
   | spend | 数字 |
   | impressions | 数字 |
   | clicks | 数字 |
   | operator | 文本 |
   | timestamp | 时间 |

4. 获取多维表格的 **App Token** (在表格 URL 中，格式: `xxxXXXxxx`)
5. 获取 **数据表 ID** (在表格 URL 中)

#### 步骤 4: 部署到 Vercel

推荐方式：直接部署仓库根目录（Vercel 会自动识别根目录的 [api/upload.js](file:///c:/Users/tang/Documents/trae_projects/Facebook_data_Chrome_Extension/api/upload.js)，对外提供 `/api/upload`）。

**方式一: 使用 Vercel CLI**

```bash
# 安装 Vercel CLI
npm install -g vercel

# 进入 API 目录
cd vercel-api

# 登录 Vercel
vercel login

# 部署 (按照提示操作)
vercel

# 设置环境变量
vercel env add LARK_APP_TOKEN
vercel env add LARK_APP_ID
vercel env add LARK_APP_SECRET
vercel env add LARK_TABLE_ID
vercel env add API_TOKEN

# 重新部署使环境变量生效
vercel --prod
```

---

## 三、数据来源与字段映射

本插件从 Ads Manager 两类接口组合还原数据：

- am_tabular（统计表格接口）
  - 作用：返回“统计口径”的明细/汇总数据
  - 结构：`headers + rows`
    - `headers.dimensions`：维度列顺序（如 `campaign_id/objective/date_start/date_stop`）
    - `headers.atomic_columns`：指标列顺序（如 `reach/spend/impressions`）
    - `rows[i].dimension_values/atomic_values`：与以上顺序一一对应
    - `result_columns/action_columns`：`results/cost_per_result` 属于结果类型，不在 `atomic_values`，需要结合 `action_values/result_values`
  - 处理要点：
    - `"null" / "-" / "—"` 视为缺失值，不写 0
    - 只有 `objective/date_*` 的行是汇总（`MULTIPLE`），不写入 campaign 明细
    - 维度包含 `campaign_id` 才是每行一个 campaign 的明细

- graphql（AdCampaignGroup 等）
  - 作用：返回“配置/元数据”类信息
  - 常用字段：
    - `id`：campaign_id
    - `name`：广告系列真实名称
    - `daily_budget_safe_value_str` / `lifetime_budget_safe_value_str` / `budget_remaining_safe_value_str`：预算字段（字符串，单位为货币最小单位，需 ÷100）
    - `delivery_status`：投放状态
  - 用途：
    - 名称映射：优先用 `name`，若本轮未抓到则回退为 `objective (id)`
    - 预算映射：优先用 `daily_budget_safe_value_str` 或 `budget_remaining_safe_value_str`（÷100）

字段写入规则：

- 明细指标：来自 `am_tabular` 的 `atomic_values`（按顺序对应 `atomic_columns`）
  - `spend` → 已花费金额
  - `impressions` → 展示次数
  - `reach` → 触达
  - `clicks/unique_link_clicks` 等按列配置返回
- 结果类指标：`results/cost_per_result` 由 `result_columns + action_values/result_values` 描述，当 `values: "modeled"` 表示模型估算
- 名称与预算：来自 `graphql`；以 `campaign_id` 合并到明细
- 缺失值：保持空，不写 0

示例（来自 graphql 的名称与预算解析，数值均 ÷100 转金额）：

- 6989638042835：name=xl-mjl-15，daily=5000→50.00，remaining=5000→50.00
- 6989709539035：name=hd-dt，daily=300→3.00，remaining=300→3.00
- 6990513538235：name=XH-HD -1/23，daily=2000→20.00，remaining=2000→20.00
- 6988103009035：name=MJL-AG-13K-5，daily=null，remaining=0→0
- 6986076671435：name=BLJ-HD-JN，daily=null，remaining=0→0

排查指引：

- 采集日志中：
  - `采集列(atomic_columns)` 出现 `reach/spend/impressions` → 已获取指标
  - `采集数据(前3条)` 中值为 `"0"` 表示确实为 0；为 `"null"` 表示缺失
- 若名称仍为 `OUTCOME_… (id)`：
  - 本轮未触发返回 `name` 的 graphql 请求；滚动广告系列列表或打开编辑侧栏以触发
  - 可查看插件日志：`名称缓存命中` 与 `名称缓存样例`
- 若预算为空：
  - 本轮未触发返回预算字段的 graphql；可在预算设置面板触发，或后端降级为只写入已获取的指标

**方式二: 使用 GitHub 部署**

1. 将 `vercel-api` 目录推送到 GitHub 仓库
2. 在 Vercel Dashboard 点击 **Import Project**
3. 选择 GitHub 仓库
4. 设置环境变量 (在 Vercel Dashboard → Settings → Environment Variables):
   - `LARK_APP_TOKEN`: 你的 Lark 多维表格 App Token
   - `LARK_APP_ID`: Lark 应用的 App ID
   - `LARK_APP_SECRET`: Lark 应用的 App Secret
   - `LARK_TABLE_ID`: 多维表格的数据表 ID
   - `API_TOKEN`: 自定义的授权 Token (用于插件验证)
5. 点击 **Deploy**

### 3. 获取 API 地址

部署完成后，Vercel 会提供如下格式的 URL:
```
https://your-project.vercel.app/api/upload
```

记录此 URL，后续配置插件时需要使用。

---

## 三、Lark API 配置详解

### 环境变量说明

| 变量名 | 说明 | 示例 |
|-------|------|------|
| LARK_APP_TOKEN | 多维表格的 App Token | `basxxxxxxxxxx` |
| LARK_APP_ID | Lark 应用的 App ID | `cli_xxxxxxxxxx` |
| LARK_APP_SECRET | Lark 应用的 App Secret | `xxxxxxxxxxxxxxxx` |
| LARK_TABLE_ID | 数据表的 Table ID | `tblxxxxxxxxxx` |
| API_TOKEN | 插件认证 Token | `your-secret-token` |

### 获取方式

1. **LARK_APP_ID / LARK_APP_SECRET**:
   - 登录 Lark 开放平台
   - 选择应用 → 凭证与基础信息

2. **LARK_APP_TOKEN**:
   - 打开多维表格
   - 复制 URL 中 `bitsheet:///` 后面的部分
   - 格式: `https://bytedance.larksuite.com/docx/{APP_TOKEN}`

3. **LARK_TABLE_ID**:
   - 在多维表格中，点击右上角 **分享** → **复制链接**
   - URL 中包含 table ID

---

## 四、安全注意事项

1. **API_TOKEN**: 请使用强密码或随机字符串，不要使用简单 token
2. **LARK_APP_SECRET**: 高度敏感，请勿泄露或在客户端代码中暴露
3. **CORS**: 当前 API 仅允许 POST 请求，需要携带正确的 Authorization header
4. **数据安全**: 所有数据通过 HTTPS 传输，插件不会在本地存储敏感信息

---

## 五、常见问题

### Q: 插件无法捕获数据?
A: 确保:
- 在 Facebook Ads Manager 页面使用插件
- 页面已加载广告数据 (不是空白页)
- 等待 3 秒采集完成

### Q: 上传失败，提示 401?
A: 检查:
- API Token 是否正确配置
- Token 是否与 Vercel 环境变量一致

### Q: Lark API 返回 99991661 错误?
A: 这是 access token 缺失或过期错误。请检查:
- LARK_APP_ID 和 LARK_APP_SECRET 是否正确
- 应用是否已发布/启用

### Q: 如何调试?
A:
1. 打开 Chrome 插件页面，右键点击插件图标 → 检查弹出内容
2. 打开 Chrome DevTools (F12) → Console 查看日志
3. Vercel 函数日志可在 Vercel Dashboard → Functions 查看

---

## 六、版本更新

- v1.0.0 (2026-03-25): 初始版本
