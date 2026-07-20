(function() {
  const collectBtn = document.getElementById('collectBtn');
  const statusNoteEl = document.getElementById('statusNote');
  const logEl = document.getElementById('log');
  const logListEl = document.getElementById('logList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const projectNameInput = document.getElementById('projectName');
  const businessNameInput = document.getElementById('businessName');
  const buyerNameInput = document.getElementById('buyerName');
  const uploadModeInput = document.getElementById('uploadMode');
  const refreshOptionsBtn = document.getElementById('refreshOptionsBtn');

  const apiEndpoint = 'https://facebook-ads-manager-data-collector.vercel.app/api/upload';
  const defaultCollectText = '开始采集数据';

  let collectedData = [];
  let logEntries = [];
  let statusHistoryEntries = [];
  let lastConsumedUploadResultAt = 0;
  let statusState = { message: defaultCollectText, type: 'idle' };
  let statusResetTimer = null;
  let projectsByBusiness = {};

  function clearStatusResetTimer() {
    if (!statusResetTimer) return;
    clearTimeout(statusResetTimer);
    statusResetTimer = null;
  }

  function getTimeLabel() {
    return new Date().toLocaleString('zh-CN', { hour12: false });
  }

  function renderStatusHistory() {
    if (!logListEl) return;
    logListEl.innerHTML = '';
    const visibleEntries = logEntries.concat(statusHistoryEntries).sort((a, b) => {
      return Number(a.timestamp || 0) - Number(b.timestamp || 0);
    });
    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const entry = visibleEntries[i];
      const item = document.createElement('div');
      item.className = 'log-entry ' + entry.type;
      item.textContent = '[' + entry.time + '] ' + entry.message;
      logListEl.appendChild(item);
    }
    logListEl.scrollTop = 0;
  }

  function setStatusNote(message, type, recordHistory = true) {
    if (!statusNoteEl || !message) return;
    const time = getTimeLabel();
    const timestamp = Date.now();
    statusNoteEl.textContent = '[' + time + '] ' + message;
    statusNoteEl.title = '点击查看历史记录';
    statusNoteEl.className = 'status-note ' + type;
    if (recordHistory) {
      statusHistoryEntries.push({ time, message, type, timestamp });
      if (statusHistoryEntries.length > 100) {
        statusHistoryEntries = statusHistoryEntries.slice(statusHistoryEntries.length - 100);
      }
      if (logEl.style.display !== 'none') {
        renderStatusHistory();
      }
    }
  }

  function updateStatus(message, type, noteMessage, shouldPersist = true) {
    statusState = { message, type };
    clearStatusResetTimer();
    const buttonText = type === 'idle' ? defaultCollectText : message;
    collectBtn.textContent = buttonText;
    collectBtn.classList.remove('state-idle', 'state-collecting', 'state-success', 'state-error');
    collectBtn.classList.add('state-' + type);
    if (type === 'success' || type === 'error') {
      setStatusNote(noteMessage || message, type, true);
    }
    if (type === 'success' || type === 'error') {
      collectBtn.disabled = true;
      statusResetTimer = setTimeout(() => {
        updateStatus(defaultCollectText, 'idle');
        collectBtn.disabled = false;
      }, 3000);
    }
    if (shouldPersist) {
      persistUIState();
    }
  }

  function addLog(message, type = 'info', shouldPersist = true) {
    const entry = {
      time: new Date().toLocaleTimeString(),
      message,
      type,
      timestamp: Date.now()
    };
    logEntries.push(entry);
    if (logEntries.length > 200) {
      logEntries = logEntries.slice(logEntries.length - 200);
    }
    if (shouldPersist) {
      persistUIState();
    }
    if (logEl.style.display !== 'none') {
      renderStatusHistory();
    }
  }

  function formatDate(value) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getYesterdayDateString() {
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return formatDate(yesterday);
  }

  function getTodayDateString() {
    return formatDate(new Date());
  }

  function extractDateRange(record) {
    const raw = record && record.raw_fields ? record.raw_fields : {};
    return {
      date_start: record.date_start || raw.date_start || '',
      date_stop: record.date_stop || raw.date_stop || ''
    };
  }

  function getOptionsEndpoint() {
    return apiEndpoint.replace(/\/api\/upload\/?$/, '/api/options?business_project_test=1');
  }

  function validateSelections(projectName, buyerName, businessName) {
    if (!businessName || !projectName || !buyerName) {
      updateStatus('请选择商务、项目和投手', 'error', '请先选择商务、项目和投手');
      addLog('未选择商务、项目或投手，已停止上传', 'error');
      return false;
    }
    return true;
  }

  function setSelectOptions(selectEl, options, placeholder, selectedValue) {
    const value = selectedValue || selectEl.value || '';
    const blockedLabels = new Set(['请选择项目', '请选择项目名称', '请选择投手', '请选择投手名称']);
    const items = Array.isArray(options)
      ? options
          .map((item) => (item == null ? '' : String(item).trim()))
          .filter((item) => item && !blockedLabels.has(item))
      : [];
    selectEl.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = placeholder;
    empty.disabled = true;
    empty.hidden = true;
    selectEl.appendChild(empty);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item;
      option.textContent = item;
      selectEl.appendChild(option);
    }
    selectEl.value = value && items.includes(value) ? value : '';
  }

  function setBusinessOptions(options, selectedValue) {
    const items = Array.isArray(options) ? options.filter((item) => item && item.value) : [];
    businessNameInput.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '请选择商务';
    empty.disabled = true;
    empty.hidden = true;
    businessNameInput.appendChild(empty);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = String(item.value);
      option.textContent = String(item.label || item.value);
      businessNameInput.appendChild(option);
    }
    const values = items.map((item) => String(item.value));
    businessNameInput.value = selectedValue && values.includes(selectedValue) ? selectedValue : '';
  }

  function applyBusinessProjects(selectedProject) {
    const businessCode = businessNameInput.value || '';
    const projects = Array.isArray(projectsByBusiness[businessCode]) ? projectsByBusiness[businessCode] : [];
    setSelectOptions(projectNameInput, projects, businessCode ? '请选择项目' : '请先选择商务', selectedProject);
    projectNameInput.disabled = !businessCode;
  }

  async function loadOptions(selectedProject, selectedBuyer, selectedBusiness) {
    let loadFailed = false;
    try {
      updateStatus('插件加载中...', 'collecting');
      collectBtn.disabled = true;
      const response = await fetch(getOptionsEndpoint(), { method: 'GET' });
      if (!response.ok) {
        loadFailed = true;
        updateStatus('配置表读取失败', 'error', '配置表读取失败: HTTP ' + response.status);
        addLog('配置表读取失败: ' + response.status, 'error');
        return;
      }
      const data = await response.json();
      const projects = data && Array.isArray(data.projects) ? data.projects : [];
      const buyers = data && Array.isArray(data.buyers) ? data.buyers : [];
      const businesses = data && Array.isArray(data.businesses) ? data.businesses : [];
      projectsByBusiness = data && data.projects_by_business && typeof data.projects_by_business === 'object'
        ? data.projects_by_business
        : {};
      setBusinessOptions(businesses, selectedBusiness);
      applyBusinessProjects(selectedProject);
      setSelectOptions(buyerNameInput, buyers, '请选择投手', selectedBuyer);
      const selectedProjects = Array.isArray(projectsByBusiness[businessNameInput.value])
        ? projectsByBusiness[businessNameInput.value]
        : [];
      if (selectedProject && !selectedProjects.includes(selectedProject)) projectNameInput.value = '';
      if (selectedBuyer && !buyers.includes(selectedBuyer)) buyerNameInput.value = '';
      chrome.storage.local.set({
        optionsCache: {
          date: getTodayDateString(),
          projects,
          buyers,
          businesses,
          projectsByBusiness
        }
      });
      saveSettings();
    } catch (e) {
      loadFailed = true;
      const message = e && e.message ? e.message : String(e);
      updateStatus('配置表读取失败', 'error', '配置表读取失败: ' + message);
      addLog('配置表读取失败: ' + message, 'error');
    } finally {
      if (!loadFailed) updateStatus('等待采集...', 'idle');
      if (statusState.type !== 'success' && statusState.type !== 'error') collectBtn.disabled = false;
    }
  }

  function persistUIState() {
    chrome.storage.local.set({
      uiState: {
        status: statusState,
        logs: logEntries,
        statusHistory: statusHistoryEntries,
        lastConsumedUploadResultAt,
        logVisible: logEl.style.display !== 'none',
        statusNote: statusNoteEl ? statusNoteEl.textContent : '',
        statusNoteType: statusNoteEl && statusNoteEl.classList.contains('error') ? 'error' :
          statusNoteEl && statusNoteEl.classList.contains('success') ? 'success' : ''
      }
    });
  }

  function loadSettings() {
    chrome.storage.local.get(['businessName', 'projectName', 'buyerName', 'uploadMode', 'uiState', 'optionsCache'], function(result) {
      const savedBusiness = result.businessName || '';
      const savedProject = result.projectName || '';
      const savedBuyer = result.buyerName || '';
      const savedUploadMode = result.uploadMode || '消耗';
      if (savedProject) projectNameInput.value = savedProject;
      if (savedBuyer) buyerNameInput.value = savedBuyer;
      if (uploadModeInput) uploadModeInput.value = savedUploadMode;
      if (result.uiState) {
        const uiState = result.uiState;
        if (Array.isArray(uiState.logs)) {
          logEntries = uiState.logs;
        }
        if (Array.isArray(uiState.statusHistory)) {
          statusHistoryEntries = uiState.statusHistory;
        }
        if (typeof uiState.lastConsumedUploadResultAt === 'number') {
          lastConsumedUploadResultAt = uiState.lastConsumedUploadResultAt;
        }
        if (statusNoteEl && typeof uiState.statusNote === 'string') {
          statusNoteEl.textContent = uiState.statusNote;
          statusNoteEl.title = uiState.statusNote ? '点击查看历史记录' : '';
          statusNoteEl.className = 'status-note' + (uiState.statusNoteType ? ' ' + uiState.statusNoteType : '');
        }
        renderStatusHistory();
        if (typeof uiState.logVisible === 'boolean') {
          logEl.style.display = uiState.logVisible ? 'block' : 'none';
        } else {
          logEl.style.display = 'none';
        }
      }
      updateStatus(defaultCollectText, 'idle', null, false);
      collectBtn.disabled = false;
      const optionsCache = result.optionsCache;
      const cacheProjects = optionsCache && Array.isArray(optionsCache.projects) ? optionsCache.projects : null;
      const cacheBuyers = optionsCache && Array.isArray(optionsCache.buyers) ? optionsCache.buyers : null;
      const cacheBusinesses = optionsCache && Array.isArray(optionsCache.businesses) ? optionsCache.businesses : null;
      const cacheProjectsByBusiness = optionsCache && optionsCache.projectsByBusiness && typeof optionsCache.projectsByBusiness === 'object'
        ? optionsCache.projectsByBusiness
        : null;
      const isTodayCache = optionsCache && optionsCache.date === getTodayDateString();
      if (isTodayCache && cacheProjects && cacheBuyers && cacheBusinesses && cacheProjectsByBusiness) {
        projectsByBusiness = cacheProjectsByBusiness;
        setBusinessOptions(cacheBusinesses, savedBusiness);
        applyBusinessProjects(savedProject);
        setSelectOptions(buyerNameInput, cacheBuyers, '请选择投手', savedBuyer);
        const selectedProjects = Array.isArray(projectsByBusiness[businessNameInput.value])
          ? projectsByBusiness[businessNameInput.value]
          : [];
        if (savedProject && !selectedProjects.includes(savedProject)) projectNameInput.value = '';
        if (savedBuyer && !cacheBuyers.includes(savedBuyer)) buyerNameInput.value = '';
        saveSettings();
      } else {
        loadOptions(savedProject, savedBuyer, savedBusiness);
      }
      configureUploadModeForActiveTab();
    });
  }

  function configureUploadModeForActiveTab() {
    if (!uploadModeInput) return;
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      const isGoogleAds = Boolean(tab && /^https:\/\/ads\.google\.com\/aw\//i.test(tab.url || ''));
      const refluxOption = Array.from(uploadModeInput.options).find((option) => option.value === '回流');
      if (refluxOption) {
        refluxOption.hidden = isGoogleAds;
        refluxOption.disabled = isGoogleAds;
      }
      uploadModeInput.disabled = isGoogleAds;
      if (isGoogleAds) {
        uploadModeInput.value = '消耗';
        saveSettings();
      }
    });
  }

  function saveSettings() {
    chrome.storage.local.set({
      businessName: businessNameInput ? businessNameInput.value : '',
      projectName: projectNameInput.value,
      buyerName: buyerNameInput.value,
      uploadMode: uploadModeInput ? uploadModeInput.value : '消耗'
    });
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: false, error: 'background timeout' });
      }, 8000);
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: 'empty response' });
      });
    });
  }

  function findAndClickRefreshButton(tabId, callback) {
    chrome.tabs.sendMessage(tabId, { action: 'clickRefresh' }, function(response) {
      if (chrome.runtime.lastError) {
        callback(false, chrome.runtime.lastError.message);
      } else {
        callback(response && response.success, response && response.error, response || null);
      }
    });
  }

  function ensureContentScript(tabId) {
    return new Promise((resolve) => {
      try {
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  function applyUploadTaskResult(result) {
    if (!result || !result.type) return;
    if (result.at && typeof result.at === 'number') {
      lastConsumedUploadResultAt = result.at;
    }
    if (result.type === 'success') {
      updateStatus('上传成功!', 'success', result.message || '上传成功');
      return;
    }
    updateStatus('上传失败', 'error', result.message || '上传失败');
  }

  async function pollUploadTaskResult(maxRound = 30) {
    for (let i = 0; i < maxRound; i++) {
      const stateResp = await sendToBackground({ action: 'getUploadTaskState' });
      if (stateResp && stateResp.success) {
        if (stateResp.result && !stateResp.running) {
          applyUploadTaskResult(stateResp.result);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  async function syncUploadTaskStateFromBackground() {
    const stateResp = await sendToBackground({ action: 'getUploadTaskState' });
    if (!stateResp || !stateResp.success) return;
    if (stateResp.running) {
      updateStatus('正在后台上传数据...', 'collecting', null, false);
      collectBtn.disabled = true;
      await pollUploadTaskResult(120);
      return;
    }
    if (stateResp.result && stateResp.result.at && stateResp.result.at !== lastConsumedUploadResultAt) {
      setStatusNote(stateResp.result.message || (stateResp.result.type === 'success' ? '上传成功' : '上传失败'), stateResp.result.type, true);
      lastConsumedUploadResultAt = stateResp.result.at;
      persistUIState();
      sendToBackground({ action: 'clearUploadTaskResult' });
    }
    updateStatus(defaultCollectText, 'idle', null, false);
    collectBtn.disabled = false;
  }

  collectBtn.addEventListener('click', async function() {
    const businessName = businessNameInput ? businessNameInput.value.trim() : '';
    const projectName = projectNameInput.value.trim();
    const buyerName = buyerNameInput.value.trim();
    const uploadMode = uploadModeInput ? String(uploadModeInput.value || '消耗').trim() : '消耗';
    if (!validateSelections(projectName, buyerName, businessName)) return;

    saveSettings();

    updateStatus('正在采集数据...', 'collecting');
    collectBtn.disabled = true;
    addLog('开始采集广告数据...');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const isGoogleAds = Boolean(tab && /^https:\/\/ads\.google\.com\/aw\//i.test(tab.url || ''));
      addLog('标签页 ID: ' + tab.id);
      if (tab && tab.url) addLog('标签页 URL: ' + tab.url);

      const ping = await sendToBackground({ action: 'ping' });
      if (!ping || !ping.success) {
        addLog('后台未响应，尝试继续启动采集', 'error');
      }

      const startResp = await sendToBackground({ action: 'startCollection', tabId: tab.id });
      if (!startResp || !startResp.success) {
        updateStatus('采集启动失败', 'error', '采集启动失败: ' + ((startResp && startResp.error) || 'unknown'));
        addLog('采集启动失败: ' + ((startResp && startResp.error) || 'unknown'), 'error');
        if (startResp && startResp.error === 'background timeout') {
          addLog('后台未响应，正在重新加载扩展，请重新打开弹窗再试', 'error');
          chrome.runtime.reload();
        }
        if (statusState.type !== 'success' && statusState.type !== 'error') collectBtn.disabled = false;
        return;
      }

      addLog('点击刷新按钮...');
      let ready = false;
      for (let i = 0; i < 12; i++) {
        const statusResp = await sendToBackground({ action: 'getStatus' });
        if (statusResp && statusResp.ready) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) {
        addLog('采集尚未完全就绪，继续尝试刷新', 'error');
      }

      const proceedAfterRefresh = async function() {
        addLog(isGoogleAds ? '等待 Google Ads 报表刷新并校验数据...' : '等待 5 秒采集数据...');
        updateStatus('正在后台上传数据...', 'collecting');
        const triggerResp = await sendToBackground({
          action: 'finalizeCollectionUpload',
          project_name: projectName || '',
          buyer_name: buyerName || '',
          upload_mode: uploadMode || '消耗',
          api_endpoint: apiEndpoint
        });
        if (!triggerResp || !triggerResp.success) {
          updateStatus('上传失败', 'error', '上传失败: ' + ((triggerResp && triggerResp.error) || 'unknown'));
          return;
        }
        await pollUploadTaskResult();
      };

      const stopAfterRefreshFailure = async function(error) {
        const message = '刷新失败，已停止采集，本次未上传: ' + (error || 'unknown');
        addLog(message, 'error');
        updateStatus('采集已停止', 'error', message);
        await sendToBackground({ action: 'stopCollection' });
      };

      findAndClickRefreshButton(tab.id, async function(success, error, refreshResult) {
        if (success) {
          addLog(refreshResult && refreshResult.click_count === 2
            ? 'Google Ads 第一次刷新后报表不可读取，已自动补点第 2 次'
            : isGoogleAds ? 'Google Ads 刷新 1 次后报表已可读取' : '刷新按钮已点击');
          proceedAfterRefresh();
          return;
        }

        const errText = String(error || '');
        if (errText.includes('Receiving end does not exist')) {
          addLog('点击刷新按钮失败: ' + error, 'error');
          addLog('检测到内容脚本未连接，尝试注入...', 'error');
          const injected = await ensureContentScript(tab.id);
          if (injected) {
            addLog('内容脚本已注入，重试点击刷新...');
            findAndClickRefreshButton(tab.id, async function(success2, error2, refreshResult2) {
              if (success2) {
                addLog(refreshResult2 && refreshResult2.click_count === 2
                  ? 'Google Ads 第一次刷新后报表不可读取，已自动补点第 2 次'
                  : isGoogleAds ? 'Google Ads 刷新 1 次后报表已可读取' : '刷新按钮已点击');
                proceedAfterRefresh();
              } else {
                addLog('点击刷新按钮失败: ' + (error2 || 'unknown'), 'error');
                await stopAfterRefreshFailure(error2);
              }
            });
          } else {
            addLog('注入失败：请重新加载插件并刷新 Ads Manager 页面', 'error');
            await stopAfterRefreshFailure('内容脚本注入失败');
          }
          return;
        }

        addLog('点击刷新按钮失败: ' + error, 'error');
        await stopAfterRefreshFailure(error);
      });

    } catch (error) {
      updateStatus('发生错误', 'error', '采集失败: ' + error.message);
      addLog('错误: ' + error.message, 'error');
      await sendToBackground({ action: 'stopCollection' });
      if (statusState.type !== 'success' && statusState.type !== 'error') collectBtn.disabled = false;
    }
  });

  if (projectNameInput) {
    projectNameInput.addEventListener('change', saveSettings);
  }
  if (businessNameInput) {
    businessNameInput.addEventListener('change', function() {
      applyBusinessProjects('');
      saveSettings();
    });
  }
  if (buyerNameInput) {
    buyerNameInput.addEventListener('change', saveSettings);
  }
  if (uploadModeInput) {
    uploadModeInput.addEventListener('change', saveSettings);
  }
  if (refreshOptionsBtn) {
    refreshOptionsBtn.addEventListener('click', function() {
      const selectedProject = projectNameInput.value || '';
      const selectedBuyer = buyerNameInput.value || '';
      const selectedBusiness = businessNameInput ? businessNameInput.value || '' : '';
      addLog('手动刷新下拉选项...');
      loadOptions(selectedProject, selectedBuyer, selectedBusiness);
    });
  }
  if (statusNoteEl && logEl) {
    statusNoteEl.addEventListener('click', function() {
      if (!statusNoteEl.textContent) return;
      const isVisible = logEl.style.display !== 'none';
      logEl.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) {
        renderStatusHistory();
      }
      persistUIState();
    });
  }
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', function() {
      statusHistoryEntries = [];
      renderStatusHistory();
      persistUIState();
    });
  }
  logEl.style.display = 'none';

  loadSettings();
  syncUploadTaskStateFromBackground();
  addLog('插件已就绪，请在广告平台报表页面使用', 'info', false);
})();
