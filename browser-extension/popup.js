const MAX_TEXT_CHARS = 12000;

const state = {
    context: null,
    sullyCharacters: []
};

const readBtn = document.getElementById('readBtn');
const copyBtn = document.getElementById('copyBtn');
const sendBtn = document.getElementById('sendBtn');
const pageTitle = document.getElementById('pageTitle');
const pageUrl = document.getElementById('pageUrl');
const statusEl = document.getElementById('status');
const pageText = document.getElementById('pageText');
const targetModeInput = document.getElementById('targetModeInput');
const appUrlInput = document.getElementById('appUrlInput');
const sullyCharacterInput = document.getElementById('sullyCharacterInput');
const refreshCharactersBtn = document.getElementById('refreshCharactersBtn');

function setStatus(message, kind = '') {
    statusEl.textContent = message;
    statusEl.classList.toggle('is-error', kind === 'error');
    statusEl.classList.toggle('is-ok', kind === 'ok');
}

async function rememberDeliveryStatus(message, kind = '') {
    try {
        await chrome.storage.local.set({
            lastDeliveryStatus: {
                message,
                kind,
                at: Date.now()
            }
        });
    } catch {}
}

async function showRecentDeliveryStatus() {
    try {
        const { lastDeliveryStatus } = await chrome.storage.local.get({ lastDeliveryStatus: null });
        if (!lastDeliveryStatus) return;
        if (Date.now() - lastDeliveryStatus.at > 10 * 60 * 1000) return;
        const prefix = lastDeliveryStatus.kind === 'error' ? '上次发送失败' : '上次发送结果';
        setStatus(`${prefix}：${lastDeliveryStatus.message}`, lastDeliveryStatus.kind);
    } catch {}
}

function formatContextForClipboard(context) {
    return [
        `标题：${context.title || '无标题'}`,
        `链接：${context.url || ''}`,
        '',
        '正文：',
        context.text || ''
    ].join('\n');
}

function renderContext(context) {
    state.context = context;
    pageTitle.textContent = context.title || '无标题';
    pageUrl.textContent = context.url || '';
    pageText.value = context.text || '';
    const shownCount = (context.text || '').length;
    const originalCount = context.originalCharCount || shownCount;
    const suffix = originalCount > shownCount ? `，已截取前 ${shownCount} 字` : '';
    setStatus(`已读取 ${originalCount} 字${suffix}`, 'ok');
}

function extractCurrentPageText(maxChars) {
    const removedSelector = [
        'script',
        'style',
        'noscript',
        'svg',
        'canvas',
        'iframe',
        'nav',
        'header',
        'footer',
        'aside',
        'form',
        'button',
        'input',
        'textarea',
        'select',
        '[aria-hidden="true"]'
    ].join(',');

    const contentSelectors = [
        'article',
        'main',
        '[role="main"]',
        '.RichContent-inner',
        '.Post-RichText',
        '.QuestionRichText',
        '.note-content',
        '.note-text',
        '.desc',
        '.content',
        '.markdown-body'
    ];

    function normalizeText(text) {
        const lines = String(text || '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);

        const seenShortLines = new Map();
        const output = [];
        for (const line of lines) {
            const key = line.replace(/\s+/g, ' ');
            if (key.length < 120) {
                const count = seenShortLines.get(key) || 0;
                if (count >= 2) continue;
                seenShortLines.set(key, count + 1);
            }
            output.push(line);
        }
        return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function textFromElement(element) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        clone.querySelectorAll(removedSelector).forEach(node => node.remove());
        return normalizeText(clone.textContent || '');
    }

    const selectionText = normalizeText(window.getSelection ? window.getSelection().toString() : '');
    const candidates = [];

    contentSelectors.forEach((selector, index) => {
        document.querySelectorAll(selector).forEach(element => {
            const text = textFromElement(element);
            if (text.length < 80) return;
            candidates.push({
                text,
                score: text.length + (contentSelectors.length - index) * 300
            });
        });
    });

    const bodyText = normalizeText(document.body ? document.body.innerText || document.body.textContent || '' : '');
    const bestCandidate = candidates.sort((a, b) => b.score - a.score)[0];
    let text = bodyText;

    if (selectionText.length >= 80) {
        text = selectionText;
    } else if (bestCandidate && bestCandidate.text.length >= Math.min(600, bodyText.length * 0.35)) {
        text = bestCandidate.text;
    }

    return {
        title: document.title || '',
        url: location.href,
        text: text.slice(0, maxChars),
        originalCharCount: text.length,
        selectedCharCount: selectionText.length,
        source: 'browser_extension',
        createdAt: new Date().toISOString()
    };
}

async function readCurrentTab() {
    setStatus('正在读取当前页面...');
    readBtn.disabled = true;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
            throw new Error('没有找到当前标签页');
        }
        if (/^(chrome|edge|about):/i.test(tab.url || '')) {
            throw new Error('浏览器内部页面不能读取，请切到普通网页');
        }

        const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractCurrentPageText,
            args: [MAX_TEXT_CHARS]
        });

        const context = result && result.result;
        if (!context || !context.text) {
            throw new Error('没有读到正文，可能页面文字尚未加载');
        }
        renderContext(context);
    } catch (error) {
        setStatus(error.message || String(error), 'error');
    } finally {
        readBtn.disabled = false;
    }
}

