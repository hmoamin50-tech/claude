/**
 * بوت المكتبة — Cloudflare Worker — النسخة الكاملة
 * (المستخدمون + أدوات المشرف + الرفع + النقل + التصنيف + الدمج + التصدير)
 *
 * المتغيرات (Settings ← Variables and Secrets):
 *   BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY (المفتاح السري), WEBHOOK_SECRET, ADMIN_IDS
 *   اختياري: SUBREQ_LIMIT (الافتراضي 45؛ ضعها 900 إن كانت خطتك مدفوعة)
 *
 * التفعيل مرة واحدة:  https://اسم-الworker.workers.dev/setup?key=WEBHOOK_SECRET
 * قبل ذلك شغّل schema.sql مرة واحدة في Supabase ← SQL Editor.
 */

/* ================= الثوابت ================= */

const WELCOME = [
  '👋 أهلاً بك في',
  '',
  '📚 <b>مجموعة آفاق</b>',
  'مكتبة طلاب كلية الهندسة — جامعة كسلا',
  '',
  'اختر من القائمة، أو اكتب اسم ملف للبحث عنه:',
].join('\n');
const BACK_LABEL = 'رجوع 🔙';
const MAIN_LABEL = 'القائمة الرئيسية 🔝';
const ADMIN_LABEL = 'لوحة المشرف ⚙️';
const ACADEMIC = 'المحتوى الأكاديمي 📚📚';
const LEGACY_NAME = '📥 ملفات قديمة (غير مصنفة)';
const SUBJECT_SECTIONS = ['📚 مقررات', '🧪 امتحانات'];
const LEVEL_CHILDREN = ['Semester 1', 'Semester 2'];
const LEGACY_PREFIXES = ['📁 ', '📘 ', '🎓 '];
const PAGE = 8;

const collator = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cb = (text, data) => ({ text, callback_data: data });
const kbd = (rows) => ({ inline_keyboard: rows });
const fileIcon = (f) => (f.kind === 'video' ? '🎬' : '📄');

/* ================= المخطِّط (دوال نقية للتصنيف والدمج) ================= */

const norm = (s = '') => s.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
const clean = (s = '') => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
const LV = [['الخامس', 4], ['الرابع', 3], ['الثالث', 2], ['الثاني', 1], ['الاول', 0]];
const levelIdx = (name) => (LV.find(([k]) => norm(name).includes(k)) || [, -1])[1];
const semIdx = (name) => {
  const m = /semester\s*(\d)/i.exec(name);
  if (m) return Number(m[1]);
  const n = norm(name);
  return n.includes('الثاني') ? 2 : n.includes('الاول') ? 1 : 0;
};
const DEPT_KW = [['ميكانيك', 'ميكانيك'], ['كهرب', 'كهرب'], ['مدني', 'مدني']];
const deptKey = (name) => (DEPT_KW.find(([k]) => norm(name).includes(k)) || [])[0];
const LEVEL_NAMES = ['المستوى الأول', 'المستوى الثاني', 'المستوى الثالث', 'المستوى الرابع', 'المستوى الخامس'];

function planFrom(nodes, fileCount, commonMode = 'all') {
  const by = new Map();
  nodes.forEach((n) => { const k = n.parent_id || 0; (by.get(k) || by.set(k, []).get(k)).push(n); });
  const kids = (id) => by.get(id) || [];
  const holder = kids(0).find((n) => n.name === LEGACY_NAME);
  const acad = kids(0).find((n) => n.name === ACADEMIC);
  if (!holder || !acad) return { error: 'الهيكل الجديد أو المجلد القديم غير موجود.' };

  const dept = (key) => kids(acad.id).find((d) => norm(d.name).includes(key));
  const dip = kids(acad.id).find((d) => d.name.includes('دبلوم'));
  const semOf = (d, li, si) => {
    const lv = d && kids(d.id).find((n) => levelIdx(n.name) === li);
    return lv && kids(lv.id).find((s) => semIdx(s.name) === si);
  };
  const sub = (id) => kids(id).reduce((a, k) => { const r = sub(k.id); return { files: a.files + r.files, nodes: a.nodes + 1 + r.nodes }; },
    { files: fileCount.get(id) || 0, nodes: 0 });

  const items = [], skipped = [];
  const add = (node, d, li, si, mode, label) => {
    const sem = semOf(d, li, si);
    if (!sem) return skipped.push(`${clean(node.name)}: لا يوجد فصل مقابل (${label})`);
    const dup = kids(sem.id).some((x) => clean(x.name) === clean(node.name));
    if (dup && mode === 'move') return skipped.push(`${clean(node.name)}: موجودة مسبقاً في الوجهة`);
    const s = sub(node.id);
    items.push({ id: node.id, name: clean(node.name), destSem: sem.id, mode, files: s.files, nodes: s.nodes + 1,
      dest: `${d.name} › ${LEVEL_NAMES[li]} › Semester ${si}` });
  };

  let left = 0;
  for (const lvl of kids(holder.id)) {
    const li = levelIdx(lvl.name), isDip = lvl.name.includes('دبلوم');
    if (li < 0) { skipped.push(`${lvl.name}: مستوى غير معروف`); continue; }
    left += fileCount.get(lvl.id) || 0;
    for (const sem of kids(lvl.id)) {
      const si = semIdx(sem.name);
      left += fileCount.get(sem.id) || 0;
      if (!si) { skipped.push(`${sem.name}: فصل غير معروف`); continue; }
      for (const ch of kids(sem.id)) {
        if (ch.name.startsWith('📘')) {
          if (isDip) add(ch, dip, li, si, 'move', 'دبلوم');
          else {
            const targets = commonMode === 'one' ? ['مدني'] : ['مدني', 'كهرب', 'ميكانيك'];
            targets.forEach((k, i) => add(ch, dept(k), li, si, i === 0 ? 'move' : 'clone', k));
          }
        } else if (ch.name.startsWith('📁') && deptKey(ch.name)) {
          left += fileCount.get(ch.id) || 0;
          for (const s of kids(ch.id)) {
            if (s.name.startsWith('📘')) add(s, dept(deptKey(ch.name)), li, si, 'move', ch.name);
            else skipped.push(`${s.name}: ليست مادة`);
          }
        } else skipped.push(`${ch.name}: غير معروف`);
      }
    }
  }
  items.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'clone' ? -1 : 1));
  return { items, skipped, left };
}

const MERGE_NAMES = ['تلخيص', 'شروحات فيديو'];
function mergePlan(nodes, fileCount) {
  const by = new Map();
  nodes.forEach((n) => { const k = n.parent_id || 0; (by.get(k) || by.set(k, []).get(k)).push(n); });
  const items = [];
  for (const n of nodes) {
    if (!n.parent_id || !MERGE_NAMES.includes(clean(n.name))) continue;
    const target = (by.get(n.parent_id) || []).find((x) => clean(x.name) === 'مقررات');
    items.push({ id: n.id, name: clean(n.name), parent: n.parent_id, target: target?.id ?? null,
      files: fileCount.get(n.id) || 0, children: (by.get(n.id) || []).length });
  }
  return items;
}

/* ================= نصوص الدليل ================= */

const USER_HELP = [
  '📖 <b>طريقة الاستخدام</b>',
  '',
  '• استخدم الأزرار أسفل الشاشة للتنقل: المحتوى الأكاديمي ← القسم ← المستوى ← الفصل ← المادة.',
  '• عند الوصول لمجلد فيه ملفات تصلك مباشرة.',
  '• اكتب اسم الملف في المحادثة للبحث عنه.',
  '• /start للعودة للقائمة الرئيسية.',
].join('\n');

