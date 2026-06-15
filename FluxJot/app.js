// OAuth2.0 PKCE 定数
// CLIENT_ID は WASM 初期化後に window.FLUXJOT_CLIENT_ID として提供される。
// ビルド時注入: GOOS=js GOARCH=wasm go build -ldflags "-X 'main.defaultClientID=<ID>'"
// 未注入（開発ビルド）の場合は空文字列となり、認証ボタンは機能しない。
// REDIRECT_URI: origin + pathname（末尾スラッシュ正規化）により GitHub Pages サブパスに対応する。
const REDIRECT_URI = window.location.origin +
  window.location.pathname.replace(/\/?$/, "/");
const SCOPES = "https://www.googleapis.com/auth/drive";
const TOKEN_KEY = "fluxjot_token";
const VERIFIER_KEY = "fluxjot_code_verifier";
const PENDING_TEXT_KEY = "fluxjot_pending_text";

// PKCE ヘルパー: ランダム文字列生成
function generateRandomString(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// PKCE ヘルパー: SHA-256 Base64URL ハッシュ
async function sha256Base64URL(str) {
  const buf = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// 認証開始: code_verifier を生成して sessionStorage に保存し、Google 認証画面へリダイレクト
async function startAuth() {
  const clientId = window.FLUXJOT_CLIENT_ID;
  if (!clientId) {
    console.error("FluxJot: CLIENT_ID が未設定です。WASM ビルド時に -ldflags で注入してください。");
    return;
  }
  const verifier = generateRandomString(64);
  const challenge = await sha256Base64URL(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  window.location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + params;
}

// WASM 変数が truthy になるまでポーリングして待機するヘルパー。
// handleOAuthCallback() はページロード直後（WASM 初期化前）に実行されるため、
// WASM が window に変数をセットするまで待つ必要がある。
function waitForWasmVar(name, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (window[name]) { resolve(window[name]); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      if (window[name]) {
        clearInterval(timer);
        resolve(window[name]);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(name + " was not set within " + timeoutMs + "ms"));
      }
    }, 50);
  });
}

// コールバック処理: URL の ?code= を受け取りトークンを取得して localStorage に保存
async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return false;

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) { console.error("code_verifier not found"); return false; }

  sessionStorage.removeItem(VERIFIER_KEY);
  // URL から code を除去
  window.history.replaceState({}, "", window.location.pathname);

  // FLUXJOT_TOKEN_PROXY_URL は WASM 初期化後にセットされるため、セットされるまで待機する
  let tokenProxyURL;
  try {
    tokenProxyURL = await waitForWasmVar("FLUXJOT_TOKEN_PROXY_URL");
  } catch (e) {
    console.error("FLUXJOT_TOKEN_PROXY_URL is not set");
    return false;
  }
  const resp = await fetch(tokenProxyURL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: window.FLUXJOT_CLIENT_ID || "",
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!resp.ok) { console.error("token exchange failed", await resp.text()); return false; }
  const data = await resp.json();
  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token || "",
    expiry,
  }));
  return true;
}

// 同期ステータスバーを更新する。
// state: "syncing" | "ok" | "error" | "unauthenticated"
// message: 表示するテキスト
// error 状態のときはクリックでメッセージを非表示にする。
function updateSyncStatus(state, message) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.className = `sync-${state}`;
  el.textContent = message;
  if (state === "error") {
    el.onclick = () => { el.textContent = ""; el.className = ""; };
  } else {
    el.onclick = null;
  }
}

// 認証状態に応じて UI を更新
function updateAuthUI() {
  const token = localStorage.getItem(TOKEN_KEY);
  const authSection = document.getElementById("auth-section");
  const appSection = document.getElementById("app-section");
  if (token) {
    authSection.style.display = "none";
    appSection.style.display = "block";
    const pending = sessionStorage.getItem(PENDING_TEXT_KEY);
    if (pending) {
      sessionStorage.removeItem(PENDING_TEXT_KEY);
      setBodyText(pending);
    }
  } else {
    authSection.style.display = "block";
    appSection.style.display = "none";
  }
}