async function copyContext() {
    if (!state.context) {
        await readCurrentTab();
    }
    if (!state.context) return;
    await navigator.clipboard.writeText(formatContextForClipboard(state.context));
    setStatus('已复制到剪贴板', 'ok');
}

function buildWhaleUrl(appUrl, context) {
    const cleanAppUrl = normalizeAppUrl(appUrl).split('#')[0];
    const payload = {
        title: context.title || '',
        url: context.url || '',
        text: context.text || '',
        source: 'browser_extension',
        createdAt: context.createdAt || new Date().toISOString()
    };
    return `${cleanAppUrl}#whaleSharedWebContext=${encodeURIComponent(JSON.stringify(payload))}`;
}

function normalizeAppUrl(appUrl) {
    const value = String(appUrl || '').trim();
    if (/^[a-z]:[\\/]/i.test(value)) {
        return `file:///${value.replace(/\\/g, '/')}`;
    }
    if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value)) {
        return `http://${value}`;
    }
    return value;
}

function getOriginPermissionPattern(appUrl) {
    const normalized = normalizeAppUrl(appUrl);
    let url;
    try {
        url = new URL(normalized);
    } catch {
        return '';
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
        return `${url.protocol}//${url.hostname}/*`;
    }
    if (url.protocol === 'file:') {
        return 'file:///*';
    }
    return '';
}

function getAppTabQueryPattern(appUrl) {
    const normalized = normalizeAppUrl(appUrl);
    let url;
    try {
        url = new URL(normalized);
    } catch {
        return '';
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
        const basePath = url.pathname.endsWith('/')
            ? url.pathname
            : url.pathname.replace(/\/[^/]*$/, '/');
        return `${url.protocol}//${url.hostname}${basePath || '/'}*`;
    }
    return '';
}

async function ensureHostPermission(appUrl) {
    const pattern = getOriginPermissionPattern(appUrl);
    if (!pattern) {
        throw new Error('SullyOS 地址需要是 http(s) 或 file 地址。');
    }

    const hasPermission = await chrome.permissions.contains({ origins: [pattern] });
    if (hasPermission) return;

    let granted = false;
    try {
        granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (error) {
        throw new Error(`请求 SullyOS 页面访问权限失败：${error.message || error}`);
    }

    if (!granted) {
        throw new Error('需要允许扩展访问 SullyOS 页面，才能把网页卡片写入聊天。');
    }
}

function waitForTabComplete(tabId, timeoutMs = 12000) {
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }, timeoutMs);

        function listener(updatedTabId, changeInfo) {
            if (updatedTabId !== tabId) return;
            if (changeInfo.status !== 'complete') return;
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }

        chrome.tabs.onUpdated.addListener(listener);
    });
}

async function findExistingAppTab(appUrl) {
    const pattern = getAppTabQueryPattern(appUrl);
    if (!pattern) return null;
    try {
        const tabs = await chrome.tabs.query({ url: pattern });
        return tabs.find(tab => tab.id) || null;
    } catch {
        return null;
    }
}

async function openAppTab(appUrl) {
    const existingTab = await findExistingAppTab(appUrl);
    if (existingTab && existingTab.id) {
        if (existingTab.status !== 'complete') {
            await waitForTabComplete(existingTab.id);
        }
        return existingTab;
    }

    const tab = await chrome.tabs.create({ url: normalizeAppUrl(appUrl), active: false });
    if (!tab || !tab.id) {
        throw new Error('没有打开目标应用标签页。');
    }
    await waitForTabComplete(tab.id);
    return tab;
}

