const crypto = require('crypto');

const fetchImpl = global.fetch || require('node-fetch');
const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN || '';
const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_BUSINESS_PROJECT_TABLES = process.env.LARK_BUSINESS_PROJECT_TABLES || '';
const LARK_APPROVAL_OPTIONS_TOKEN = process.env.LARK_APPROVAL_OPTIONS_TOKEN || '';

const BUSINESS_CODES = {
  tlx: 'tlx',
  天狼星: 'tlx',
  fq: 'fq',
  番茄: 'fq',
  ws: 'ws',
  五三: 'ws'
};

function parseBusinessTables() {
  try {
    const parsed = JSON.parse(LARK_BUSINESS_PROJECT_TABLES);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([code, tableId]) => [
          String(code || '').trim().toLowerCase(),
          String(tableId || '').trim()
        ])
        .filter(([code, tableId]) => code && tableId)
    );
  } catch (error) {
    return {};
  }
}

function parseRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body !== 'string' || !req.body.trim()) return {};
  try {
    return JSON.parse(req.body);
  } catch (error) {
    return {};
  }
}

function tokensMatch(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length &&
    actualBuffer.length > 0 &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function extractScalarValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(extractScalarValues);
  if (typeof value === 'object') {
    return ['value', 'text', 'name', 'label', 'key']
      .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
      .flatMap((key) => extractScalarValues(value[key]));
  }
  const text = String(value).trim();
  return text ? [text] : [];
}

function normalizeBusinessCode(value) {
  const text = String(value || '').trim();
  return BUSINESS_CODES[text] || BUSINESS_CODES[text.toLowerCase()] || '';
}

function extractBusinessCode(linkageParams) {
  if (!linkageParams || typeof linkageParams !== 'object') return '';
  const preferredKeys = ['business_code', 'business', '所属商务', '商务'];
  for (const key of preferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(linkageParams, key)) continue;
    for (const value of extractScalarValues(linkageParams[key])) {
      const code = normalizeBusinessCode(value);
      if (code) return code;
    }
  }
  for (const value of Object.values(linkageParams)) {
    for (const item of extractScalarValues(value)) {
      const code = normalizeBusinessCode(item);
      if (code) return code;
    }
  }
  return '';
}

function extractProjectNames(fieldValue) {
  if (fieldValue === null || fieldValue === undefined) return [];
  if (Array.isArray(fieldValue)) return fieldValue.flatMap(extractProjectNames);
  if (typeof fieldValue === 'object') {
    if (Object.prototype.hasOwnProperty.call(fieldValue, 'text')) {
      return extractProjectNames(fieldValue.text);
    }
    if (Object.prototype.hasOwnProperty.call(fieldValue, 'name')) {
      return extractProjectNames(fieldValue.name);
    }
    if (Object.prototype.hasOwnProperty.call(fieldValue, 'value')) {
      return extractProjectNames(fieldValue.value);
    }
    return [];
  }
  const projectName = String(fieldValue).trim();
  return projectName && projectName !== '-' ? [projectName] : [];
}

async function getTenantAccessToken() {
  const response = await fetchImpl('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET
    })
  });
  const data = await response.json();
  if (!response.ok || !data.tenant_access_token) {
    throw new Error(data.msg || '获取 Lark 访问凭证失败');
  }
  return data.tenant_access_token;
}

async function loadProjectsFromTable(tenantAccessToken, tableId) {
  const params = new URLSearchParams({ page_size: '200' });
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${tableId}/records?${params}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${tenantAccessToken}` }
  });
  const data = await response.json();
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(data.msg || '读取项目表失败');
  }
  const projects = new Set();
  const items = data && data.data && Array.isArray(data.data.items) ? data.data.items : [];
  for (const item of items) {
    const fields = item && item.fields ? item.fields : {};
    for (const projectName of extractProjectNames(fields['项目名称'])) {
      projects.add(projectName);
    }
  }
  return Array.from(projects);
}

function createApprovalResponse(projectNames) {
  const names = Array.from(new Set(projectNames.map((name) => String(name || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .slice(0, 200);
  const texts = {};
  const options = names.map((name) => {
    const value = `project_${crypto.createHash('sha256').update(name).digest('hex').slice(0, 20)}`;
    texts[value] = name;
    return {
      id: value,
      value
    };
  });
  return {
    code: 0,
    msg: 'success!',
    data: {
      result: {
        options,
        i18nResources: [
          {
            locale: 'zh_cn',
            isDefault: true,
            texts
          },
          {
            locale: 'en_us',
            isDefault: false,
            texts
          }
        ]
      }
    }
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, msg: '只支持 POST 请求' });
  }

  const body = parseRequestBody(req);
  if (!LARK_APPROVAL_OPTIONS_TOKEN || !tokensMatch(body.token, LARK_APPROVAL_OPTIONS_TOKEN)) {
    return res.status(401).json({ code: 401, msg: 'Token 校验失败' });
  }
  if (!LARK_APP_TOKEN || !LARK_APP_ID || !LARK_APP_SECRET || !LARK_BUSINESS_PROJECT_TABLES) {
    return res.status(500).json({ code: 500, msg: 'Lark 环境变量配置不完整' });
  }

  const businessTables = parseBusinessTables();
  if (!Object.keys(businessTables).length) {
    return res.status(500).json({ code: 500, msg: '商务项目表映射配置无效' });
  }

  try {
    const tenantAccessToken = await getTenantAccessToken();
    const businessCode = extractBusinessCode(body.linkage_params);
    if (businessCode) {
      const tableId = businessTables[businessCode];
      if (!tableId) return res.status(200).json(createApprovalResponse([]));
      const projects = await loadProjectsFromTable(tenantAccessToken, tableId);
      return res.status(200).json(createApprovalResponse(projects));
    }

    // “校验接口”通常不携带联动值；此时并行读取所有商务，返回最多 200 个项目。
    const projectGroups = await Promise.all(
      Object.values(businessTables).map((tableId) => loadProjectsFromTable(tenantAccessToken, tableId))
    );
    return res.status(200).json(createApprovalResponse(projectGroups.flat()));
  } catch (error) {
    return res.status(500).json({
      code: 500,
      msg: error && error.message ? error.message : '读取项目选项失败'
    });
  }
};
