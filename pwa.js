'use strict';
/* Tamat PWA: cadangan/impor data, penyimpanan permanen, petunjuk pasang ke Layar Utama. */
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* overlay tunggal, terhubung ke tombol back/swipe-back lewat window.onBack */
const ov = (() => {
  const el = h('section', 'ov'); el.id = 'backup'; el.hidden = true;
  const head = h('header', 'ov-head'), back = h('button', 'ov-back', '‹ Back'); back.onclick = () => history.back();
  head.append(back, h('span', 'ov-title', 'Backup'));
  const body = h('div', 'ov-body'); el.append(head, body); document.body.append(el);
  let open = false;
  const o = {
    body,
    show() { open = true; el.hidden = false; el.scrollTop = 0; requestAnimationFrame(() => el.classList.add('in')); history.pushState({ o: 'backup' }, ''); },
    hide() { open = false; el.classList.remove('in'); setTimeout(() => { if (!open) el.hidden = true; }, 260); },
  };
  window.onBack = () => { if (!open) return false; o.hide(); return true; };
  return o;
})();

const mb = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(1) + ' MB';
const LS_KEYS = ['theme', 'fs', 'rate_pdf', 'rate_epub', 'rate_c'];

async function buildBackup(setMsg) {
  const zip = new JSZip(), list = await DB.all();
  const meta = [];
  let i = 0;
  for (const b of list) {
    setMsg(`Preparing ${++i}/${list.length}…`);
    const f = await DB.file(b.id); if (!f) continue;
    const { reflow, cover, ...m } = b; m.ext = b.type === 'pdf' ? 'pdf' : 'epub';
    if (cover instanceof Blob) { m.coverType = cover.type; zip.file('covers/' + b.id, cover, { compression: 'STORE' }); }
    meta.push(m); zip.file(`files/${b.id}.${m.ext}`, f, { compression: 'STORE' });
  }
  const prefs = {}; for (const k of LS_KEYS) { const v = ls.get(k, null); if (v != null) prefs[k] = v; }
  zip.file('tamat.json', JSON.stringify({ app: 'tamat', v: 1, at: Date.now(), books: meta, stats, prefs }));
  setMsg('Packing…');
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

async function importBackup(file, setMsg) {
  const zip = await JSZip.loadAsync(file);
  const j = zip.file('tamat.json'); if (!j) throw new Error('not a Tamat backup');
  const data = JSON.parse(await j.async('string'));
  if (data.app !== 'tamat') throw new Error('not a Tamat backup');
  const have = new Map((await DB.all()).map(b => [b.id, b]));
  let added = 0, updated = 0, i = 0;
  for (const m of data.books) {
    setMsg(`Restoring ${++i}/${data.books.length}…`);
    const { ext, ...b } = m, cur = have.get(b.id);
    if (cur) {
      if ((b.lastRead || 0) > (cur.lastRead || 0)) { await DB.save({ ...cur, pos: b.pos, lastRead: b.lastRead, done: b.done, doneAt: b.doneAt, spent: b.spent, rate: b.rate, samples: b.samples }); updated++; }
      continue;
    }
    const z = zip.file(`files/${b.id}.${ext}`); if (!z) continue;
    const blob = new Blob([await z.async('arraybuffer')], { type: ext === 'pdf' ? 'application/pdf' : 'application/epub+zip' });
    const cz = zip.file('covers/' + b.id); if (cz) b.cover = new Blob([await cz.async('arraybuffer')], { type: b.coverType || 'image/jpeg' }); delete b.coverType;
    b.hasReflow = false; b.reflowV = undefined; b.reflowTried2 = false; // teks hasil ekstrak PDF dibuat ulang saat dibuka
    await DB.add(b, blob); added++;
  }
  for (const [d, s] of Object.entries(data.stats || {})) stats[d] = Math.max(stats[d] || 0, s);
  ls.set('stats', stats);
  for (const [k, v] of Object.entries(data.prefs || {})) if (ls.get(k, null) == null) ls.set(k, v);
  return { added, updated };
}

async function showBackup() {
  const root = ov.body; root.replaceChildren();
  root.append(h('h3', '', 'Storage'));
  const st = h('p', 'stat', 'Checking…'); root.append(st);
  const refreshStat = async () => {
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const n = (await DB.all()).length;
    st.textContent = `${n} books · using ${est?.usage != null ? mb(est.usage) : '?'} · persistent storage: ${persisted ? 'on ✓' : 'not yet'}`;
  };
  refreshStat();
  if (navigator.storage?.persist) {
    const p = h('button', 'btn', 'Request persistent storage');
    p.onclick = async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Persistent storage on' : 'Browser has not allowed it yet'); refreshStat(); };
    root.append(p);
  }
  if (isIOS && !standalone) root.append(h('p', 'hint', 'Tip: open Tamat from its Home Screen icon (Share → Add to Home Screen). Safari can erase data of sites you rarely visit; Home Screen apps are much safer.'));

  root.append(h('h3', '', 'Back up'));
  root.append(h('p', 'hint', 'Save all your books + reading progress as one .zip file. Keep it in Files / iCloud Drive, or send it to yourself.'));
  const ex = h('button', 'btn pri', 'Create backup'), msg = h('p', 'hint', ''), out = h('div');
  ex.onclick = async () => {
    ex.disabled = true; out.replaceChildren();
    try {
      const blob = await buildBackup(t => msg.textContent = t);
      const name = `tamat-cadangan-${dayKey()}.zip`, file = new File([blob], name, { type: 'application/zip' });
      msg.textContent = `Ready: ${name} (${mb(blob.size)})`;
      if (navigator.canShare?.({ files: [file] })) {
        const s = h('button', 'btn pri', 'Save / Share');
        s.onclick = () => navigator.share({ files: [file], title: name }).catch(e => { if (e.name !== 'AbortError') toast('Could not share'); });
        out.append(s);
      }
      const a = h('a', 'btn', 'Download .zip'); a.href = URL.createObjectURL(blob); a.download = name;
      a.style.cssText = 'display:inline-flex;align-items:center;text-decoration:none;color:inherit';
      out.append(a);
    } catch (e) { console.error(e); msg.textContent = 'Backup failed: ' + e.message; }
    ex.disabled = false;
  };
  root.append(ex, msg, out);

  root.append(h('h3', '', 'Restore'));
  root.append(h('p', 'hint', 'Pick a backup .zip. Books you already have are kept; newer progress wins.'));
  const im = h('button', 'btn', 'Choose backup file'), inp = h('input'); inp.type = 'file'; inp.accept = '.zip,application/zip'; inp.hidden = true;
  const msg2 = h('p', 'hint', '');
  im.onclick = () => inp.click();
  inp.onchange = async () => {
    const f = inp.files[0]; inp.value = ''; if (!f) return;
    im.disabled = true;
    try { const r = await importBackup(f, t => msg2.textContent = t); msg2.textContent = `Done: ${r.added} books restored, ${r.updated} progress updated.`; await refreshLibrary(); refreshStat(); }
    catch (e) { console.error(e); msg2.textContent = 'Restore failed: ' + e.message; }
    im.disabled = false;
  };
  root.append(im, inp, msg2);
  ov.show();
}
$('#go-backup').onclick = showBackup;

/* ---------------- install guide (visual) ---------------- */
const ACC = '#b4501a';
const svgEl = (w, hgt, inner) => `<svg viewBox="0 0 ${w} ${hgt}" xmlns="http://www.w3.org/2000/svg" role="img">${inner}</svg>`;
const ring = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ACC}" stroke-width="3"><animate attributeName="r" values="${r};${r + 5};${r}" dur="1.6s" repeatCount="indefinite"/></circle>`;
const shareIcon = (x, y, c = '#007aff') => `<g transform="translate(${x - 8} ${y - 10})" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V2M4 6l4-4 4 4"/><path d="M3 9H1.5v11h13V9H13"/></g>`;
const bar = (x, y, w, t) => `<rect x="${x}" y="${y}" width="${w}" height="22" rx="11" fill="#e6e3dc"/><text x="${x + w / 2}" y="${y + 15}" text-anchor="middle" font-size="9" fill="#555" font-family="system-ui">${t}</text>`;
const row = (x, y, w, t, hot, ic) => `<rect x="${x}" y="${y}" width="${w}" height="26" fill="${hot ? '#fff3ea' : '#fff'}" stroke="${hot ? ACC : '#e3e3e3'}" stroke-width="${hot ? 2 : 1}"/><text x="${x + 10}" y="${y + 17}" font-size="9.5" fill="#222" font-family="system-ui" font-weight="${hot ? 700 : 400}">${t}</text>${ic ? `<g transform="translate(${x + w - 24} ${y + 6})" fill="none" stroke="#222" stroke-width="1.6"><rect x="0" y="0" width="14" height="14" rx="3"/><path d="M7 4v6M4 7h6"/></g>` : ''}`;
const icon = (x, y, s, hot) => `<image href="icon-192.png" x="${x}" y="${y}" width="${s}" height="${s}" style="clip-path:inset(0 round ${s * .22}px)"/>${hot ? `<rect x="${x - 3}" y="${y - 3}" width="${s + 6}" height="${s + 6}" rx="${s * .26}" fill="none" stroke="${ACC}" stroke-width="3"/>` : ''}`;
const ghost = (x, y, s) => `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * .22}" fill="#cfd6df"/>`;
const grid = (cols, rows, x0, y0, dx, dy, s, skipC, skipR) => Array.from({ length: cols }, (_, c) => Array.from({ length: rows }, (_, r) => (c === skipC && r === skipR) ? '' : ghost(x0 + c * dx, y0 + r * dy, s)).join('')).join('');

