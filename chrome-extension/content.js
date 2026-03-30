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

  function findHorizontalScrollContainer() {
    const nodes = document.querySelectorAll('div');
    let best = null;
    let bestOverflow = 0;
    for (const node of nodes) {
      if (!node || node.offsetParent === null) continue;
      const style = window.getComputedStyle(node);
      const overflowX = style && style.overflowX;
      if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
      const overflow = node.scrollWidth - node.clientWidth;
      if (overflow > 50 && overflow > bestOverflow) {
        best = node;
        bestOverflow = overflow;
      }
    }
    return best;
  }

  function scrollTable(position) {
    const container = findHorizontalScrollContainer();
    if (!container) return false;
    const max = container.scrollWidth - container.clientWidth;
    if (position === 'left') container.scrollLeft = 0;
    else if (position === 'right') container.scrollLeft = max;
    else if (position === 'center') container.scrollLeft = Math.max(0, Math.floor(max / 2));
    else container.scrollLeft = 0;
    return true;
  }

  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'clickRefresh') {
      const clicked = findAndClickRefreshButton();
      sendResponse({ success: clicked });
      return true;
    }
    if (request.action === 'scrollTable') {
      const ok = scrollTable(request.position);
      sendResponse({ success: ok });
      return true;
    }
  });

  console.log('[Facebook Ads Collector] Content script loaded');
})();
