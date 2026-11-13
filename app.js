'use strict';
/* Tamat — pembaca PDF + EPUB yang mendorong kamu menamatkan bacaan. */

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ---------------- storage ---------------- */
const DB = (() => {
  let p;
  const open = () => p ??= new Promise((res, rej) => {
    const r = indexedDB.open('tamat', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const [n, o] of [['books', { keyPath: 'id' }], ['files'], ['words', { keyPath: 'id' }], ['kv']]) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o);
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const run = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode); let out;
      try { out = fn(...stores.map(s => t.objectStore(s))); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out?.result); t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    run,
    all: () => run(['books'], 'readonly', s => s.getAll()),
    file: id => run(['files'], 'readonly', s => s.get(id)),
    save: b => run(['books'], 'readwrite', s => s.put({ ...b, reflow: undefined })),
    putFile: (k, v) => run(['files'], 'readwrite', s => s.put(v, k)),
    add: (b, f) => run(['books', 'files'], 'readwrite', (s, fl) => { s.put({ ...b, reflow: undefined }); return fl.put(f, b.id); }),
    del: id => run(['books', 'files'], 'readwrite', (s, f) => { s.delete(id); f.delete(id + ':reflow'); return f.delete(id); }),
  };
})();

const ls = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const fmtDate = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const dayKey = () => fmtDate(new Date());
const stats = ls.get('stats', {});
function addRead(sec) { const k = dayKey(); stats[k] = (stats[k] || 0) + sec; ls.set('stats', stats); }
function streak() {
  let n = 0; const d = new Date();
  if (!(stats[fmtDate(d)] > 30)) d.setDate(d.getDate() - 1);
  while (stats[fmtDate(d)] > 30) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------------- time estimate ---------------- */
// Satuan progres & estimasi = KARAKTER (non-spasi). Laju baca: detik per karakter (default ≈ 1070 karakter/menit ≈ 230 kata/menit; rata-rata kata Inggris ≈ 4,65 karakter non-spasi).
// Buku yang belum dimigrasi (b.cv kosong) masih memakai laju lama (per kata / per halaman) sampai migrasi selesai.
const nchars = s => String(s || '').replace(/\s+/g, '').length;
const defRate = (t, b) => t === 'pdf' ? ls.get('rate_pdf', 75) : (b && !b.cv ? ls.get('rate_epub', 0.26) : ls.get('rate_c', 0.056));
const legacyPdf = b => b.type === 'pdf' && !b.wv; // belum dimigrasi ke satuan kata
const kind = b => (legacyPdf(b) && b.mode !== 'text') ? 'pdf' : 'epub';
// persentase selalu berbasis KATA (bukan halaman); tidak pernah 100% sebelum benar-benar tamat
const pctOf = (pos, total, done) => done ? 100 : clamp(Math.floor((pos || 0) / Math.max(total || 1, 1) * 100), 0, 99);
const rateOf = b => b.rate || defRate(kind(b), b);
const remaining = b => Math.max(0, (b.total || 1) - (b.pos || 0)) * rateOf(b);
function fmt(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return '< 1 min';
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/* ---------------- helpers ---------------- */
const h = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  if (tag === 'button') e.type = 'button';
  return e;
};
let toastT;
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2400);
}
const project = (v, d = .994) => (v / 1000) * d / (1 - d);
const rubber = (o, dim, c = .55) => Math.sign(o) * (Math.abs(o) * dim * c) / (dim + c * Math.abs(o));

/* ---------------- spring (damping ratio + response, a la Apple) ---------------- */
let springRaf = 0, springCancel = null;
function cancelSpring() { cancelAnimationFrame(springRaf); springCancel?.(false); springCancel = null; }
function springP(from, to, v, { response = .32, damping = 1 } = {}, step) {
  cancelSpring();
  if (!Number.isFinite(from)) from = to || 0;
  if (!Number.isFinite(to)) to = 0;
  if (!Number.isFinite(v)) v = 0;
  if (reduceMotion) { step(to); return Promise.resolve(true); }
  return new Promise(resolve => {
    springCancel = resolve;
    let x = from, vel = v;
    const k = (2 * Math.PI / response) ** 2, c = 2 * damping * Math.sqrt(k);
    let last = performance.now();
    const tick = now => {
      const dt = Math.min((now - last) / 1000, 1 / 30); last = now;
      const n = Math.max(1, Math.ceil(dt / .004)), hh = dt / n;
      for (let i = 0; i < n; i++) { vel += (-k * (x - to) - c * vel) * hh; x += vel * hh; }
      step(x);
      if (Math.abs(x - to) < .35 && Math.abs(vel) < 6) { step(to); springCancel = null; resolve(true); return; }
      springRaf = requestAnimationFrame(tick);
    };
    springRaf = requestAnimationFrame(tick);
  });
}

/* ---------------- EPUB parsing (import) ---------------- */
const resolvePath = (base, rel) => decodeURIComponent(new URL(rel, 'http://x/' + base).pathname.slice(1));
async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file);
  const xml = async p => new DOMParser().parseFromString(await zip.file(p).async('string'), 'application/xml');
  const cont = await xml('META-INF/container.xml');
  const opfPath = cont.querySelector('rootfile').getAttribute('full-path');
  const opf = await xml(opfPath);
  const manifest = {};
  opf.querySelectorAll('manifest > item').forEach(i => manifest[i.getAttribute('id')] = i.getAttribute('href'));
  const title = opf.querySelector('metadata title')?.textContent.trim() || file.name.replace(/\.epub$/i, '');
  const author = opf.querySelector('metadata creator')?.textContent.trim() || '';
  const chaps = [];
  let i = 0;
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const href = manifest[ref.getAttribute('idref')]; if (!href) continue;
    const path = resolvePath(opfPath, href);
    const f = zip.file(path); if (!f) continue;
    const doc = new DOMParser().parseFromString(await f.async('string'), 'text/html');
    const chars = nchars(doc.body?.textContent || '');
    const hasImg = !!doc.querySelector('img, svg image');
    const ttl = doc.querySelector('h1, h2, h3')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) || '';
    if (!chars && !hasImg) continue;
    chaps.push({ path, chars: Math.max(chars, hasImg ? 200 : 1), title: ttl });
    i++;
  }
  if (!chaps.length) throw new Error('EPUB kosong');
  const cover = await epubCover(zip, opf, opfPath, manifest).catch(() => null);
  const lang = (opf.querySelector('metadata language')?.textContent || '').trim().slice(0, 2).toLowerCase();
  return { type: 'epub', title, author, lang, cover, chaps, total: chaps.reduce((a, c) => a + c.chars, 0), pos: 0, cv: 1, wv: 1 };
}


/* ---------------- covers ---------------- */
const THUMB_W = 320;
async function thumbOf(src, w, h) {
  const s = THUMB_W / w, c = document.createElement('canvas'); c.width = THUMB_W; c.height = Math.round(h * s);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', .82));
}
async function pdfCover(pdf) {
  const pg = await pdf.getPage(1), v0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: THUMB_W / v0.width });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  await pg.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
  return new Promise(r => c.toBlob(r, 'image/jpeg', .82));
}
async function epubCover(zip, opf, opfPath, manifest) {
  let href = opf.querySelector('manifest > item[properties~="cover-image"]')?.getAttribute('href');
  if (!href) { const id = opf.querySelector('metadata meta[name="cover"]')?.getAttribute('content'); if (id) href = manifest[id]; }
  if (!href) href = Object.values(manifest).find(v => /cover.*\.(jpe?g|png|webp)$/i.test(v));
  const f = href && zip.file(resolvePath(opfPath, href)); if (!f) return null;
  const bmp = await createImageBitmap(await f.async('blob'));
  return thumbOf(bmp, bmp.width, bmp.height);
}
async function ensureCover(b) {
  if (b.cover || b.coverTried) return false;
  b.coverTried = true;
  try {
    const f = await DB.file(b.id);
    if (b.type === 'pdf') { const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise; b.cover = await pdfCover(pdf); pdf.destroy(); }
    else { const zip = await JSZip.loadAsync(f); const cont = new DOMParser().parseFromString(await zip.file('META-INF/container.xml').async('string'), 'application/xml'); const p = cont.querySelector('rootfile').getAttribute('full-path'); const opf = new DOMParser().parseFromString(await zip.file(p).async('string'), 'application/xml'); const m = {}; opf.querySelectorAll('manifest > item').forEach(i => m[i.getAttribute('id')] = i.getAttribute('href')); b.cover = await epubCover(zip, opf, p, m); }
  } catch (e) { console.warn('cover', e); }
  await DB.save(b); return !!b.cover;
}
const coverUrls = new Map();
function coverEl(b, cls) {
  const d = h('div', 'cover ' + cls);
  if (b.cover) { if (!coverUrls.has(b.id)) coverUrls.set(b.id, URL.createObjectURL(b.cover)); const i = h('img'); i.src = coverUrls.get(b.id); i.alt = ''; d.append(i); }
  else d.append(h('span', '', (b.title || '?').slice(0, 1).toUpperCase()));
  return d;
}

/* ---------------- library ---------------- */
let books = [];
let showAll = false, showDoneList = false;

async function refreshLibrary() {
  books = await DB.all(); renderLibrary();
  let changed = false; for (const b of books) if (await ensureCover(b)) changed = true;
  if (changed) renderLibrary();
}

