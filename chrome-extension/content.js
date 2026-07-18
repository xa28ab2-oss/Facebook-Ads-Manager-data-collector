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
      const accountMatch = (document.body.innerText || '').match(/\b\d{3}-\d{3}-\d{4}\b/);
      const costPerConversion = parseNumber(fields['每次转化费用']);
      const record = {
        platform: 'google_ads',
        campaign_name: 'Google Ads 账号汇总',
        account_id: accountMatch ? accountMatch[0].replace(/-/g, '') : '',
        ad_account_id: accountMatch ? accountMatch[0].replace(/-/g, '') : '',
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
    return { success: false, error: '未找到 Google Ads 广告系列汇总表，请打开广告系列报表并显示费用、展示次数、点击次数和转化次数列' };
  }

  function findAndClickRefreshButton() {
    const selectors = [
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

          if (label.includes('刷新') || label.toLowerCase().includes('refresh') ||
              text.includes('刷新') || text.toLowerCase().includes('refresh')) {
            console.log('[Facebook Ads Collector] Found refresh button, clicking...');
            el.click();
            return true;
          }
        }
      } catch (e) {}
    }

    console.log('[Facebook Ads Collector] Refresh button not found');
    return false;
  }

  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'clickRefresh') {
      const clicked = findAndClickRefreshButton();
      sendResponse({ success: clicked });
      return true;
    }
    if (request.action === 'collectGoogleAdsData') {
      sendResponse(collectGoogleAdsData());
      return true;
    }
  });

  console.log('[Ads Data Collector] Content script loaded');
})();
