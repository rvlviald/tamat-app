'use strict';
/* Tamat PWA: cadangan/impor data, penyimpanan permanen, petunjuk pasang ke Layar Utama. */
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* overlay tunggal, terhubung ke tombol back/swipe-back lewat window.onBack */
const ov = (() => {
  const el = h('section', 'ov'); el.id = 'backup'; el.hidden = true;
  const head = h('header', 'ov-head'), back = h('button', 'ov-back', '‹ Kembali'); back.onclick = () => history.back();
  head.append(back, h('span', 'ov-title', 'Cadangan'));
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
    setMsg(`Menyiapkan ${++i}/${list.length}…`);
    const f = await DB.file(b.id); if (!f) continue;
    const { reflow, ...m } = b; m.ext = b.type === 'pdf' ? 'pdf' : 'epub';
    meta.push(m); zip.file(`files/${b.id}.${m.ext}`, f, { compression: 'STORE' });
  }
  const prefs = {}; for (const k of LS_KEYS) { const v = ls.get(k, null); if (v != null) prefs[k] = v; }
  zip.file('tamat.json', JSON.stringify({ app: 'tamat', v: 1, at: Date.now(), books: meta, stats, prefs }));
  setMsg('Mengemas…');
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

async function importBackup(file, setMsg) {
  const zip = await JSZip.loadAsync(file);
  const j = zip.file('tamat.json'); if (!j) throw new Error('bukan cadangan Tamat');
  const data = JSON.parse(await j.async('string'));
  if (data.app !== 'tamat') throw new Error('bukan cadangan Tamat');
  const have = new Map((await DB.all()).map(b => [b.id, b]));
  let added = 0, updated = 0, i = 0;
  for (const m of data.books) {
    setMsg(`Memulihkan ${++i}/${data.books.length}…`);
    const { ext, ...b } = m, cur = have.get(b.id);
    if (cur) {
      if ((b.lastRead || 0) > (cur.lastRead || 0)) { await DB.save({ ...cur, pos: b.pos, lastRead: b.lastRead, done: b.done, doneAt: b.doneAt, spent: b.spent, rate: b.rate, samples: b.samples }); updated++; }
      continue;
    }
    const z = zip.file(`files/${b.id}.${ext}`); if (!z) continue;
    const blob = new Blob([await z.async('arraybuffer')], { type: ext === 'pdf' ? 'application/pdf' : 'application/epub+zip' });
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
  root.append(h('h3', '', 'Penyimpanan'));
  const st = h('p', 'stat', 'Memeriksa…'); root.append(st);
  const refreshStat = async () => {
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const n = (await DB.all()).length;
    st.textContent = `${n} buku · terpakai ${est?.usage != null ? mb(est.usage) : '?'} · penyimpanan permanen: ${persisted ? 'aktif ✓' : 'belum'}`;
  };
  refreshStat();
  if (navigator.storage?.persist) {
    const p = h('button', 'btn', 'Minta penyimpanan permanen');
    p.onclick = async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Penyimpanan permanen aktif' : 'Browser belum mengizinkan'); refreshStat(); };
    root.append(p);
  }
  if (isIOS && !standalone) root.append(h('p', 'hint', 'Tips: buka Tamat dari ikon di Layar Utama (Bagikan → Tambah ke Layar Utama). Safari bisa menghapus data situs yang jarang dibuka; aplikasi di Layar Utama jauh lebih awet.'));

  root.append(h('h3', '', 'Cadangkan'));
  root.append(h('p', 'hint', 'Simpan semua buku + progres bacaan jadi satu file .zip. Simpan ke Files/iCloud Drive, atau kirim ke dirimu sendiri.'));
  const ex = h('button', 'btn pri', 'Buat cadangan'), msg = h('p', 'hint', ''), out = h('div');
  ex.onclick = async () => {
    ex.disabled = true; out.replaceChildren();
    try {
      const blob = await buildBackup(t => msg.textContent = t);
      const name = `tamat-cadangan-${dayKey()}.zip`, file = new File([blob], name, { type: 'application/zip' });
      msg.textContent = `Siap: ${name} (${mb(blob.size)})`;
      if (navigator.canShare?.({ files: [file] })) {
        const s = h('button', 'btn pri', 'Simpan / Bagikan');
        s.onclick = () => navigator.share({ files: [file], title: name }).catch(e => { if (e.name !== 'AbortError') toast('Gagal membagikan'); });
        out.append(s);
      }
      const a = h('a', 'btn', 'Unduh .zip'); a.href = URL.createObjectURL(blob); a.download = name;
      a.style.cssText = 'display:inline-flex;align-items:center;text-decoration:none;color:inherit';
      out.append(a);
    } catch (e) { console.error(e); msg.textContent = 'Gagal membuat cadangan: ' + e.message; }
    ex.disabled = false;
  };
  root.append(ex, msg, out);

  root.append(h('h3', '', 'Pulihkan'));
  root.append(h('p', 'hint', 'Pilih file cadangan .zip. Buku yang sudah ada tidak ditimpa; progres yang lebih baru dipakai.'));
  const im = h('button', 'btn', 'Pilih file cadangan'), inp = h('input'); inp.type = 'file'; inp.accept = '.zip,application/zip'; inp.hidden = true;
  const msg2 = h('p', 'hint', '');
  im.onclick = () => inp.click();
  inp.onchange = async () => {
    const f = inp.files[0]; inp.value = ''; if (!f) return;
    im.disabled = true;
    try { const r = await importBackup(f, t => msg2.textContent = t); msg2.textContent = `Selesai: ${r.added} buku dipulihkan, ${r.updated} progres diperbarui.`; await refreshLibrary(); refreshStat(); }
    catch (e) { console.error(e); msg2.textContent = 'Gagal memulihkan: ' + e.message; }
    im.disabled = false;
  };
  root.append(im, inp, msg2);
  ov.show();
}
$('#go-backup').onclick = showBackup;

/* petunjuk pasang ke Layar Utama (iOS Safari, belum standalone) */
if (isIOS && !standalone && !ls.get('hintOff', false)) {
  const hint = h('div', 'install-hint');
  hint.append(h('span', '', 'Pasang Tamat di Layar Utama biar bacaanmu awet dan bisa dibuka offline: ketuk Bagikan, lalu “Tambah ke Layar Utama”.'));
  const x = h('button', '', '✕'); x.setAttribute('aria-label', 'Tutup petunjuk'); x.onclick = () => { ls.set('hintOff', true); hint.remove(); };
  hint.append(x); $('#lib-actions').after(hint);
}