function renderLibrary() {
  const root = $('#lib-body');
  if (!root) return;
  root.replaceChildren();
  const today = stats[dayKey()] || 0, st = streak();
  $('#today').textContent = [today > 30 ? `Today ${fmt(today)}` : '', st >= 2 ? `${st}-day streak` : ''].filter(Boolean).join(' · ') || (books.length ? 'Pick up where you left off.' : '');

  if (!books.length) {
    const e = h('div', 'empty');
    e.append(h('h2', '', 'Nothing to read yet'), h('p', '', 'Add a PDF (including scanned/OCR) or EPUB. Tamat handles the rest.'));
    const b = h('button', 'primary', 'Add books'); b.onclick = () => $('#file').click();
    e.append(b); root.append(e); $('.lib-foot').hidden = true; return;
  }
  $('.lib-foot').hidden = false;

  const active = books.filter(b => !b.done).sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));
  const done = books.filter(b => b.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  const cur = active[0];
  if (cur) {
    const hero = h('button', 'hero');
    const rem = remaining(cur), pct = pctOf(cur.pos, cur.total, cur.done);
    const top = h('div', 'hero-top'), txt = h('div', 'hero-txt');
    txt.append(h('div', 'eyebrow', (cur.lastRead ? 'Continue' : 'Start') + (cur.isScanned ? ' · OCR' : '')), h('h2', '', cur.title));
    if (cur.author) txt.append(h('p', 'author', cur.author));
    top.append(coverEl(cur, 'cover-lg'), txt); hero.append(top);
    const big = h('div', 'big'); big.append(document.createTextNode(fmt(rem)), h('small', '', ' left to finish')); hero.append(big);
    const bar = h('div', 'bar'); const fill = h('i'); bar.append(fill); hero.append(bar);
    requestAnimationFrame(() => fill.style.width = pct + '%');
    hero.append(h('div', 'meta', `${pct}% done`), h('span', 'go', cur.lastRead ? 'Keep reading' : 'Start reading'));
    hero.onclick = () => openBook(cur.id);
    root.append(hero);
  }

  const rest = active.slice(1).sort((a, b) => remaining(a) - remaining(b)); // paling dekat selesai di atas
  if (rest.length) {
    root.append(h('p', 'section-label', 'Up next'));
    (showAll ? rest : rest.slice(0, 3)).forEach(b => root.append(item(b)));
    if (rest.length > 3 && !showAll) { const x = h('button', 'expand', `${rest.length - 3} more`); x.onclick = () => { showAll = true; renderLibrary(); }; root.append(x); }
  }
  if (done.length) {
    const x = h('button', 'expand', `${showDoneList ? 'Hide' : 'Finished'} · ${done.length}`);
    x.style.marginTop = '20px'; x.onclick = () => { showDoneList = !showDoneList; renderLibrary(); }; root.append(x);
    if (showDoneList) done.forEach(b => root.append(item(b, true)));
  }
}

function item(b, isDone) {
  const w = h('div', 'item-wrap'); w.style.position = 'relative';
  const it = h('button', 'item');
  const tx = h('div', 'item-txt');
  tx.append(h('div', 't', b.title));
  tx.append(h('div', 's', isDone ? 'Finished' : `${fmt(remaining(b))} left · ${pctOf(b.pos, b.total, b.done)}%${b.isScanned ? ' · OCR' : ''}`));
  if (!isDone) { const bar = h('div', 'bar'); const f = h('i'); f.style.width = pctOf(b.pos, b.total, b.done) + '%'; bar.append(f); tx.append(bar); }
  it.append(coverEl(b, 'cover-sm'), tx);
  it.onclick = () => openBook(b.id);
  const more = h('button', 'more', '⋯'); more.setAttribute('aria-label', 'Book menu');
  more.onclick = async e => { e.stopPropagation(); if (window.bookMenu) return bookMenu(b); if (confirm(`Remove "${b.title}" from Tamat?`)) { await DB.del(b.id); refreshLibrary(); } };
  w.append(it, more); return w;
}

async function addFiles(files) {
  let n = 0;
  for (const f of files) {
    try {
      toast(`Adding ${f.name}…`);
      const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
      let meta;
      if (isPdf) {
        const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
        const info = (await pdf.getMetadata().catch(() => null))?.info || {};
        const { cw, isScanned } = await pdfCharMap(pdf);
        meta = { type: 'pdf', title: info.Title?.trim() || f.name.replace(/\.pdf$/i, '').replace(/_+/g, ' '), author: info.Author?.trim() || '', pages: pdf.numPages, cw, isScanned, ptotal: cw[cw.length - 1], total: cw[cw.length - 1], pos: 0, cv: 1, wv: 1, cover: await pdfCover(pdf).catch(() => null) };
        pdf.destroy();
      } else meta = await parseEpub(f);
      const book = { id: crypto.randomUUID(), ...meta, addedAt: Date.now(), lastRead: 0, rate: null, samples: [], spent: 0, done: false, ms: 0 };
      await DB.add(book, f); n++;
    } catch (e) { console.error(e); toast(`Couldn't open ${f.name}`); }
  }
  if (n) { toast(n === 1 ? 'Book added' : `${n} books added`); await refreshLibrary(); }
}
$('#add').onclick = () => $('#file').click();
$('#file').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addFiles(fs); };


/* ---------------- peta karakter (satuan progres & estimasi waktu = karakter) ---------------- */
async function pdfCharMap(pdf, prog) {
  const n = pdf.numPages, c = []; let sum = 0;
  for (let p = 1; p <= n; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent(); let t = '';
    for (const it of tc.items) t += it.str;
    const k = nchars(t); c.push(k); sum += k;
    prog?.(p / n); if (p % 8 === 0) await new Promise(r => setTimeout(r));
  }
  const isScanned = sum / Math.max(1, n) < 120; // PDF hasil scan: tak ada teks, pakai bobot tetap per halaman
  const cw = [0]; for (const k of c) cw.push(cw[cw.length - 1] + (isScanned ? 1500 : Math.max(k, 60)));
  cw.isScanned = isScanned;
  return { cw, isScanned };
}
const textOfHtml = html => new DOMParser().parseFromString(html, 'text/html').body?.textContent || '';
const unitJobs = new Map();
// hitung ulang ukuran buku dalam karakter; posisi baca dipertahankan (sebagai pecahan), laju baca lama dibuang karena satuannya berbeda
function ensureUnits(b, blob, prog) {
  if (b.cv) return Promise.resolve();
  if (unitJobs.has(b.id)) return unitJobs.get(b.id);
  const job = (async () => {
    const f = b.total ? b.pos / b.total : 0;
    if (b.type === 'pdf') {
      const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
      const { cw, isScanned } = await pdfCharMap(pdf, prog); pdf.destroy();
      if (b.cv) return;
      b.cw = cw; b.isScanned = isScanned; b.ptotal = cw[cw.length - 1]; b.pages = cw.length - 1;
      if (b.hasReflow) {
        const rf = await DB.file(b.id + ':reflow');
        if (rf) {
          for (const c of rf.chaps) { c.chars = nchars(textOfHtml(c.html)) + (c.html.match(/<figure/g) || []).length * 200; delete c.words; }
          rf.total = rf.chaps.reduce((a, c) => a + c.chars, 0); await DB.putFile(b.id + ':reflow', rf); b.rtotal = rf.total;
        }
      }
      b.total = (b.mode || 'page') === 'page' ? b.ptotal : b.rtotal;
    } else {
      const zip = await JSZip.loadAsync(blob);
      for (const c of b.chaps) {
        const fl = zip.file(c.path); const doc = new DOMParser().parseFromString(fl ? await fl.async('string') : '', 'text/html');
        c.chars = Math.max(nchars(doc.body?.textContent || ''), doc.querySelector('img, svg image') ? 200 : 1); delete c.words;
        await new Promise(r => setTimeout(r));
      }
      b.total = b.chaps.reduce((a, c) => a + c.chars, 0);
    }
    b.pos = f * b.total; b.rate = null; b.samples = []; b.alt = { rate: null, samples: [] }; b.cv = 1; b.wv = 1;
  })().finally(() => unitJobs.delete(b.id));
  unitJobs.set(b.id, job); return job;
}
async function migrateBooks() {
  let ch = false;
  for (const b of books) if (!b.cv) {
    try { await ensureUnits(b, await DB.file(b.id)); await DB.save(b); ch = true; } catch (e) { console.warn('migrate', e); }
  }
  if (ch) renderLibrary();
}