async function focusTab(tab) {
    if (!tab || !tab.id) return;
    try {
        if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
        await chrome.tabs.update(tab.id, { active: true });
    } catch {}
}

async function readSullyOSCharactersFromPage() {
    const DB_NAME = 'AetherOS_Data';
    const asText = value => String(value || '').trim();

    function openExistingDb() {
        return new Promise((resolve, reject) => {
            let createdDuringOpen = false;
            const request = indexedDB.open(DB_NAME);
            request.onupgradeneeded = () => {
                createdDuringOpen = true;
                try {
                    request.transaction && request.transaction.abort();
                } catch {}
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                if (createdDuringOpen) {
                    reject(new Error('SullyOS 数据库还没有初始化，请先打开一次 SullyOS。'));
                    return;
                }
                reject(request.error || new Error('无法打开 SullyOS 数据库。'));
            };
            request.onblocked = () => reject(new Error('SullyOS 数据库正在升级，请稍后再试。'));
        });
    }

    function getAll(db, storeName) {
        return new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains(storeName)) {
                reject(new Error(`SullyOS 数据库缺少 ${storeName} 数据表。`));
                return;
            }
            const tx = db.transaction(storeName, 'readonly');
            const request = tx.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error(`读取 ${storeName} 失败。`));
        });
    }

    function pickVisibleCharacter(characters) {
        const visibleLines = String(document.body?.innerText || '')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 80);
        const ignored = new Set(['ONLINE', 'Message...', 'Tap to Unlock', 'SullyOS Simulation']);

        for (const char of characters) {
            const name = asText(char?.name);
            if (!name || ignored.has(name)) continue;
            if (visibleLines.includes(name)) return char;
        }
        return null;
    }

    const db = await openExistingDb();
    try {
        const characters = await getAll(db, 'characters');
        const visibleChar = pickVisibleCharacter(characters);
        const lastActiveId = asText(localStorage.getItem('os_last_active_char_id'));
        return {
            ok: true,
            currentCharId: asText(visibleChar?.id) || lastActiveId,
            characters: characters
                .map((char, index) => ({
                    id: asText(char?.id),
                    name: asText(char?.name) || `角色 ${index + 1}`
                }))
                .filter(char => char.id)
        };
    } finally {
        try { db.close(); } catch {}
    }
}

function normalizeSullyCharacters(characters) {
    const seen = new Set();
    return (Array.isArray(characters) ? characters : [])
        .map(char => ({
            id: String(char?.id || '').trim(),
            name: String(char?.name || '').trim() || '未命名角色'
        }))
        .filter(char => {
            if (!char.id || seen.has(char.id)) return false;
            seen.add(char.id);
            return true;
        });
}

function populateSullyCharacters(characters, selectedId = '') {
    state.sullyCharacters = normalizeSullyCharacters(characters);
    sullyCharacterInput.replaceChildren();

    const autoOption = new Option('自动选择当前/最近角色', '');
    sullyCharacterInput.append(autoOption);

    for (const char of state.sullyCharacters) {
        const option = new Option(char.name, char.id);
        option.dataset.name = char.name;
        sullyCharacterInput.append(option);
    }

    const hasSelected = state.sullyCharacters.some(char => char.id === selectedId);
    sullyCharacterInput.value = hasSelected ? selectedId : '';
}

function getSelectedSullyCharacter() {
    const id = String(sullyCharacterInput.value || '').trim();
    if (!id) return null;
    const selected = state.sullyCharacters.find(char => char.id === id);
    const selectedOption = sullyCharacterInput.options[sullyCharacterInput.selectedIndex];
    return {
        id,
        name: selected?.name || selectedOption?.dataset?.name || selectedOption?.textContent || ''
    };
}

async function refreshSullyOSCharacters() {
    const appUrl = appUrlInput.value.trim();
    if (!appUrl) {
        setStatus('先填写 SullyOS 网页地址。', 'error');
        appUrlInput.focus();
        return;
    }

    refreshCharactersBtn.disabled = true;
    setStatus('正在读取 SullyOS 角色列表...');
    try {
        await ensureHostPermission(appUrl);
        const tab = await openAppTab(appUrl);
        const previousId = sullyCharacterInput.value;
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: readSullyOSCharactersFromPage
        });

        const payload = result && result.result;
        if (!payload || !payload.ok) {
            throw new Error('SullyOS 没有返回角色列表。');
        }

        const selectedId = previousId || payload.currentCharId || '';
        const characters = normalizeSullyCharacters(payload.characters);
        populateSullyCharacters(characters, selectedId);
        await chrome.storage.local.set({
            sullyOSCharacters: characters,
            sullyOSCharactersAppUrl: normalizeAppUrl(appUrl)
        });
        await chrome.storage.sync.set({ sullyOSCharacterId: sullyCharacterInput.value });
        setStatus(`已读取 ${characters.length} 个 SullyOS 角色`, 'ok');
    } catch (error) {
        setStatus(error.message || String(error), 'error');
    } finally {
        refreshCharactersBtn.disabled = false;
    }
}