const ADMIN_HELP = USER_HELP + '\n\n' + [
  '🛠 <b>للمشرفين</b>',
  '',
  '• <b>➕ إضافة:</b> مجلد أو مادة (تُنشأ أقسامها تلقائياً). يمكنك إرسال عدة أسماء، كل اسم في سطر.',
  '• <b>⚙️ لوحة المشرف:</b> زر أسفل الشاشة يفتح أدوات الإدارة للمجلد الذي أنت فيه.',
  '• <b>🎓 المستوى:</b> يُنشأ بفصلين تلقائياً (Semester 1/2).',
  '• <b>📥 الملفات القديمة:</b> أسهل طريقة /classify لنقلها تلقائياً، أو يدوياً: افتح الملف ← 🔀 نقل ← اختر القسم ← «انقل إلى هنا».',
  '• <b>📞 تواصل معنا:</b> من /panel ← «نص تواصل معنا».',
  '• <b>📤 رفع ملفات:</b> افتح المجلد، اضغط رفع، ثم أرسل الملفات وأنهِ الرفع.',
  '• <b>⚙️ إدارة هذا المجلد:</b> إعادة تسمية، تقديم/تأخير، نقل، حذف.',
  '• على أي ملف: تعديل العنوان، نقل، حذف.',
  '• /panel لوحة التحكم، /cancel لإلغاء أي وضع، /export تصدير، /merge دمج «تلخيص» و«شروحات فيديو».',
].join('\n');

const USER_CMDS = [
  { command: 'start', description: 'القائمة الرئيسية' },
  { command: 'help', description: 'طريقة الاستخدام' },
];
const ADMIN_CMDS = [
  ...USER_CMDS,
  { command: 'panel', description: 'لوحة التحكم' },
  { command: 'cancel', description: 'إلغاء الوضع الحالي' },
  { command: 'export', description: 'تصدير الملفات JSON' },
  { command: 'classify', description: 'تصنيف الملفات القديمة' },
  { command: 'merge', description: 'دمج تلخيص وفيديو في مقررات' },
];

/* ================= الاتصال بتلجرام و Supabase ================= */