/* ---------------- PDF → teks yang bisa reflow + OCR & Pecah Gambar ---------------- */
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const med = a => { if (!a || !a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
async function pageFigures(pg, vp, textWords) {
  const ops = await pg.getOperatorList(), O = pdfjsLib.OPS, boxes = [], stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const paint = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintJpegXObject].filter(x => x != null));
  ops.fnArray.forEach((fn, i) => {
    const ar = ops.argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() || ctm;
    else if (fn === O.transform) ctm = mul(ar, ctm);
    else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); if (ar && ar[0]) ctm = mul(ar[0], ctm); }
    else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (paint.has(fn)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => pdfjsLib.Util.applyTransform([ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]], vp.transform));
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  });
  let bs = boxes.filter(b => b.x1 - b.x0 >= 45 && b.y1 - b.y0 >= 45);
  for (let merged = true; merged;) { // gabung kotak yang bersentuhan
    merged = false;
    outer: for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const p = bs[i], q = bs[j];
      if (p.x0 - 6 < q.x1 && q.x0 - 6 < p.x1 && p.y0 - 6 < q.y1 && q.y0 - 6 < p.y1) {
        bs[i] = { x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1) }; bs.splice(j, 1); merged = true; break outer;
      }
    }
  }
  const area = vp.width * vp.height;
  bs = bs.filter(b => !((b.x1 - b.x0) * (b.y1 - b.y0) > area * .85)); // latar halaman hasil scan
  if (!bs.length) return [];
  const sc = 2, rv = pg.getViewport({ scale: sc }), c = document.createElement('canvas'); c.width = Math.floor(rv.width); c.height = Math.floor(rv.height);
  const cx = c.getContext('2d', { alpha: false }); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: cx, viewport: rv }).promise;
  return bs.map(b => {
    const x = Math.max(0, b.x0 * sc), y = Math.max(0, b.y0 * sc), w = Math.min(c.width - x, (b.x1 - b.x0) * sc), hh = Math.min(c.height - y, (b.y1 - b.y0) * sc);
    const k = Math.min(1, 1000 / w), o = document.createElement('canvas'); o.width = Math.max(1, Math.round(w * k)); o.height = Math.max(1, Math.round(hh * k));
    o.getContext('2d').drawImage(c, x, y, w, hh, 0, 0, o.width, o.height);
    return { ...b, url: o.toDataURL('image/jpeg', .82) };
  });
}
/* Ligatur (fi, fl, ff, ffi, ffl) di banyak PDF diekstrak pdf.js sebagai karakter kosong (\u0000). Pulihkan lewat daftar kata Inggris. */
let FREQ = null;
async function loadFreq() {
  if (FREQ) return FREQ; FREQ = new Map();
  try { (await (await fetch('vendor/en-freq.txt')).text()).split('\n').forEach((w, i) => { w = w.trim(); if (w) FREQ.set(w, i + 1); }); } catch (e) { console.warn('freq', e); }
  return FREQ;
}
const LIGS = ['fi', 'fl', 'ff', 'ffi', 'ffl'];
// model huruf (trigram) dari daftar kata: dipakai bila kata tidak ada di daftar (nama, kata langka, mis. "fluffy")
let TRI = null, BI = null;
function buildLM() {
  TRI = new Map(); BI = new Map();
  for (const w of FREQ.keys()) { const s = '^^' + w + '$'; for (let i = 2; i < s.length; i++) { const b = s.slice(i - 2, i), t = s.slice(i - 2, i + 1); TRI.set(t, (TRI.get(t) || 0) + 1); BI.set(b, (BI.get(b) || 0) + 1); } }
}
function lmScore(w) {
  if (!TRI) buildLM();
  const s = '^^' + w.toLowerCase() + '$'; let sc = 0;
  for (let i = 2; i < s.length; i++) sc += Math.log(((TRI.get(s.slice(i - 2, i + 1)) || 0) + .1) / ((BI.get(s.slice(i - 2, i)) || 0) + 2.7));
  return sc;
}
function wordRank(w) {
  w = w.toLowerCase().replace(/^['’-]+|['’-]+$/g, ''); if (FREQ.has(w)) return FREQ.get(w);
  for (const suf of ['s', 'es', 'ed', 'd', 'ing', 'ly', 'er', 'ers', "'s", '’s']) if (w.length > suf.length + 2 && w.endsWith(suf) && FREQ.has(w.slice(0, -suf.length))) return FREQ.get(w.slice(0, -suf.length)) + 3000;
  return 0;
}
function fixLig(s) {
  if (!s.includes('\0')) return s;
  return s.replace(/[\p{L}\u0000'’-]*\u0000[\p{L}\u0000'’-]*/gu, tok => {
    const parts = tok.split('\0'), k = parts.length - 1;
    if (k > 2) return parts.join('fi');
    let best = null, bestR = 0; const cands = [];
    const walk = (i, acc) => {
      if (i === k) { cands.push(acc + parts[k]); const r = wordRank(acc + parts[k]); if (r && (!bestR || r < bestR)) { bestR = r; best = acc + parts[k]; } return; }
      for (const l of LIGS) walk(i + 1, acc + parts[i] + l);
    };
    walk(0, '');
    if (best != null) return best;
    let bs = -Infinity; for (const c of cands) { const sc = lmScore(c.replace(/^['’-]+|['’-]+$/g, '')) - 4 * (c.match(/ff[il]/gi) || []).length; if (sc > bs) { bs = sc; best = c; } }
    return best ?? parts.join('fi');
  });
}
const OCR_PAGE_CACHE = new Map();

async function runOcrLines(cv, vp) {
  const pw = vp.width, ph = vp.height;
  if (window.Tesseract || navigator.onLine) {
    try {
      if (!window.Tesseract) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      if (!window._tessWorker) window._tessWorker = await window.Tesseract.createWorker('ind+eng');
      const { data } = await window._tessWorker.recognize(cv);
      const sx = pw / cv.width, sy = ph / cv.height;
      return (data.lines || []).map(l => {
        const b = l.bbox || {};
        const x0 = (b.x0 || 0) * sx, y0 = (b.y0 || 0) * sy;
        const x1 = (b.x1 || 0) * sx, y1 = (b.y1 || 0) * sy;
        return {
          text: String(l.text || '').replace(/\s+/g, ' ').trim(),
          x0, y0, x1, y1,
          h: Math.max(7, (y1 - y0) * 0.78),
        };
      }).filter(l => l.text.length > 0);
    } catch (e) {
      console.warn('Web OCR fallback error:', e);
    }
  }
  return [];
}

function segmentScannedFigures(cv, ocrLines, vp) {
  const W = cv.width, H = cv.height;
  if (W < 40 || H < 40) return { lines: ocrLines, figs: [] };
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H).data;

  const G = Math.max(8, Math.round(Math.min(W, H) / 76));
  const gw = Math.floor(W / G), gh = Math.floor(H / G);
  if (gw < 8 || gh < 8) return { lines: ocrLines, figs: [] };

  const meanLum = new Float32Array(gw * gh);
  const stdLum = new Float32Array(gw * gh);
  const satArr = new Float32Array(gw * gh);
  const lumsSample = [];

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0, sum2 = 0, sumSat = 0, n = 0;
      const yStart = gy * G, xStart = gx * G;
      for (let y = yStart; y < yStart + G; y += 2) {
        const rowOff = y * W;
        for (let x = xStart; x < xStart + G; x += 2) {
          const i = (rowOff + x) * 4;
          const r = img[i], g = img[i + 1], b = img[i + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          sum += lum; sum2 += lum * lum; sumSat += sat; n++;
        }
      }
      const m = sum / n;
      const v = Math.max(0, sum2 / n - m * m);
      const idx = gy * gw + gx;
      meanLum[idx] = m;
      stdLum[idx] = Math.sqrt(v);
      satArr[idx] = sumSat / n;
      if (gx > 2 && gx < gw - 3 && gy > 2 && gy < gh - 3) lumsSample.push(m);
    }
  }

  lumsSample.sort((a, b) => a - b);
  const bgLum = lumsSample.length ? lumsSample[Math.floor(lumsSample.length * 0.78)] : 240;

  const grid = new Uint8Array(gw * gh);
  for (let gy = 2; gy < gh - 2; gy++) {
    for (let gx = 2; gx < gw - 2; gx++) {
      const idx = gy * gw + gx;
      const diff = bgLum - meanLum[idx];
      if (diff > 24 || stdLum[idx] > 22 || satArr[idx] > 28) grid[idx] = 1;
    }
  }

  const sx = W / vp.width, sy = H / vp.height;
  for (const l of ocrLines) {
    const lx0 = Math.floor((l.x0 * sx - G * 0.85) / G);
    const ly0 = Math.floor((l.y0 * sy - G * 0.55) / G);
    const lx1 = Math.ceil((l.x1 * sx + G * 0.85) / G);
    const ly1 = Math.ceil((l.y1 * sy + G * 0.55) / G);
    for (let gy = Math.max(0, ly0); gy <= Math.min(gh - 1, ly1); gy++) {
      for (let gx = Math.max(0, lx0); gx <= Math.min(gw - 1, lx1); gx++) {
        grid[gy * gw + gx] = 0;
      }
    }
  }

  const dil = new Uint8Array(gw * gh);
  for (let gy = 1; gy < gh - 1; gy++) {
    for (let gx = 1; gx < gw - 1; gx++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (grid[(gy + dy) * gw + (gx + dx)]) { any = 1; break; }
        }
      }
      dil[gy * gw + gx] = any;
    }
  }

  const vis = new Uint8Array(gw * gh);
  const rawBoxes = [];
  const q = new Int32Array(gw * gh);

  for (let gy = 1; gy < gh - 1; gy++) {
    for (let gx = 1; gx < gw - 1; gx++) {
      const start = gy * gw + gx;
      if (!dil[start] || vis[start]) continue;
      let head = 0, tail = 0;
      q[tail++] = start;
      vis[start] = 1;
      let minX = gx, maxX = gx, minY = gy, maxY = gy, active = 0;

      while (head < tail) {
        const cur = q[head++];
        const cy = Math.floor(cur / gw), cx = cur - cy * gw;
        if (grid[cur]) active++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny <= 0 || ny >= gh - 1) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            if (nx <= 0 || nx >= gw - 1) continue;
            const ni = ny * gw + nx;
            if (dil[ni] && !vis[ni]) {
              vis[ni] = 1;
              q[tail++] = ni;
            }
          }
        }
      }

      const bwCells = maxX - minX + 1;
      const bhCells = maxY - minY + 1;
      const fill = active / Math.max(1, bwCells * bhCells);
      const rw = (bwCells * G) / W;
      const rh = (bhCells * G) / H;
      const areaRatio = rw * rh;

      const isEdgeLine = (minX <= 3 && rw < 0.08) || (maxX >= gw - 4 && rw < 0.08) ||
                         (minY <= 3 && rh < 0.06) || (maxY >= gh - 4 && rh < 0.06);
      if (isEdgeLine) continue;
      if (rw >= 0.14 && rh >= 0.06 && areaRatio >= 0.016 && areaRatio <= 0.82 && fill >= 0.20) {
        rawBoxes.push({ minX, minY, maxX, maxY, active });
      }
    }
  }

  let merged = true;
  while (merged && rawBoxes.length > 1) {
    merged = false;
    for (let i = 0; i < rawBoxes.length; i++) {
      for (let j = i + 1; j < rawBoxes.length; j++) {
        const a = rawBoxes[i], b = rawBoxes[j];
        const gapX = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
        const gapY = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
        if (gapX <= 2 && gapY <= 2) {
          a.minX = Math.min(a.minX, b.minX);
          a.minY = Math.min(a.minY, b.minY);
          a.maxX = Math.max(a.maxX, b.maxX);
          a.maxY = Math.max(a.maxY, b.maxY);
          a.active += b.active;
          rawBoxes.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }

  const figs = [];
  for (const b of rawBoxes) {
    const pad = Math.round(G * 0.6);
    const px0 = clamp(b.minX * G - pad, 0, W - 1);
    const py0 = clamp(b.minY * G - pad, 0, H - 1);
    const px1 = clamp((b.maxX + 1) * G + pad, px0 + 16, W);
    const py1 = clamp((b.maxY + 1) * G + pad, py0 + 16, H);
    const cw = px1 - px0, ch = py1 - py0;

    const scaleOut = Math.min(1, 780 / Math.max(cw, ch));
    const fc = document.createElement('canvas');
    fc.width = Math.max(1, Math.round(cw * scaleOut));
    fc.height = Math.max(1, Math.round(ch * scaleOut));
    fc.getContext('2d').drawImage(cv, px0, py0, cw, ch, 0, 0, fc.width, fc.height);

    const lx0 = px0 / sx, ly0 = py0 / sy, lx1 = px1 / sx, ly1 = py1 / sy;
    figs.push({
      x0: lx0, y0: ly0, x1: lx1, y1: ly1,
      url: fc.toDataURL('image/jpeg', 0.82),
    });
  }

  const cleanLines = ocrLines.filter(l => {
    const cx = (l.x0 + l.x1) * 0.5;
    const cy = (l.y0 + l.y1) * 0.5;
    const lw = l.x1 - l.x0;
    for (const f of figs) {
      if (cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1) {
        if (lw < (f.x1 - f.x0) * 0.82 && l.text.length < 40) return false;
      }
    }
    return true;
  });

  return { lines: cleanLines, figs };
}

async function ocrScannedPage(pg, vp, cacheKey) {
  if (cacheKey && OCR_PAGE_CACHE.has(cacheKey)) return OCR_PAGE_CACHE.get(cacheKey);
  const targetScale = clamp(1240 / Math.max(vp.width, vp.height, 1), 1.15, 1.8);
  const rv = pg.getViewport({ scale: targetScale });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(rv.width));
  c.height = Math.max(1, Math.floor(rv.height));
  const cx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  cx.fillStyle = '#fff';
  cx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: cx, viewport: rv }).promise;

  const rawLines = await runOcrLines(c, vp);
  const { lines, figs } = segmentScannedFigures(c, rawLines, vp);

  const L = lines.map(l => ({
    s: l.text,
    y: vp.height - l.y0,
    h: l.h,
    x0: l.x0,
    x1: l.x1,
  }));
  for (const f of figs) {
    L.push({
      img: f.url,
      s: '',
      y: vp.height - f.y0,
      h: f.y1 - f.y0,
      x0: f.x0,
      x1: f.x1,
    });
  }
  L.sort((p, q) => q.y - p.y);
  const out = { L, H: vp.height, rawLines };
  if (cacheKey) OCR_PAGE_CACHE.set(cacheKey, out);
  return out;
}

