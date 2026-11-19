/* DevilutionX companion – UI logic.
 * Polls the companion server embedded in DevilutionX and renders the data. */
(() => {
  'use strict';

  const DEFAULT_SERVER = 'http://127.0.0.1:8642';
  const POLL_MS = 250;
  const RETRY_MS = 1000;

  const native = window.CompanionNative || null; // Android bridge (optional)
  if (native) document.body.classList.add('native');

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const params = new URLSearchParams(location.search);
  // Embedded in DevilutionX Thor (second screen): the server address is fixed.
  const embedded = params.get('embedded') === '1';
  if (embedded) document.body.classList.add('embedded');
  let server = (params.get('server') || (embedded ? DEFAULT_SERVER : store.get('server', DEFAULT_SERVER))).replace(/\/+$/, '');
  const settings = {
    labels: store.get('opt.labels', true),
    items: store.get('opt.items', true),
    keepFocus: store.get('opt.keepFocus', true),
    keepScreen: store.get('opt.keepScreen', true),
    hiddenQuests: store.get('opt.hiddenQuests', false),
    mapBelt: store.get('opt.mapBelt', true),
  };

  // ------------------------------------------------------------------ i18n
  let langSetting = store.get('opt.lang', 'auto');
  let lang = 'en';
  let L = window.I18N.en;
  function resolveLang() {
    if (langSetting !== 'auto' && window.I18N[langSetting]) return langSetting;
    for (const l of navigator.languages || [navigator.language || 'en']) {
      const code = String(l).slice(0, 2).toLowerCase();
      if (window.I18N[code]) return code;
    }
    return 'en';
  }
  function t(key, vars) {
    let v = L[key] ?? window.I18N.en[key] ?? key;
    if (vars && typeof v === 'string') v = v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
    return v;
  }
  function applyLang() {
    lang = resolveLang();
    L = window.I18N[lang];
    document.documentElement.lang = lang;
    document.title = lang === 'fr' ? 'Compagnon DevilutionX' : 'DevilutionX Companion';
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
  applyLang();

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString(L.locale);

  let state = null;
  let map = null;          // { version, w, h, cells }
  let mapVersion = -1;
  let connected = false;
  let currentTab = 'map';
  let lastError = '';

  // ------------------------------------------------------------------ net
  // In DevilutionX Thor the game is read in-process through a JNI bridge;
  // in a regular browser the companion HTTP server is used.
  const game = window.DevilutionXGame || null;

  async function fetchJson(path) {
    if (game) {
      const json = path === '/api/map' ? game.getMap() : game.getState();
      if (!json) throw new Error('second screen disabled or game not started');
      return JSON.parse(json);
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    try {
      const r = await fetch(server + path, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  let pollTimer = 0;
  let polling = false;

  /** Polls right away, e.g. after a HUD button so the UI reflects it quickly. */
  function pollSoon() {
    if (polling) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 60);
  }

  async function poll() {
    polling = true;
    let delay = POLL_MS;
    try {
      const s = await fetchJson('/api/state');
      setConnected(true);
      if (s.inGame && s.game && s.game.mapVersion !== mapVersion) {
        try {
          const m = await fetchJson('/api/map');
          map = m;
          mapVersion = m.version;
          buildMapGeometry();
        } catch { /* retry next poll */ }
      }
      onState(s);
    } catch (e) {
      lastError = (e && e.message) || String(e);
      setConnected(false);
      updateOverlay();
      delay = RETRY_MS;
    }
    polling = false;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  function setConnected(ok) {
    if (ok === connected && $('conn-status').dataset.init) return;
    connected = ok;
    $('conn-status').dataset.init = '1';
    const where = game ? 'DevilutionX' : server;
    $('conn-status').textContent = ok ? t('connectedTo', { s: where }) : t('notConnected', { s: where });
    $('conn-status').style.color = ok ? 'var(--ok)' : 'var(--bad)';
    updateOverlay();
  }

  function updateOverlay() {
    const ov = $('overlay');
    if (currentTab === 'settings') { ov.classList.add('hidden'); return; }
    if (!connected) {
      ov.classList.remove('hidden');
      $('overlay-title').textContent = t('waiting');
      $('overlay-sub').textContent = embedded ? t('waitingSubEmbedded') : t('waitingSub', { s: server });
      // Diagnostic: how the UI talks to the game, and the last error.
      $('overlay-sub').textContent += `  [${game ? 'jni' : 'http'}${lastError ? ': ' + lastError : ''}]`;
    } else if (!state || !state.inGame) {
      ov.classList.remove('hidden');
      $('overlay-title').textContent = t('connected');
      $('overlay-sub').textContent = t('connectedSub');
    } else {
      ov.classList.add('hidden');
    }
  }

  // ------------------------------------------------------------------ state
  let lastPos = null;
  function onState(s) {
    state = s;
    updateOverlay();
    if (!s.inGame) return;
    renderHud(s);
    if (currentTab === 'hud') renderHudTab(s);
    if (currentTab === 'char') renderChar(s);
    if (currentTab === 'items') renderItems(s);
    if (currentTab === 'quests') renderQuests(s);
    renderMonsterList(s);
    if (currentTab === 'map') renderMapBelt(s);

    const p = s.player.pos;
    if (!lastPos || lastPos[0] !== p[0] || lastPos[1] !== p[1]) {
      anim.from = anim.pos ? anim.pos.slice() : p.slice();
      anim.to = p.slice();
      anim.start = performance.now();
      lastPos = p.slice();
    }
    requestDraw();
  }


  function setBar(id, txtId, value, max, text) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    $(id).style.width = pct + '%';
    $(txtId).textContent = text ?? `${value} / ${max}`;
    return pct;
  }

  function lowDurability(s) {
    return (s.player.equipment || []).filter((it) => it && it.maxDur > 0 && it.dur / it.maxDur <= 0.25);
  }

  function renderHud(s) {
    const p = s.player;
    $('hud-name').textContent = p.name;
    $('hud-class').textContent = ' ' + t('classLevel', { cls: p.class, lvl: p.level });
    let loc = s.game.location;
    if (s.game.difficulty > 0) loc += ' · ' + t('difficulty')[s.game.difficulty];
    $('hud-loc').textContent = loc;

    const hpPct = setBar('bar-hp', 'txt-hp', p.hp, p.hpMax);
    $('bar-hp').parentElement.classList.toggle('low', hpPct <= 30 && !p.dead);
    setBar('bar-mana', 'txt-mana', p.mana, p.manaMax);
    if (p.maxLevel) {
      setBar('bar-xp', 'txt-xp', 1, 1, t('maxLevel'));
    } else {
      const span = Math.max(1, p.xpNext - p.xpPrev);
      const cur = Math.max(0, p.xp - p.xpPrev);
      setBar('bar-xp', 'txt-xp', cur, span, t('xpText', { xp: fmt(p.xp), next: fmt(p.xpNext), left: fmt(p.xpNext - p.xp) }));
    }

    const alerts = [];
    if (p.dead) alerts.push([t('alertDead'), '']);
    for (const it of lowDurability(s)) alerts.push([t('alertDurability', { name: it.name, dur: it.dur, max: it.maxDur }), '']);
    if (p.statPoints > 0) alerts.push([t('alertStatPoints', { n: p.statPoints }), 'info']);
    if (p.potions && p.potions.heal === 0 && p.hpMax > 0) alerts.push([t('alertNoHealPotion'), '']);
    $('alerts').innerHTML = alerts.map(([t, c]) => `<span class="alert ${c}">${esc(t)}</span>`).join('');
  }

  function statClass(base, now, max) {
    if (base >= max) return 'maxed';
    if (now > base) return 'up';
    if (now < base) return 'down';
    return '';
  }

  function resClass(v) {
    if (v >= 75) return 'maxed';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return '';
  }

  function kv(label, value, cls = '') {
    return `<div class="kv"><span class="muted">${esc(label)}</span><b class="${cls}">${esc(value)}</b></div>`;
  }

  function renderChar(s) {
    const p = s.player;
    const rows = [[t('str'), p.str], [t('mag'), p.mag], [t('dex'), p.dex], [t('vit'), p.vit]];
    $('attr-body').innerHTML = rows.map(([n, [b, c, m]]) =>
      `<tr><td>${n}</td><td class="${b >= m ? 'maxed' : ''}">${b}</td><td class="${statClass(b, c, m)}">${c}</td><td class="muted">${m}</td></tr>`).join('');
    const sp = $('stat-points');
    sp.classList.toggle('hidden', !(p.statPoints > 0));
    sp.textContent = t('statPoints', { n: p.statPoints });

    $('combat').innerHTML =
      kv(t('armor'), p.ac) + kv(t('toHit'), p.toHit + ' %') +
      kv(t('damage'), `${p.damage[0]}–${p.damage[1]}`) + kv(t('gold'), fmt(p.gold));

    const r = p.resist;
    $('resists').innerHTML = [[t('resMagic'), r.magic], [t('resFire'), r.fire], [t('resLightning'), r.lightning]]
      .map(([l, v]) => `<div class="res"><div class="v ${resClass(v)}">${v}%</div><div class="l">${l}</div></div>`).join('');

    const spell = p.spell ? p.spell.name + (p.spell.level > 0 ? t('spellLevel', { lvl: p.spell.level }) : '') : '—';
    $('misc').innerHTML =
      kv(t('level'), p.level) + kv(t('experience'), fmt(p.xp)) +
      kv(t('nextLevel'), p.maxLevel ? '—' : fmt(p.xpNext)) + kv(t('readySpell'), spell);
  }

  function itemClass(it) {
    return 'q' + (it.quality || 0) + (it.usable === false ? ' unusable' : '');
  }

  function renderItems(s) {
    const eq = s.player.equipment || [];
    $('equipment').innerHTML = t('slots').map((slot, i) => {
      const it = eq[i];
      if (!it) return `<div class="slot"><span class="where">${slot}</span><span class="name empty">${t('empty')}</span></div>`;
      let meta = '';
      if (it.maxDur > 0) {
        const r = it.dur / it.maxDur;
        const cls = r <= 0.15 ? 'crit' : r <= 0.35 ? 'warn' : '';
        meta += `<span class="dur ${cls}"><i style="width:${Math.round(r * 100)}%"></i></span><span>${it.dur}/${it.maxDur}</span>`;
      }
      if (it.maxCharges > 0) meta += `<span>${t('charges', { c: it.charges, m: it.maxCharges })}</span>`;
      if (it.quality > 0 && !it.identified) meta += `<span>${t('unidentified')}</span>`;
      return `<div class="slot"><span class="where">${slot}</span><span class="name ${itemClass(it)}">${esc(it.name)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</div>`;
    }).join('');

    const belt = s.player.belt || [];
    $('belt').innerHTML = belt.map((it, i) => {
      if (!it) return `<div class="cell"><span class="empty">—</span><span class="n">${i + 1}</span></div>`;
      const n = it.name.toLowerCase();
      const kind = /r(é|e)g(é|e)n|rejuv/.test(n) ? 'rejuv' : /mana/.test(n) ? 'mana' : /(soin|vie|heal)/.test(n) ? 'heal' : '';
      return `<div class="cell ${kind}"><span class="${itemClass(it)}">${esc(it.name)}</span><span class="n">${i + 1}</span></div>`;
    }).join('');
    const pot = s.player.potions || { heal: 0, mana: 0 };
    $('potions').textContent = t('potions', { heal: pot.heal, mana: pot.mana });
  }

  function renderQuests(s) {
    const qs = s.quests || [];
    const list = [];
    for (const q of qs) {
      const known = q.log || q.state === 3;
      if (q.state === 3) list.push([q, 'done', t('questDone'), 2]);
      else if (q.state === 2 && q.log) list.push([q, 'active', t('questActive'), 0]);
      else if (q.state === 2) list.push([q, 'active', t('questFound'), 1]);
      else if (!known && settings.hiddenQuests) list.push([q, 'hidden-q', q.level > 0 ? t('questLevel', { lvl: q.level }) : t('questHidden'), 3]);
    }
    list.sort((a, b) => a[3] - b[3]);
    $('quests').innerHTML = list.length
      ? list.map(([q, cls, label]) => `<div class="quest"><span>${esc(q.name)}</span><span class="st ${cls}">${esc(label)}</span></div>`).join('')
      : `<div class="muted">${t('noQuests')}</div>`;
  }

  // ------------------------------------------------------------------ HUD tab
  const canControl = !!(game && game.sendCommand);

  function sendCommand(cmd, el) {
    if (!canControl || !cmd) return;
    game.sendCommand(cmd);
    if (el) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 150);
    }
    pollSoon();
  }

  $('tab-hud').addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (el && !el.disabled) sendCommand(el.dataset.cmd, el);
  });
  if (!canControl) for (const b of document.querySelectorAll('#tab-hud .hb')) b.disabled = true;

  function setOrb(id, txtId, value, max) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    $(id).style.setProperty('--pct', pct + '%');
    $(txtId).textContent = `${value}/${max}`;
    return pct;
  }

  function beltIcon(it) {
    const k = it.kind || 'other';
    if (/heal|mana|rejuv|elixir/.test(k)) return '<i class="flask"></i>';
    if (k === 'scroll' || k === 'book') return '<i class="icon-scroll"></i>';
    return '<i class="icon-other"></i>';
  }

  /** Short belt label: potion type, or the spell of a scroll. */
  function beltLabel(it) {
    const short = { heal: 'beltHeal', fullheal: 'beltFullHeal', mana: 'beltMana', fullmana: 'beltFullMana', rejuv: 'beltRejuv', fullrejuv: 'beltFullRejuv' }[it.kind];
    if (short) return t(short);
    if (it.kind === 'scroll') return it.name.replace(/^(scroll of|parchemin d[e']\s*)\s*/i, '');
    return it.name;
  }

  /** Belt slots as buttons (tap = use), shared by the HUD and the map. */
  function renderBelt(container, belt) {
    belt = belt || [];
    const html = [];
    for (let i = 0; i < 8; i++) {
      const it = belt[i];
      if (!it) {
        html.push(`<button class="slot-btn empty" disabled><span class="n">${i + 1}</span></button>`);
      } else {
        html.push(`<button class="slot-btn k-${esc(it.kind || 'other')}" data-cmd="belt:${i}" ${canControl ? '' : 'disabled'}><span class="n">${i + 1}</span>${beltIcon(it)}<span class="lbl ${itemClass(it)}">${esc(beltLabel(it))}</span></button>`);
      }
    }
    const beltHtml = html.join('');
    if (container.dataset.html !== beltHtml) { // avoid replacing buttons while they are being touched
      container.innerHTML = beltHtml;
      container.dataset.html = beltHtml;
    }
  }

  $('map-belt').addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (el && !el.disabled) sendCommand(el.dataset.cmd, el);
  });

  function renderMapBelt(s) {
    const el = $('map-belt');
    el.classList.toggle('hidden', !settings.mapBelt);
    if (settings.mapBelt) renderBelt(el, s.player.belt);
  }

  function renderHudTab(s) {
    const p = s.player;
    const hpPct = setOrb('orb-life', 'orb-life-txt', p.hp, p.hpMax);
    $('orb-life').classList.toggle('low', hpPct <= 30 && !p.dead);
    setOrb('orb-mana', 'orb-mana-txt', p.mana, p.manaMax);

    renderBelt($('hud-belt'), p.belt);

    const hud = s.hud || { open: {}, info: '' };
    $('hud-info').textContent = hud.info || '';
    for (const b of document.querySelectorAll('#tab-hud [data-open]')) b.classList.toggle('on', !!hud.open[b.dataset.open]);

    const spell = $('hud-spell');
    spell.className = 'hb spell' + (p.spell ? ' t' + p.spell.type : '') + (hud.open.spellList ? ' on' : '');
    $('hud-spell-name').textContent = p.spell ? p.spell.name + (p.spell.level > 0 ? ` (${p.spell.level})` : '') : t('hudNoSpell');

    $('hud-levelup').classList.toggle('hidden', !(p.statPoints > 0));
    $('hud-friendly').classList.toggle('hidden', !s.game.multiplayer);
  }

  function renderMonsterList(s) {
    const mons = (s.entities.monsters || []).filter((m) => !m[5]);
    if (!mons.length) { $('monsters').innerHTML = ''; return; }
    const [px, py] = s.player.pos;
    mons.sort((a, b) => (b[4] - a[4]) || (Math.hypot(a[0] - px, a[1] - py) - Math.hypot(b[0] - px, b[1] - py)));
    const shown = mons.slice(0, 5);
    let html = shown.map((m) => `<div class="m ${m[4] ? 'u' : ''}"><span class="nm">${esc(m[2])}</span><span class="hp"><i style="width:${m[3]}%"></i></span></div>`).join('');
    if (mons.length > shown.length) html += `<div class="more">${t('moreMonsters', { n: mons.length - shown.length })}</div>`;
    $('monsters').innerHTML = html;
  }

  // ------------------------------------------------------------------ map
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const TW = 32; // tile width in world units (isometric diamond)
  const TH = 16;
  const view = { zoom: store.get('map.zoom', 0.8), follow: true, cx: 0, cy: 0 };
  const anim = { from: null, to: null, pos: null, start: 0 };
  let floorPath = null;
  let wallPath = null;
  let drawPending = false;

  const iso = (x, y) => [(x - y) * TW / 2, (x + y) * TH / 2];

  function diamond(path, x, y) {
    const [sx, sy] = iso(x, y);
    path.moveTo(sx, sy - TH / 2);
    path.lineTo(sx + TW / 2, sy);
    path.lineTo(sx, sy + TH / 2);
    path.lineTo(sx - TW / 2, sy);
    path.closePath();
  }

  function buildMapGeometry() {
    floorPath = new Path2D();
    wallPath = new Path2D();
    if (!map || !map.cells) return;
    const { w, h, cells } = map;
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 48 : cells.charCodeAt(y * w + x));
    // A wall cell is drawn only when it borders an explored floor cell, so thick
    // walls collapse into a single line like the in-game automap.
    const edge = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = at(x, y);
        if (c === 49) { diamond(floorPath, x, y); continue; } // '1' floor
        if (c !== 50) continue; // '2' wall
        let touches = false;
        for (let dy = -1; dy <= 1 && !touches; dy++)
          for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === 49) { touches = true; break; }
        if (touches) edge[y * w + x] = 1;
      }
    }
    const isEdge = (x, y) => x >= 0 && y >= 0 && x < w && y < h && edge[y * w + x] === 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isEdge(x, y)) continue;
        const [sx, sy] = iso(x, y);
        let linked = false;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          if (!isEdge(x + dx, y + dy)) continue;
          const [ex, ey] = iso(x + dx, y + dy);
          wallPath.moveTo(sx, sy);
          wallPath.lineTo(ex, ey);
          linked = true;
        }
        if (!linked && !isEdge(x - 1, y) && !isEdge(x, y - 1)) {
          // isolated pillar
          wallPath.moveTo(sx - 3, sy);
          wallPath.lineTo(sx + 3, sy);
        }
      }
    }
    requestDraw();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    requestDraw();
  }

  function requestDraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(draw);
  }

  function playerWorldPos(now) {
    if (!anim.to) return null;
    const t = Math.min(1, (now - anim.start) / POLL_MS);
    anim.pos = [anim.from[0] + (anim.to[0] - anim.from[0]) * t, anim.from[1] + (anim.to[1] - anim.from[1]) * t];
    return { pos: anim.pos, animating: t < 1 };
  }

  function draw(now) {
    drawPending = false;
    if (currentTab !== 'map') return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#050403';
    ctx.fillRect(0, 0, W, H);
    if (!state || !state.inGame) return;

    const pw = playerWorldPos(now);
    const ppos = pw ? pw.pos : state.player.pos;
    const [psx, psy] = iso(ppos[0], ppos[1]);
    if (view.follow) { view.cx = psx; view.cy = psy; }
    const z = view.zoom * dpr;
    // Keep the player centred in the part of the map not covered by the belt bar.
    const beltH = settings.mapBelt ? 52 * dpr : 0;
    ctx.setTransform(z, 0, 0, z, W / 2 - view.cx * z, (H - beltH) / 2 - view.cy * z);

    if (floorPath) {
      ctx.fillStyle = '#2b2017';
      ctx.fill(floorPath);
      if (z > 1.4) {
        ctx.lineWidth = 1 / z;
        ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.stroke(floorPath);
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2.2 * dpr / z, 2);
      ctx.strokeStyle = '#c49a55';
      ctx.stroke(wallPath);
    }

    const ents = state.entities || {};
    const labels = [];
    const r = (k) => Math.max(k / z * dpr, k * 0.5);

    // stairs / level transitions
    for (const [x, y, kind] of ents.triggers || []) {
      const [sx, sy] = iso(x, y);
      const up = kind === 'up' || kind === 'town' || kind === 'return';
      const s = r(9);
      ctx.fillStyle = '#d6b26a';
      ctx.beginPath();
      if (up) { ctx.moveTo(sx, sy - s); ctx.lineTo(sx + s, sy + s * 0.7); ctx.lineTo(sx - s, sy + s * 0.7); }
      else { ctx.moveTo(sx, sy + s); ctx.lineTo(sx + s, sy - s * 0.7); ctx.lineTo(sx - s, sy - s * 0.7); }
      ctx.closePath();
      ctx.fill();
      const txt = { up: t('trigUp'), down: t('trigDown'), town: t('trigTown'), warp: t('trigWarp'), return: t('trigReturn'), quest: t('trigQuest') }[kind] || '';
      if (txt) labels.push([sx, sy + s + 2, txt, '#d6b26a']);
    }

    // objects
    for (const [x, y, kind, , open] of ents.objects || []) {
      const [sx, sy] = iso(x, y);
      const s = r(kind === 'door' ? 4 : 5);
      ctx.fillStyle = kind === 'shrine' ? '#4fd0d6' : kind === 'door' ? (open ? '#3f3428' : '#6d5a45') : '#b07a3a';
      ctx.fillRect(sx - s, sy - s, s * 2, s * 2);
    }

    // items
    if (settings.items) {
      for (const [x, y, , q, gold] of ents.items || []) {
        const [sx, sy] = iso(x, y);
        ctx.fillStyle = gold ? '#ffd23f' : q === 2 ? '#d9b64f' : q === 1 ? '#7d95ff' : '#e9dfcc';
        ctx.beginPath();
        ctx.arc(sx, sy, r(gold ? 3 : 4), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // NPCs (town)
    for (const [x, y, name] of ents.npcs || []) {
      const [sx, sy] = iso(x, y);
      ctx.fillStyle = '#5fd36a';
      ctx.beginPath();
      ctx.arc(sx, sy, r(5), 0, Math.PI * 2);
      ctx.fill();
      labels.push([sx, sy + r(5) + 2, name, '#9fe3a5']);
    }

    // other players
    for (const [x, y, name] of ents.players || []) {
      const [sx, sy] = iso(x, y);
      ctx.fillStyle = '#62b6ff';
      ctx.beginPath();
      ctx.arc(sx, sy, r(6), 0, Math.PI * 2);
      ctx.fill();
      labels.push([sx, sy + r(6) + 2, name, '#a8d6ff']);
    }

    // monsters
    for (const [x, y, name, , unique, minion] of ents.monsters || []) {
      const [sx, sy] = iso(x, y);
      ctx.fillStyle = minion ? '#5fd36a' : unique ? '#ff9d1c' : '#e0392b';
      ctx.beginPath();
      ctx.arc(sx, sy, r(unique ? 6 : 4.5), 0, Math.PI * 2);
      ctx.fill();
      if (unique) labels.push([sx, sy + r(6) + 2, name, '#ffbf63']);
    }

    // player
    {
      const s = r(7);
      ctx.beginPath();
      ctx.arc(psx, psy, s * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(214,178,106,.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(psx, psy, s, 0, Math.PI * 2);
      ctx.fillStyle = state.player.dead ? '#777' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = r(2);
      ctx.strokeStyle = '#d6b26a';
      ctx.stroke();
    }

    // labels in screen space (constant size)
    if (settings.labels && labels.length) {
      const m = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `600 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      for (const [wx, wy, text, color] of labels) {
        const p = m.transformPoint(new DOMPoint(wx, wy));
        if (p.x < -50 || p.y < -20 || p.x > W + 50 || p.y > H + 20) continue;
        ctx.strokeText(text, p.x, p.y);
        ctx.fillStyle = color;
        ctx.fillText(text, p.x, p.y);
      }
    }

    if (pw && pw.animating) requestDraw();
  }

  // gestures: drag to pan, pinch to zoom, double tap to recenter
  const pointers = new Map();
  let pinch = null;
  let lastTap = 0;

  function setZoom(z, fx, fy) {
    const dpr = window.devicePixelRatio || 1;
    const nz = Math.max(0.35, Math.min(5, z));
    if (fx !== undefined && !view.follow) {
      // keep focal point fixed
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      const wx = view.cx + (fx - W / 2) / view.zoom;
      const wy = view.cy + (fy - H / 2) / view.zoom;
      view.cx = wx - (fx - W / 2) / nz;
      view.cy = wy - (fy - H / 2) / nz;
    }
    view.zoom = nz;
    store.set('map.zoom', nz);
    requestDraw();
  }

  function setFollow(f) {
    view.follow = f;
    $('btn-center').classList.toggle('following', f);
    requestDraw();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
    }
    const now = performance.now();
    if (pointers.size === 1 && now - lastTap < 300) setFollow(true);
    lastTap = now;
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.offsetX, y: e.offsetY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.5) return;
      if (view.follow) setFollow(false);
      view.cx -= dx / view.zoom;
      view.cy -= dy / view.zoom;
      requestDraw();
    } else if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom(pinch.zoom * d / Math.max(1, pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.offsetX, e.offsetY); }, { passive: false });

  $('btn-zoom-in').onclick = () => setZoom(view.zoom * 1.3);
  $('btn-zoom-out').onclick = () => setZoom(view.zoom / 1.3);
  $('btn-center').onclick = () => setFollow(true);
  $('btn-legend').onclick = () => $('legend').classList.toggle('hidden');
  $('legend').onclick = () => $('legend').classList.add('hidden');

  // ------------------------------------------------------------------ tabs
  function showTab(name) {
    currentTab = name;
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === 'tab-' + name);
    // The settings tab contains a text field: allow focus there so the keyboard can be used.
    if (native && native.setFocusable) native.setFocusable(name === 'settings' || !settings.keepFocus);
    updateOverlay();
    if (state && state.inGame) {
      if (name === 'hud') renderHudTab(state);
      if (name === 'map') renderMapBelt(state);
      if (name === 'char') renderChar(state);
      if (name === 'items') renderItems(state);
      if (name === 'quests') renderQuests(state);
    }
    if (name === 'map') resize();
    store.set('tab', name);
  }
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showTab(b.dataset.tab);

  // ------------------------------------------------------------------ settings
  $('server-url').value = server;
  $('btn-save-server').onclick = () => {
    let v = $('server-url').value.trim() || DEFAULT_SERVER;
    if (!/^https?:\/\//.test(v)) v = 'http://' + v;
    server = v.replace(/\/+$/, '');
    $('server-url').value = server;
    store.set('server', server);
    mapVersion = -1;
    $('conn-status').dataset.init = '';
    setConnected(false);
  };
  $('btn-reset-server').onclick = () => { $('server-url').value = DEFAULT_SERVER; $('btn-save-server').onclick(); };

  const bindToggle = (id, key, onChange) => {
    const el = $(id);
    el.checked = settings[key];
    el.onchange = () => { settings[key] = el.checked; store.set('opt.' + key, el.checked); if (onChange) onChange(el.checked); requestDraw(); };
  };
  bindToggle('opt-labels', 'labels');
  bindToggle('opt-items', 'items');
  bindToggle('opt-map-belt', 'mapBelt', () => state && state.inGame && renderMapBelt(state));
  bindToggle('show-hidden-quests', 'hiddenQuests', () => state && state.inGame && renderQuests(state));
  bindToggle('opt-keep-focus', 'keepFocus');
  bindToggle('opt-keep-screen', 'keepScreen', (v) => native && native.setKeepScreenOn && native.setKeepScreenOn(v));
  if (native && native.setKeepScreenOn) native.setKeepScreenOn(settings.keepScreen);

  const langButtons = document.querySelectorAll('#opt-lang button');
  const markLang = () => langButtons.forEach((b) => b.classList.toggle('active', b.dataset.lang === langSetting));
  markLang();
  langButtons.forEach((b) => {
    b.onclick = () => {
      langSetting = b.dataset.lang;
      store.set('opt.lang', langSetting);
      markLang();
      applyLang();
      $('conn-status').dataset.init = '';
      setConnected(connected);
      if (state) onState(state);
    };
  });

  // ------------------------------------------------------------------ boot
  window.addEventListener('resize', resize);
  setFollow(true);
  showTab(store.get('tab', 'hud'));
  resize();
  poll();
})();
