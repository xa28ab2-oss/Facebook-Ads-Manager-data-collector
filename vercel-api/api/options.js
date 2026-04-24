const fetch = require('node-fetch');

const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN || '';
const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_BUYER_TABLE_ID = process.env.LARK_BUYER_TABLE_ID || process.env.LARK_CONFIG_TABLE_ID || '';
const LARK_PROJECT_TABLE_ID = process.env.LARK_PROJECT_TABLE_ID || '';

function normalizeFieldName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .trim();
}

function shouldIgnoreOptionField(fieldName) {
  const normalized = normalizeFieldName(fieldName);
  return normalized === normalizeFieldName('序号') || normalized === 'serialno';
}

function extractStringValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) {
      const items = extractStringValues(item);
      for (const v of items) result.push(v);
    }
    return result;
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return extractStringValues(value.text);
    if (Object.prototype.hasOwnProperty.call(value, 'name')) return extractStringValues(value.name);
    if (Object.prototype.hasOwnProperty.call(value, 'value')) return extractStringValues(value.value);
    return [];
  }
  const text = String(value).trim();
  if (!text || text === 'null' || text === '-' || text === '—') return [];
  return [text];
}

function pickFieldValues(fields, candidates) {
  if (!fields || typeof fields !== 'object') return [];
  const normalized = new Map();
  for (const key of Object.keys(fields)) {
    normalized.set(normalizeFieldName(key), fields[key]);
  }
  for (const candidate of candidates) {
    const hit = normalized.get(normalizeFieldName(candidate));
    if (hit !== undefined) return extractStringValues(hit);
  }
  return [];
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

async function listBitableRecords(tenantAccessToken, tableId, pageToken) {
  const params = new URLSearchParams({ page_size: '200' });
  if (pageToken) params.set('page_token', pageToken);
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${tableId}/records?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + tenantAccessToken
    }
  });
  return await response.json();
}

async function listBitableFields(tenantAccessToken, tableId) {
  const params = new URLSearchParams({ page_size: '500' });
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${tableId}/fields?${params.toString()}`;
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

  if (!LARK_APP_TOKEN || !LARK_APP_ID || !LARK_APP_SECRET || !LARK_BUYER_TABLE_ID || !LARK_PROJECT_TABLE_ID) {
    return res.status(500).json({ error: 'Lark API configuration missing' });
  }

  try {
    const tenantAccessToken = await getTenantAccessToken();
    if (!tenantAccessToken) {
      return res.status(500).json({ error: 'Failed to get tenant access token' });
    }

    const projects = new Set();
    const buyers = new Set();
    let buyerPageToken = '';
    for (let i = 0; i < 5; i++) {
      const resp = await listBitableRecords(tenantAccessToken, LARK_BUYER_TABLE_ID, buyerPageToken);
      const items = resp && resp.data && Array.isArray(resp.data.items) ? resp.data.items : [];
      for (const item of items) {
        const fields = item && item.fields ? item.fields : {};
        const buyerValues = pickFieldValues(fields, ['投手名称', 'buyer_name', 'buyer', '投手', '操盘手']);
        for (const buyer of buyerValues) {
          if (buyer) buyers.add(buyer);
        }
      }
      buyerPageToken = resp && resp.data ? resp.data.page_token : '';
      if (!buyerPageToken) break;
    }

    let projectPageToken = '';
    for (let i = 0; i < 5; i++) {
      const resp = await listBitableRecords(tenantAccessToken, LARK_PROJECT_TABLE_ID, projectPageToken);
      const items = resp && resp.data && Array.isArray(resp.data.items) ? resp.data.items : [];
      for (const item of items) {
        const fields = item && item.fields ? item.fields : {};
        for (const key of Object.keys(fields)) {
          if (shouldIgnoreOptionField(key)) continue;
          const values = extractStringValues(fields[key]);
          for (const project of values) {
            if (project) projects.add(project);
          }
        }
      }
      projectPageToken = resp && resp.data ? resp.data.page_token : '';
      if (!projectPageToken) break;
    }

    const fieldResp = await listBitableFields(tenantAccessToken, LARK_PROJECT_TABLE_ID);
    const fieldItems = fieldResp && fieldResp.data && Array.isArray(fieldResp.data.items) ? fieldResp.data.items : [];
    for (const field of fieldItems) {
      const fieldName = field && (field.field_name || field.fieldName || field.name);
      if (shouldIgnoreOptionField(fieldName)) continue;
      const property = field && field.property ? field.property : {};
      const options = Array.isArray(property.options) ? property.options : [];
      for (const option of options) {
        const names = extractStringValues(option && (option.name || option.text || option.value));
        for (const name of names) {
          if (name) projects.add(name);
        }
      }
    }

    res.status(200).json({
      projects: Array.from(projects),
      buyers: Array.from(buyers)
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load options' });
  }
};