// URL の ?text= パラメータを読み取る。
// 認証済みなら即座に #body へセット、未認証なら sessionStorage に保存。
function handleTextParam() {
  const params = new URLSearchParams(window.location.search);
  const text = params.get("text");
  if (!text) return;
  window.history.replaceState({}, "", window.location.pathname);
  if (localStorage.getItem(TOKEN_KEY)) {
    setBodyText(text);
  } else {
    sessionStorage.setItem(PENDING_TEXT_KEY, text);
  }
}

function setBodyText(text) {
  const bodyEl = document.getElementById("body");
  if (!bodyEl) return;
  bodyEl.value = text;
  bodyEl.focus();
  bodyEl.scrollIntoView({ behavior: "smooth" });
}

// 二重呼び出し防御フラグ: initAfterAuth と waitForFluxjot のどちらか一方が先に
// renderList/initSync を実行したら他方はスキップする。
let syncInitialized = false;

// ページロード時にコールバックを確認（WASM ロード前に実行）
handleOAuthCallback().then(authenticated => {
  if (!authenticated) return;
  updateAuthUI();
  // fluxjot が初期化済みであれば即座に、未初期化なら待機してから実行
  const initAfterAuth = () => {
    if (syncInitialized) return;
    const tokenJSON = localStorage.getItem(TOKEN_KEY);
    if (!tokenJSON) return;
    syncInitialized = true;
    renderList();
    fluxjot.initSync(tokenJSON)
      .then(() => fluxjot.startAutoSync(60000))
      .catch(err => console.error("FluxJot: sync init failed:", err));
  };
  if (window.fluxjot) {
    initAfterAuth();
  } else {
    const start = Date.now();
    const wait = setInterval(() => {
      if (window.fluxjot) {
        clearInterval(wait);
        initAfterAuth();
      } else if (Date.now() - start >= 5000) {
        clearInterval(wait);
        console.error("FluxJot: window.fluxjot was not set within 5000ms");
      }
    }, 50);
  }
});
handleTextParam();

const go = new Go();
WebAssembly.instantiateStreaming(fetch("main.wasm"), go.importObject)
  .catch(() =>
    fetch("main.wasm")
      .then(r => r.arrayBuffer())
      .then(buf => WebAssembly.instantiate(buf, go.importObject))
  )
  .then(result => {
    go.run(result.instance);
    const waitForFluxjot = () => {
      if (window.fluxjot) {
        updateAuthUI();
        const tokenJSON = localStorage.getItem(TOKEN_KEY);
        if (tokenJSON && !syncInitialized) {
          syncInitialized = true;
          renderList();
          fluxjot.initSync(tokenJSON)
            .then(() => fluxjot.startAutoSync(60000))
            .catch(err => console.error("FluxJot: sync init failed:", err));
        }
      } else {
        setTimeout(waitForFluxjot, 50);
      }
    };
    waitForFluxjot();
  });

document.getElementById("create-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!window.fluxjot) {
    document.getElementById("error").textContent = "FluxJot がまだ初期化されていません。";
    return;
  }
  const body = document.getElementById("body").value;
  try {
    await fluxjot.create({ body });
    e.target.reset();
    document.getElementById("error").textContent = "";
    await renderList();
  } catch (err) {
    document.getElementById("error").textContent = err;
  }
});

document.getElementById("body").addEventListener("keydown", e => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    document.getElementById("create-form").requestSubmit();
  }
});