const phone = inner => svgEl(200, 340, `<rect x="6" y="4" width="188" height="332" rx="28" fill="#1c1c1e"/><rect x="12" y="10" width="176" height="320" rx="22" fill="#f6f4ef"/><rect x="70" y="14" width="60" height="14" rx="7" fill="#1c1c1e"/>${inner}`);
const pad = inner => svgEl(260, 340, `<rect x="4" y="4" width="252" height="332" rx="18" fill="#1c1c1e"/><rect x="11" y="11" width="238" height="318" rx="11" fill="#f6f4ef"/>${inner}`);
const brand = (x, y, sz) => `<text x="${x}" y="${y}" text-anchor="middle" font-size="${sz}" font-weight="700" font-family="Georgia" fill="#241f19">Tamat</text>`;

const GUIDE = {
  iPhone: [
    ['Open the link in Safari', 'Use Safari, not Chrome or an in-app browser. Type or paste the address.', phone(`${brand(100, 140, 22)}<text x="100" y="160" text-anchor="middle" font-size="9" fill="#777" font-family="system-ui">Your reading app</text>${bar(32, 292, 136, 'rvlviald.github.io')}<rect x="29" y="289" width="142" height="28" rx="14" fill="none" stroke="${ACC}" stroke-width="3"/>`)],
    ['Tap the Share button', 'It is the square with an arrow pointing up, in the bottom bar.', phone(`<rect x="12" y="284" width="176" height="46" fill="#ececec"/><g fill="none" stroke="#007aff" stroke-width="2" stroke-linecap="round"><path d="M32 308l-6-5 6-5"/><path d="M62 298l6 5-6 5"/></g>${shareIcon(100, 304)}<rect x="132" y="298" width="12" height="12" rx="2" fill="none" stroke="#007aff" stroke-width="2"/><rect x="160" y="298" width="12" height="12" rx="2" fill="none" stroke="#007aff" stroke-width="2"/>${ring(100, 304, 17)}`)],
    ['Choose “Add to Home Screen”', 'Scroll down in the share sheet until you see it.', phone(`<rect x="12" y="10" width="176" height="320" rx="22" fill="#00000033"/><rect x="12" y="120" width="176" height="210" rx="18" fill="#f2f2f7"/>${row(24, 150, 152, 'Copy')}${row(24, 176, 152, 'Add Bookmark')}${row(24, 202, 152, 'Add to Home Screen', 1, 1)}${row(24, 228, 152, 'Markup')}${row(24, 254, 152, 'Print')}`)],
    ['Tap “Add”', 'Keep the name “Tamat”, then tap Add in the top-right corner.', phone(`<rect x="12" y="10" width="176" height="320" rx="22" fill="#f2f2f7"/><text x="100" y="50" text-anchor="middle" font-size="8" font-weight="700" font-family="system-ui">Add to Home Screen</text><text x="26" y="50" font-size="8.5" fill="#007aff" font-family="system-ui">Cancel</text><rect x="140" y="38" width="38" height="16" rx="8" fill="none" stroke="${ACC}" stroke-width="2.5"/><text x="159" y="50" text-anchor="middle" font-size="10" font-weight="700" fill="#007aff" font-family="system-ui">Add</text><rect x="24" y="70" width="152" height="64" rx="12" fill="#fff"/>${icon(34, 80, 44)}<text x="90" y="98" font-size="11" font-weight="600" font-family="system-ui">Tamat</text><text x="90" y="114" font-size="8" fill="#888" font-family="system-ui">rvlviald.github.io</text>`)],
    ['Open Tamat from the Home Screen', 'Always open it from this icon. Let it load once so it works offline.', phone(`${grid(4, 3, 26, 50, 38, 62, 30, 1, 1)}${icon(64, 112, 30, 1)}<text x="79" y="154" text-anchor="middle" font-size="8" font-family="system-ui" fill="#333">Tamat</text>`)],
  ],
  iPad: [
    ['Open the link in Safari', 'Use Safari. Type or paste the address in the top bar.', pad(`<rect x="11" y="11" width="238" height="30" fill="#ececec"/>${bar(70, 15, 120, 'rvlviald.github.io')}<rect x="67" y="12" width="126" height="28" rx="14" fill="none" stroke="${ACC}" stroke-width="3"/>${brand(130, 170, 26)}`)],
    ['Tap the Share button', 'On iPad it is at the top right of the Safari toolbar.', pad(`<rect x="11" y="11" width="238" height="30" fill="#ececec"/>${bar(60, 15, 110, 'rvlviald.github.io')}${shareIcon(212, 26)}${ring(212, 26, 15)}${brand(130, 170, 26)}`)],
    ['Choose “Add to Home Screen”', 'Find it in the list that pops up.', pad(`<rect x="11" y="11" width="238" height="30" fill="#ececec"/>${shareIcon(212, 26)}<rect x="96" y="44" width="148" height="170" rx="12" fill="#f2f2f7" stroke="#d0d0d0"/>${row(104, 54, 132, 'Copy')}${row(104, 80, 132, 'Add Bookmark')}${row(104, 106, 132, 'Add to Home Screen', 1, 1)}${row(104, 132, 132, 'Markup')}${row(104, 158, 132, 'Print')}`)],
    ['Tap “Add”', 'Keep the name “Tamat”, then tap Add.', pad(`<rect x="11" y="11" width="238" height="318" rx="11" fill="#00000022"/><rect x="40" y="90" width="180" height="130" rx="14" fill="#f2f2f7"/><text x="130" y="112" text-anchor="middle" font-size="8" font-weight="700" font-family="system-ui">Add to Home Screen</text><text x="52" y="112" font-size="8" fill="#007aff" font-family="system-ui">Cancel</text><rect x="180" y="100" width="34" height="16" rx="8" fill="none" stroke="${ACC}" stroke-width="2.5"/><text x="197" y="112" text-anchor="middle" font-size="10" font-weight="700" fill="#007aff" font-family="system-ui">Add</text><rect x="52" y="126" width="156" height="60" rx="10" fill="#fff"/>${icon(60, 134, 44)}<text x="116" y="156" font-size="11" font-weight="600" font-family="system-ui">Tamat</text><text x="116" y="170" font-size="8" fill="#888" font-family="system-ui">rvlviald.github.io</text>`)],
    ['Open Tamat from the Home Screen', 'Open it from this icon. Let it load once so it works offline.', pad(`${grid(5, 4, 26, 40, 42, 70, 32, 1, 1)}${icon(68, 110, 32, 1)}<text x="84" y="154" text-anchor="middle" font-size="8" font-family="system-ui" fill="#333">Tamat</text>`)],
  ],
};

