(function() {
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
  });

  console.log('[Facebook Ads Collector] Content script loaded');
})();