async function extractPdfPageData(pdf, n, bookId) {
  const pg = await pdf.getPage(n), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
  const its = tc.items.filter(i => i.str && i.str.trim()).map(i => ({
    s: i.str, x: i.transform[4], y: i.transform[5],
    h: Math.hypot(i.transform[2], i.transform[3]) || i.height || 10,
    w: i.width,
  }));
  const rawWordCount = its.reduce((acc, i) => acc + i.s.trim().split(/\s+/).length, 0);

  if (rawWordCount < 6) {
    const ocrOut = await ocrScannedPage(pg, vp, `${bookId || 'pdf'}:${n}`);
    return { L: ocrOut.L, H: vp.height, pageNum: n, isScanned: true };
  }

  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = []; let cur = null;
  for (const it of its) {
    if (cur && Math.abs(it.y - cur.y) < .45 * Math.max(it.h, cur.h)) cur.its.push(it);
    else { cur = { y: it.y, its: [it] }; lines.push(cur); }
  }
  const L = lines.map(l => {
    l.its.sort((a, b) => a.x - b.x); let s = '', px = null, h = 0;
    for (const it of l.its) {
      if (px != null && it.x - px > .12 * it.h && !/\s$/.test(s) && !/^\s/.test(it.s)) s += ' ';
      s += it.s; px = it.x + it.w; h = Math.max(h, it.h);
    }
    return { s: fixLig(s.replace(/\s+/g, ' ').trim()), y: l.y, h, x0: l.its[0].x, x1: px };
  }).filter(l => l.s);

  const figs = await pageFigures(pg, vp, L.reduce((t, l) => t + l.s.split(' ').length, 0)).catch(() => []);
  const keep = L.filter(l => {
    const cy = vp.height - l.y;
    return !figs.some(f => l.x0 >= f.x0 - 2 && l.x0 <= f.x1 && cy >= f.y0 - 2 && cy <= f.y1 + 2);
  });
  for (const f of figs) keep.push({ img: f.url, s: '', y: vp.height - f.y0, h: f.y1 - f.y0, x0: f.x0, x1: f.x1 });
  keep.sort((p, q) => q.y - p.y);
  return { L: keep, H: vp.height, pageNum: n, isScanned: false };
}

