(function() {
  function cleanCellText(value) {
    return String(value || '')
      .split('\n')
      .map((part) => part.trim())
      .filter((part) => part && !['help_outline', 'expand_more', 'settings'].includes(part))
      .join(' ')
      .trim();
  }

  function parseNumber(value) {
    const text = String(value || '').replace(/,/g, '').replace(/[^0-9.\-]/g, '');
    const number = Number(text);
    return Number.isFinite(number) ? number : 0;
  }

  function extractGoogleAdsDate() {
    const text = document.body ? document.body.innerText : '';
    const iso = text.match(/(20\d{2})-(\d{2})-(\d{2})\s*(?:至|–|—|-)\s*(20\d{2})-(\d{2})-(\d{2})/);
    if (iso) return { date_start: `${iso[1]}-${iso[2]}-${iso[3]}`, date_stop: `${iso[4]}-${iso[5]}-${iso[6]}` };
    const zh = text.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*[–—-]\s*(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日)?/);
    if (!zh) return null;
    const pad = (part) => String(part).padStart(2, '0');
    const start = `${zh[1]}-${pad(zh[2])}-${pad(zh[3])}`;
    const stop = zh[5] ? `${zh[4] || zh[1]}-${pad(zh[5])}-${pad(zh[6])}` : start;
    return { date_start: start, date_stop: stop };
  }

  function extractGoogleAdsAccountId() {
    const pattern = /\b\d{3}-\d{3}-\d{4}\b/;
    const accountInfo = document.querySelector('.account-info[title]');
    const accountInfoText = accountInfo
      ? `${accountInfo.getAttribute('title') || ''} ${accountInfo.textContent || ''}`
      : '';
    const headerMatch = accountInfoText.match(pattern);
    if (headerMatch) return headerMatch[0];

    const titleMatch = String(document.title || '').match(pattern);
    if (titleMatch) return titleMatch[0];

    const pageMatch = String(document.body ? document.body.innerText : '').match(pattern);
    return pageMatch ? pageMatch[0] : '';
  }

  function extractGoogleSummaryCardValue(label) {
    const candidates = Array.from(document.querySelectorAll('body *')).filter((element) => {
      if (element.children.length > 2) return false;
      return cleanCellText(element.textContent) === label;
    });
    for (const candidate of candidates) {
      let container = candidate.parentElement;
      for (let depth = 0; container && depth < 5; depth++, container = container.parentElement) {
        const lines = String(container.innerText || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length > 20) continue;
        const labelIndex = lines.indexOf(label);
        if (labelIndex === -1) continue;
        for (let index = labelIndex + 1; index < Math.min(lines.length, labelIndex + 4); index++) {
          if (/\d/.test(lines[index])) return lines[index];
        }
      }
    }
    return '';
  }

  function collectGoogleAdsData() {
    const range = extractGoogleAdsDate();
    if (!range) return { success: false, error: '无法识别 Google Ads 日期范围' };
    if (range.date_start !== range.date_stop) return { success: false, error: 'Google Ads 只支持采集单日数据' };

    const grids = Array.from(document.querySelectorAll('[role="grid"]'));
    for (const grid of grids) {
      const rows = Array.from(grid.querySelectorAll('[role="row"]'));
      if (!rows.length) continue;
      const headers = Array.from(rows[0].querySelectorAll('[role="columnheader"], [role="gridcell"]'))
        .map((cell) => cleanCellText(cell.getAttribute('aria-label') || cell.innerText));
      if (!headers.includes('广告系列') || !headers.includes('费用')) continue;
      const totalRow = rows.find((row) => cleanCellText(row.innerText).includes('总计：账号'));
      if (!totalRow) continue;
      const values = Array.from(totalRow.querySelectorAll('[role="gridcell"]')).map((cell) => cleanCellText(cell.innerText));
      const fields = {};
      // Google 的账号汇总行会比表头多一个左侧展开单元格；指标列从右侧对齐最稳定。
      headers.forEach((header, index) => {
        if (!header) return;
        const valueIndex = values.length - (headers.length - index);
        fields[header] = values[valueIndex] || '';
      });
      const accountId = extractGoogleAdsAccountId();
      const costPerConversion = parseNumber(fields['每次转化费用']);
      const record = {
        platform: 'google_ads',
        campaign_name: 'Google Ads 账号汇总',
        account_id: accountId,
        ad_account_id: accountId,
        date_start: range.date_start,
        date_stop: range.date_stop,
        spend: parseNumber(fields['费用']),
        impressions: parseNumber(fields['展示次数']),
        clicks: parseNumber(fields['点击次数']),
        results: parseNumber(fields['转化次数']),
        conversions: parseNumber(fields['转化次数']),
        ctr: parseNumber(fields['点击率']),
        conversion_rate: parseNumber(fields['转化率']),
        cpc: parseNumber(fields['平均每次点击费用']),
        cost_per_conversion: costPerConversion,
        cost_per_result: costPerConversion,
        currency: (fields['费用'].match(/^[^\d\s]+/) || [''])[0],
        raw_fields: {
          ...fields,
          source_platform: 'google_ads',
          spend: parseNumber(fields['费用']),
          impressions: parseNumber(fields['展示次数']),
          clicks: parseNumber(fields['点击次数']),
          results: parseNumber(fields['转化次数']),
          date_start: range.date_start,
          date_stop: range.date_stop
        }
      };
      return { success: true, data: [record], meta: { platform: 'google_ads', headers } };
    }

    // 部分 Google Ads 布局不会把“总计：账号”行渲染到 DOM，但顶部汇总卡片仍有完整指标。
    const cardFields = {
      '费用': extractGoogleSummaryCardValue('费用'),
      '展示次数': extractGoogleSummaryCardValue('展示次数'),
      '点击次数': extractGoogleSummaryCardValue('点击次数'),
      '转化次数': extractGoogleSummaryCardValue('转化次数')
    };
    if (Object.values(cardFields).every((value) => value && /\d/.test(value))) {
      const accountId = extractGoogleAdsAccountId();
      const spend = parseNumber(cardFields['费用']);
      const impressions = parseNumber(cardFields['展示次数']);
      const clicks = parseNumber(cardFields['点击次数']);
      const conversions = parseNumber(cardFields['转化次数']);
      const currencyMatch = cardFields['费用'].match(/^[^\d\s-]+/);
      const record = {
        platform: 'google_ads',
        campaign_name: 'Google Ads 账号汇总',
        account_id: accountId,
        ad_account_id: accountId,
        date_start: range.date_start,
        date_stop: range.date_stop,
        spend,
        impressions,
        clicks,
        results: conversions,
        conversions,
        ctr: impressions > 0 ? clicks / impressions * 100 : 0,
        conversion_rate: clicks > 0 ? conversions / clicks * 100 : 0,
        cpc: clicks > 0 ? spend / clicks : 0,
        cost_per_conversion: conversions > 0 ? spend / conversions : 0,
        cost_per_result: conversions > 0 ? spend / conversions : 0,
        currency: currencyMatch ? currencyMatch[0] : '',
        raw_fields: {
          ...cardFields,
          source_platform: 'google_ads',
          source_layout: 'summary_cards',
          spend,
          impressions,
          clicks,
          results: conversions,
          date_start: range.date_start,
          date_stop: range.date_stop
        }
      };
      return {
        success: true,
        data: [record],
        meta: { platform: 'google_ads', source_layout: 'summary_cards', headers: Object.keys(cardFields) }
      };
    }
    return { success: false, error: '未找到 Google Ads 广告系列汇总表，请打开广告系列报表并显示费用、展示次数、点击次数和转化次数列' };
  }

  function findRefreshButton() {
    const selectors = [
      'material-button.icon-refresh[role="button"]',
      'material-button[role="button"]',
      'div[role="button"]',
      'span[role="button"]',
      'button',
      'div[aria-label*="刷新"]',
      'div[aria-label*="refresh"]',
    ];

    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (el.offsetParent === null) continue;

          const label = el.getAttribute('aria-label') || '';
          const text = el.textContent?.trim() || '';
          const className = typeof el.className === 'string' ? el.className : '';

          if (label.includes('刷新') || label.toLowerCase().includes('refresh') ||
              text.includes('刷新') || text.toLowerCase().includes('refresh') ||
              className.split(/\s+/).includes('icon-refresh')) {
            return el;
          }
        }
      } catch (e) {}
    }

    return null;
  }

  async function clickRefreshButton() {
    const firstButton = findRefreshButton();
    if (!firstButton) return { success: false, error: '未找到刷新按钮' };
    firstButton.click();

    if (location.hostname === 'ads.google.com') {
      // 同一次采集只刷新一次，避免第一次刷新尚未完成时再次点击导致报表卡住。
      return { success: true, click_count: 1 };
    }

    return { success: true, click_count: 1 };
  }

  function getRefreshButtonRect() {
    const button = findRefreshButton();
    if (!button) return { success: false, error: '未找到刷新按钮' };
    const rect = button.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { success: false, error: '刷新按钮当前不可点击' };
    }
    return {
      success: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height
    };
  }

  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'getRefreshButtonRect') {
      sendResponse(getRefreshButtonRect());
      return true;
    }
    if (request.action === 'clickRefresh') {
      clickRefreshButton()
        .then(sendResponse)
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }
    if (request.action === 'collectGoogleAdsData') {
      sendResponse(collectGoogleAdsData());
      return true;
    }
  });

  console.log('[Ads Data Collector] Content script loaded');
})();