function makeApi(env) {
  const base = `https://api.telegram.org/bot${(env.BOT_TOKEN || '').trim()}`;
  const sbUrl = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const sbKey = (env.SUPABASE_KEY || '').trim();
  let calls = 0;

  async function tg(method, params = {}) {
    calls++;
    try {
      const r = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return await r.json();
    } catch (e) {
      console.error('tg error', method, e.message);
      return { ok: false };
    }
  }

  async function tgForm(method, form) {
    calls++;
    try {
      return await (await fetch(`${base}/${method}`, { method: 'POST', body: form })).json();
    } catch (e) {
      console.error('tgForm error', method, e.message);
      return { ok: false };
    }
  }

  async function sbx(method, table, query = '', body = null, extra = {}) {
    calls++;
    const auth = sbKey.startsWith('eyJ') ? { Authorization: `Bearer ${sbKey}` } : {};
    const headers = { apikey: sbKey, 'Content-Type': 'application/json', ...auth, ...extra };
    try {
      const r = await fetch(`${sbUrl}/rest/v1/${table}${query ? '?' + query : ''}`, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (!r.ok) console.error('sb error', method, table, r.status, text.slice(0, 200));
      let data = [];
      try { data = JSON.parse(text); } catch { /* فارغ */ }
      return { ok: r.ok, status: r.status, data, headers: r.headers };
    } catch (e) {
      console.error('sb fetch error', e.message);
      return { ok: false, status: 0, data: [], headers: new Headers() };
    }
  }

  const sb = async (...a) => { const r = await sbx(...a); return Array.isArray(r.data) ? r.data : []; };
  const sbCount = async (table, query = '') => {
    const r = await sbx('HEAD', table, 'select=id' + (query ? '&' + query : ''), null, { Prefer: 'count=exact' });
    const m = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
    return m ? Number(m[1]) : 0;
  };

  return { tg, tgForm, sb, sbx, sbCount, calls: () => calls };
}

/* ================= المنطق ================= */

function makeBot(env) {
  const { tg, tgForm, sb, sbx, sbCount, calls } = makeApi(env);
  const secret = (env.WEBHOOK_SECRET || '').trim();
  const LIMIT = Number(env.SUBREQ_LIMIT) || 45;
  const owners = new Set((env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean));

  /* ---------- قاعدة البيانات ---------- */
  const isOwner = (uid) => owners.has(uid);
  const isAdmin = async (uid) => owners.has(uid) || (await sb('GET', 'admins', `select=id&id=eq.${uid}`)).length > 0;
  const loadAdmins = () => sb('GET', 'admins', 'select=*&order=created_at.asc');

  async function addAdmin(id, name, by) {
    const r = await sbx('POST', 'admins', 'on_conflict=id', [{ id, name: name || null, added_by: by || null }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (!r.ok) throw new Error('تعذّر حفظ المشرف. شغّل schema.sql في Supabase.');
    await tg('setMyCommands', { commands: ADMIN_CMDS, scope: { type: 'chat', chat_id: Number(id) } });
  }
  async function removeAdmin(id) {
    await sb('DELETE', 'admins', `id=eq.${id}`);
    await tg('deleteMyCommands', { scope: { type: 'chat', chat_id: Number(id) } });
  }

  const children = (parent) =>
    sb('GET', 'nodes', `select=*&order=position.asc,id.asc&${parent ? 'parent_id=eq.' + parent : 'parent_id=is.null'}`);
  const getNode = async (id) => (id ? (await sb('GET', 'nodes', `select=*&id=eq.${id}`))[0] || null : null);
  const getFile = async (id) => (await sb('GET', 'files', `select=*&id=eq.${id}`))[0] || null;
  const filesOf = (nodeId) => sb('GET', 'files', `select=*&node_id=eq.${nodeId}`);

  async function crumbs(node) {
    const names = [];
    let cur = node;
    while (cur) {
      names.unshift(cur.name);
      cur = cur.parent_id ? await getNode(cur.parent_id) : null;
    }
    return names.join(' › ');
  }

  async function nextPos(parent) {
    const r = await sb('GET', 'nodes', `select=position&order=position.desc&limit=1&${parent ? 'parent_id=eq.' + parent : 'parent_id=is.null'}`);
    return (Number(r[0]?.position) || 0) + 1;
  }

  async function createNode(parent, name, kind) {
    const r = await sb('POST', 'nodes', '', { parent_id: parent || null, name: name.slice(0, 60), position: await nextPos(parent) },
      { Prefer: 'return=representation' });
    const n = r[0];
    const kids = kind === 's' ? SUBJECT_SECTIONS : kind === 'l' ? LEVEL_CHILDREN : [];
    if (n && kids.length)
      await sb('POST', 'nodes', '', kids.map((k, i) => ({ parent_id: n.id, name: k, position: i + 1 })));
    return n;
  }

  async function swap(node, dir) {
    const sibs = await children(node.parent_id);
    const i = sibs.findIndex((s) => Number(s.id) === Number(node.id));
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sibs.length) return false;
    if (Number(sibs[i].position) !== Number(sibs[j].position)) {
      await Promise.all([
        sb('PATCH', 'nodes', `id=eq.${sibs[i].id}`, { position: sibs[j].position }),
        sb('PATCH', 'nodes', `id=eq.${sibs[j].id}`, { position: sibs[i].position }),
      ]);
    } else {
      [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      await Promise.all(sibs.map((s, k) => sb('PATCH', 'nodes', `id=eq.${s.id}`, { position: k + 1 })));
    }
    return true;
  }

  const legacyId = async () => {
    const r = await sb('GET', 'nodes', `select=id&parent_id=is.null&name=eq.${enc(LEGACY_NAME)}&limit=1`);
    return r[0] ? Number(r[0].id) : null;
  };

  /* مكان المستخدم + حالة المشرف + قيم بسيطة */
  const getCur = async (uid) => Number((await sb('GET', 'users', `select=cur_node&id=eq.${uid}`))[0]?.cur_node) || 0;
  const setCur = (uid, node) =>
    sb('POST', 'users', 'on_conflict=id', [{ id: uid, cur_node: node || null }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' });

  const getState = async (id) => (await sb('GET', 'admin_state', `select=*&admin_id=eq.${id}`))[0] || null;
  const setState = (id, mode, target) =>
    sb('POST', 'admin_state', 'on_conflict=admin_id', [{ admin_id: id, mode, target_id: target }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
  const clearState = (id) => sb('DELETE', 'admin_state', `admin_id=eq.${id}`);

  const kvGet = async (key) => (await sb('GET', 'settings', `select=value&key=eq.${enc(key)}`))[0]?.value ?? null;
  const kvSet = (key, value) =>
    sb('POST', 'settings', 'on_conflict=key', [{ key, value: String(value) }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
  const kvDel = (key) => sb('DELETE', 'settings', `key=eq.${enc(key)}`);

  async function fetchAll(table, cols) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
      const part = await sb('GET', table, `select=${cols}&order=id.asc&limit=1000&offset=${off}`);
      rows.push(...part);
      if (part.length < 1000) break;
    }
    return rows;
  }

  /* ---------- الرسائل ---------- */
  async function show(ctx, text, kb, msgId, keepLV = false) {
    if (!keepLV) await kvDel(`lv:${ctx.chat}`);
    const target = msgId || ctx.msgId;
    const extra = { parse_mode: 'HTML', reply_markup: kb };
    if (target) {
      const r = await tg('editMessageText', { chat_id: ctx.chat, message_id: target, text, ...extra });
      if (r.ok || String(r.description || '').includes('not modified')) return target;
    }
    const r = await tg('sendMessage', { chat_id: ctx.chat, text, ...extra });
    return r.result?.message_id;
  }

  const say = (ctx, text, extra = {}) => tg('sendMessage', { chat_id: ctx.chat, text, ...extra });
  const answer = (ctx, text, alert = false) =>
    tg('answerCallbackQuery', { callback_query_id: ctx.cbId, ...(text ? { text, show_alert: alert } : {}) });

  async function forceReply(ctx, text, tag) {
    return say(ctx, `${text}\n\n🔖 ${tag}${ctx.msgId ? ':' + ctx.msgId : ''}`,
      { reply_markup: { force_reply: true, selective: true } });
  }

  /* ---------- لوحة المفاتيح السفلية + الملفات ---------- */
  async function keyboardFor(nodeId, admin) {
    const hid = admin ? null : await legacyId();
    const kids = (await children(nodeId || null)).filter((k) => Number(k.id) !== hid);
    const rows = kids.map((k) => [{ text: String(k.name).trim() }]);
    if (nodeId) rows.push([{ text: BACK_LABEL }, { text: MAIN_LABEL }]);
    if (admin) rows.push([{ text: ADMIN_LABEL }]);
    return { kb: { keyboard: rows, resize_keyboard: true }, hasKids: kids.length > 0 };
  }

  const fileKb = (id) => kbd([
    [cb('✏️ تعديل العنوان', `rnf:${id}`), cb('🔀 نقل', `mvf:${id}`)],
    [cb('🗑 حذف', `delf:${id}`)],
  ]);

  // caption جاهز مسبقاً للمشرف لتوفير الاستعلامات
  const sendFile = (ctx, f, caption, admin) => {
    const video = f.kind === 'video';
    return tg(video ? 'sendVideo' : 'sendDocument', {
      chat_id: ctx.chat,
      [video ? 'video' : 'document']: f.file_id,
      caption: String(caption ?? f.title).slice(0, 1000),
      ...(admin ? { reply_markup: fileKb(f.id) } : {}),
    });
  };

  async function sendFiles(ctx, files, admin, node) {
    if (admin) {
      const where = node ? await crumbs(node) : '';
      for (const f of files.slice(0, 15)) await sendFile(ctx, f, `${f.title}\n📍 ${where}\n🆔 #${f.id}`, true);
      if (files.length > 15) await say(ctx, `… و${files.length - 15} ملف آخر. استخدم «${ADMIN_LABEL}» لعرضها كاملة.`);
      return;
    }
    const docs = files.filter((f) => f.kind !== 'video');
    const vids = files.filter((f) => f.kind === 'video');
    for (let i = 0; i < docs.length; i += 10) {
      const chunk = docs.slice(i, i + 10);
      if (chunk.length === 1) { await sendFile(ctx, chunk[0]); continue; }
      const res = await tg('sendMediaGroup', {
        chat_id: ctx.chat,
        media: chunk.map((f) => ({ type: 'document', media: f.file_id, caption: String(f.title).slice(0, 1000) })),
      });
      if (!res.ok) for (const f of chunk) await sendFile(ctx, f);
    }
    for (const v of vids) await sendFile(ctx, v);
  }

  async function openNode(ctx, nodeId = 0) {
    const node = await getNode(nodeId);
    const id = node ? Number(node.id) : 0;
    await setCur(ctx.uid, id);
    let files = [];
    if (id) {
      files = await filesOf(id);
      files.sort((a, b) => collator.compare(a.title, b.title));
    }
    const { kb, hasKids } = await keyboardFor(id, ctx.admin);
    let text = node ? esc(node.name) : WELCOME;
    if (node && !hasKids && !files.length) text += '\n\n<i>لا يوجد محتوى هنا بعد.</i>';
    await say(ctx, text, { parse_mode: 'HTML', reply_markup: kb });
    if (files.length) await sendFiles(ctx, files.slice(0, 100), ctx.admin, node);
  }

  async function restoreKeyboard(ctx, text = '✅ تم') {
    const { kb } = await keyboardFor(await getCur(ctx.uid), ctx.admin);
    await say(ctx, text, { reply_markup: kb });
  }

  /* ---------- العرض الإداري بالأزرار الشفافة ---------- */
  async function view(ctx, nodeId = 0, page = 0, msgId) {
    const admin = ctx.admin;
    const st = admin ? await getState(ctx.uid) : null;
    const node = await getNode(nodeId);
    const id = node ? Number(node.id) : 0;
    const uploading = st?.mode === 'upload' && Number(st.target_id) === id;
    const moving = st?.mode?.startsWith('move_');

    const kids = await children(id || null);
    const rows = [];
    for (let i = 0; i < kids.length; i += 2)
      rows.push(kids.slice(i, i + 2).map((k) => cb(String(k.name).slice(0, 32), `n:${k.id}:0`)));

    let total = 0;
    if (id) {
      const files = (await sb('GET', 'files', `select=id,title,kind&node_id=eq.${id}`)).sort((a, b) => collator.compare(a.title, b.title));
      total = files.length;
      page = Math.max(0, Math.min(page, Math.ceil(total / PAGE) - 1));
      files.slice(page * PAGE, page * PAGE + PAGE).forEach((f) =>
        rows.push([cb(`${fileIcon(f)} ${String(f.title).slice(0, 50)}`, `f:${f.id}`)]));
      const nav = [];
      if (page > 0) nav.push(cb('◀️ السابق', `n:${id}:${page - 1}`));
      if ((page + 1) * PAGE < total) nav.push(cb('التالي ▶️', `n:${id}:${page + 1}`));
      if (nav.length) rows.push(nav);
    }

    let banner = '';
    if (admin) {
      if (moving) {
        banner = '\n\n🔀 <b>وضع النقل:</b> تصفّح إلى المكان الجديد ثم اضغط «انقل إلى هنا».';
        rows.push([cb('📥 انقل إلى هنا', `mvhere:${id}`)]);
        rows.push([cb('❌ إلغاء النقل', 'mvcancel')]);
      } else if (uploading) {
        banner = '\n\n📤 <b>وضع الرفع مفعّل:</b> أرسل الملفات/الفيديوهات الآن.';
        rows.push([cb('➕ إضافة', `add:${id}`), cb('✅ إنهاء الرفع', 'upend')]);
      } else {
        const r = [cb('➕ إضافة', `add:${id}`)];
        if (id) r.push(cb('📤 رفع ملفات', `up:${id}`));
        rows.push(r);
        if (id) rows.push([cb('⚙️ إدارة هذا المجلد', `mg:${id}`)]);
        else rows.push([cb('🛠 لوحة التحكم', 'panel')]);
      }
    }
    if (node && !uploading) {
      const nav = [];
      if (node.parent_id) nav.push(cb('🔙 رجوع', `n:${node.parent_id}:0`));
      nav.push(cb('🏠 الرئيسية', 'n:0:0'));
      rows.push(nav);
    }

    let text = node ? `📍 ${esc(await crumbs(node))}` : WELCOME;
    if (!kids.length && !total)
      text += admin ? '\n\n<i>فارغ — استخدم ➕ إضافة أو 📤 رفع ملفات.</i>' : '\n\n<i>لا يوجد محتوى هنا بعد.</i>';

    const shown = await show(ctx, text + banner, kbd(rows), msgId, true);
    if (admin && shown) await kvSet(`lv:${ctx.chat}`, JSON.stringify({ msgId: shown, nodeId: id, page }));
  }

  async function refreshView(ctx, nodeId) {
    const raw = await kvGet(`lv:${ctx.chat}`);
    if (!raw) return;
    const lv = JSON.parse(raw);
    if (nodeId !== undefined && Number(lv.nodeId) !== Number(nodeId)) return;
    await view(ctx, lv.nodeId, lv.page, lv.msgId);
  }

  /* ---------- التنقل بلوحة المفاتيح السفلية ---------- */
  async function handleNav(ctx, text) {
    const t = text.trim();
    const here = await getCur(ctx.uid);

    if (t === ADMIN_LABEL) {
      if (!ctx.admin) return false;
      await view(ctx, here);
      return true;
    }
    if (t === MAIN_LABEL) { await openNode(ctx, 0); return true; }
    if (t === BACK_LABEL) {
      const node = here ? await getNode(here) : null;
      await openNode(ctx, Number(node?.parent_id) || 0);
      return true;
    }

    const hid = ctx.admin ? null : await legacyId();
    const hit = (await children(here || null)).find((k) => String(k.name).trim() === t && Number(k.id) !== hid);
    if (!hit) {
      const r = await sb('GET', 'nodes', `select=id&limit=1&name=eq.${enc(t)}`);
      if (r.length) {
        await say(ctx, '⚠️ تم تحديث القوائم، عدنا للقائمة الرئيسية.');
        await openNode(ctx, 0);
        return true;
      }
      return false;
    }
    if (!here && String(hit.name).includes('تواصل معنا')) {
      await say(ctx, (await kvGet('contact')) || 'لم تُضف معلومات التواصل بعد.');
      return true;
    }
    await openNode(ctx, Number(hit.id));
    return true;
  }

  async function handleSearch(ctx, text) {
    const q = text.replace(/[%_,()*]/g, ' ').trim().slice(0, 60);
    const rows = q ? await sb('GET', 'files', `select=id,title,kind&limit=15&title=ilike.${enc('*' + q + '*')}`) : [];
    if (!rows.length) return void (await say(ctx, 'لا نتائج. جرّب كلمة أخرى أو /start'));
    await say(ctx, `🔎 نتائج البحث (${rows.length}):`, {
      reply_markup: kbd(rows.map((f) => [cb(`${fileIcon(f)} ${String(f.title).slice(0, 50)}`, `f:${f.id}`)])),
    });
  }

  /* ---------- لوحة التحكم والمشرفون ---------- */
  async function legacyFileCount() {
    const hid = await legacyId();
    if (!hid) return null;
    let ids = [hid], frontier = [hid];
    while (frontier.length) {
      const data = await sb('GET', 'nodes', `select=id&parent_id=in.(${frontier.join(',')})`);
      frontier = data.map((n) => n.id);
      ids = ids.concat(frontier);
    }
    return sbCount('files', `node_id=in.(${ids.join(',')})`);
  }

  async function panelView(ctx) {
    const [u, f, n, left] = await Promise.all([sbCount('users'), sbCount('files'), sbCount('nodes'), legacyFileCount()]);
    let t = `👥 المستخدمون: <b>${u}</b>\n📄 الملفات: <b>${f}</b>\n📁 المجلدات: <b>${n}</b>`;
    if (left !== null) t += `\n📥 ملفات غير مصنفة: <b>${left}</b>`;
    const rows = [[cb('📞 نص «تواصل معنا»', 'ctc')], [cb('📖 الدليل', 'guide')]];
    const hid = await legacyId();
    if (hid) rows.unshift([cb('📥 الملفات القديمة (للتصنيف)', `n:${hid}:0`)]);
    if (isOwner(ctx.uid)) rows.unshift([cb('👥 المشرفون', 'adm')]);
    rows.push([cb('🏠 الرئيسية', 'n:0:0')]);
    await show(ctx, `🛠 <b>لوحة التحكم</b>\n\n${t}`, kbd(rows));
  }

  async function adminsView(ctx, msgId) {
    const list = await loadAdmins();
    const rows = list.map((a) => [cb(`👤 ${String(a.name || a.id).slice(0, 24)}`, 'noop'), cb('❌ إزالة', `admrm:${a.id}`)]);
    rows.push([cb('➕ إضافة بالمعرّف', 'admadd'), cb('🔗 رابط دعوة', 'adminv')]);
    rows.push([cb('🔙 رجوع', 'panel')]);
    const text = `👥 <b>المشرفون</b>\n\n👑 المالكون: ${[...owners].join('، ') || '—'}\n` +
      (list.length ? `\nمشرفون مضافون: ${list.length}` : '\n<i>لا يوجد مشرفون مضافون بعد.</i>');
    await show(ctx, text, kbd(rows), msgId);
  }

  async function sign(e) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(e));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  async function redeemInvite(ctx, payload, from) {
    const m = /^adm_([a-z0-9]+)_([a-f0-9]{16})$/.exec(payload || '');
    if (!m || !secret) return false;
    if ((await sign(m[1])) !== m[2] || parseInt(m[1], 36) < Date.now() / 1000) {
      await say(ctx, '⏰ انتهت صلاحية رابط الدعوة.');
      return true;
    }
    if (!ctx.admin) {
      await addAdmin(ctx.uid, from.first_name, null);
      ctx.admin = true;
      await say(ctx, '🎉 أصبحت الآن مشرفاً. اكتب /help لمعرفة طريقة التحكم.');
    }
    return true;
  }

  /* ---------- رفع الملفات ---------- */
  async function handleUpload(ctx, msg) {
    if (!ctx.admin) return void (await say(ctx, 'رفع الملفات للمشرف فقط.'));
    const st = await getState(ctx.uid);
    if (st?.mode !== 'upload') return void (await say(ctx, 'افتح المجلد المطلوب ثم اضغط «📤 رفع ملفات» أولاً.'));

    const d = msg.document || msg.video;
    const kind = msg.video ? 'video' : 'document';
    const title = (msg.caption || d.file_name || (kind === 'video' ? 'فيديو' : 'ملف'))
      .replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 100);
    const target = Number(st.target_id);

    let mine = null, dup = false;
    const same = await sb('GET', 'files', `select=id&node_id=eq.${target}&file_unique_id=eq.${enc(d.file_unique_id)}&limit=1`);
    if (same.length) dup = true;
    else {
      const r = await sbx('POST', 'files', '', {
        node_id: target, title, kind, file_id: d.file_id, file_unique_id: d.file_unique_id, file_size: d.file_size,
      }, { Prefer: 'return=representation' });
      if (!r.ok) return void (await say(ctx, '❌ تعذّر حفظ الملف. تأكد من إعدادات Supabase.'));
      mine = r.data[0]?.id;
    }

    // عند وصول عدة ملفات معاً، يرسل آخر ملف فقط رسالة الحالة
    await sleep(1800);
    if (mine) {
      const latest = await sb('GET', 'files', `select=id&node_id=eq.${target}&order=id.desc&limit=1`);
      if (Number(latest[0]?.id) !== Number(mine)) return;
    }

    const since = (await kvGet(`upstart:${ctx.uid}`)) || new Date(Date.now() - 3600e3).toISOString();
    const count = await sbCount('files', `node_id=eq.${target}&created_at=gte.${enc(since)}`);
    const node = await getNode(target);
    const text = `✅ أُضيف <b>${count}</b> ملف` + (dup ? '\n⚠️ تم تجاهل ملف مكرر' : '') +
      `\n📍 ${esc(await crumbs(node))}\n📄 آخر ملف: ${esc(title)}\n\nأرسل المزيد أو اضغط «إنهاء الرفع».`;

    const old = await kvGet(`upst:${ctx.uid}`);
    if (old) await tg('deleteMessage', { chat_id: ctx.chat, message_id: Number(old) });
    const sent = await say(ctx, text, { parse_mode: 'HTML', reply_markup: kbd([[cb('✅ إنهاء الرفع', 'upend')]]) });
    if (sent.result?.message_id) await kvSet(`upst:${ctx.uid}`, sent.result.message_id);
  }

  /* ---------- ردود المشرف على رسائل الطلب ---------- */
  async function handleAdminReply(ctx, text, m, msg) {
    const [, act, idStr, kind, msgStr] = m;
    const id = Number(idStr);
    const msgId = msgStr ? Number(msgStr) : undefined;

    if (act === 'add') {
      const names = text.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12);
      for (const n of names) await createNode(id, n, kind);
      await view(ctx, id, 0, msgId);
    } else if (act === 'adm') {
      if (isOwner(ctx.uid)) {
        const fwd = msg.forward_origin?.sender_user || msg.forward_from;
        const uid = fwd?.id || Number(text.replace(/\D/g, ''));
        if (uid) {
          try { await addAdmin(uid, fwd?.first_name || null, ctx.uid); } catch (e) { await say(ctx, '❌ ' + e.message); }
        } else await say(ctx, '❌ أرسل رقم المعرّف (ID) أو حوّل رسالة من الشخص.');
        await adminsView(ctx, msgId);
      }
    } else if (act === 'ctc') {
      await kvSet('contact', text.slice(0, 3500));
      await say(ctx, '✅ حُفظ نص «تواصل معنا».');
    } else if (act === 'rnn') {
      const node = await getNode(id);
      const pre = LEGACY_PREFIXES.find((p) => node?.name.startsWith(p)) || '';
      await sb('PATCH', 'nodes', `id=eq.${id}`, { name: pre + text.slice(0, 60) });
      await view(ctx, id, 0, msgId);
    } else if (act === 'rnf') {
      await sb('PATCH', 'files', `id=eq.${id}`, { title: text.slice(0, 100) });
      const f = await getFile(id);
      if (f && msgId) {
        const where = await crumbs(await getNode(f.node_id));
        await tg('editMessageCaption', {
          chat_id: ctx.chat, message_id: msgId, caption: `${f.title}\n📍 ${where}\n🆔 #${f.id}`.slice(0, 1000),
          reply_markup: fileKb(id),
        });
      }
      if (f) await refreshView(ctx, f.node_id);
    }

    await tg('deleteMessage', { chat_id: ctx.chat, message_id: msg.reply_to_message.message_id });
    await tg('deleteMessage', { chat_id: ctx.chat, message_id: msg.message_id });
    await restoreKeyboard(ctx);
  }

  /* ---------- التصنيف والدمج والتصدير ---------- */
  async function loadPlan() {
    const nodes = await fetchAll('nodes', 'id,parent_id,name,position');
    const fc = new Map();
    (await fetchAll('files', 'id,node_id')).forEach((f) => fc.set(f.node_id, (fc.get(f.node_id) || 0) + 1));
    return { nodes, fc };
  }

  function previewText(plan) {
    const mv = plan.items.filter((i) => i.mode === 'move');
    const cl = plan.items.filter((i) => i.mode === 'clone');
    const g = new Map();
    mv.forEach((i) => g.set(i.dest, [(g.get(i.dest)?.[0] || 0) + 1, (g.get(i.dest)?.[1] || 0) + i.files]));
    let t = '🗂 <b>خطة التصنيف</b>\n\n';
    for (const [d, [n, f]] of g) t += `• ${esc(d)}\n   ${n} مادة — ${f} ملف\n`;
    if (cl.length) t += `\n📑 المستوى المشترك: يُنقل لمدنية ويُنسخ لكهرباء وميكانيكا: ${cl.length} مادة.\n`;
    if (plan.skipped.length) t += `\n⚠️ سيُترك في القديم:\n${plan.skipped.slice(0, 10).map((s) => '– ' + esc(s)).join('\n')}\n`;
    t += `\nقد يُنفَّذ على دفعات (حدّ الطلبات ${LIMIT}); كرر الأمر حتى يكتمل. لا يُحذف شيء. اختر:`;
    return t;
  }

  async function cloneTree(srcId, parentId, name, position, byParent) {
    const root = (await sb('POST', 'nodes', '', { parent_id: parentId, name, position }, { Prefer: 'return=representation' }))[0];
    if (!root) throw new Error('تعذّر إنشاء النسخة');
    const pairs = [[srcId, root.id]];
    let frontier = [[srcId, root.id]];
    while (frontier.length) {
      const batch = [];
      for (const [s, n] of frontier)
        (byParent.get(s) || []).forEach((k, i) => batch.push({ src: k.id, row: { parent_id: n, name: k.name, position: i + 1 } }));
      if (!batch.length) break;
      const created = await sb('POST', 'nodes', '', batch.map((b) => b.row), { Prefer: 'return=representation' });
      frontier = created.map((c, i) => [batch[i].src, c.id]);
      pairs.push(...frontier);
    }
    const map = new Map(pairs);
    const files = await sb('GET', 'files', `select=node_id,title,kind,file_id,file_unique_id,file_size&node_id=in.(${[...map.keys()].join(',')})`);
    if (files.length) await sb('POST', 'files', '', files.map((f) => ({ ...f, node_id: map.get(f.node_id) })));
  }

  async function classifyRun(ctx, mode) {
    const { nodes, fc } = await loadPlan();
    const plan = planFrom(nodes, fc, mode);
    if (plan.error) return void (await say(ctx, '❌ ' + plan.error));
    const byParent = new Map();
    nodes.forEach((n) => (byParent.get(n.parent_id) || byParent.set(n.parent_id, []).get(n.parent_id)).push(n));
    const posOf = new Map();
    const nextIn = (id) => {
      if (!posOf.has(id)) posOf.set(id, Math.max(0, ...(byParent.get(id) || []).map((k) => Number(k.position) || 0)) + 1);
      const v = posOf.get(id); posOf.set(id, v + 1); return v;
    };

    const units = new Map(); // لكل مادة: النسخ ثم النقل
    plan.items.forEach((it) => (units.get(it.id) || units.set(it.id, []).get(it.id)).push(it));
    let moved = 0, cloned = 0, files = 0, done = 0; const failed = [];
    for (const [srcId, list] of units) {
      if (calls() > LIMIT - 10) break;
      const src = nodes.find((n) => n.id === srcId);
      try {
        for (const it of list.filter((x) => x.mode === 'clone')) {
          await cloneTree(src.id, it.destSem, clean(src.name), nextIn(it.destSem), byParent); cloned++;
        }
        for (const it of list.filter((x) => x.mode === 'move')) {
          await sb('PATCH', 'nodes', `id=eq.${src.id}`, { parent_id: it.destSem, name: clean(src.name), position: nextIn(it.destSem) });
          moved++; files += it.files;
        }
        done++;
      } catch (e) { failed.push(`${clean(src.name)}: ${e.message}`); }
    }
    const rest = units.size - done - failed.length;
    let t = `✅ <b>تم</b>\n\n📘 مواد منقولة: <b>${moved}</b> (${files} ملف)`;
    if (cloned) t += `\n📑 مواد منسوخة للأقسام المشتركة: <b>${cloned}</b>`;
    if (failed.length) t += `\n\n❌ تعذّر:\n${failed.slice(0, 5).map(esc).join('\n')}`;
    if (rest > 0) t += `\n\n⏳ بقي <b>${rest}</b> مادة. أرسل /classify ونفّذ مرة أخرى لإكمال الباقي.`;
    else t += '\n\nراجع القوائم بـ /start. ما بقي في «الملفات القديمة» مجلدات فارغة يمكنك حذفها.';
    await say(ctx, t, { parse_mode: 'HTML' });
  }

  async function mergeRun(ctx) {
    const { nodes, fc } = await loadPlan();
    let moved = 0, deleted = 0; const failed = [];
    const items = mergePlan(nodes, fc);
    let rest = items.length;
    for (const it of items) {
      if (calls() > LIMIT - 8) break;
      try {
        let target = it.target;
        if (!target) {
          target = (await sb('POST', 'nodes', '', { parent_id: it.parent, name: '📚 مقررات', position: 0 }, { Prefer: 'return=representation' }))[0]?.id;
          if (!target) throw new Error('تعذّر إنشاء «مقررات»');
        }
        await sb('PATCH', 'files', `node_id=eq.${it.id}`, { node_id: target });
        await sb('PATCH', 'nodes', `parent_id=eq.${it.id}`, { parent_id: target });
        if (await sbCount('files', `node_id=eq.${it.id}`)) throw new Error('بقيت ملفات');
        await sb('DELETE', 'nodes', `id=eq.${it.id}`);
        moved += it.files; deleted++; rest--;
      } catch (e) { failed.push(`${it.name}: ${e.message}`); rest--; }
    }
    let t = `✅ <b>تم</b>\n🗑 مجلدات محذوفة: <b>${deleted}</b>\n📄 ملفات نُقلت إلى «مقررات»: <b>${moved}</b>`;
    if (failed.length) t += `\n\n❌ تعذّر:\n${failed.slice(0, 5).map(esc).join('\n')}`;
    if (rest > 0) t += `\n\n⏳ بقي ${rest}. أرسل /merge مرة أخرى لإكمال الباقي.`;
    await say(ctx, t, { parse_mode: 'HTML' });
  }

  async function exportRun(ctx) {
    const nodes = await fetchAll('nodes', 'id,parent_id,name,position');
    const files = await fetchAll('files', 'id,node_id,title,kind,file_size');
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pathOf = (id) => { const a = []; for (let c = byId.get(id); c; c = byId.get(c.parent_id)) a.unshift(c.name); return a.join(' > '); };
    const data = {
      exported_at: new Date().toISOString(),
      nodes: nodes.map((n) => ({ ...n, path: pathOf(n.id) })),
      files: files.map((f) => ({ id: f.id, title: f.title, kind: f.kind, size: f.file_size, node_id: f.node_id, path: pathOf(f.node_id) })),
    };
    const form = new FormData();
    form.append('chat_id', String(ctx.chat));
    form.append('caption', `📦 ${data.nodes.length} مجلد — ${data.files.length} ملف`);
    form.append('document', new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), 'library-export.json');
    await tgForm('sendDocument', form);
  }

  /* ---------- ضغطات الأزرار الشفافة ---------- */
  const ADMIN_ACTS = /^(add|addk|up|upend|mg|rnn|nup|ndn|deln|delnok|mvn|mva|mvf|mvcancel|mvhere|rnf|delf|fcancel|delfok|panel|guide|ctc|cls|mrg)(:|$)/;
  const OWNER_ACTS = /^(adm|admadd|admrm|adminv)(:|$)/;

  async function manageView(ctx, node) {
    const sibs = await children(node.parent_id);
    const pos = sibs.findIndex((s) => Number(s.id) === Number(node.id)) + 1;
    await show(ctx, `⚙️ <b>إدارة</b>\n${esc(await crumbs(node))}\n\n🔢 الترتيب: ${pos} من ${sibs.length}`, kbd([
      [cb('✏️ إعادة تسمية', `rnn:${node.id}`)],
      [cb('⬆️ تقديم', `nup:${node.id}`), cb('⬇️ تأخير', `ndn:${node.id}`)],
      [cb('🔀 نقل', `mvn:${node.id}`), cb('🗑 حذف', `deln:${node.id}`)],
      [cb('📦 نقل كل المحتوى إلى مجلد آخر', `mva:${node.id}`)],
      [cb('🔙 رجوع', `n:${node.id}:0`)],
    ]));
  }

  async function inside(start, target) {
    let c = start ? await getNode(start) : null;
    while (c) { if (Number(c.id) === Number(target)) return true; c = c.parent_id ? await getNode(c.parent_id) : null; }
    return false;
  }

  async function handleCallback(ctx, data) {
    let m;
    if (data === 'noop') return void (await answer(ctx));

    if ((m = /^n:(\d+):(\d+)$/.exec(data))) { await answer(ctx); return view(ctx, Number(m[1]), Number(m[2])); }

    if ((m = /^f:(\d+)$/.exec(data))) {
      const f = await getFile(m[1]);
      if (!f) return void (await answer(ctx, 'الملف غير موجود', true));
      await answer(ctx, 'جارٍ الإرسال...');
      const where = ctx.admin ? await crumbs(await getNode(f.node_id)) : '';
      return void (await sendFile(ctx, f, ctx.admin ? `${f.title}\n📍 ${where}\n🆔 #${f.id}` : f.title, ctx.admin));
    }

    if (ADMIN_ACTS.test(data) && !ctx.admin) return void (await answer(ctx, 'للمشرف فقط', true));
    if (OWNER_ACTS.test(data) && !isOwner(ctx.uid)) return void (await answer(ctx, 'للمالك فقط', true));

    if ((m = /^add:(\d+)$/.exec(data))) {
      await answer(ctx);
      const id = m[1];
      return void (await tg('editMessageReplyMarkup', { chat_id: ctx.chat, message_id: ctx.msgId, reply_markup: kbd([
        [cb('📘 مادة (تفرعات تلقائية)', `addk:${id}:s`)],
        [cb('🎓 مستوى (Semester 1/2 تلقائياً)', `addk:${id}:l`)],
        [cb('📁 مجلد عادي (تخصص/أي شيء)', `addk:${id}:f`)],
        [cb('↩️ إلغاء', `n:${id}:0`)],
      ]) }));
    }
    if ((m = /^addk:(\d+):([fsl])$/.exec(data))) {
      await answer(ctx);
      const label = { s: 'المادة (ستُنشأ مقررات وامتحانات تلقائياً)', l: 'المستوى (سيُنشأ Semester 1 و Semester 2 تلقائياً)', f: 'المجلد' }[m[2]];
      return void (await forceReply(ctx, `✏️ أرسل اسم ${label}\n(يمكنك إرسال عدة أسماء، كل اسم في سطر)\n(رد على هذه الرسالة)`, `add:${m[1]}:${m[2]}`));
    }

    if ((m = /^up:(\d+)$/.exec(data))) {
      const id = Number(m[1]);
      await setState(ctx.uid, 'upload', id);
      await kvSet(`upstart:${ctx.uid}`, new Date().toISOString());
      await kvDel(`upst:${ctx.uid}`);
      await answer(ctx, 'وضع الرفع مفعّل');
      return view(ctx, id);
    }
    if (data === 'upend') {
      const st = await getState(ctx.uid);
      await clearState(ctx.uid);
      await kvDel(`upst:${ctx.uid}`);
      await answer(ctx, 'تم إنهاء الرفع ✅');
      const stale = JSON.parse((await kvGet(`lv:${ctx.chat}`)) || 'null');
      await view(ctx, Number(st?.target_id) || 0);
      const now = JSON.parse((await kvGet(`lv:${ctx.chat}`)) || 'null');
      if (stale && now && stale.msgId !== now.msgId) await tg('deleteMessage', { chat_id: ctx.chat, message_id: stale.msgId });
      return;
    }

    if ((m = /^mg:(\d+)$/.exec(data))) {
      const node = await getNode(m[1]);
      if (!node) return void (await answer(ctx, 'غير موجود'));
      await answer(ctx);
      return manageView(ctx, node);
    }
    if ((m = /^rnn:(\d+)$/.exec(data))) {
      await answer(ctx);
      return void (await forceReply(ctx, '✏️ أرسل الاسم الجديد (رد على هذه الرسالة)', `rnn:${m[1]}`));
    }
    if ((m = /^(nup|ndn):(\d+)$/.exec(data))) {
      const node = await getNode(m[2]);
      if (!node) return void (await answer(ctx, 'غير موجود'));
      const dir = m[1] === 'nup' ? -1 : 1;
      const moved = await swap(node, dir);
      await answer(ctx, moved ? 'تم ✅' : dir < 0 ? 'هو الأول بالفعل' : 'هو الأخير بالفعل');
      return moved ? manageView(ctx, node) : undefined;
    }
    if ((m = /^deln:(\d+)$/.exec(data))) {
      const node = await getNode(m[1]);
      if (!node) return void (await answer(ctx, 'غير موجود'));
      await answer(ctx);
      return void (await show(ctx, `⚠️ حذف «${esc(node.name)}» وكل ما بداخله من مجلدات وملفات؟`,
        kbd([[cb('✅ نعم، احذف', `delnok:${m[1]}`), cb('↩️ إلغاء', `mg:${m[1]}`)]])));
    }
    if ((m = /^delnok:(\d+)$/.exec(data))) {
      const node = await getNode(m[1]);
      if (!node) return void (await answer(ctx, 'غير موجود'));
      await sb('DELETE', 'nodes', `id=eq.${node.id}`);
      await answer(ctx, 'تم الحذف 🗑');
      return view(ctx, Number(node.parent_id) || 0);
    }

    if ((m = /^mvn:(\d+)$/.exec(data))) {
      const node = await getNode(m[1]);
      if (!node) return void (await answer(ctx, 'غير موجود'));
      await setState(ctx.uid, 'move_node', node.id);
      await answer(ctx, 'اختر الوجهة');
      return view(ctx, Number(node.parent_id) || 0);
    }
    if ((m = /^mva:(\d+)$/.exec(data))) {
      const node = await getNode(m[1]);
      if (!node) return void (await answer(ctx, 'غير موجود'));
      await setState(ctx.uid, 'move_all', node.id);
      await answer(ctx, 'اختر المجلد الوجهة');
      return view(ctx, 0);
    }
    if ((m = /^mvf:(\d+)$/.exec(data))) {
      const f = await getFile(m[1]);
      if (!f) return void (await answer(ctx, 'غير موجود'));
      await setState(ctx.uid, 'move_file', f.id);
      await answer(ctx, 'اختر الوجهة');
      return view(ctx, Number(f.node_id));
    }
    if (data === 'mvcancel') {
      await clearState(ctx.uid);
      await answer(ctx, 'أُلغي النقل');
      return view(ctx, 0);
    }
    if ((m = /^mvhere:(\d+)$/.exec(data))) {
      const dest = Number(m[1]);
      const st = await getState(ctx.uid);
      if (!st?.mode?.startsWith('move_')) return void (await answer(ctx, 'لا يوجد نقل نشط'));
      const tid = Number(st.target_id);
      if (st.mode === 'move_file') {
        if (!dest) return void (await answer(ctx, 'لا يمكن وضع ملف في الصفحة الرئيسية', true));
        await sb('PATCH', 'files', `id=eq.${tid}`, { node_id: dest });
      } else if (st.mode === 'move_all') {
        if (!dest) return void (await answer(ctx, 'اختر مجلداً وليس الصفحة الرئيسية', true));
        if (await inside(dest, tid)) return void (await answer(ctx, 'لا يمكن النقل إلى نفس المجلد أو داخله', true));
        await sb('PATCH', 'files', `node_id=eq.${tid}`, { node_id: dest });
        let pos = await nextPos(dest);
        for (const k of await children(tid)) await sb('PATCH', 'nodes', `id=eq.${k.id}`, { parent_id: dest, position: pos++ });
      } else {
        if (await inside(dest, tid)) return void (await answer(ctx, 'لا يمكن نقل المجلد داخل نفسه', true));
        await sb('PATCH', 'nodes', `id=eq.${tid}`, { parent_id: dest || null, position: await nextPos(dest) });
      }
      await clearState(ctx.uid);
      await answer(ctx, 'تم النقل ✅');
      return view(ctx, dest);
    }

    if ((m = /^rnf:(\d+)$/.exec(data))) {
      await answer(ctx);
      return void (await forceReply(ctx, '✏️ أرسل العنوان الجديد للملف (رد على هذه الرسالة)', `rnf:${m[1]}`));
    }
    if ((m = /^delf:(\d+)$/.exec(data))) {
      await answer(ctx);
      return void (await tg('editMessageReplyMarkup', { chat_id: ctx.chat, message_id: ctx.msgId,
        reply_markup: kbd([[cb('✅ نعم، احذف', `delfok:${m[1]}`), cb('↩️ إلغاء', `fcancel:${m[1]}`)]]) }));
    }
    if ((m = /^fcancel:(\d+)$/.exec(data))) {
      await answer(ctx);
      return void (await tg('editMessageReplyMarkup', { chat_id: ctx.chat, message_id: ctx.msgId, reply_markup: fileKb(m[1]) }));
    }
    if ((m = /^delfok:(\d+)$/.exec(data))) {
      const f = await getFile(m[1]);
      await sb('DELETE', 'files', `id=eq.${m[1]}`);
      await answer(ctx, 'تم الحذف 🗑');
      await tg('deleteMessage', { chat_id: ctx.chat, message_id: ctx.msgId });
      if (f) await refreshView(ctx, f.node_id);
      return;
    }

    if (data === 'panel') { await answer(ctx); return panelView(ctx); }
    if (data === 'guide') {
      await answer(ctx);
      return void (await show(ctx, ADMIN_HELP, kbd([[cb('🔙 رجوع', 'panel')]])));
    }
    if (data === 'ctc') {
      await answer(ctx);
      return void (await forceReply(ctx, '✏️ أرسل نص «تواصل معنا» (أرقام، روابط، أي معلومات) — رد على هذه الرسالة', 'ctc:0'));
    }

    if (data === 'adm') { await answer(ctx); return adminsView(ctx); }
    if (data === 'admadd') {
      await answer(ctx);
      return void (await forceReply(ctx, '➕ أرسل رقم المعرّف (ID) للمشرف الجديد، أو حوّل لي رسالة منه.\n(رد على هذه الرسالة)', 'adm:0'));
    }
    if ((m = /^admrm:(\d+)$/.exec(data))) {
      await removeAdmin(m[1]);
      await answer(ctx, 'تمت الإزالة');
      return adminsView(ctx);
    }
    if (data === 'adminv') {
      if (!secret) return void (await answer(ctx, 'اضبط WEBHOOK_SECRET أولاً', true));
      await answer(ctx);
      const e = (Math.floor(Date.now() / 1000) + 3600).toString(36);
      const me = await tg('getMe');
      const link = `https://t.me/${me.result?.username}?start=adm_${e}_${await sign(e)}`;
      return void (await show(ctx, `🔗 <b>رابط دعوة مشرف</b> (صالح لمدة ساعة)\n\n${link}\n\nأرسله للشخص وسيصبح مشرفاً عند فتحه.`,
        kbd([[cb('🔙 رجوع', 'adm')]])));
    }

    if (data === 'cls:no' || data === 'mrg:no') {
      await answer(ctx, 'أُلغي');
      return void (await tg('deleteMessage', { chat_id: ctx.chat, message_id: ctx.msgId }));
    }
    if ((m = /^cls:(all|one)$/.exec(data))) {
      await answer(ctx, 'جارٍ التنفيذ…');
      await tg('editMessageText', { chat_id: ctx.chat, message_id: ctx.msgId, text: '⏳ جارٍ نقل الملفات…' });
      return classifyRun(ctx, m[1]);
    }
    if (data === 'mrg:yes') {
      await answer(ctx, 'جارٍ التنفيذ…');
      await tg('editMessageText', { chat_id: ctx.chat, message_id: ctx.msgId, text: '⏳ جارٍ الدمج…' });
      return mergeRun(ctx);
    }
    await answer(ctx);
  }

  /* ---------- المعالج الرئيسي ---------- */
  async function handleUpdate(u) {
    if (u.callback_query) {
      const cq = u.callback_query;
      if (!cq.message) return void (await tg('answerCallbackQuery', { callback_query_id: cq.id }));
      const ctx = {
        chat: cq.message.chat.id, uid: cq.from.id, cbId: cq.id, msgId: cq.message.message_id, from: cq.from,
        admin: await isAdmin(cq.from.id),
      };
      return handleCallback(ctx, cq.data || '');
    }

    const msg = u.message;
    if (!msg) return;
    const ctx = { chat: msg.chat.id, uid: msg.from.id, from: msg.from, admin: await isAdmin(msg.from.id) };

    if (msg.document || msg.video) return handleUpload(ctx, msg);
    if (typeof msg.text !== 'string') return;
    const text = msg.text.trim();

    const sm = /^\/start(@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (sm) {
      await sb('POST', 'users', 'on_conflict=id',
        [{ id: ctx.uid, username: msg.from.username || null, first_name: msg.from.first_name || null }],
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (sm[2] && (await redeemInvite(ctx, sm[2], msg.from))) return openNode(ctx, 0);
      return openNode(ctx, 0);
    }

    if (/^\/help(@\w+)?$/.test(text)) return void (await say(ctx, ctx.admin ? ADMIN_HELP : USER_HELP, { parse_mode: 'HTML' }));
    if (/^\/(panel|stats)(@\w+)?$/.test(text)) return ctx.admin ? panelView(ctx) : undefined;
    if (/^\/cancel(@\w+)?$/.test(text)) {
      if (!ctx.admin) return;
      await clearState(ctx.uid);
      return void (await say(ctx, 'تم إلغاء الوضع الحالي.'));
    }
    if (/^\/export(@\w+)?$/.test(text)) return ctx.admin ? exportRun(ctx) : undefined;
    if (/^\/classify(@\w+)?$/.test(text)) {
      if (!ctx.admin) return;
      const { nodes, fc } = await loadPlan();
      const plan = planFrom(nodes, fc, 'all');
      if (plan.error) return void (await say(ctx, '❌ ' + plan.error));
      if (!plan.items.length) return void (await say(ctx, 'لا يوجد محتوى قديم قابل للتصنيف.'));
      return void (await say(ctx, previewText(plan), { parse_mode: 'HTML', reply_markup: kbd([
        [cb('✅ نفّذ — المشترك لكل الأقسام الثلاثة', 'cls:all')],
        [cb('✅ نفّذ — المشترك لمدنية فقط', 'cls:one')],
        [cb('❌ إلغاء', 'cls:no')],
      ]) }));
    }
    if (/^\/merge(@\w+)?$/.test(text)) {
      if (!ctx.admin) return;
      const { nodes, fc } = await loadPlan();
      const items = mergePlan(nodes, fc);
      if (!items.length) return void (await say(ctx, 'لا توجد مجلدات «تلخيص» أو «شروحات فيديو».'));
      const files = items.reduce((a, i) => a + i.files, 0);
      return void (await say(ctx,
        `🧹 <b>دمج المجلدات</b>\n\n• مجلدات ستُحذف: <b>${items.length}</b>\n• ملفات ستُنقل إلى «مقررات»: <b>${files}</b>\n\nلا يُحذف أي ملف، فقط المجلدات الفارغة بعد النقل.`,
        { parse_mode: 'HTML', reply_markup: kbd([[cb('✅ نفّذ', 'mrg:yes'), cb('❌ إلغاء', 'mrg:no')]]) }));
    }
    if (text === '' || text.startsWith('/')) return;

    const tag = msg.reply_to_message?.text?.match(/🔖 (add|rnn|rnf|adm|ctc):(\d+)(?::([fsl]))?(?::(\d+))?/);
    if (ctx.admin && tag) return handleAdminReply(ctx, text, tag, msg);

    if (await handleNav(ctx, text)) return;
    await handleSearch(ctx, text);
  }

  return { tg, sb, loadAdmins, handleUpdate };
}

/* ================= مهمة أسبوعية: إبقاء Supabase نشطاً ================= */

async function keepAlive(env) {
  const { tg, sbx } = makeApi(env);
  const r = await sbx('GET', 'nodes', 'select=id&limit=1');
  const me = await tg('getMe');
  return { supabase_ok: r.ok, supabase_status: r.status, telegram_ok: !!me.ok, time: new Date().toISOString() };
}

/* ================= نقطة الدخول ================= */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = (env.WEBHOOK_SECRET || '').trim();

    // تفعيل الـ webhook وقائمة الأوامر (مرة واحدة)
    if (url.pathname === '/setup') {
      if (!secret || url.searchParams.get('key') !== secret) return new Response('wrong key', { status: 403 });
      const bot = makeBot(env);
      const hook = `${url.origin}/webhook`;
      const r = await bot.tg('setWebhook', { url: hook, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
      await bot.tg('setMyCommands', { commands: USER_CMDS });
      const ids = new Set((env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean));
      (await bot.loadAdmins()).forEach((a) => ids.add(Number(a.id)));
      for (const id of ids) await bot.tg('setMyCommands', { commands: ADMIN_CMDS, scope: { type: 'chat', chat_id: id } });
      return new Response(JSON.stringify(r) + '\n' + hook, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // فحص الاتصال بـ Supabase وتلجرام: /ping?key=WEBHOOK_SECRET
    if (url.pathname === '/ping') {
      if (!secret || url.searchParams.get('key') !== secret) return new Response('wrong key', { status: 403 });
      return new Response(JSON.stringify(await keepAlive(env), null, 1), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (!secret || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
        return new Response('forbidden', { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response('OK'); }
      const bot = makeBot(env);
      ctx.waitUntil(bot.handleUpdate(update).catch((e) => console.error('bot error:', e.stack || e.message)));
      return new Response('OK');
    }

    return new Response('OK');
  },

  // يُستدعى تلقائياً حسب جدول crons في wrangler.jsonc
  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepAlive(env).then((r) => console.log('keep-alive:', JSON.stringify(r))));
  },
};