async function deliverContextToSullyOS(context, targetCharacter = null) {
    const DB_NAME = 'AetherOS_Data';
    const TRANSPARENT_AVATAR = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const asText = value => String(value || '').trim();
    const clamp = (value, max) => asText(value).slice(0, max);
    const requestedCharacterId = asText(targetCharacter?.id);
    const requestedCharacterName = asText(targetCharacter?.name);

    function makeNoRetryError(message) {
        const error = new Error(message);
        error.noRetry = true;
        return error;
    }

    function openExistingDb() {
        return new Promise((resolve, reject) => {
            let createdDuringOpen = false;
            const request = indexedDB.open(DB_NAME);
            request.onupgradeneeded = () => {
                createdDuringOpen = true;
                try {
                    request.transaction && request.transaction.abort();
                } catch {}
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                if (createdDuringOpen) {
                    reject(new Error('SullyOS 数据库还没有初始化，请先打开一次 SullyOS。'));
                    return;
                }
                reject(request.error || new Error('无法打开 SullyOS 数据库。'));
            };
            request.onblocked = () => reject(new Error('SullyOS 数据库正在升级，请稍后再试。'));
        });
    }

    function getAll(db, storeName) {
        return new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains(storeName)) {
                reject(new Error(`SullyOS 数据库缺少 ${storeName} 数据表。`));
                return;
            }
            const tx = db.transaction(storeName, 'readonly');
            const request = tx.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error(`读取 ${storeName} 失败。`));
        });
    }

    function addMessage(db, message) {
        return new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains('messages')) {
                reject(new Error('SullyOS 数据库缺少 messages 数据表。'));
                return;
            }
            const tx = db.transaction('messages', 'readwrite');
            const request = tx.objectStore('messages').add(message);
            let messageId = null;
            request.onsuccess = () => { messageId = request.result; };
            request.onerror = () => reject(request.error || new Error('写入 SullyOS 聊天失败。'));
            tx.oncomplete = () => resolve(messageId);
            tx.onerror = () => reject(tx.error || new Error('写入 SullyOS 聊天失败。'));
        });
    }

    function countMessagesForChar(db, charId) {
        return new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains('messages')) {
                reject(new Error('SullyOS 数据库缺少 messages 数据表。'));
                return;
            }
            const tx = db.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            if (!store.indexNames.contains('charId')) {
                const request = store.getAll();
                request.onsuccess = () => {
                    const all = request.result || [];
                    resolve(all.filter(message => message?.charId === charId && !message?.groupId).length);
                };
                request.onerror = () => reject(request.error || new Error('读取 SullyOS 消息失败。'));
                return;
            }
            const request = store.index('charId').count(IDBKeyRange.only(charId));
            request.onsuccess = () => resolve(request.result || 0);
            request.onerror = () => reject(request.error || new Error('读取 SullyOS 消息数量失败。'));
        });
    }

    function getMessageById(db, messageId) {
        return new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains('messages')) {
                reject(new Error('SullyOS 数据库缺少 messages 数据表。'));
                return;
            }
            const tx = db.transaction('messages', 'readonly');
            const request = tx.objectStore('messages').get(messageId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('校验 SullyOS 消息失败。'));
        });
    }

    function pickVisibleCharacter(characters) {
        const visibleLines = String(document.body?.innerText || '')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 80);
        const ignored = new Set(['ONLINE', 'Message...', 'Tap to Unlock', 'SullyOS Simulation']);
        let best = null;
        let bestIndex = Number.POSITIVE_INFINITY;

        for (const char of characters) {
            const name = asText(char?.name);
            if (!name || ignored.has(name)) continue;
            const index = visibleLines.findIndex(line => line === name);
            if (index >= 0 && index < bestIndex) {
                best = char;
                bestIndex = index;
            }
        }

        return best;
    }

    function pickCharacter(characters) {
        if (requestedCharacterId) {
            const selectedChar = characters.find(char => asText(char?.id) === requestedCharacterId);
            if (selectedChar) return selectedChar;
            const nameHint = requestedCharacterName ? `「${requestedCharacterName}」` : requestedCharacterId;
            throw makeNoRetryError(`没有找到选中的 SullyOS 角色 ${nameHint}，请刷新角色列表后重试。`);
        }

        const visibleChar = pickVisibleCharacter(characters);
        if (visibleChar) return visibleChar;
        const lastActiveId = asText(localStorage.getItem('os_last_active_char_id'));
        return characters.find(char => char && asText(char.id) === lastActiveId) || characters[0] || null;
    }

    function pasteIntoVisibleInput() {
        const textarea =
            document.querySelector('textarea[placeholder="Message..."]') ||
            document.querySelector('textarea');
        if (!textarea) return null;

        const value = [
            asText(context.url),
            context.title ? `标题：${asText(context.title)}` : '',
            '',
            '正文：',
            asText(context.text)
        ].filter((line, index) => index >= 2 || line).join('\n');

        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(textarea, value);
        else textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        return { mode: 'input', message: '已填入 SullyOS 输入框，请手动发送。' };
    }

    async function writeCardMessage() {
        const db = await openExistingDb();
        try {
            const characters = await getAll(db, 'characters');
            const char = pickCharacter(characters);
            if (!char || !char.id) {
                throw new Error('没有找到 SullyOS 角色，请先打开一次聊天。');
            }
            const beforeCount = await countMessagesForChar(db, char.id).catch(() => null);

            const now = Date.now();
            const title = clamp(context.title, 160);
            const url = clamp(context.url, 1000);
            const text = clamp(context.text, 12000);
            const displayTitle = title || url || '网页分享';
            const postContent = [
                url ? `链接：${url}` : '',
                text
            ].filter(Boolean).join('\n\n');

            const message = {
                charId: char.id,
                role: 'user',
                type: 'social_card',
                content: url || displayTitle,
                timestamp: now,
                metadata: {
                    post: {
                        id: `shared-web-${now}`,
                        title: displayTitle,
                        content: postContent || displayTitle,
                        authorName: '网页',
                        authorAvatar: TRANSPARENT_AVATAR,
                        images: ['1f4c4'],
                        bgStyle: 'linear-gradient(135deg, #e0f2fe 0%, #f8fafc 100%)',
                        url,
                        source: 'browser_extension',
                        createdAt: context.createdAt || new Date(now).toISOString()
                    },
                    webPageContext: {
                        title,
                        url,
                        text,
                        source: 'browser_extension',
                        createdAt: context.createdAt || new Date(now).toISOString()
                    }
                }
            };

            const messageId = await addMessage(db, message);
            const savedMessage = await getMessageById(db, messageId).catch(() => null);
            const afterCount = await countMessagesForChar(db, char.id).catch(() => null);
            if (!savedMessage) {
                throw new Error(`SullyOS 写入后没有读回消息 id=${messageId}。`);
            }
            console.info('[Whale Reader] SullyOS card written', {
                messageId,
                charId: char.id,
                charName: char.name || '当前角色',
                title: displayTitle,
                beforeCount,
                afterCount
            });
            try {
                localStorage.setItem('os_last_active_char_id', char.id);
            } catch {}
            try {
                window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId: char.id } }));
            } catch {}
            await sleep(120);
            try {
                window.dispatchEvent(new CustomEvent('active-msg-received', {
                    detail: {
                        charId: char.id,
                        charName: char.name || 'SullyOS',
                        body: url || displayTitle
                    }
                }));
            } catch {}

            return {
                mode: 'card',
                messageId,
                charId: char.id,
                charName: char.name || '当前角色',
                beforeCount,
                afterCount
            };
        } finally {
            try { db.close(); } catch {}
        }
    }

    let lastError = null;
    for (let i = 0; i < 12; i += 1) {
        try {
            const result = await writeCardMessage();
            return { ok: true, ...result };
        } catch (error) {
            if (error?.noRetry) throw error;
            lastError = error;
            await sleep(500);
        }
    }

    if (requestedCharacterId) {
        throw lastError || new Error('写入选中的 SullyOS 角色失败。');
    }

    const pasted = pasteIntoVisibleInput();
    if (pasted) return { ok: true, ...pasted };

    throw lastError || new Error('写入 SullyOS 失败。');
}