function buildReflowFromPages(pages) {
  const cloned = pages.map(p => ({ L: [...p.L], H: p.H, pageNum: p.pageNum }));
  const cnt = new Map(), norm = s => s.replace(/\d+/g, '#').toLowerCase();
  const edge = (l, p) => l.y > p.H * .92 || l.y < p.H * .08;
  for (const p of cloned) for (const l of p.L) if (!l.img && edge(l, p)) cnt.set(norm(l.s), (cnt.get(norm(l.s)) || 0) + 1);
  for (const p of cloned) {
    p.L = p.L.filter(l => l.img || !(edge(l, p) && (/^[\divxlc\s.-]{1,8}$/i.test(l.s) || cnt.get(norm(l.s)) >= Math.max(3, cloned.length * .25))));
  }
  const all = cloned.flatMap(p => p.L).filter(l => !l.img);
  const allImgs = cloned.flatMap(p => p.L).filter(l => l.img);
  if (!all.length && !allImgs.length) return null;

  const body = med(all.map(l => l.h)) || 12;
  const gaps = [];
  for (const p of cloned) for (let i = 1; i < p.L.length; i++) {
    if (p.L[i].img || p.L[i - 1].img) continue;
    const g = p.L[i - 1].y - p.L[i].y;
    if (g > 0 && g < body * 3) gaps.push(g);
  }
  const lead = med(gaps) || body * 1.25;
  const paras = []; let cur = null;

  cloned.forEach((p, idx) => {
    const pgNo = p.pageNum || (idx + 1);
    const T = p.L.filter(l => !l.img);
    if (!T.length && !p.L.length) return;
    const x0 = T.length ? Math.min(...T.map(l => l.x0)) : 0;
    const x1 = T.length ? Math.max(...T.map(l => l.x1)) : 1;
    const colW = Math.max(100, x1 - x0);
    p.L.forEach((l, i) => {
      if (l.img) { paras.push({ img: l.img, page: pgNo }); cur = null; return; }
      const prev = (i && !p.L[i - 1].img) ? p.L[i - 1] : null;
      const isH = (l.h > body * 1.28 && l.s.length < 90) || (/^(bab|chapter|bagian|part|prolog|epilog)\b/i.test(l.s) && l.s.length < 70);
      const endS = cur && /[.!?:"”’)]$/.test(cur.t);
      let np = !cur || cur.h || isH;
      if (!np && prev) np = (prev.y - l.y) > lead * 1.45 || (endS && l.x0 > x0 + body * .8) || (endS && prev.x1 - x0 < colW * .72);
      if (!np && !prev) np = endS && (l.x0 > x0 + body * .8);
      if (np) { cur = { t: l.s, h: isH, page: pgNo }; paras.push(cur); }
      else if (/[a-z]-$/i.test(cur.t) && /^[a-z]/i.test(l.s)) cur.t = cur.t.slice(0, -1) + l.s;
      else cur.t += ' ' + l.s;
    });
  });

  const PER = 8, chaps = [];
  for (const p of paras) {
    const k = Math.floor((p.page - 1) / PER);
    let c = chaps[k];
    if (!c) c = chaps[k] = { html: '', chars: 0, title: '', first: p.page, last: p.page };
    if (p.img) { c.html += `<figure><img src="${p.img}" alt=""></figure>`; c.chars += 200; c.last = p.page; continue; }
    c.html += p.h ? `<h2>${esc(p.t)}</h2>` : `<p>${esc(p.t)}</p>`;
    c.chars += Math.max(1, nchars(p.t));
    c.last = p.page;
    if (p.h && !c.title && p.t.length < 45) c.title = p.t;
  }
  const out = chaps.filter(Boolean);
  if (!out.length) return null;
  out.forEach(c => { if (!c.title) c.title = `Pages ${c.first}–${c.last}`; });
  return { chaps: out, total: Math.max(1, out.reduce((a, c) => a + c.chars, 0)) };
}

let bgOcrToken = 0;

async function extractReflow(pdf, prog, book) {
  await loadFreq();
  const totalPages = pdf.numPages;
  const pageMap = new Map();
  let startPg = 1;
  if (book && book.cw && book.pos) {
    let p = 1;
    while (p < totalPages && book.cw[p] < book.pos - 0.5) p++;
    startPg = clamp(p, 1, totalPages);
  }

  const probe = [...new Set([startPg, Math.min(totalPages, startPg + 1)])];
  let scannedHits = 0;
  for (const p of probe) {
    const d = await extractPdfPageData(pdf, p, book?.id);
    pageMap.set(p, d);
    if (d.isScanned) scannedHits++;
  }
  const isScannedBook = scannedHits > 0;
  if (book && isScannedBook) book.isScanned = true;

  const initialCount = isScannedBook ? Math.min(totalPages, 16) : totalPages;
  const order = [];
  const winStart = Math.max(1, startPg - 2);
  for (let p = winStart; p <= totalPages && order.length < initialCount; p++) order.push(p);
  for (let p = 1; p < winStart && order.length < initialCount; p++) order.push(p);

  for (let i = 0; i < order.length; i++) {
    const n = order[i];
    if (!pageMap.has(n)) {
      const d = await extractPdfPageData(pdf, n, book?.id);
      pageMap.set(n, d);
    }
    prog?.((i + 1) / order.length, isScannedBook, pageMap.size, totalPages);
    if (i % 2 === 0) await new Promise(r => setTimeout(r));
  }

  const initialPages = [...pageMap.values()].sort((a, b) => a.pageNum - b.pageNum);
  const initialRes = buildReflowFromPages(initialPages);

  if (isScannedBook && pageMap.size < totalPages && book) {
    const myTok = ++bgOcrToken;
    (async () => {
      try {
        const blob = await DB.file(book.id);
        const bgPdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
        for (let p = 1; p <= totalPages; p++) {
          if (myTok !== bgOcrToken || !S.book || S.book.id !== book.id) { bgPdf.destroy(); return; }
          if (pageMap.has(p)) continue;
          const d = await extractPdfPageData(bgPdf, p, book.id);
          pageMap.set(p, d);
          if (pageMap.size % 8 === 0 || pageMap.size === totalPages) {
            const sorted = [...pageMap.values()].sort((a, b) => a.pageNum - b.pageNum);
            const updated = buildReflowFromPages(sorted);
            if (updated) {
              await DB.putFile(book.id + ':reflow', updated);
              book.reflow = updated;
              book.rtotal = updated.total;
              if (book.mode === 'text') book.total = updated.total;
              await DB.save(book);
              if (reader instanceof EpubReader && reader.mem && S.book?.id === book.id) {
                reader.chaps = updated.chaps;
                reader.total = updated.total;
                reader.starts = [];
                let a = 0;
                for (const c of reader.chaps) { reader.starts.push(a); a += c.chars; }
                ui();
              }
            }
          }
          await new Promise(r => setTimeout(r, 12));
        }
        bgPdf.destroy();
        toast('OCR & figure extraction finished ✓');
      } catch (e) {
        console.warn('Background OCR stopped:', e);
      }
    })();
  }

  return initialRes;
}

function setMode(b, mode) {
  const cur = b.mode || 'page'; if (cur === mode) return;
  const f = b.total ? b.pos / b.total : 0, a = b.alt || { rate: null, samples: [] };
  b.alt = { rate: b.rate, samples: b.samples || [] };
  b.mode = mode; b.total = mode === 'text' ? (b.rtotal || b.ptotal) : b.ptotal;
  b.pos = f * b.total;
  b.rate = a.rate; b.samples = a.samples || [];
}

/* ---------------- Unified Back & Ctrl+Z Undo Stack ---------------- */
const OV = [];
window.OV = OV;

function armHistoryGuard() {
  try {
    if (!history.state || !history.state.tamatGuard) {
      history.pushState({ tamatGuard: true }, '');
    }
  } catch {}
}
try {
  history.replaceState({ tamatRoot: true }, '');
  history.pushState({ tamatGuard: true }, '');
} catch {}

/* ---------------- reader shared state ---------------- */
const view = $('#view'), reader$ = $('#reader');
const R = { sx: 0 };
let reader = null;
let S = { book: null, t: null, saveT: 0, flipping: false, undoStack: [], restoringUndo: false };

function updateUndoBtn() {
  const btn = $('#undo-btn');
  if (!btn) return;
  const stackLen = S.undoStack?.length || 0;
  btn.hidden = stackLen === 0;
  if (stackLen > 0) {
    const top = S.undoStack[stackLen - 1];
    btn.title = `Undo to ${top.label || 'previous position'} (Ctrl+Z)`;
  }
}

function captureReaderSnap(label) {
  if (!S.book || !reader) return null;
  const b = S.book;
  return {
    mode: b.mode || 'page',
    pos: reader.pos,
    page: reader instanceof PdfReader ? reader.page : null,
    ci: reader instanceof EpubReader ? reader.ci : null,
    pg: reader instanceof EpubReader ? reader.pg : null,
    theme: ls.get('theme', 'auto'),
    label: label || reader.where().split(' · ')[0],
  };
}

function pushReaderUndo(snap) {
  if (!snap || S.restoringUndo) return;
  if (!S.undoStack) S.undoStack = [];
  const last = S.undoStack[S.undoStack.length - 1];
  if (last && last.mode === snap.mode && Math.abs((last.pos || 0) - (snap.pos || 0)) < 1 && last.theme === snap.theme) {
    return;
  }
  S.undoStack.push(snap);
  if (S.undoStack.length > 50) S.undoStack.shift();
  updateUndoBtn();
}

async function restoreReaderSnap(snap) {
  if (!snap || !S.book) return false;
  S.restoringUndo = true;
  try {
    const b = S.book;
    if (snap.theme && snap.theme !== ls.get('theme', 'auto')) {
      ls.set('theme', snap.theme);
      applyTheme();
    }
    const curMode = b.mode || 'page';
    if (b.type === 'pdf' && snap.mode !== curMode) {
      setMode(b, snap.mode);
      b.pos = snap.pos;
      await DB.save(b);
      reader?.destroy();
      reader = null;
      await mount(b, await DB.file(b.id));
    } else if (reader instanceof PdfReader && snap.page != null) {
      b.pos = snap.pos;
      await reader.load(snap.page);
    } else if (reader instanceof EpubReader && snap.ci != null) {
      b.pos = snap.pos;
      await reader.loadChapter(snap.ci, 'start');
      reader.pg = clamp(snap.pg || 0, 0, Math.max(0, reader.pages - 1));
      reader.setX();
    } else if (reader) {
      b.pos = snap.pos;
      await reader.jump(clamp(snap.pos / Math.max(1, b.total), 0, 1));
    }
    R.sx = 0;
    reader?.apply?.();
    ui();
    scheduleSave();
    toast(`↶ Back to ${snap.label}`);
    return true;
  } finally {
    S.restoringUndo = false;
    updateUndoBtn();
  }
}

window.undoAction = async () => {
  if (OV.length) {
    OV.pop().hide();
    return true;
  }
  if (!$('#done').hidden) {
    $('#done').hidden = true;
    return true;
  }
  if (reader && S.undoStack?.length > 0) {
    const snap = S.undoStack.pop();
    updateUndoBtn();
    await restoreReaderSnap(snap);
    return true;
  }
  return false;
};

window.goBack = async (source = 'ui') => {
  if (window.onBack?.()) {
    armHistoryGuard();
    return true;
  }
  if (OV.length) {
    OV.pop().hide();
    armHistoryGuard();
    return true;
  }
  if (!$('#done').hidden) {
    $('#done').hidden = true;
    armHistoryGuard();
    return true;
  }
  if (reader) {
    if (source === 'exit-reader') {
      closeReader();
      armHistoryGuard();
      return true;
    }
    if (S.undoStack?.length > 0) {
      const snap = S.undoStack.pop();
      updateUndoBtn();
      await restoreReaderSnap(snap);
      armHistoryGuard();
      return true;
    }
    closeReader();
    armHistoryGuard();
    return true;
  }
  return false;
};

/* ---------------- PDF reader ---------------- */
class PdfReader {
  constructor() { this.zoom = 1; this.ox = 0; this.oy = 0; this.live = 1; this.rtok = 0; this.cv = $('#page'); this.wheelT = 0; this.wheelOn = false; }
  async open(b, blob) {
    this.b = b;
    this.cv.style.display = 'block'; $('#epub').style.display = 'none';
    if (view.clientWidth < 10) await new Promise(r => requestAnimationFrame(r));
    this.pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    this.total = this.pdf.numPages; this.wc = b.cw; this.size = this.wc[this.total];
    await this.load(this.pageAt(b.pos || 0));
  }
  pageAt(w) { let p = 1; while (p < this.total && this.wc[p] < w - .5) p++; return p; }
  get pos() { return this.wc[this.page]; }
  get unit() { return this.wc[this.page] - this.wc[this.page - 1]; }
  where() { return `Page ${this.page} of ${this.total}${this.b?.isScanned ? ' · OCR' : ''} · ${pctOf(this.pos, this.size, this.atEnd())}%`; }
  atEnd() { return this.page >= this.total; }
  canStep(d) { return d > 0 ? this.page < this.total : this.page > 1; }
  async step(d) { await this.load(clamp(this.page + d, 1, this.total)); }
  async jump(frac) { await this.load(this.pageAt(frac * this.size)); }
  async load(n) {
    n = clamp(n, 1, this.total);
    this.page = n;
    const pg = await this.pdf.getPage(n); if (this.page !== n) return;
    this.pg = pg; const v = pg.getViewport({ scale: 1 });
    this.pw = v.width || 600; this.ph = v.height || 800;
    this.oy = 0; await this.draw();
  }
  layout() {
    const W = Math.max(300, view.clientWidth || window.innerWidth);
    const H = Math.max(400, view.clientHeight || window.innerHeight);
    if (!Number.isFinite(this.zoom) || this.zoom < 1) this.zoom = 1;
    if (!Number.isFinite(this.live) || this.live <= 0) this.live = 1;
    this.fit = Math.min(W / this.pw, H / this.ph);
    this.cw = this.pw * this.fit * this.zoom; this.ch = this.ph * this.fit * this.zoom;
    this.cv.style.width = this.cw + 'px'; this.cv.style.height = this.ch + 'px';
    this.clampPos(); this.apply();
  }
  bounds() {
    const W = Math.max(300, view.clientWidth || window.innerWidth);
    const H = Math.max(400, view.clientHeight || window.innerHeight);
    return { x: this.cw <= W ? [(W - this.cw) / 2, (W - this.cw) / 2] : [W - this.cw, 0], y: this.ch <= H ? [(H - this.ch) / 2, (H - this.ch) / 2] : [H - this.ch, 0] };
  }
  clampPos() {
    const b = this.bounds();
    if (!Number.isFinite(this.ox)) this.ox = b.x[0];
    if (!Number.isFinite(this.oy)) this.oy = b.y[0];
    this.ox = clamp(this.ox, ...b.x); this.oy = clamp(this.oy, ...b.y);
  }
  apply() {
    if (!Number.isFinite(R.sx)) R.sx = 0;
    if (!Number.isFinite(this.live) || this.live <= 0) this.live = 1;
    this.cv.style.transform = `translate3d(${this.ox + R.sx}px,${this.oy}px,0) scale(${this.live})`;
  }
  async draw() {
    if (!this.pg) return;
    const t = ++this.rtok; try { this.task?.cancel(); } catch {} this.layout();
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    let sc = this.fit * this.zoom * dpr;
    while (this.pw * sc * this.ph * sc > 16e6) sc *= .9;
    const vp = this.pg.getViewport({ scale: Math.max(0.2, sc) });
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.floor(vp.width)); tmp.height = Math.max(1, Math.floor(vp.height));
    const task = this.task = this.pg.render({ canvasContext: tmp.getContext('2d', { alpha: false }), viewport: vp });
    try { await task.promise; } catch { return; }
    if (t !== this.rtok) return;
    this.cv.width = tmp.width; this.cv.height = tmp.height; this.cv.getContext('2d').drawImage(tmp, 0, 0);
    this.apply();
  }
  swipeable() { return this.zoom <= 1.02 && this.live === 1; }
  pannable() { return !this.swipeable(); }
  panStart() { this.p0 = { x: this.ox, y: this.oy }; }
  pan(dx, dy) {
    const b = this.bounds(), W = view.clientWidth || window.innerWidth, H = view.clientHeight || window.innerHeight;
    const soft = (v, [lo, hi], dim) => v > hi ? hi + rubber(v - hi, dim) : v < lo ? lo - rubber(lo - v, dim) : v;
    this.ox = soft(this.p0.x + dx, b.x, W); this.oy = soft(this.p0.y + dy, b.y, H); this.apply();
  }
  async panEnd() {
    const b = this.bounds(), fx = this.ox, fy = this.oy, tx = clamp(fx, ...b.x), ty = clamp(fy, ...b.y);
    if (tx === fx && ty === fy) return;
    await springP(0, 1, 0, { response: .32 }, s => { this.ox = fx + (tx - fx) * s; this.oy = fy + (ty - fy) * s; this.apply(); });
  }
  pinchStart(c) { this.A = { z0: this.zoom, q: { x: c.x - this.ox, y: c.y - this.oy } }; this.live = 1; }
  place(c) { if (!this.A || !c) return; this.ox = c.x - this.A.q.x * this.live; this.oy = c.y - this.A.q.y * this.live; this.apply(); }
  pinchMove(s, c) { if (!this.A || !Number.isFinite(s) || s <= 0) return; const z0 = this.A.z0; this.live = clamp(s, .7 / z0, 6.5 / z0); this.place(c); }
  async pinchEnd(c) {
    if (!this.A) return;
    const A = this.A, zt = clamp(A.z0 * this.live, 1, 6);
    await springP(this.live, zt / A.z0, 0, { response: .28 }, s => { this.live = s; this.place(c); });
    this.commit(zt);
  }
  commit(zt) { this.zoom = zt; this.live = 1; this.draw(); }
  async doubleTap(c) {
    this.pinchStart(c); const zt = this.zoom > 1.3 ? 1 : 2.5;
    await springP(1, zt / this.A.z0, 0, { response: .32 }, s => { this.live = s; this.place(c); });
    this.commit(zt);
  }
  wheel(e) {
    if (!(e.ctrlKey || e.metaKey)) { this.panStart(); this.pan(-e.deltaX, -e.deltaY); this.panEnd(); return true; }
    const c = { x: e.clientX, y: e.clientY };
    if (!this.wheelOn) { this.pinchStart(c); this.wheelOn = true; this.wheelS = 1; }
    this.wheelS *= Math.exp(-e.deltaY * .01); this.pinchMove(this.wheelS, c);
    clearTimeout(this.wheelT); this.wheelT = setTimeout(async () => { this.wheelOn = false; await this.pinchEnd(c); }, 160);
    return true;
  }
  resize() { if (this.pg) this.draw(); }
  destroy() { try { this.task?.cancel(); } catch {} this.pdf?.destroy(); this.cv.style.display = 'none'; }
}

