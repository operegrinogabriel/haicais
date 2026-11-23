/* Caderno de Haicais — armazenamento local (IndexedDB) + backup na nuvem (Supabase, via REST).
   Tudo funciona offline; quando há internet e login, as mudanças sobem e descem.
   Regra de conflito: vence a versão com updatedAt mais recente (por haicai). */
(function () {
  const CFG = window.HAICAI_CONFIG || {};
  const CLOUD_ON = !!(CFG.supabaseUrl && CFG.supabaseKey);
  const TABLE = "haicai_docs";
  const KIGOS_ID = "__kigos";

  /* ---------- IndexedDB ---------- */
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("caderno-haicais", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("docs", { keyPath: "id" }); // {id, data, deleted, updatedAt, dirty}
        d.createObjectStore("kv");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => (out = v));
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const kvGet = k => tx("kv", "readonly", s => req(s.get(k)));
  const kvSet = (k, v) => tx("kv", "readwrite", s => { s.put(v, k); });

  /* ---------- estado em memória ---------- */
  const docs = new Map(); // id -> registro
  let kigos = [], userKigos = [];
  const kigosReady = fetch("kigos.json").then(r => r.ok ? r.json() : []).then(l => { if (Array.isArray(l) && l.length) { kigos = l; emit("change") } }).catch(() => { });
  const listeners = new Set();
  const status = { cloud: CLOUD_ON, email: null, syncing: false, lastSync: null, pending: 0, error: null, online: navigator.onLine };
  function emit(what) { status.pending = [...docs.values()].filter(d => d.dirty).length; listeners.forEach(f => { try { f(what) } catch (e) { } }); }

  async function load() {
    const rows = await tx("docs", "readonly", s => req(s.getAll()));
    rows.forEach(r => docs.set(r.id, r));
    const k = docs.get(KIGOS_ID);
    userKigos = k && !k.deleted && k.data && Array.isArray(k.data.list) ? k.data.list : [];
    if (!kigos.length) kigos = userKigos;
    const sess = await kvGet("session");
    session = sess || null;
    status.email = session?.user?.email || null;
    status.lastSync = (await kvGet("lastSyncAt")) || null;
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist() } catch (e) { }
    emit("load");
  }

  function haikus() {
    const out = [];
    docs.forEach(r => { if (!r.deleted && !r.id.startsWith("__")) out.push(Object.assign({}, r.data, { id: r.id })) });
    return out;
  }

  async function putLocal(records) {
    await tx("docs", "readwrite", s => { records.forEach(r => s.put(r)) });
    records.forEach(r => docs.set(r.id, r));
  }

  async function saveHaiku(id, data) {
    const now = Date.now();
    await putLocal([{ id, data, deleted: false, updatedAt: now, dirty: true }]);
    emit("change"); scheduleSync(800);
  }
  /* documentos de ajustes do poeta (ex.: "__silabas"), sincronizados como os haicais */
  function getDoc(id) { const r = docs.get(id); return r && !r.deleted ? r.data : null }
  async function saveDoc(id, data) { return saveHaiku(id, data) }
  async function deleteHaiku(id) {
    const prev = docs.get(id);
    await putLocal([{ id, data: prev ? prev.data : {}, deleted: true, updatedAt: Date.now(), dirty: true }]);
    emit("change"); scheduleSync(800);
  }

  /* ---------- importar / exportar pacote ---------- */
  async function importPack(pack) {
    if (!pack || pack.format !== "caderno-haicais") throw new Error("formato");
    const recs = [];
    let added = 0, kept = 0;
    (pack.haikus || []).forEach((h, i) => {
      const { id, ...data } = h;
      if (!id) return;
      if (data.ord == null) data.ord = i;
      const ts = h.updatedAt || 1;
      const cur = docs.get(id);
      if (cur && cur.updatedAt >= ts) { kept++; return }
      recs.push({ id, data, deleted: false, updatedAt: ts, dirty: true }); added++;
    });
    await putLocal(recs);
    emit("change"); scheduleSync(300);
    return { added, kept };
  }
  function exportPack() {
    const hs = [];
    docs.forEach(r => { if (!r.deleted && !r.id.startsWith("__")) hs.push(Object.assign({ id: r.id }, r.data, { updatedAt: r.updatedAt })) });
    hs.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
    return { format: "caderno-haicais", version: 1, exportedAt: new Date().toISOString(), haikus: hs };
  }

  /* ---------- nuvem: autenticação ---------- */
  let session = null; // {access_token, refresh_token, expires_at, user}
  const base = () => CFG.supabaseUrl.replace(/\/$/, "");
  async function authCall(path, body) {
    const r = await fetch(base() + "/auth/v1/" + path, {
      method: "POST", headers: { apikey: CFG.supabaseKey, "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.msg || j.error_description || j.message || ("Erro " + r.status)); e.code = j.error_code || j.error || r.status; throw e }
    return j;
  }
  async function setSession(j) {
    session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: { id: j.user?.id || session?.user?.id, email: j.user?.email || session?.user?.email } };
    status.email = session.user.email;
    await kvSet("session", session);
  }
  async function login(email, password) {
    const j = await authCall("token?grant_type=password", { email, password });
    await setSession(j); status.error = null; emit("auth"); await sync(); return true;
  }
  const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, "");
  const rt = () => "?redirect_to=" + encodeURIComponent(REDIRECT);
  async function signup(email, password) {
    const j = await authCall("signup" + rt(), { email, password });
    if (j.access_token) { await setSession(j); emit("auth"); await sync(); return "ok" }
    return "confirm"; // projeto exige confirmar o e-mail
  }
  async function recover(email) { await authCall("recover" + rt(), { email }); return true }
  async function authUser(t, method, body) {
    const r = await fetch(base() + "/auth/v1/user", { method: method || "GET", headers: { apikey: CFG.supabaseKey, Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.msg || j.message || ("Erro " + r.status)); e.code = j.error_code || r.status; throw e }
    return j;
  }
  async function updatePassword(password) { await authUser(await token(), "PUT", { password }); return true }
  /* volta do e-mail (confirmação de conta ou troca de senha): os dados vêm depois do # no endereço */
  async function handleRedirect() {
    const h = location.hash.replace(/^#/, "");
    if (!h || !/access_token=|error=/.test(h)) return null;
    const p = new URLSearchParams(h);
    history.replaceState(null, "", location.pathname + location.search);
    if (p.get("error")) return { error: p.get("error_code") || p.get("error"), message: p.get("error_description") || "" };
    const t = p.get("access_token");
    const u = await authUser(t);
    await setSession({ access_token: t, refresh_token: p.get("refresh_token"), expires_in: +p.get("expires_in") || 3600, user: u });
    status.error = null; emit("auth");
    return { type: p.get("type") || "login" };
  }
  async function logout() {
    session = null; status.email = null; await kvSet("session", null); await kvSet("lastSync", null); emit("auth");
  }
  async function token() {
    if (!session) return null;
    if (Date.now() > session.expires_at - 60000) {
      try { await setSession(await authCall("token?grant_type=refresh_token", { refresh_token: session.refresh_token })) }
      catch (e) { if (e.code && String(e.code).match(/refresh|invalid|400|401/)) { await logout(); status.error = "Sua sessão expirou. Entre de novo para continuar o backup." } throw e }
    }
    return session.access_token;
  }
  async function rest(method, query, body, extraHeaders) {
    const t = await token();
    const r = await fetch(base() + "/rest/v1/" + TABLE + query, {
      method, headers: Object.assign({ apikey: CFG.supabaseKey, Authorization: "Bearer " + t, "Content-Type": "application/json" }, extraHeaders || {}),
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.message || ("Erro " + r.status)); e.code = r.status; throw e }
    return r.status === 204 || method !== "GET" ? null : r.json();
  }

  /* ---------- nuvem: sincronização ---------- */
  let syncTimer = null, running = null;
  function scheduleSync(ms) { if (!CLOUD_ON || !session) return; clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms || 0) }
  async function sync() {
    if (!CLOUD_ON || !session) return;
    if (!navigator.onLine) { status.online = false; emit("status"); return }
    if (running) return running;
    running = (async () => {
      status.syncing = true; status.error = null; emit("status");
      try {
        await pull();
        await push();
        status.lastSync = Date.now(); await kvSet("lastSyncAt", status.lastSync);
      } catch (e) {
        status.error = status.error || (e && e.message ? "Backup não concluído: " + e.message : "Backup não concluído.");
      } finally { status.syncing = false; running = null; emit("status") }
    })();
    return running;
  }
  async function pull() {
    let since = (await kvGet("lastSync")) || "1970-01-01T00:00:00Z";
    let maxSeen = since, offset = 0;
    for (; ;) {
      const rows = await rest("GET", "?select=id,data,deleted,updated_at,synced_at&synced_at=gte." + encodeURIComponent(since) + "&order=synced_at.asc,id.asc&limit=1000&offset=" + offset);
      const recs = [];
      for (const row of rows) {
        if (row.synced_at > maxSeen) maxSeen = row.synced_at;
        const cur = docs.get(row.id);
        const ts = Number(row.updated_at);
        if (cur && cur.updatedAt > ts) continue;          // a versão local é mais nova: fica e sobe depois
        if (cur && cur.updatedAt === ts && !cur.dirty) continue;
        recs.push({ id: row.id, data: row.data, deleted: row.deleted, updatedAt: ts, dirty: false });
      }
      if (recs.length) {
        await putLocal(recs);
        const k = docs.get(KIGOS_ID); if (k && !k.deleted && k.data?.list && !kigos.length) kigos = k.data.list;
        emit("change");
      }
      if (rows.length < 1000) break;
      offset += rows.length;
    }
    await kvSet("lastSync", maxSeen);
  }
  async function push() {
    const dirty = [...docs.values()].filter(d => d.dirty);
    for (let i = 0; i < dirty.length; i += 300) {
      const chunk = dirty.slice(i, i + 300);
      await rest("POST", "?on_conflict=user_id,id", chunk.map(d => ({ user_id: session.user.id, id: d.id, data: d.data, deleted: !!d.deleted, updated_at: d.updatedAt })),
        { Prefer: "resolution=merge-duplicates,return=minimal" });
      const done = chunk.map(d => Object.assign({}, docs.get(d.id))).filter(d => d.updatedAt === chunk.find(c => c.id === d.id).updatedAt);
      done.forEach(d => d.dirty = false);
      await putLocal(done);
      emit("status");
    }
  }

  window.addEventListener("online", () => { status.online = true; emit("status"); scheduleSync(500) });
  window.addEventListener("offline", () => { status.online = false; emit("status") });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleSync(300) });
  setInterval(() => scheduleSync(0), 5 * 60 * 1000);

  window.Caderno = {
    ready: load().then(async () => { let r = null; try { r = await handleRedirect() } catch (e) { r = { error: "link", message: e.message } } scheduleSync(200); return r }),
    haikus, get kigos() { return kigos }, status, version: () => docs.size + ":" + status.pending + ":" + kigos.length,
    onChange: f => listeners.add(f), saveHaiku, deleteHaiku, getDoc, saveDoc, importPack, exportPack,
    login, signup, logout, recover, updatePassword, syncNow: () => sync(), cloudEnabled: CLOUD_ON,
  };
})();