async function sendToWhale() {
    if (!state.context) {
        await readCurrentTab();
    }
    if (!state.context) return;

    const appUrl = appUrlInput.value.trim();
    if (!appUrl) {
        setStatus('先填写 Whale 网页版地址，或直接复制后粘贴。', 'error');
        appUrlInput.focus();
        return;
    }

    await chrome.storage.sync.set({ whaleAppUrl: appUrl });
    await chrome.tabs.create({ url: buildWhaleUrl(appUrl, state.context) });
    setStatus('已打开 Whale，选择角色后发送即可。', 'ok');
}

async function sendToSullyOS() {
    const appUrl = appUrlInput.value.trim();
    if (!appUrl) {
        setStatus('先填写 SullyOS 网页地址，或直接复制后粘贴。', 'error');
        appUrlInput.focus();
        return;
    }

    await ensureHostPermission(appUrl);

    if (!state.context) {
        await readCurrentTab();
    }
    if (!state.context) return;

    const targetCharacter = getSelectedSullyCharacter();
    await chrome.storage.sync.set({
        whaleAppUrl: appUrl,
        targetMode: 'sullyos',
        sullyOSCharacterId: targetCharacter?.id || ''
    });
    const tab = await openAppTab(appUrl);

    const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: deliverContextToSullyOS,
        args: [state.context, targetCharacter]
    });

    const delivery = result && result.result;
    if (!delivery || !delivery.ok) {
        throw new Error('SullyOS 没有确认写入成功。');
    }

    if (delivery.mode === 'input') {
        await rememberDeliveryStatus(delivery.message, 'ok');
        await focusTab(tab);
        setStatus(delivery.message, 'ok');
        return;
    }

    const countText = typeof delivery.beforeCount === 'number' && typeof delivery.afterCount === 'number'
        ? `，消息数 ${delivery.beforeCount}→${delivery.afterCount}`
        : '';
    const message = `已写入 ${delivery.charName}，id=${delivery.messageId}${countText}。点 ⚡ 可触发回复。`;
    await rememberDeliveryStatus(message, 'ok');
    await focusTab(tab);
    setStatus(message, 'ok');
}