/* ---------------- EPUB / Reflow reader ---------------- */
class EpubReader {
  constructor() { this.epub = $('#epub'); this.flow = $('#flow'); this.fs = ls.get('fs', 20); this.urls = new Map(); this.live = 1; this.ptok = 0; }
  async open(b, blob) {
    this.b = b; this.mem = b.mode === 'text'; const src = this.mem ? b.reflow : b; this.chaps = src.chaps; this.total = src.total;
    this.starts = []; let a = 0; for (const c of this.chaps) { this.starts.push(a); a += c.chars; }
    if (!this.mem) this.zip = await JSZip.loadAsync(blob);
    this.epub.style.display = 'block'; $('#page').style.display = 'none';
    if (view.clientWidth < 10) await new Promise(r => requestAnimationFrame(r));
    await this.seek(b.pos || 0);
  }
  // posisi = jumlah karakter yang sudah terbaca sampai akhir halaman ini (dipetakan dari teks nyata, bukan dari jumlah halaman)
  thru(pg) {
    const pb = this.pb, w = this.chaps[this.ci]?.chars || 1;
    if (!pb) return ((pg + 1) / Math.max(1, this.pages)) * w;
    return pb[this.pages] > 0 ? pb[Math.min(pg + 1, pb.length - 1)] / pb[this.pages] * w : (pg + 1) / this.pages * w;
  }
  // anchor menahan posisi persis selama zoom/resize sampai pembaca membalik halaman lagi
  get pos() { return this.anchor ?? ((this.starts[this.ci] || 0) + this.thru(this.pg)); }
  get unit() { return this.thru(this.pg) - (this.pg ? this.thru(this.pg - 1) : 0); }
  where() {
    const c = this.chaps[this.ci] || {}, t = c.title && c.title.length < 40 ? c.title : `Part ${this.ci + 1}`;
    return `${t}${this.b?.isScanned ? ' · OCR' : ''} · ${pctOf(this.pos, this.total, this.atEnd())}%`;
  }
  atEnd() { return this.ci === this.chaps.length - 1 && this.pg === this.pages - 1; }
  canStep(d) { return d > 0 ? !this.atEnd() : !(this.ci === 0 && this.pg === 0); }
  async step(d) {
    this.anchor = null;
    if (d > 0) { if (this.pg < this.pages - 1) { this.pg++; this.setX(); } else await this.loadChapter(this.ci + 1, 'start'); }
    else { if (this.pg > 0) { this.pg--; this.setX(); } else await this.loadChapter(this.ci - 1, 'end'); }
  }
  async jump(frac) { this.anchor = null; await this.seek(frac * this.total); }
  async seek(pos) {
    let i = this.starts.findIndex((s, k) => pos <= s + this.chaps[k].chars); if (i < 0) i = this.chaps.length - 1;
    await this.loadChapter(i, clamp(pos - this.starts[i], 0, this.chaps[i].chars));
  }
  async blobUrl(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    const f = this.zip.file(path); if (!f) return null;
    const u = URL.createObjectURL(await f.async('blob')); this.urls.set(path, u); return u;
  }
  async loadChapter(i, where) {
    i = clamp(i, 0, this.chaps.length - 1); const tok = ++this.ptok;
    const ch = this.chaps[i];
    const doc = new DOMParser().parseFromString(this.mem ? `<body>${ch.html}</body>` : await this.zip.file(ch.path).async('string'), 'text/html');
    doc.querySelectorAll('script, style, link, meta, title').forEach(n => n.remove());
    for (const im of doc.querySelectorAll('img, image')) {
      const attr = im.hasAttribute('src') ? 'src' : im.hasAttribute('href') ? 'href' : 'xlink:href';
      const v = im.getAttribute(attr); if (!v || /^(data:|https?:)/.test(v)) continue;
      const u = await this.blobUrl(resolvePath(ch.path, v)); if (u) im.setAttribute(attr, u);
    }
    if (tok !== this.ptok) return;
    this.ci = i; R.sx = 0; this.live = 1;
    this.flow.innerHTML = doc.body.innerHTML;
    this.flow.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
    await Promise.race([Promise.all([...this.flow.querySelectorAll('img')].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))), new Promise(r => setTimeout(r, 2500))]);
    await new Promise(r => requestAnimationFrame(r));
    this.paginate();
    this.pg = where === 'start' ? 0 : where === 'end' ? this.pages - 1 : this.pageAt(where);
    this.pg = clamp(this.pg, 0, Math.max(0, this.pages - 1));
    this.setX(); this.apply();
  }
  paginate() {
    const W = Math.max(300, view.clientWidth || window.innerWidth), H = Math.max(400, view.clientHeight || window.innerHeight), wide = W > 760;
    const side = wide ? (W - 640) / 2 : clamp(W * .075, 20, 34);
    const top = 44 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0), bottom = 64;
    this.pw = Math.max(220, Math.round(W - 2 * side)); this.ph = Math.max(240, Math.round(H - top - bottom));
    // Clear epub transform while measuring bounding rects so column boundaries are never skewed
    const prevTransform = this.epub.style.transform;
    this.epub.style.transform = 'none';
    Object.assign(this.epub.style, { left: side + 'px', top: top + 'px', width: this.pw + 'px', height: this.ph + 'px' });
    this.flow.style.cssText = `--fs:${this.fs}px;width:${this.pw}px;height:${this.ph}px;columns:${this.pw}px;column-gap:0;transform:translate3d(0,0,0)`;
    void this.flow.offsetWidth;
    this.pages = Math.max(1, Math.round(this.flow.scrollWidth / this.pw));
    this.mapChars();
    this.epub.style.transform = prevTransform;
  }
  pageAt(w) { for (let p = 0; p < this.pages; p++) if (this.thru(p) >= w - .01) return p; return this.pages - 1; }
  // hitung jumlah karakter nyata di tiap halaman (kolom) supaya persentase & estimasi waktu konsisten dengan teks, bukan dengan jumlah halaman
  mapChars() {
    const n = this.pages, pw = this.pw, cnt = new Array(n).fill(0), x0 = this.flow.getBoundingClientRect().left;
    const pageOf = r => clamp(Math.floor((r.left - x0 + 1) / pw), 0, n - 1);
    const tw = document.createTreeWalker(this.flow, NodeFilter.SHOW_TEXT), rg = document.createRange();
    for (let nd; (nd = tw.nextNode());) {
      const t = nd.nodeValue, ws = [], P = [0]; for (const m of t.matchAll(/\S+/g)) { ws.push(m.index); P.push(P[P.length - 1] + m[0].length); }
      if (!ws.length) continue;
      rg.selectNodeContents(nd); const rs = rg.getClientRects(); if (!rs.length) continue;
      let lo = n, hi = 0; for (const r of rs) { const p = pageOf(r); if (p < lo) lo = p; if (p > hi) hi = p; }
      if (lo === hi) { cnt[lo] += P[ws.length]; continue; }
      const pgOf = k => { rg.setStart(nd, ws[k]); rg.setEnd(nd, Math.min(t.length, ws[k] + 1)); const r = rg.getClientRects()[0]; return r ? pageOf(r) : lo; };
      let prev = 0;
      for (let p = lo + 1; p <= hi; p++) {
        let a = prev, b = ws.length;
        while (a < b) { const mid = (a + b) >> 1; if (pgOf(mid) >= p) b = mid; else a = mid + 1; }
        cnt[p - 1] += P[a] - P[prev]; prev = a;
      }
      cnt[hi] += P[ws.length] - P[prev];
    }
    const pb = [0]; for (const c of cnt) pb.push(pb[pb.length - 1] + c); this.pb = pb;
  }
  setX() { this.pg = clamp(this.pg, 0, Math.max(0, this.pages - 1)); this.flow.style.transform = `translate3d(${-this.pg * this.pw}px,0,0)`; }
  apply() {
    if (!Number.isFinite(R.sx)) R.sx = 0;
    if (!Number.isFinite(this.live) || this.live <= 0) this.live = 1;
    this.epub.style.transform = `translate3d(${R.sx}px,0,0) scale(${this.live})`;
  }
  swipeable() { return true; } pannable() { return false; }
  panStart() {} pan() {} panEnd() {}
  pinchStart() { this.f0 = this.fs; this.live = 1; this.epub.style.transformOrigin = '50% 50%'; }
  pinchMove(s) { if (Number.isFinite(s) && s > 0) { this.live = clamp(s, .6, 1.8); this.apply(); } }
  async pinchEnd() { await this.setFont(this.f0 * this.live); }
  async doubleTap() { const sizes = [18, 22, 27]; const i = sizes.findIndex(s => s > this.fs + .5); await this.setFont(sizes[i < 0 ? 0 : i]); }
  async setFont(fs) {
    fs = Math.round(clamp(fs, 14, 40)); const p = this.pos, u = this.unit;
    this.fs = fs; ls.set('fs', fs); this.live = 1; this.apply();
    await this.relayout(p, u);
  }
  wheel(e) { if (e.ctrlKey || e.metaKey) { this.setFont(this.fs + (e.deltaY < 0 ? 1 : -1)); return true; } return false; }
  async relayout(p, u) {
    this.anchor = null; this.paginate(); await this.seek(p - u * .5); this.anchor = p;
    if (S.book) { S.book.pos = this.pos; ui(); }
  }
  resize() { this.relayout(this.pos, this.unit); }
  destroy() { this.urls.forEach(u => URL.revokeObjectURL(u)); this.flow.replaceChildren(); this.epub.style.display = 'none'; this.epub.style.transform = ''; }
}

