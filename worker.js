/**
 * بوت المكتبة — Cloudflare Worker — الإصدار 1 (جانب المستخدم)
 * يعمل على نفس قاعدة Supabase الحالية دون أي تغيير في البيانات.
 *
 * المتغيرات (Settings ← Variables and Secrets):
 *   BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY (المفتاح السري), WEBHOOK_SECRET, ADMIN_IDS
 *
 * التفعيل مرة واحدة:  https://اسم-الworker.workers.dev/setup?key=WEBHOOK_SECRET
 */

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
const LEGACY_NAME = '📥 ملفات قديمة (غير مصنفة)';

const collator = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const enc = encodeURIComponent;

/* ================= الاتصال بتلجرام و Supabase ================= */

function makeApi(env) {
  const base = `https://api.telegram.org/bot${(env.BOT_TOKEN || '').trim()}`;
  const sbUrl = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const sbKey = (env.SUPABASE_KEY || '').trim();

  async function tg(method, params = {}) {
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

  async function sb(method, table, query = '', body = null, extra = {}) {
    const auth = sbKey.startsWith('eyJ') ? { Authorization: `Bearer ${sbKey}` } : {}; // المفاتيح الجديدة ليست JWT
    const headers = { apikey: sbKey, 'Content-Type': 'application/json', ...auth, ...extra };
    try {
      const r = await fetch(`${sbUrl}/rest/v1/${table}${query ? '?' + query : ''}`, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (!r.ok) console.error('sb error', method, table, r.status, text.slice(0, 200));
      try {
        const d = JSON.parse(text);
        return Array.isArray(d) ? d : [];
      } catch {
        return [];
      }
    } catch (e) {
      console.error('sb fetch error', e.message);
      return [];
    }
  }

  return { tg, sb };
}

/* ================= المنطق ================= */

function makeBot(env) {
  const { tg, sb } = makeApi(env);
  const owners = new Set(
    (env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean)
  );

  const isAdmin = async (uid) =>
    owners.has(uid) || (await sb('GET', 'admins', `select=id&id=eq.${uid}`)).length > 0;

  const children = (parent) =>
    sb('GET', 'nodes', `select=*&order=position.asc,id.asc&${parent ? 'parent_id=eq.' + parent : 'parent_id=is.null'}`);

  const getNode = async (id) => (await sb('GET', 'nodes', `select=*&id=eq.${id}`))[0] || null;

  const legacyId = async () => {
    const r = await sb('GET', 'nodes', `select=id&parent_id=is.null&name=eq.${enc(LEGACY_NAME)}&limit=1`);
    return r[0] ? Number(r[0].id) : null;
  };

  const getCur = async (uid) => Number((await sb('GET', 'users', `select=cur_node&id=eq.${uid}`))[0]?.cur_node) || 0;
  const setCur = (uid, node) => sb('PATCH', 'users', `id=eq.${uid}`, { cur_node: node || null });
  const getSetting = async (key) => (await sb('GET', 'settings', `select=value&key=eq.${enc(key)}`))[0]?.value ?? null;

  /* ---------- لوحة المفاتيح والعرض ---------- */

  async function keyboardFor(nodeId, admin) {
    const hid = admin ? null : await legacyId(); // المجلد القديم للمشرف فقط
    const kids = (await children(nodeId || null)).filter((k) => Number(k.id) !== hid);
    const rows = kids.map((k) => [{ text: String(k.name).trim() }]);
    if (nodeId) rows.push([{ text: BACK_LABEL }, { text: MAIN_LABEL }]);
    if (admin) rows.push([{ text: ADMIN_LABEL }]);
    return { kb: { keyboard: rows, resize_keyboard: true }, hasKids: kids.length > 0 };
  }

  const sendFile = (chat, f) => {
    const video = f.kind === 'video';
    return tg(video ? 'sendVideo' : 'sendDocument', {
      chat_id: chat,
      [video ? 'video' : 'document']: f.file_id,
      caption: String(f.title).slice(0, 1000),
    });
  };

  async function sendFiles(chat, files) {
    const docs = files.filter((f) => f.kind !== 'video');
    const vids = files.filter((f) => f.kind === 'video');
    for (let i = 0; i < docs.length; i += 10) {
      const chunk = docs.slice(i, i + 10);
      if (chunk.length === 1) { await sendFile(chat, chunk[0]); continue; }
      const res = await tg('sendMediaGroup', {
        chat_id: chat,
        media: chunk.map((f) => ({ type: 'document', media: f.file_id, caption: String(f.title).slice(0, 1000) })),
      });
      if (!res.ok) for (const f of chunk) await sendFile(chat, f); // احتياط عند فشل المجموعة
    }
    for (const v of vids) await sendFile(chat, v);
  }

  async function openNode(chat, uid, admin, nodeId = 0) {
    const node = nodeId ? await getNode(nodeId) : null;
    const id = node ? Number(node.id) : 0;
    await setCur(uid, id);

    let files = [];
    if (id) {
      files = await sb('GET', 'files', `select=*&node_id=eq.${id}`);
      files.sort((a, b) => collator.compare(a.title, b.title)); // محاضرة 2 قبل محاضرة 10
    }
    const { kb, hasKids } = await keyboardFor(id, admin);
    let text = node ? esc(node.name) : WELCOME;
    if (node && !hasKids && !files.length) text += '\n\n<i>لا يوجد محتوى هنا بعد.</i>';

    await tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', reply_markup: kb });
    if (files.length) await sendFiles(chat, files.slice(0, 100));
  }

  /* ---------- معالجة الرسائل ---------- */

  // يرجع true إن كان النص ضغطة زر من لوحة المفاتيح
  async function handleNav(chat, uid, admin, text) {
    const t = text.trim();
    const here = await getCur(uid);

    if (t === ADMIN_LABEL) {
      if (!admin) return false;
      await tg('sendMessage', { chat_id: chat, text: '⚙️ أدوات المشرف (الرفع والإضافة والنقل) ستصل في الإصدار 2 من نسخة Cloudflare.' });
      return true;
    }
    if (t === MAIN_LABEL) { await openNode(chat, uid, admin, 0); return true; }
    if (t === BACK_LABEL) {
      const node = here ? await getNode(here) : null;
      await openNode(chat, uid, admin, Number(node?.parent_id) || 0);
      return true;
    }

    const hid = admin ? null : await legacyId();
    const hit = (await children(here || null)).find((k) => String(k.name).trim() === t && Number(k.id) !== hid);

    if (!hit) {
      // لوحة مفاتيح قديمة بعد تعديل القوائم؟ نعيده للرئيسية بدل البحث
      const r = await sb('GET', 'nodes', `select=id&limit=1&name=eq.${enc(t)}`);
      if (r.length) {
        await tg('sendMessage', { chat_id: chat, text: '⚠️ تم تحديث القوائم، عدنا للقائمة الرئيسية.' });
        await openNode(chat, uid, admin, 0);
        return true;
      }
      return false; // ليس زراً: يُعامل كبحث
    }

    if (!here && String(hit.name).includes('تواصل معنا')) {
      await tg('sendMessage', { chat_id: chat, text: (await getSetting('contact')) || 'لم تُضف معلومات التواصل بعد.' });
      return true;
    }
    await openNode(chat, uid, admin, Number(hit.id));
    return true;
  }

  async function handleSearch(chat, text) {
    const q = text.replace(/[%_,()*]/g, ' ').trim().slice(0, 60);
    const rows = q ? await sb('GET', 'files', `select=id,title,kind&limit=15&title=ilike.${enc('*' + q + '*')}`) : [];
    if (!rows.length) {
      await tg('sendMessage', { chat_id: chat, text: 'لا نتائج. جرّب كلمة أخرى أو /start' });
      return;
    }
    await tg('sendMessage', {
      chat_id: chat,
      text: `🔎 نتائج البحث (${rows.length}):`,
      reply_markup: {
        inline_keyboard: rows.map((f) => [{
          text: (f.kind === 'video' ? '🎬 ' : '📄 ') + String(f.title).slice(0, 50),
          callback_data: 'f:' + f.id,
        }]),
      },
    });
  }

  async function handleUpdate(u) {
    /* ضغطة زر شفاف (نتائج البحث) */
    if (u.callback_query) {
      const cq = u.callback_query;
      const chat = cq.message?.chat?.id;
      const m = /^f:(\d+)$/.exec(cq.data || '');
      if (m && chat) {
        const f = (await sb('GET', 'files', `select=*&id=eq.${m[1]}`))[0];
        if (!f) return void (await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'الملف غير موجود', show_alert: true }));
        await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'جارٍ الإرسال...' });
        await sendFile(chat, f);
      } else {
        await tg('answerCallbackQuery', { callback_query_id: cq.id });
      }
      return;
    }

    const msg = u.message;
    if (!msg || typeof msg.text !== 'string') return;
    const chat = msg.chat.id;
    const uid = msg.from.id;
    const text = msg.text.trim();
    const admin = await isAdmin(uid);

    if (/^\/start(@\w+)?(\s|$)/.test(text)) {
      await sb('POST', 'users', 'on_conflict=id',
        [{ id: uid, username: msg.from.username || null, first_name: msg.from.first_name || null }],
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      return openNode(chat, uid, admin, 0);
    }
    if (text === '' || text.startsWith('/')) return;
    if (await handleNav(chat, uid, admin, text)) return;
    await handleSearch(chat, text);
  }

  return { tg, handleUpdate };
}

/* ================= نقطة الدخول ================= */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = (env.WEBHOOK_SECRET || '').trim();

    // تفعيل الـ webhook مرة واحدة
    if (url.pathname === '/setup') {
      if (!secret || url.searchParams.get('key') !== secret) return new Response('wrong key', { status: 403 });
      const { tg } = makeApi(env);
      const hook = `${url.origin}/webhook`;
      const r = await tg('setWebhook', {
        url: hook,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
      });
      return new Response(JSON.stringify(r) + '\n' + hook, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // طلبات تلجرام فقط
    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (!secret || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
        return new Response('forbidden', { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response('OK'); }

      // نردّ على تلجرام فوراً ونكمل المعالجة في الخلفية
      const bot = makeBot(env);
      ctx.waitUntil(bot.handleUpdate(update).catch((e) => console.error('bot error:', e.message)));
      return new Response('OK');
    }

    return new Response('OK');
  },
};