const guide = (() => {
  const el = h('section', 'ov'); el.id = 'guide'; el.hidden = true;
  const head = h('header', 'ov-head'), back = h('button', 'ov-back', '‹ Back'); back.onclick = () => history.back();
  head.append(back, h('span', 'ov-title', 'Install on iPhone / iPad'));
  const body = h('div', 'ov-body'); el.append(head, body); document.body.append(el);
  let open = false;
  const prev = window.onBack;
  window.onBack = () => { if (open) { o.hide(); return true; } return prev ? prev() : false; };
  const o = {
    show(dev) { render(dev || (isIOS && /iPad|Macintosh/.test(navigator.userAgent) ? 'iPad' : 'iPhone')); open = true; el.hidden = false; el.scrollTop = 0; requestAnimationFrame(() => el.classList.add('in')); history.pushState({ o: 'guide' }, ''); },
    hide() { open = false; el.classList.remove('in'); setTimeout(() => { if (!open) el.hidden = true; }, 260); },
  };
  function render(dev) {
    body.replaceChildren();
    const tabs = h('div', 'filters');
    for (const d of Object.keys(GUIDE)) { const b = h('button', 'chip' + (d === dev ? ' on' : ''), d); b.onclick = () => render(d); tabs.append(b); }
    body.append(tabs, h('p', 'hint', 'Takes 30 seconds. Once installed, Tamat opens full-screen like a normal app and works offline.'));
    GUIDE[dev].forEach(([t, d, svg], i) => {
      const s = h('div', 'step'), fig = h('div', 'fig'); fig.innerHTML = svg;
      const tx = h('div', 'st'); tx.append(h('b', '', `${i + 1}. ${t}`), h('span', '', d)); s.append(fig, tx); body.append(s);
    });
  }
  return o;
})();
$('#lib-actions').prepend(Object.assign(h('button', 'chip', 'Install guide'), { onclick: () => guide.show() }));
if (isIOS && !standalone && !ls.get('hintOff', false)) {
  const hint = h('div', 'install-hint');
  const t = h('span', '', 'Install Tamat on your Home Screen so your books stay safe and work offline. ');
  const a = h('button', 'link', 'Show me how'); a.style.cssText = 'text-decoration:underline;padding:0;min-height:0;color:inherit'; a.onclick = () => guide.show();
  t.append(a); hint.append(t);
  const x = h('button', '', '✕'); x.setAttribute('aria-label', 'Dismiss'); x.onclick = () => { ls.set('hintOff', true); hint.remove(); };
  hint.append(x); $('#lib-actions').after(hint);
}

/* ---------------- little surprises ---------------- */
const PHOTO = 'us.jpg';
function loveCard(title, text, autoMs) {
  const c = h('div', 'love'), img = h('img'); img.src = PHOTO; img.alt = '';
  const tx = h('div', 'love-t'); tx.append(h('b', '', title), h('span', '', text));
  c.append(img, tx); c.onclick = () => c.remove(); document.body.append(c);
  requestAnimationFrame(() => c.classList.add('in')); if (autoMs) setTimeout(() => c.remove(), autoMs);
}
window.onProgress = b => {
  if (!b.half && !b.done && b.total && b.pos / b.total >= .5) { b.half = true; loveCard('Halfway there!', 'I love you ♥', 6000); }
};
(() => { // photo on the "Tamat." sheet
  const sheet = $('#done .sheet'), img = h('img', 'done-photo'); img.src = PHOTO; img.alt = '';
  sheet.prepend(img); sheet.append(h('p', 'love-line', 'I love you ♥'));
})();