/* ---------------- reader flow ---------------- */
async function ensurePdfReflow(b, blob) {
  if (b.hasReflow && b.reflowV === 3) {
    if (!b.reflow) b.reflow = await DB.file(b.id + ':reflow');
    if (b.reflow?.chaps?.length) return true;
  }
  const L = $('#loading');
  reader$.classList.add('loading');
  L.textContent = b.isScanned ? 'Preparing OCR & figures…' : 'Preparing text…';
  try {
    const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    const res = await extractReflow(pdf, (p, scanned, doneN, totN) => {
      L.textContent = scanned
        ? `OCR & Figures… (${doneN}/${Math.min(totN, 16)} initial pages)`
        : `Preparing text… ${Math.round(p * 100)}%`;
    }, b);
    pdf.destroy();
    if (res && res.chaps?.length) {
      const f = (b.mode === 'text' && b.total) ? b.pos / b.total : null;
      await DB.putFile(b.id + ':reflow', res);
      b.reflow = res; b.rtotal = res.total; b.hasReflow = true; b.reflowV = 3;
      if (f != null) { b.total = res.total; b.pos = f * b.total; }
      else setMode(b, 'text');
      await DB.save(b);
      return true;
    }
  } catch (e) { console.warn('reflow/ocr error', e); }
  return false;
}

async function openBook(id) {
  const b = books.find(x => x.id === id); if (!b) return;
  reader$.classList.add('open', 'loading'); reader$.setAttribute('aria-hidden', 'false');
  armHistoryGuard();
  S = { book: b, t: null, saveT: 0, flipping: false, doneShown: false, undoStack: [], restoringUndo: false };
  updateUndoBtn();
  try {
    const blob = await DB.file(id);
    if (!b.cv) { const L = $('#loading'); L.textContent = 'Counting text…'; await ensureUnits(b, blob, p => L.textContent = `Counting text… ${Math.round(p * 100)}%`); await DB.save(b); }
    if (b.type === 'pdf' && b.reflowV !== 3 && !b.reflowTried3) {
      b.reflowTried3 = true;
      await ensurePdfReflow(b, blob);
      $('#loading').textContent = 'Opening…';
      await DB.save(b);
    }
    await new Promise(r => requestAnimationFrame(r));
    await mount(b, blob);
    applyTheme(); ui(); S.t = performance.now();
    reader$.classList.remove('loading');
    setChrome(false);
    navigator.wakeLock?.request('screen').then(l => S.wake = l).catch(() => {});
  } catch (e) { console.error(e); toast("Couldn't open this book"); closeReader(); }
}
async function mount(b, blob) {
  if (b.hasReflow && !b.reflow) b.reflow = await DB.file(b.id + ':reflow');
  reader = (b.type === 'pdf' && b.mode !== 'text') ? new PdfReader() : new EpubReader();
  R.sx = 0; await reader.open(b, blob); reader.apply?.();
  $('#rtitle').textContent = b.title;
  const mb = $('#mode'); mb.hidden = b.type !== 'pdf';
  mb.textContent = b.mode === 'text' ? 'Original pages' : (b.isScanned && !b.hasReflow ? 'OCR & Text' : 'Text');
}
$('#mode').onclick = async () => {
  const b = S.book; if (!reader || !b || b.type !== 'pdf') return;
  const prevSnap = captureReaderSnap();
  flushSave(); reader$.classList.add('loading');
  try {
    const blob = await DB.file(b.id);
    if (!b.hasReflow || !b.reflow) {
      const ok = await ensurePdfReflow(b, blob);
      if (!ok) {
        toast('Could not run OCR on this document');
        reader$.classList.remove('loading');
        return;
      }
    } else {
      setMode(b, b.mode === 'text' ? 'page' : 'text');
      await DB.save(b);
    }
    reader?.destroy(); reader = null;
    await mount(b, blob);
    pushReaderUndo(prevSnap);
    ui(); S.t = performance.now();
    toast(b.mode === 'text' ? 'Text & Figure mode active' : 'Original pages mode');
  } finally {
    reader$.classList.remove('loading');
  }
};
function closeReader() {
  if (!reader && !reader$.classList.contains('open')) return;
  bgOcrToken++;
  flushSave(); S.wake?.release?.().catch(() => {});
  S.undoStack = [];
  updateUndoBtn();
  reader$.classList.remove('open', 'chrome', 'loading'); reader$.setAttribute('aria-hidden', 'true');
  const r = reader; reader = null; setTimeout(() => r?.destroy(), 350);
  $('#done').hidden = true; refreshLibrary();
}
$('#back').onclick = () => window.goBack('exit-reader');
if ($('#undo-btn')) $('#undo-btn').onclick = () => window.undoAction();
$('#done-back').onclick = () => window.goBack('exit-reader');
$('#done-close').onclick = () => { $('#done').hidden = true; };
window.addEventListener('popstate', () => { window.goBack('popstate'); });

function setChrome(on) { reader$.classList.toggle('chrome', on); }
function toggleChrome() { S.chromeTouched = true; setChrome(!reader$.classList.contains('chrome')); }

