chrome.runtime.onInstalled.addListener(function() {
  console.log('[Background] Facebook Ads Collector 已安装');
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.type === 'LOG') {
    console.log('[Background]', request.message);
  }
  return true;
});
