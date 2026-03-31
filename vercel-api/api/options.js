const fetch = require('node-fetch');

const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN || '';
const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_CONFIG_TABLE_ID = process.env.LARK_CONFIG_TABLE_ID || '';

function normalizeFieldName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .trim();
}

function coerceValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.length ? String(value[0]) : '';
  if (typeof value === 'object') return '';
  return String(value);
}

function pickFieldValue(fields, candidates) {
  if (!fields || typeof fields !== 'object') return '';
  const normalized = new Map();
  for (const key of Object.keys(fields)) {
    normalized.set(normalizeFieldName(key), fields[key]);
  }
  for (const candidate of candidates) {
    const hit = normalized.get(normalizeFieldName(candidate));
    if (hit !== undefined) return coerceValue(hit).trim();
  }
  return '';
}

async function getTenantAccessToken() {
  const response = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET
    })
  });
  const data = await response.json();
  return data.tenant_access_token || '';
}

async function listBitableRecords(tenantAccessToken, pageToken) {
  const params = new URLSearchParams({ page_size: '200' });
  if (pageToken) params.set('page_token', pageToken);
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_CONFIG_TABLE_ID}/records?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + tenantAccessToken
    }
  });
  return await response.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!LARK_APP_TOKEN || !LARK_APP_ID || !LARK_APP_SECRET || !LARK_CONFIG_TABLE_ID) {
    return res.status(500).json({ error: 'Lark API configuration missing' });
  }

  try {
    const tenantAccessToken = await getTenantAccessToken();
    if (!tenantAccessToken) {
      return res.status(500).json({ error: 'Failed to get tenant access token' });
    }

    const projects = new Set();
    const buyers = new Set();
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const resp = await listBitableRecords(tenantAccessToken, pageToken);
      const items = resp && resp.data && Array.isArray(resp.data.items) ? resp.data.items : [];
      for (const item of items) {
        const fields = item && item.fields ? item.fields : {};
        const project = pickFieldValue(fields, ['项目名称', 'project_name', 'project', '项目']);
        const buyer = pickFieldValue(fields, ['投手名称', 'buyer_name', 'buyer', '投手', '操盘手']);
        if (project) projects.add(project);
        if (buyer) buyers.add(buyer);
      }
      pageToken = resp && resp.data ? resp.data.page_token : '';
      if (!pageToken) break;
    }

    res.status(200).json({
      projects: Array.from(projects),
      buyers: Array.from(buyers)
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load options' });
  }
};