const THEMES = ['auto', 'paper', 'sepia', 'night'];
function applyTheme() {
  let t = ls.get('theme', 'auto'); if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'paper';
  reader$.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = getComputedStyle(reader$).getPropertyValue('--page') || '#f7f3ea';
}
$('#theme').onclick = () => {
  const prevSnap = captureReaderSnap(`Theme ${ls.get('theme', 'auto')}`);
  const t = ls.get('theme', 'auto');
  ls.set('theme', THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  applyTheme();
  pushReaderUndo(prevSnap);
  toast({ auto: 'Auto theme', paper: 'Paper', sepia: 'Sepia', night: 'Night' }[ls.get('theme', 'auto')]);
};

/* progress bookkeeping */
function moved(prev, user) {
  try {
    if (!reader || !S.book) return;
    const b = S.book, pos = reader.pos, now = performance.now();
    if (user && pos > prev && S.t) {
      const dwell = (now - S.t) / 1000;
      if (dwell > 1 && dwell < 300) { addRead(dwell); b.spent = (b.spent || 0) + dwell; }
      // aturan Kindle (BaseTicrDocViewerEventHandler): lompatan cepat (< 5 dtk dan > 900 wpm ≈ 4200 karakter/menit) diabaikan
      const fast = kind(b) === 'epub' ? (dwell < 5 && (pos - prev) * 60 / dwell > (b.cv ? 4200 : 900)) : dwell < 2;
      if (dwell > .5 && dwell < 300 && !fast && pos - prev >= reader.unit * .5) {
        const r = dwell / (pos - prev), lo = kind(b) === 'pdf' ? 8 : b.cv ? .0086 : .04, hi = kind(b) === 'pdf' ? 600 : b.cv ? .32 : 1.5;
        b.samples = [...(b.samples || []), clamp(r, lo, hi)].slice(-30);
        if (b.samples.length >= 3) b.rate = med(b.samples);
        const rk = kind(b) === 'pdf' ? 'rate_pdf' : b.cv ? 'rate_c' : 'rate_epub';
        ls.set(rk, (ls.get(rk, defRate(kind(b), b)) * .9) + clamp(r, lo, hi) * .1);
      }
    }
    S.t = now;
    b.pos = pos; b.lastRead = Date.now(); window.onProgress?.(b);
    if (reader.atEnd() && !b.done) { b.done = true; b.doneAt = Date.now(); showDone(); }
    ui(); scheduleSave();
  } catch (e) { console.warn('moved metric error:', e); }
}
function ui() {
  if (!reader || !S.book) return;
  const b = S.book, rem = remaining(b), end = reader.atEnd();
  const near = !end && rem <= 900;
  const txt = end ? 'Finished' : rem <= 300 ? `Only ${fmt(rem)} left — finish it` : rem <= 900 ? `Under ${fmt(Math.ceil(rem / 300) * 300)} left` : `${fmt(rem)} left`;
  $('#left').textContent = txt; $('#left').classList.toggle('near', near);
  $('#where').textContent = reader.where();
  $('#scrub').value = Math.round((b.pos || 0) / Math.max(1, b.total || 1) * 1000);
  $('#pill').textContent = txt; $('#pill').classList.toggle('near', near);
}
function showDone() {
  const b = S.book; $('#done-text').textContent = `${b.title} — ${fmt(b.spent || 0)} of reading time.`; $('#done').hidden = false;
}
function scheduleSave() { clearTimeout(S.saveT); S.saveT = setTimeout(flushSave, 500); }
function flushSave() { clearTimeout(S.saveT); if (S.book) DB.save(S.book).catch(() => {}); }
document.addEventListener('visibilitychange', () => { if (document.hidden) { flushSave(); if (S) S.t = null; } else if (reader) S.t = performance.now(); });

/* scrubber */
const scrub = $('#scrub');
let scrubUndoSnap = null;
scrub.addEventListener('pointerdown', e => { e.stopPropagation(); scrubUndoSnap = captureReaderSnap(); });
scrub.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
scrub.addEventListener('input', () => { if (!reader || !S.book) return; const f = scrub.value / 1000; $('#left').textContent = fmt((1 - f) * S.book.total * rateOf(S.book)) + ' left'; });
scrub.addEventListener('change', async () => {
  if (!reader) return;
  const prev = reader.pos;
  if (scrubUndoSnap) { pushReaderUndo(scrubUndoSnap); scrubUndoSnap = null; }
  R.sx = 0; await reader.jump(scrub.value / 1000); reader.apply?.(); moved(prev, false);
});

/* page flip (Single-Spring Interruptible Apple Fluid Motion — never blanks off-screen) */
async function flip(dir, v = 0, resp = .28) {
  if (!reader) return;
  const w = Math.max(300, view.clientWidth || window.innerWidth);
  if (!reader.canStep(dir)) { await springP(R.sx, 0, v, { response: .30 }, x => { R.sx = x; reader?.apply?.(); }); return; }
  S.flipping = true;
  try {
    const prevSnap = captureReaderSnap();
    const prev = reader.pos;
    const dragOffset = R.sx;

    await reader.step(dir);
    pushReaderUndo(prevSnap);
    moved(prev, true);

    R.sx = clamp(dragOffset + dir * w, -w, w);
    reader.apply();
    await springP(R.sx, 0, v, { response: resp, damping: 1.0 }, x => { R.sx = x; reader?.apply?.(); });
  } finally {
    S.flipping = false;
    if (P.size === 0 && reader) { R.sx = 0; reader.apply(); }
  }
}

/* gestures */
const P = new Map(); let g = null, lastTap = null, tapTimer = 0;
const mid = () => { const [a, b] = [...P.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
const dist = () => { const [a, b] = [...P.values()]; return Math.max(12, Math.hypot(a.x - b.x, a.y - b.y)); };
let pinch = null, twoTap = null;
view.addEventListener('pointerdown', e => {
  if (!reader) return;
  view.setPointerCapture(e.pointerId); P.set(e.pointerId, { x: e.clientX, y: e.clientY });
  cancelSpring(); S.flipping = false;
  const now = performance.now();
  if (P.size === 1) { g = { x0: e.clientX, y0: e.clientY, mode: 'tap', sx0: R.sx, hist: [[e.clientX, now]] }; reader.panStart(); }
  else if (P.size === 2) {
    clearTimeout(tapTimer); lastTap = null;
    const d0 = dist();
    g = { mode: 'pinch' }; pinch = { d0 };
    twoTap = { t0: now, d0, p0: [...P.values()].map(p => ({ x: p.x, y: p.y })), maxMove: 0, maxRatioDelta: 0 };
    R.sx = 0; reader.pinchStart(mid()); reader.apply();
  } else {
    twoTap = null;
  }
});
view.addEventListener('pointermove', e => {
  if (!P.has(e.pointerId)) return;
  P.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!g || !reader) return;
  if (g.mode === 'pinch') {
    if (P.size >= 2) {
      const ratio = dist() / pinch.d0;
      if (twoTap) {
        const pts = [...P.values()];
        for (let i = 0; i < 2; i++) if (pts[i] && twoTap.p0[i]) {
          twoTap.maxMove = Math.max(twoTap.maxMove, Math.hypot(pts[i].x - twoTap.p0[i].x, pts[i].y - twoTap.p0[i].y));
        }
        twoTap.maxRatioDelta = Math.max(twoTap.maxRatioDelta, Math.abs(ratio - 1));
      }
      reader.pinchMove(ratio, mid());
    }
    return;
  }
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0, now = performance.now();
  g.hist.push([e.clientX, now]); if (g.hist.length > 8) g.hist.shift();
  if (g.mode === 'tap' && Math.hypot(dx, dy) > 10) g.mode = reader.pannable() ? 'pan' : (Math.abs(dx) > Math.abs(dy) * 0.9 ? 'swipe' : 'none');
  if (g.mode === 'pan') reader.pan(dx, dy);
  else if (g.mode === 'swipe') {
    let x = dx; if (!reader.canStep(dx < 0 ? 1 : -1)) x = rubber(dx, view.clientWidth || window.innerWidth);
    R.sx = g.sx0 + x; reader.apply();
  }
});
function endPtr(e) {
  if (!P.has(e.pointerId)) return;
  const wasPinch = g?.mode === 'pinch'; P.delete(e.pointerId);
  if (!reader) return;
  const now = performance.now();
  if (wasPinch) {
    if (P.size < 2) {
      const c = { x: e.clientX, y: e.clientY };
      reader.pinchEnd(c);
      if (e.type !== 'pointercancel' && twoTap && now - twoTap.t0 < 360 && twoTap.maxMove < 18 && twoTap.maxRatioDelta < 0.08) {
        toggleChrome();
      }
      twoTap = null; g = null;
    }
    return;
  }
  if (P.size || !g) return;
  const m = g.mode; const gg = g; g = null;
  if (m === 'pan') { reader.panEnd(); return; }
  if (m === 'swipe' || (m === 'tap' && Math.abs(gg.sx0) > 1)) {
    const hs = gg.hist, a = hs.find(p => now - p[1] < 100) || hs[0], z = hs[hs.length - 1];
    const v = z[1] > a[1] ? (z[0] - a[0]) / (z[1] - a[1]) * 1000 : 0, w = view.clientWidth || window.innerWidth;
    const proj = R.sx + project(v);
    const dir = proj < -w * .25 ? 1 : proj > w * .25 ? -1 : 0;
    if (dir && reader.canStep(dir)) flip(dir, v, .28);
    else springP(R.sx, 0, v, { response: .28 }, x => { R.sx = x; reader?.apply?.(); });
    return;
  }
  if (m !== 'tap' || e.type === 'pointercancel') return;
  const x = e.clientX, y = e.clientY;
  if (lastTap && now - lastTap.t < 280 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) { clearTimeout(tapTimer); lastTap = null; reader.doubleTap({ x, y }); return; }
  lastTap = { t: now, x, y };
  tapTimer = setTimeout(() => {
    lastTap = null; const w = view.clientWidth || window.innerWidth;
    if (x < w * .26) flip(-1, 0, .24); else if (x > w * .74) flip(1, 0, .24); else toggleChrome();
  }, 230);
}
view.addEventListener('pointerup', endPtr); view.addEventListener('pointercancel', endPtr);
let wheelLock = 0;
view.addEventListener('wheel', e => {
  e.preventDefault(); if (!reader) return;
  if (reader.wheel(e)) return;
  const n = performance.now(); if (n - wheelLock < 300 || Math.abs(e.deltaY) < 4) return; wheelLock = n; flip(e.deltaY > 0 ? 1 : -1, 0, .24);
}, { passive: false });
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    window.undoAction();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    window.goBack('esc');
    return;
  }
  if (!reader || OV.length) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); flip(1, 0, .24); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); flip(-1, 0, .24); }
});
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => reader?.resize(), 150); });

/* boot */
refreshLibrary().then(() => migrateBooks());
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.().catch(() => {});