async function sendToTarget() {
    sendBtn.disabled = true;
    try {
        if (targetModeInput.value === 'sullyos') {
            await sendToSullyOS();
        } else {
            await sendToWhale();
        }
    } catch (error) {
        const message = error.message || String(error);
        await rememberDeliveryStatus(message, 'error');
        setStatus(message, 'error');
    } finally {
        sendBtn.disabled = false;
    }
}

function updateTargetUi() {
    const mode = targetModeInput.value;
    document.querySelectorAll('.sullyos-only').forEach(element => {
        element.hidden = mode !== 'sullyos';
    });

    if (mode === 'sullyos') {
        sendBtn.textContent = '发送到 SullyOS';
        appUrlInput.placeholder = '例如：http://localhost:5173/';
        return;
    }
    sendBtn.textContent = '发送到 Whale';
    appUrlInput.placeholder = '例如：http://localhost:8080/index.html';
}

async function restoreSettings() {
    const data = await chrome.storage.sync.get({
        whaleAppUrl: '',
        targetMode: 'whale',
        sullyOSCharacterId: ''
    });
    const localData = await chrome.storage.local.get({
        sullyOSCharacters: [],
        sullyOSCharactersAppUrl: ''
    });
    targetModeInput.value = data.targetMode || 'whale';
    appUrlInput.value = data.whaleAppUrl || '';
    const cachedCharacters = localData.sullyOSCharactersAppUrl === normalizeAppUrl(data.whaleAppUrl)
        ? localData.sullyOSCharacters
        : [];
    populateSullyCharacters(cachedCharacters, data.sullyOSCharacterId || '');
    updateTargetUi();
}

readBtn.addEventListener('click', readCurrentTab);
copyBtn.addEventListener('click', copyContext);
sendBtn.addEventListener('click', sendToTarget);
targetModeInput.addEventListener('change', () => {
    updateTargetUi();
    chrome.storage.sync.set({ targetMode: targetModeInput.value });
});
sullyCharacterInput.addEventListener('change', () => {
    chrome.storage.sync.set({ sullyOSCharacterId: sullyCharacterInput.value });
});
refreshCharactersBtn.addEventListener('click', refreshSullyOSCharacters);
appUrlInput.addEventListener('change', () => {
    chrome.storage.sync.set({ whaleAppUrl: appUrlInput.value.trim() });
});

restoreSettings().then(() => readCurrentTab()).then(showRecentDeliveryStatus);