function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tagColor(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) {
    h = Math.imul(31, h) + tag.charCodeAt(i) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 65%, 42%)`;
}

// renderBody renders the body text with tag colors and search highlights applied in a single pass.
// Tags (e.g. "#foo") from the tags array are wrapped in colored <span> elements using tagColor.
// Search words from query are wrapped in <mark> elements.
// Tag colors take priority over search highlights.
// Non-matched regions are HTML-escaped via escapeHTML.
function renderBody(body, tags, query) {
  // Build candidates: tag patterns and search words
  const candidates = [];
  if (tags) {
    tags.forEach(t => candidates.push({ pattern: "#" + t, isTag: true, tag: t }));
  }
  if (query) {
    const words = query.trim().split(/[\s\u3000]+/).filter(
      w => w && !w.startsWith("#") && !w.startsWith("since:") && !w.startsWith("until:")
    );
    words.forEach(w => candidates.push({ pattern: w, isTag: false }));
  }

  if (candidates.length === 0) return escapeHTML(body);

  let result = "";
  let remaining = body;
  while (remaining.length > 0) {
    // Find earliest (and longest on tie) match among all candidates
    let bestIdx = -1;
    let bestLen = 0;
    let bestCand = null;
    for (const c of candidates) {
      const idx = remaining.indexOf(c.pattern);
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx || (idx === bestIdx && c.pattern.length > bestLen))) {
        bestIdx = idx;
        bestLen = c.pattern.length;
        bestCand = c;
      }
    }
    if (bestIdx < 0) {
      result += escapeHTML(remaining);
      break;
    }
    result += escapeHTML(remaining.slice(0, bestIdx));
    const matched = remaining.slice(bestIdx, bestIdx + bestLen);
    if (bestCand.isTag) {
      result += `<span style="background:${tagColor(bestCand.tag)};color:#fff;padding:0 4px;border-radius:3px;margin-right:2px">${escapeHTML(matched)}</span>`;
    } else {
      result += `<mark>${escapeHTML(matched)}</mark>`;
    }
    remaining = remaining.slice(bestIdx + bestLen);
  }
  return result;
}

let currentQuery = "";

async function renderList() {
  const entries = await fluxjot.search(currentQuery);
  const list = document.getElementById("list");
  list.innerHTML = "";
  if (entries.length === 0) {
    list.innerHTML = "<p>メモがありません</p>";
    return;
  }
  entries.forEach(e => {
    const div = document.createElement("div");
    div.innerHTML = `
      <p>${e.createdAt}</p>
      <p style="white-space:pre-wrap">${renderBody(e.body, e.tags, currentQuery)}</p>
      <button onclick="startEdit('${e.id}', this)">編集</button>
      <button onclick="deleteEntry('${e.id}')">削除</button>
      <hr>
    `;
    list.appendChild(div);
  });
}

// デバウンス検索（300ms）および Enter キーによる即時検索
let debounceTimer;
const searchEl = document.getElementById("search");
searchEl.addEventListener("input", e => {
  clearTimeout(debounceTimer);
  currentQuery = e.target.value;
  debounceTimer = setTimeout(() => renderList(), 300);
});
searchEl.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    clearTimeout(debounceTimer);
    currentQuery = e.target.value;
    renderList();
  }
});

async function deleteEntry(id) {
  await fluxjot.delete({ id });
  await renderList();
}

function startEdit(id, btn) {
  const div = btn.parentElement;
  const currentBody = div.querySelector("p:nth-child(2)").textContent.trim();
  div.innerHTML = `
    <textarea id="edit-body-${id}"
      onkeydown="if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();saveEdit('${id}')}"
    >${currentBody}</textarea>
    <br>
    <button onclick="saveEdit('${id}')">保存</button>
    <button onclick="renderList()">キャンセル</button>
    <p id="edit-error-${id}" style="color:red"></p>
  `;
}

async function saveEdit(id) {
  const body = document.getElementById("edit-body-" + id).value;
  try {
    await fluxjot.update({ id, body });
    await renderList();
  } catch (err) {
    document.getElementById("edit-error-" + id).textContent = err;
  }
}

const THEME_KEY = "fluxjot_theme";
const CDN_BASE = "https://cdn.jsdelivr.net/npm/sakura.css/css/";

function applyTheme(name) {
  document.getElementById("sakura-theme").href = CDN_BASE + name + ".css";
  localStorage.setItem(THEME_KEY, name);
}

const themeSelect = document.getElementById("theme-select");
const savedTheme = localStorage.getItem(THEME_KEY) || "sakura";
themeSelect.value = savedTheme;
applyTheme(savedTheme);

themeSelect.addEventListener("change", e => applyTheme(e.target.value));
