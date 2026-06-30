// @ts-nocheck
/**
 * =======================================================
 * IPTV Proxy & Front-end - Cloudflare Worker
 * نسخه پیشرفته با سیستم سطح دسترسی + پروفایل + آپلود سنتر
 * + آمار بازدید کانال‌ها + پشتیبان‌گیری + اعلان تلگرام
 * =======================================================
 * متغیرهای محیطی (Environment Variables) مورد نیاز:
 * IPTV_KV          — KV Namespace binding (الزامی)
 * IPTV_R2          — R2 Bucket binding برای عکس پروفایل و فایل‌های آپلودی VIP (الزامی برای آپلود)
 * ADMIN_USERNAME   — نام‌کاربری حساب ادمین/owner (پیش‌فرض: "admin"). فقط همین یوزر به پنل مدیریت دسترسی دارد.
 * TRUST_CODE       — کد اعتماد مخفی برای وریفای VIP (پیش‌فرض: IPTV2025VIP)
 * TRON_ADDRESS     — آدرس کیف پول ترون برای دریافت پرداخت
 * TELEGRAM_BOT_TOKEN — توکن ربات تلگرام برای اعلان‌ها (اختیاری)
 * TELEGRAM_CHAT_ID   — آیدی چت یا کانال تلگرام برای دریافت اعلان‌ها (اختیاری)
 *
 * سطوح دسترسی کاربران (فیلد tier):
 *   "none"     — ثبت‌نام کرده، بدون اشتراک (بدون تیک)
 *   "sub"      — اشتراک پولی (تیک آبی، بدون کانال VIP)
 *   "vip"      — وریفای با کد اعتماد (تیک طلایی، همه کانال‌ها + اخبار + آپلود سنتر)
 * علاوه بر این، کاربری که username او برابر ADMIN_USERNAME باشد role="owner" دارد:
 * تیک خاکستری + برچسب ADMIN/OWNER + دسترسی کامل به پنل مدیریت (مستقل از tier).
 *
 * سطح دسترسی کانال‌ها (فیلد access):
 *   "public"   — در صفحه اصلی برای همه نمایش داده می‌شود
 *   "sub"      — فقط برای کاربران دارای اشتراک/VIP/ادمین نمایش داده می‌شود (نیاز به اشتراک پولی)
 *   "vip"      — فقط برای کاربران VIP یا ادمین نمایش داده می‌شود (کاملاً مخفی از باقی)
 *
 * مهمان بدون لاگین: اجازه پخش کانال‌های public را تا ۵ دقیقه دارد، سپس پخش قطع و درخواست ورود می‌شود.
 *
 * ── اعلان‌های تلگرام ارسال می‌شوند برای: ──
 *   1) ثبت‌نام کاربر جدید
 *   2) فعال‌سازی VIP با کد اعتماد
 *   3) "پرداخت انجام شد" → یعنی وقتی ادمین از پنل، tier کاربر را به sub تغییر می‌دهد
 *      (چون تأیید واریز TRON دستی است؛ این تغییر توسط ادمین معادل تأیید پرداخت در نظر گرفته می‌شود)
 * =======================================================
 */

const DEFAULT_CHANNELS = [
  { id: "2342", name: "LiveTV UK",   url: "https://live.livetvstream.co.uk/LS-63503-4",  icon: "📡", status: "live", playlistSuffix: "/index.m3u8",  access: "public" },
  { id: "1001", name: "BBC Persian", url: "https://vs-hls-pushb-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_persian_tv", icon: "🇬🇧", status: "live", playlistSuffix: "/mobile_wifi_main_hd_abr_v2.m3u8", access: "public" },
  { id: "1236", name: "Zed TV",      url: "https://zedhls.wns.live/hls",                 icon: "⚡", status: "live", playlistSuffix: "/stream.m3u8",  access: "sub" },
  { id: "1235", name: "Kanal D",     url: "https://demiroren.daioncdn.net/kanald",        icon: "🇹🇷", status: "live", playlistSuffix: "/kanald.m3u8?app=kanald_web&ce=3", access: "sub" },
  { id: "1111", name: "TV1 IR",      url: "https://ncdn.telewebion.ir/tv1/live",          icon: "☫", status: "live", playlistSuffix: "/playlist.m3u8", access: "public" },
  { id: "9009", name: "iFilm",       url: "https://ncdn.telewebion.ir/ifilm/live",        icon: "🎬", status: "live", playlistSuffix: "/playlist.m3u8", access: "vip" },
];

const DEFAULT_SETTINGS = {
  segmentCacheTTL: 30,
  playlistCacheTTL: 5,
  maxLogs: 200,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST, PUT, DELETE",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// ─────────────────────────────────────────────────────────────
// ورودی Worker
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS_HEADERS });

      const url      = new URL(request.url);
      const pathParts = url.pathname.split("/").filter(Boolean);

      // ── صفحه اصلی ──────────────────────────────────────────
      if (pathParts.length === 0) {
        const allChannels = await getChannels(env);
        const categories  = await getCategories(env);
        const session     = await getSessionUser(env, request);
        const owner       = session && isOwner(env, session.user);
        const tier        = session ? (session.user.tier || "none") : null;

        const visibleChannels = allChannels.filter(ch => {
          const access = ch.access || "public";
          if (access === "public") return true;
          if (owner) return true;
          if (access === "sub") return tier === "sub" || tier === "vip";
          if (access === "vip") return tier === "vip";
          return false;
        });

        return new Response(getFrontendHTML(url.origin, visibleChannels, categories), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ── پنل مدیریت ─────────────────────────────────────────
      if (pathParts[0] === "admin")
        return handleAdmin(request, env, url, pathParts);

      // ── API عمومی ──────────────────────────────────────────
      if (pathParts[0] === "api") {
        if (pathParts[1] === "news")     return handleNews(request, env);
        if (pathParts[1] === "weather")  return handleWeather(request, env, url);
        if (pathParts[1] === "auth")     return handleAuth(request, env, pathParts);
        if (pathParts[1] === "favorites") return handleFavorites(request, env);
        if (pathParts[1] === "verify")   return handleVerify(request, env);
        if (pathParts[1] === "payment-info") return handlePaymentInfo(env);
        if (pathParts[1] === "profile")  return handleProfile(request, env, pathParts);
        if (pathParts[1] === "uploads")  return handleUploads(request, env, pathParts);
        if (pathParts[1] === "guest-token") return handleGuestToken(request, env);
        if (pathParts[1] === "friends")  return handleFriends(request, env, pathParts);
        if (pathParts[1] === "chat")     return handleChat(request, env, pathParts, url);
        // ── ویژگی جدید: ثبت بازدید کانال (فراخوانی از فرانت‌اند) ──
        if (pathParts[1] === "stats" && pathParts[2] === "view") return handleRecordView(request, env);
      }

      // ── پروکسی کانال ───────────────────────────────────────
      const settings  = await getSettings(env);
      const channelId = pathParts[0];
      const restPath  = pathParts.slice(1).join("/");
      const queryString = url.search || "";

      if (restPath.startsWith("__proxy__/")) {
        const session = await getSessionUser(env, request);
        if (!session) return new Response("نیاز به ورود", { status: 401, headers: CORS_HEADERS });
        return handleProxyPath(request, restPath, queryString, settings);
      }

      const channels = await getChannels(env);
      const channel  = channels.find(c => c.id === channelId);
      if (!channel) return new Response("Channel not found", { status: 404 });

      const session = await getSessionUser(env, request);
      const accessError = await checkChannelAccess(channel, session, env, request);
      if (accessError) return jsonResponse({ error: accessError.message, needLogin: accessError.needLogin, needSub: accessError.needSub, needVip: accessError.needVip, guestExpired: accessError.guestExpired }, 403);

      const base = channel.url.replace(/\/$/, "");
      let targetUrl;

      if (restPath === "master.m3u8" || restPath === "") {
        let combinedQuery = queryString;
        const suffix = channel.playlistSuffix || "/index.m3u8";
        if (suffix.includes("?") && queryString)
          combinedQuery = "&" + queryString.replace("?", "");
        targetUrl = base + suffix + combinedQuery;
      } else {
        targetUrl = base + "/" + restPath + queryString;
      }

      const upstreamUrl = new URL(targetUrl);
      const isPlaylist  = upstreamUrl.pathname.endsWith(".m3u8");
      const cache       = caches.default;

      if (!isPlaylist) {
        const cached = await cache.match(request);
        if (cached) return cached;
      }

      const upstreamHeaders = {
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
        "Referer": upstreamUrl.origin + "/",
        ...(request.headers.get("Accept-Encoding") && { "Accept-Encoding": request.headers.get("Accept-Encoding") }),
        ...(request.headers.get("Accept") && { "Accept": request.headers.get("Accept") }),
      };

      const upstreamResponse = await fetch(upstreamUrl.toString(), {
        headers: upstreamHeaders,
        cf: {
          cacheTtl: isPlaylist ? settings.playlistCacheTTL : settings.segmentCacheTTL,
          cacheEverything: true,
        },
      });

      if (!upstreamResponse.ok)
        return new Response("Upstream Error: " + upstreamResponse.status, { status: upstreamResponse.status, headers: CORS_HEADERS });

      const contentType = upstreamResponse.headers.get("content-type") || "";

      if (contentType.includes("mpegurl") || contentType.includes("mpegURL") || isPlaylist) {
        const finalUrl  = upstreamResponse.url;
        const finalBase = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);
        const proxyBase = `${url.origin}/${channelId}`;

        let playlistText = await upstreamResponse.text();
        playlistText = playlistText.replace(/^([^#\r\n][^\r\n]*)/gm, (line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          let absoluteUrl;
          try { absoluteUrl = new URL(trimmed, finalBase).toString(); } catch { return line; }
          if (absoluteUrl.startsWith(base)) {
            const relative = absoluteUrl.slice(base.length).replace(/^\//, "");
            return `${proxyBase}/${relative}`;
          }
          return `${proxyBase}/__proxy__/${encodeURIComponent(absoluteUrl)}`;
        });
        playlistText = playlistText.replace(/(#EXT-X-KEY:[^"]*URI=")([^"]+)(")/g, (_, before, uri, after) => {
          let absoluteUri;
          try { absoluteUri = new URL(uri, finalBase).toString(); } catch { return _; }
          const proxied = absoluteUri.startsWith(base)
            ? `${proxyBase}/${absoluteUri.slice(base.length).replace(/^\//, "")}`
            : `${proxyBase}/__proxy__/${encodeURIComponent(absoluteUri)}`;
          return `${before}${proxied}${after}`;
        });
        return new Response(playlistText, {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": `public, max-age=${settings.playlistCacheTTL}`,
            ...CORS_HEADERS,
          },
        });
      }

      const segResponse = new Response(upstreamResponse.body, {
        status: 200,
        headers: {
          "Content-Type": contentType || "video/MP2T",
          "Cache-Control": `public, max-age=${settings.segmentCacheTTL}`,
          ...CORS_HEADERS,
        },
      });
      cache.put(request, segResponse.clone()).catch(() => {});
      return segResponse;

    } catch (err) {
      return new Response("Proxy Error: " + err.message, { status: 500, headers: CORS_HEADERS });
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// ویژگی ۱: آمار بازدید کانال‌ها
// ═══════════════════════════════════════════════════════════════

/**
 * هر بار که فرانت‌اند کانالی را باز می‌کند، این endpoint فراخوانی می‌شود.
 * داده‌ها در KV ذخیره می‌شوند:
 *   stats:views:{channelId}  → { total, today, yesterday, dailyKey }
 */
async function handleRecordView(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const channelId = String(body.channelId || "").trim();
    if (!channelId) return jsonResponse({ error: "channelId الزامی است" }, 400);

    const todayKey = getTodayKey();
    const raw = await env.IPTV_KV.get("stats:views:" + channelId);
    let data = raw ? JSON.parse(raw) : { total: 0, today: 0, yesterday: 0, dailyKey: todayKey };

    // اگر روز جدیدی شروع شده، yesterday را بروز کن
    if (data.dailyKey !== todayKey) {
      data.yesterday = data.dailyKey === getYesterdayKey() ? data.today : 0;
      data.today = 0;
      data.dailyKey = todayKey;
    }

    data.total += 1;
    data.today += 1;

    await env.IPTV_KV.put("stats:views:" + channelId, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 90 });
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

/** کلید روز امروز به فرمت YYYY-MM-DD */
function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}
function getYesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** دریافت آمار بازدید برای لیست کانال‌ها (استفاده در پنل ادمین) */
async function getChannelStats(env, channelIds) {
  const stats = {};
  await Promise.all(channelIds.map(async (id) => {
    try {
      const raw = await env.IPTV_KV.get("stats:views:" + id);
      if (raw) {
        const data = JSON.parse(raw);
        const todayKey = getTodayKey();
        stats[id] = {
          total: data.total || 0,
          today: data.dailyKey === todayKey ? (data.today || 0) : 0,
          yesterday: data.dailyKey === getYesterdayKey() ? (data.today || 0) : (data.yesterday || 0),
        };
      } else {
        stats[id] = { total: 0, today: 0, yesterday: 0 };
      }
    } catch {
      stats[id] = { total: 0, today: 0, yesterday: 0 };
    }
  }));
  return stats;
}

// ═══════════════════════════════════════════════════════════════
// ویژگی ۲: پشتیبان‌گیری و بازگردانی
// ═══════════════════════════════════════════════════════════════

/** Export کامل تنظیمات به JSON */
async function handleBackupExport(env) {
  try {
    const [channels, categories, settings] = await Promise.all([
      getChannels(env),
      getCategories(env),
      getSettings(env),
    ]);

    // دریافت لیست کاربران (بدون passwordHash)
    const userList = await env.IPTV_KV.list({ prefix: "user:" });
    const users = [];
    for (const key of userList.keys) {
      try {
        const raw = await env.IPTV_KV.get(key.name);
        if (raw) {
          const u = JSON.parse(raw);
          users.push({
            username: u.username,
            tier: u.tier || "none",
            city: u.city || null,
            favorites: u.favorites || [],
            createdAt: u.createdAt,
            vipAt: u.vipAt || null,
            subAt: u.subAt || null,
          });
        }
      } catch {}
    }

    const backup = {
      version: "2.0",
      exportedAt: new Date().toISOString(),
      channels,
      categories,
      settings: {
        segmentCacheTTL: settings.segmentCacheTTL,
        playlistCacheTTL: settings.playlistCacheTTL,
        subPrice: settings.subPrice,
        paymentInstructions: settings.paymentInstructions,
      },
      users,
    };

    const json = JSON.stringify(backup, null, 2);
    const filename = `streamfa-backup-${getTodayKey()}.json`;

    return new Response(json, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    return jsonResponse({ error: "خطا در export: " + e.message }, 500);
  }
}

/** Import از فایل پشتیبان JSON */
async function handleBackupImport(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    if (!body.version || !body.channels) return jsonResponse({ error: "فایل پشتیبان نامعتبر است" }, 400);

    const results = { channels: 0, categories: 0, settings: false, users: 0 };

    if (Array.isArray(body.channels) && body.channels.length > 0) {
      await env.IPTV_KV.put("channels", JSON.stringify(body.channels));
      results.channels = body.channels.length;
    }

    if (Array.isArray(body.categories) && body.categories.length > 0) {
      await env.IPTV_KV.put("categories", JSON.stringify(body.categories));
      results.categories = body.categories.length;
    }

    if (body.settings && typeof body.settings === "object") {
      const current = await getSettings(env);
      await env.IPTV_KV.put("settings", JSON.stringify({ ...current, ...body.settings }));
      results.settings = true;
    }

    // کاربران import نمی‌شوند به دلیل امنیت رمزها — فقط tier/city/favorites بروز می‌شود (در صورت وجود کاربر)
    if (Array.isArray(body.users)) {
      for (const bu of body.users) {
        try {
          const existing = await env.IPTV_KV.get("user:" + bu.username.toLowerCase());
          if (existing) {
            const user = JSON.parse(existing);
            user.tier = bu.tier || user.tier;
            user.city = bu.city || user.city;
            user.favorites = bu.favorites || user.favorites;
            await env.IPTV_KV.put("user:" + bu.username.toLowerCase(), JSON.stringify(user));
            results.users++;
          }
        } catch {}
      }
    }

    return jsonResponse({ ok: true, results });
  } catch (e) {
    return jsonResponse({ error: "خطا در import: " + e.message }, 500);
  }
}

// ═══════════════════════════════════════════════════════════════
// ویژگی ۳: اعلان تلگرام
// ═══════════════════════════════════════════════════════════════

/**
 * ارسال پیام به بات تلگرام ادمین.
 * نیاز به TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID دارد.
 */
async function sendTelegramNotification(env, message) {
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; // اگر تنظیم نشده باشد، بی‌صدا رد می‌شود

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch {
    // اعلان تلگرام هیچ‌وقت باعث خطا در عملیات اصلی نمی‌شود
  }
}

// ─────────────────────────────────────────────────────────────
// بررسی دسترسی کاربر به کانال
// ─────────────────────────────────────────────────────────────
const GUEST_WATCH_LIMIT_MS = 5 * 60 * 1000;
const GUEST_COOKIE_NAME = "iptv_guest";

function isOwner(env, user) {
  if (!user) return false;
  const adminUsername = (env.ADMIN_USERNAME || "admin").toLowerCase();
  return (user.username || "").toLowerCase() === adminUsername;
}

async function checkChannelAccess(channel, session, env, request) {
  const access = channel.access || "public";

  if (session && isOwner(env, session.user)) return null;

  const tier = session ? (session.user.tier || "none") : null;

  if (access === "sub" && (!session || tier === "none"))
    return { message: "برای پخش این کانال باید اشتراک تهیه کنید", needLogin: !session, needSub: !!session };
  if (access === "vip" && (!session || tier === "none" || tier === "sub"))
    return { message: "این کانال فقط برای کاربران VIP قابل دسترسی است", needLogin: !session, needVip: !!session };

  if (session) return null;

  const guestCheck = await checkGuestWatchTime(env, request);
  if (guestCheck.expired)
    return { message: "زمان تماشای رایگان شما به پایان رسید. برای ادامه وارد حساب کاربری شوید", needLogin: true, guestExpired: true };

  return null;
}

async function checkGuestWatchTime(env, request) {
  try {
    const cookieHeader = request.headers.get("Cookie") || "";
    const match = cookieHeader.match(new RegExp(GUEST_COOKIE_NAME + "=([^;]+)"));
    if (!match) return { expired: false, firstSeen: null, isNew: true };
    const raw = await env.IPTV_KV.get("guest:" + match[1]);
    if (!raw) return { expired: false, firstSeen: null, isNew: true };
    const data = JSON.parse(raw);
    const elapsed = Date.now() - data.firstSeen;
    return { expired: elapsed > GUEST_WATCH_LIMIT_MS, firstSeen: data.firstSeen, isNew: false };
  } catch { return { expired: false, firstSeen: null, isNew: true }; }
}

async function handleGuestToken(request, env) {
  try {
    const cookieHeader = request.headers.get("Cookie") || "";
    const match = cookieHeader.match(new RegExp(GUEST_COOKIE_NAME + "=([^;]+)"));
    let token = match ? match[1] : null;
    let firstSeen;
    let setCookie = null;

    if (token) {
      const raw = await env.IPTV_KV.get("guest:" + token);
      if (raw) {
        firstSeen = JSON.parse(raw).firstSeen;
      } else {
        firstSeen = Date.now();
        await env.IPTV_KV.put("guest:" + token, JSON.stringify({ firstSeen }), { expirationTtl: 3600 });
      }
    } else {
      token = randomToken();
      firstSeen = Date.now();
      await env.IPTV_KV.put("guest:" + token, JSON.stringify({ firstSeen }), { expirationTtl: 3600 });
      setCookie = `${GUEST_COOKIE_NAME}=${token}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax; Secure`;
    }

    const elapsed   = Date.now() - firstSeen;
    const remaining = Math.max(0, GUEST_WATCH_LIMIT_MS - elapsed);
    return jsonResponse(
      { remainingMs: remaining, limitMs: GUEST_WATCH_LIMIT_MS, expired: remaining <= 0 },
      200,
      setCookie ? { "Set-Cookie": setCookie } : {}
    );
  } catch (e) {
    return jsonResponse({ remainingMs: GUEST_WATCH_LIMIT_MS, limitMs: GUEST_WATCH_LIMIT_MS, expired: false }, 200);
  }
}

// ─────────────────────────────────────────────────────────────
// وریفای با کد اعتماد — با اعلان تلگرام
// ─────────────────────────────────────────────────────────────
async function handleVerify(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد حساب کاربری شوید" }, 401);

    const body = await request.json();
    const code = String(body.code || "").trim();

    const TRUST_CODE = env.TRUST_CODE || "IPTV2025VIP";

    if (code !== TRUST_CODE)
      return jsonResponse({ error: "کد اعتماد نامعتبر است" }, 400);

    if (session.user.tier === "vip")
      return jsonResponse({ error: "حساب شما قبلاً تأیید VIP شده است" }, 400);

    const oldTier = session.user.tier || "none";
    session.user.tier = "vip";
    session.user.vipAt = Date.now();
    await saveUser(env, session.user);
    await logTierChange(env, session.user.username, oldTier, "vip", "trust_code");

    // ── اعلان تلگرام: فعال‌سازی VIP ──
    const vipMsg = `🌟 <b>فعال‌سازی VIP</b>\n\n👤 کاربر: <code>${session.user.username}</code>\n🔑 روش: کد اعتماد\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
    await sendTelegramNotification(env, vipMsg);

    return jsonResponse({ ok: true, tier: "vip" });
  } catch (e) {
    return jsonResponse({ error: "خطا: " + e.message }, 500);
  }
}

// ─────────────────────────────────────────────────────────────
// اطلاعات پرداخت ترون
// ─────────────────────────────────────────────────────────────
async function handlePaymentInfo(env) {
  const address = env.TRON_ADDRESS || "TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const settings = await getSettings(env);
  return jsonResponse({
    tronAddress: address,
    subPrice: settings.subPrice || "10",
    currency: "USDT (TRC20)",
    instructions: settings.paymentInstructions || "پس از واریز، رسید پرداخت را به ادمین ارسال کنید تا اشتراک شما فعال شود.",
  });
}

// ─────────────────────────────────────────────────────────────
// پنل مدیریت /admin — با آمار بازدید + پشتیبان‌گیری + تلگرام
// ─────────────────────────────────────────────────────────────
async function handleAdmin(request, env, url, pathParts) {
  const session = await getSessionUser(env, request);

  if (!session || !isOwner(env, session.user)) {
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  }

  const subPath = pathParts.slice(1).join("/");

  // ── آمار بازدید کانال‌ها ─────────────────────────────────
  if (subPath === "api/stats/views" && request.method === "GET") {
    try {
      const channels = await getChannels(env);
      const stats = await getChannelStats(env, channels.map(c => c.id));
      const result = channels.map(ch => ({
        id: ch.id,
        name: ch.name,
        icon: ch.icon || "📺",
        access: ch.access || "public",
        status: ch.status,
        views: stats[ch.id] || { total: 0, today: 0, yesterday: 0 },
      })).sort((a, b) => b.views.total - a.views.total);
      return jsonResponse(result);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }

  // ── Export پشتیبان ───────────────────────────────────────
  if (subPath === "api/backup/export" && request.method === "GET") {
    return handleBackupExport(env);
  }

  // ── Import پشتیبان ───────────────────────────────────────
  if (subPath === "api/backup/import" && request.method === "POST") {
    return handleBackupImport(request, env);
  }

  // ── کانال‌ها ──────────────────────────────────────────────
  if (subPath === "api/channels") {
    if (request.method === "GET") return jsonResponse(await getChannels(env));
    if (request.method === "POST") {
      const body     = await request.json();
      const channels = await getChannels(env);
      if (channels.find(c => c.id === body.id))
        return jsonResponse({ error: "شناسه کانال تکراری است" }, 400);
      channels.push({
        id: body.id, name: body.name, url: body.url,
        icon: body.icon || "📺", status: body.status || "live",
        playlistSuffix: body.playlistSuffix || "/index.m3u8",
        access: body.access || "public",
        type: body.type || "hls",
        category: body.category || "",
      });
      await env.IPTV_KV.put("channels", JSON.stringify(channels));
      return jsonResponse({ ok: true });
    }
  }

  if (subPath.startsWith("api/channels/")) {
    const id = subPath.replace("api/channels/", "");
    if (id === "delete-errors" && request.method === "POST") {
      const channels  = await getChannels(env);
      const remaining = channels.filter(ch => ch.status !== "error");
      const removed   = channels.length - remaining.length;
      await env.IPTV_KV.put("channels", JSON.stringify(remaining));
      return jsonResponse({ ok: true, removed });
    }
    if (id === "delete-bulk" && request.method === "POST") {
      const body = await request.json();
      const ids  = new Set(body.ids || []);
      if (!ids.size) return jsonResponse({ error: "هیچ کانالی انتخاب نشده" }, 400);
      const channels  = await getChannels(env);
      const remaining = channels.filter(ch => !ids.has(ch.id));
      const removed   = channels.length - remaining.length;
      await env.IPTV_KV.put("channels", JSON.stringify(remaining));
      return jsonResponse({ ok: true, removed });
    }
    if (id === "delete-by-group" && request.method === "POST") {
      const body  = await request.json();
      const group = String(body.group || "");
      if (!group) return jsonResponse({ error: "گروه مشخص نشده" }, 400);
      const channels  = await getChannels(env);
      const remaining = channels.filter(ch => ch.group !== group);
      const removed   = channels.length - remaining.length;
      await env.IPTV_KV.put("channels", JSON.stringify(remaining));
      return jsonResponse({ ok: true, removed });
    }
    const channels = await getChannels(env);
    const idx = channels.findIndex(c => c.id === id);
    if (request.method === "PUT") {
      if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
      const body = await request.json();
      channels[idx] = { ...channels[idx], ...body };
      await env.IPTV_KV.put("channels", JSON.stringify(channels));
      return jsonResponse({ ok: true });
    }
    if (request.method === "DELETE") {
      if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
      channels.splice(idx, 1);
      await env.IPTV_KV.put("channels", JSON.stringify(channels));
      return jsonResponse({ ok: true });
    }
  }

  // ── Health Check ──────────────────────────────────────────
  if (subPath === "api/health/run" && request.method === "POST") {
    const channels = await getChannels(env);
    const checkPromises = channels.map(async (ch) => {
      const suffix    = ch.playlistSuffix || "/index.m3u8";
      const targetUrl = ch.url.replace(/\/$/, "") + suffix;
      const start = Date.now();
      let status = "error", latency = null, httpCode = null;
      try {
        const resp = await fetch(targetUrl, {
          method: "HEAD",
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        latency = Date.now() - start;
        httpCode = resp.status;
        status = resp.ok ? "live" : "error";
      } catch { latency = Date.now() - start; }
      return { id: ch.id, status, latency, httpCode, checkedAt: Date.now() };
    });
    const checks    = await Promise.allSettled(checkPromises);
    const healthMap = {};
    checks.forEach(r => { if (r.status === "fulfilled") healthMap[r.value.id] = r.value; });
    const updated = channels.map(ch => {
      const h = healthMap[ch.id];
      if (!h) return ch;
      return { ...ch, status: h.status, lastCheck: { latency: h.latency, httpCode: h.httpCode, checkedAt: h.checkedAt } };
    });
    await env.IPTV_KV.put("channels", JSON.stringify(updated));
    return jsonResponse({ ok: true, results: Object.values(healthMap) });
  }

  if (subPath === "api/health/check-one" && request.method === "POST") {
    const body     = await request.json();
    const channels = await getChannels(env);
    const ch       = channels.find(c => c.id === body.id);
    if (!ch) return jsonResponse({ error: "کانال یافت نشد" }, 404);
    const suffix    = ch.playlistSuffix || "/index.m3u8";
    const targetUrl = ch.url.replace(/\/$/, "") + suffix;
    const start = Date.now();
    let status = "error", latency = null, httpCode = null;
    try {
      const resp = await fetch(targetUrl, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000), cf: { cacheTtl: 0, cacheEverything: false } });
      latency = Date.now() - start; httpCode = resp.status; status = resp.ok ? "live" : "error";
    } catch { latency = Date.now() - start; }
    const lastCheck = { latency, httpCode, checkedAt: Date.now() };
    const idx = channels.findIndex(c => c.id === body.id);
    channels[idx] = { ...channels[idx], status, lastCheck };
    await env.IPTV_KV.put("channels", JSON.stringify(channels));
    return jsonResponse({ ok: true, id: body.id, status, latency, httpCode });
  }

  // ── دسته‌بندی‌ها ──────────────────────────────────────────
  if (subPath === "api/categories") {
    if (request.method === "GET") return jsonResponse(await getCategories(env));
    if (request.method === "POST") {
      const body = await request.json();
      if (!body.name) return jsonResponse({ error: "نام الزامی است" }, 400);
      const cats = await getCategories(env);
      const id   = body.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\u0600-\u06FF-]/g, "");
      if (cats.find(c => c.id === id)) return jsonResponse({ error: "این دسته قبلاً وجود دارد" }, 400);
      cats.push({ id, name: body.name, icon: body.icon || "📂", color: body.color || "#4da6ff" });
      await env.IPTV_KV.put("categories", JSON.stringify(cats));
      return jsonResponse({ ok: true, id });
    }
  }

  if (subPath.startsWith("api/categories/")) {
    const catId = subPath.replace("api/categories/", "");
    const cats  = await getCategories(env);
    const idx   = cats.findIndex(c => c.id === catId);
    if (request.method === "PUT") {
      if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
      cats[idx] = { ...cats[idx], ...(await request.json()) };
      await env.IPTV_KV.put("categories", JSON.stringify(cats));
      return jsonResponse({ ok: true });
    }
    if (request.method === "DELETE") {
      if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
      cats.splice(idx, 1);
      await env.IPTV_KV.put("categories", JSON.stringify(cats));
      const channels  = await getChannels(env);
      const remaining = channels.filter(ch => ch.category !== catId);
      await env.IPTV_KV.put("channels", JSON.stringify(remaining));
      return jsonResponse({ ok: true, removedChannels: channels.length - remaining.length });
    }
  }

  // ── مدیریت کاربران ───────────────────────────────────────
  if (subPath === "api/users") {
    if (request.method === "GET") {
      const list = await env.IPTV_KV.list({ prefix: "user:" });
      const users = [];
      for (const key of list.keys) {
        try {
          const raw = await env.IPTV_KV.get(key.name);
          if (raw) {
            const u = JSON.parse(raw);
            users.push({
              username: u.username,
              tier: u.tier || "none",
              createdAt: u.createdAt,
              vipAt: u.vipAt || null,
              subAt: u.subAt || null,
              favorites: (u.favorites || []).length,
            });
          }
        } catch {}
      }
      users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return jsonResponse(users);
    }
  }

  if (subPath.startsWith("api/users/")) {
    const username = decodeURIComponent(subPath.replace("api/users/", ""));

    if (request.method === "PUT") {
      const user = await getUserByUsername(env, username);
      if (!user) return jsonResponse({ error: "کاربر یافت نشد" }, 404);
      const body    = await request.json();
      const oldTier = user.tier || "none";
      if (body.tier) {
        user.tier = body.tier;
        if (body.tier === "vip") user.vipAt = Date.now();
        if (body.tier === "sub") user.subAt = Date.now();
        if (body.tier === "none") { delete user.vipAt; delete user.subAt; }
        await logTierChange(env, username, oldTier, body.tier, "admin");

        // ── اعلان تلگرام ──
        // تغییر به "sub" توسط ادمین = معادل تأیید پرداخت دستی TRON در نظر گرفته می‌شود
        if (body.tier !== oldTier) {
          if (body.tier === "sub") {
            const payMsg = `💳 <b>پرداخت تأیید شد</b>\n\n👤 کاربر: <code>${username}</code>\n✅ اشتراک فعال شد توسط ادمین\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
            await sendTelegramNotification(env, payMsg);
          } else {
            const tierNames = { none: "بدون اشتراک", sub: "اشتراک ✅", vip: "VIP 🌟" };
            const msg = `⚙️ <b>تغییر سطح دسترسی توسط ادمین</b>\n\n👤 کاربر: <code>${username}</code>\n📊 از: ${tierNames[oldTier] || oldTier} → ${tierNames[body.tier] || body.tier}\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
            await sendTelegramNotification(env, msg);
          }
        }
      }
      await saveUser(env, user);
      return jsonResponse({ ok: true });
    }

    if (request.method === "DELETE") {
      await env.IPTV_KV.delete("user:" + username.toLowerCase());
      return jsonResponse({ ok: true });
    }
  }

  // ── تنظیمات پرداخت ───────────────────────────────────────
  if (subPath === "api/settings/payment") {
    if (request.method === "GET") {
      const settings = await getSettings(env);
      return jsonResponse({
        tronAddress: env.TRON_ADDRESS || "",
        subPrice: settings.subPrice || "10",
        paymentInstructions: settings.paymentInstructions || "",
      });
    }
    if (request.method === "POST") {
      const body     = await request.json();
      const settings = await getSettings(env);
      const updated  = { ...settings };
      if (body.subPrice)             updated.subPrice = body.subPrice;
      if (body.paymentInstructions !== undefined) updated.paymentInstructions = body.paymentInstructions;
      await env.IPTV_KV.put("settings", JSON.stringify(updated));
      return jsonResponse({ ok: true });
    }
  }

  // ── تنظیمات تلگرام ───────────────────────────────────────
  if (subPath === "api/settings/telegram") {
    if (request.method === "GET") {
      return jsonResponse({
        botTokenSet: !!(env.TELEGRAM_BOT_TOKEN),
        chatIdSet: !!(env.TELEGRAM_CHAT_ID),
        chatId: env.TELEGRAM_CHAT_ID || "",
        note: "توکن ربات از طریق متغیر TELEGRAM_BOT_TOKEN و آیدی چت از TELEGRAM_CHAT_ID تنظیم می‌شود.",
      });
    }
    if (request.method === "POST") {
      try {
        const testMsg = `🔔 <b>تست اعلان StreamFa</b>\n\nاتصال به تلگرام با موفقیت برقرار شد!\n🕐 ${new Date().toLocaleString("fa-IR")}`;
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
          return jsonResponse({ error: "ابتدا TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID را در متغیرهای محیطی تنظیم کنید" }, 400);
        await sendTelegramNotification(env, testMsg);
        return jsonResponse({ ok: true, message: "پیام تست ارسال شد. اگر ربات را استارت کرده باشید، باید پیام را دریافت کنید." });
      } catch (e) {
        return jsonResponse({ error: "خطا در ارسال: " + e.message }, 500);
      }
    }
  }

  // ── لاگ تغییرات tier ─────────────────────────────────────
  if (subPath === "api/tier-logs" && request.method === "GET") {
    try {
      const raw  = await env.IPTV_KV.get("tier_logs");
      const logs = raw ? JSON.parse(raw) : [];
      return jsonResponse(logs.slice(-100).reverse());
    } catch { return jsonResponse([]); }
  }

  // ── Import M3U ───────────────────────────────────────────
  if (subPath === "api/import/parse" && request.method === "POST") {
    try {
      const body = await request.json();
      let m3uText = "";
      if (body.url) {
        const resp = await fetch(body.url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!resp.ok) return jsonResponse({ error: "خطا در دریافت پلی‌لیست از URL" }, 400);
        m3uText = await resp.text();
      } else if (body.text) {
        m3uText = body.text;
      } else {
        return jsonResponse({ error: "نه URL و نه متن ارسال نشد" }, 400);
      }
      return jsonResponse(parseM3U(m3uText));
    } catch (e) {
      return jsonResponse({ error: "خطا در پردازش: " + e.message }, 500);
    }
  }

  if (subPath === "api/import/save" && request.method === "POST") {
    try {
      const body      = await request.json();
      const incoming  = body.channels || [];
      const newCats   = body.newCategories || [];
      if (!incoming.length) return jsonResponse({ error: "هیچ کانالی ارسال نشد" }, 400);
      const existing    = await getChannels(env);
      const existingIds = new Set(existing.map(c => c.id));
      const cats        = await getCategories(env);
      const existingCatIds = new Set(cats.map(c => c.id));
      let newCatsCount = 0;
      for (const nc of newCats) {
        if (!nc || !nc.id || !nc.name || existingCatIds.has(nc.id)) continue;
        cats.push({ id: nc.id, name: nc.name, icon: nc.icon || "📂", color: nc.color || "#4da6ff" });
        existingCatIds.add(nc.id);
        newCatsCount++;
      }
      if (newCatsCount > 0) await env.IPTV_KV.put("categories", JSON.stringify(cats));
      let added = 0, skipped = 0;
      for (const ch of incoming) {
        if (existingIds.has(ch.id)) { skipped++; continue; }
        existing.push({ ...ch, access: ch.access || "public", category: existingCatIds.has(ch.category) ? ch.category : "" });
        existingIds.add(ch.id);
        added++;
      }
      await env.IPTV_KV.put("channels", JSON.stringify(existing));
      return jsonResponse({ ok: true, added, skipped, newCategories: newCatsCount });
    } catch (e) {
      return jsonResponse({ error: "خطا در ذخیره: " + e.message }, 500);
    }
  }

  // ── صفحه HTML ادمین ──────────────────────────────────────
  if (!subPath || subPath === "")
    return new Response(getAdminHTML(url.origin), { headers: { "Content-Type": "text/html; charset=utf-8" } });

  return new Response("Not found", { status: 404 });
}

// ─────────────────────────────────────────────────────────────
// احراز هویت کاربران — با اعلان تلگرام برای ثبت‌نام
// ─────────────────────────────────────────────────────────────
async function handleAuth(request, env, pathParts) {
  const action = pathParts[2] || "";

  if (action === "signup" && request.method === "POST") {
    try {
      const body     = await request.json();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!username || username.length < 3)
        return jsonResponse({ error: "نام کاربری باید حداقل ۳ کاراکتر باشد" }, 400);
      if (!/^[a-zA-Z0-9_\u0600-\u06FF]+$/.test(username))
        return jsonResponse({ error: "نام کاربری فقط می‌تواند حروف، عدد و _ داشته باشد" }, 400);
      if (!password || password.length < 4)
        return jsonResponse({ error: "رمز عبور باید حداقل ۴ کاراکتر باشد" }, 400);
      if (await getUserByUsername(env, username))
        return jsonResponse({ error: "این نام کاربری قبلاً ثبت شده است" }, 400);

      const user = { username, passwordHash: await sha256Hex(password), tier: "none", favorites: [], city: null, avatarKey: null, createdAt: Date.now() };
      await saveUser(env, user);
      const token = await createSession(env, username);

      // ── اعلان تلگرام: ثبت‌نام کاربر جدید ──
      const signupMsg = `👤 <b>کاربر جدید ثبت‌نام کرد</b>\n\n🆔 نام کاربری: <code>${username}</code>\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
      await sendTelegramNotification(env, signupMsg);

      return jsonResponse({ ok: true, user: publicUser(user, env) }, 200, { "Set-Cookie": sessionCookieHeader(token) });
    } catch (e) {
      return jsonResponse({ error: "خطا در ثبت‌نام: " + e.message }, 500);
    }
  }

  if (action === "login" && request.method === "POST") {
    try {
      const body     = await request.json();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const user     = await getUserByUsername(env, username);
      if (!user || (await sha256Hex(password)) !== user.passwordHash)
        return jsonResponse({ error: "نام کاربری یا رمز عبور اشتباه است" }, 401);
      const token = await createSession(env, username);
      return jsonResponse({ ok: true, user: publicUser(user, env) }, 200, { "Set-Cookie": sessionCookieHeader(token) });
    } catch (e) {
      return jsonResponse({ error: "خطا در ورود: " + e.message }, 500);
    }
  }

  if (action === "logout" && request.method === "POST") {
    await destroySession(env, request);
    return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearSessionCookieHeader() });
  }

  if (action === "me" && request.method === "GET") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ user: null });
    return jsonResponse({ user: publicUser(session.user, env) });
  }

  if (action === "change-password" && request.method === "POST") {
    try {
      const session = await getSessionUser(env, request);
      if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
      const body = await request.json();
      if ((await sha256Hex(String(body.currentPassword || ""))) !== session.user.passwordHash)
        return jsonResponse({ error: "رمز فعلی اشتباه است" }, 400);
      if (!body.newPassword || String(body.newPassword).length < 4)
        return jsonResponse({ error: "رمز جدید باید حداقل ۴ کاراکتر باشد" }, 400);
      session.user.passwordHash = await sha256Hex(String(body.newPassword));
      await saveUser(env, session.user);
      return jsonResponse({ ok: true });
    } catch (e) {
      return jsonResponse({ error: "خطا: " + e.message }, 500);
    }
  }

  if (action === "set-city" && request.method === "POST") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
    const body   = await request.json();
    session.user.city = body.city || null;
    await saveUser(env, session.user);
    return jsonResponse({ ok: true, city: session.user.city });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ─────────────────────────────────────────────────────────────
// کانال‌های مورد علاقه
// ─────────────────────────────────────────────────────────────
async function handleFavorites(request, env) {
  const session = await getSessionUser(env, request);
  if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
  if (request.method === "GET") return jsonResponse({ favorites: session.user.favorites || [] });
  if (request.method === "POST") {
    const body      = await request.json();
    const channelId = String(body.channelId || "");
    if (!channelId) return jsonResponse({ error: "channelId الزامی است" }, 400);
    const favs = new Set(session.user.favorites || []);
    if (favs.has(channelId)) favs.delete(channelId); else favs.add(channelId);
    session.user.favorites = Array.from(favs);
    await saveUser(env, session.user);
    return jsonResponse({ ok: true, favorites: session.user.favorites });
  }
  return jsonResponse({ error: "Not found" }, 404);
}

// ─────────────────────────────────────────────────────────────
// پروفایل کاربر — آپلود/حذف عکس پروفایل
// ─────────────────────────────────────────────────────────────
const MAX_AVATAR_SIZE = 3 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

async function handleProfile(request, env, pathParts) {
  const action = pathParts[2] || "";

  if (action === "avatar") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);

    if (request.method === "POST") {
      if (!env.IPTV_R2) return jsonResponse({ error: "آپلود فایل روی این سرور فعال نیست (R2 متصل نشده)" }, 500);
      try {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") return jsonResponse({ error: "فایلی ارسال نشد" }, 400);
        if (!ALLOWED_AVATAR_TYPES.includes(file.type)) return jsonResponse({ error: "فقط فرمت‌های JPG، PNG، WEBP و GIF پذیرفته می‌شود" }, 400);
        if (file.size > MAX_AVATAR_SIZE) return jsonResponse({ error: "حجم عکس باید کمتر از ۳ مگابایت باشد" }, 400);

        const key = "avatars/" + session.user.username.toLowerCase();
        await env.IPTV_R2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
        session.user.avatarKey = key;
        await saveUser(env, session.user);
        return jsonResponse({ ok: true, avatarUrl: "/api/uploads/avatar/" + session.user.username.toLowerCase() });
      } catch (e) {
        return jsonResponse({ error: "خطا در آپلود: " + e.message }, 500);
      }
    }

    if (request.method === "DELETE") {
      if (session.user.avatarKey && env.IPTV_R2) {
        try { await env.IPTV_R2.delete(session.user.avatarKey); } catch {}
      }
      session.user.avatarKey = null;
      await saveUser(env, session.user);
      return jsonResponse({ ok: true });
    }
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ─────────────────────────────────────────────────────────────
// آپلود سنتر — فقط برای کاربران VIP و ادمین/owner
// ─────────────────────────────────────────────────────────────
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const MAX_UPLOADS_PER_USER = 30;

async function handleUploads(request, env, pathParts) {
  const sub = pathParts[2] || "";

  if (sub === "avatar" && pathParts[3]) {
    const username = decodeURIComponent(pathParts[3]).toLowerCase();
    if (!env.IPTV_R2) return new Response("R2 not configured", { status: 500 });
    const obj = await env.IPTV_R2.get("avatars/" + username);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=300", ...CORS_HEADERS } });
  }

  if (sub === "file" && pathParts[3]) {
    const fileId = decodeURIComponent(pathParts[3]);
    if (!env.IPTV_R2) return new Response("R2 not configured", { status: 500 });
    const meta = await getUploadMeta(env, fileId);
    if (!meta) return new Response("Not found", { status: 404 });
    const obj = await env.IPTV_R2.get("uploads/" + fileId);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": meta.type || "application/octet-stream",
        "Content-Disposition": `inline; filename="${encodeURIComponent(meta.name || fileId)}"`,
        "Cache-Control": "public, max-age=600",
        ...CORS_HEADERS,
      },
    });
  }

  const session = await getSessionUser(env, request);
  const allowed = session && (isOwner(env, session.user) || session.user.tier === "vip");
  if (!allowed) return jsonResponse({ error: "آپلود سنتر فقط برای کاربران VIP در دسترس است", needVip: true }, 403);

  if (sub === "list" && request.method === "GET") {
    const files = await getUserUploads(env, session.user.username);
    return jsonResponse({ files });
  }

  if (sub === "upload" && request.method === "POST") {
    if (!env.IPTV_R2) return jsonResponse({ error: "آپلود فایل روی این سرور فعال نیست (R2 متصل نشده)" }, 500);
    try {
      const existing = await getUserUploads(env, session.user.username);
      if (existing.length >= MAX_UPLOADS_PER_USER)
        return jsonResponse({ error: `حداکثر ${MAX_UPLOADS_PER_USER} فایل می‌توانید آپلود کنید. ابتدا فایلی را حذف کنید` }, 400);

      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return jsonResponse({ error: "فایلی ارسال نشد" }, 400);
      if (file.size > MAX_UPLOAD_SIZE) return jsonResponse({ error: "حجم فایل باید کمتر از ۵۰ مگابایت باشد" }, 400);

      const fileId = randomToken().slice(0, 16);
      await env.IPTV_R2.put("uploads/" + fileId, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });

      const meta = { id: fileId, name: file.name || "file", type: file.type || "application/octet-stream", size: file.size, owner: session.user.username, uploadedAt: Date.now() };
      await saveUploadMeta(env, meta);
      existing.push(fileId);
      await env.IPTV_KV.put("uploads_by_user:" + session.user.username.toLowerCase(), JSON.stringify(existing));

      return jsonResponse({ ok: true, file: { ...meta, url: "/api/uploads/file/" + fileId } });
    } catch (e) {
      return jsonResponse({ error: "خطا در آپلود: " + e.message }, 500);
    }
  }

  if (sub === "delete" && request.method === "POST") {
    try {
      const body   = await request.json();
      const fileId = String(body.fileId || "");
      const meta   = await getUploadMeta(env, fileId);
      if (!meta || meta.owner.toLowerCase() !== session.user.username.toLowerCase())
        return jsonResponse({ error: "فایل یافت نشد" }, 404);

      if (env.IPTV_R2) { try { await env.IPTV_R2.delete("uploads/" + fileId); } catch {} }
      await env.IPTV_KV.delete("upload_meta:" + fileId);
      const list = (await getUserUploads(env, session.user.username)).filter(id => id !== fileId);
      await env.IPTV_KV.put("uploads_by_user:" + session.user.username.toLowerCase(), JSON.stringify(list));

      return jsonResponse({ ok: true });
    } catch (e) {
      return jsonResponse({ error: "خطا: " + e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not found" }, 404);
}

async function getUserUploads(env, username) {
  try {
    const raw = await env.IPTV_KV.get("uploads_by_user:" + username.toLowerCase());
    const ids = raw ? JSON.parse(raw) : [];
    const metas = await Promise.all(ids.map(id => getUploadMeta(env, id)));
    return metas.filter(Boolean);
  } catch { return []; }
}
async function getUploadMeta(env, fileId) {
  try { const raw = await env.IPTV_KV.get("upload_meta:" + fileId); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function saveUploadMeta(env, meta) {
  await env.IPTV_KV.put("upload_meta:" + meta.id, JSON.stringify(meta));
}

async function handleWeather(request, env, url) {
  const action = url.pathname.split("/").filter(Boolean)[2] || "";

  if (action === "search-city") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
    const q = url.searchParams.get("q") || "";
    if (!q.trim()) return jsonResponse({ results: [] });
    try {
      const resp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=fa&format=json`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!resp.ok) return jsonResponse({ results: [], error: "خطا در جستجوی شهر" });
      const data = await resp.json();
      return jsonResponse({ results: (data.results || []).map(r => ({ name: r.name, country: r.country, admin1: r.admin1 || "", lat: r.latitude, lon: r.longitude })) });
    } catch (e) { return jsonResponse({ results: [], error: "خطا در جستجو: " + e.message }); }
  }

  if (action === "current") {
    try {
      let lat = url.searchParams.get("lat");
      let lon = url.searchParams.get("lon");
      let cityName = url.searchParams.get("name") || "";
      const session = await getSessionUser(env, request);
      if (session && session.user.city && session.user.city.lat && (!lat || !lon)) {
        lat = session.user.city.lat; lon = session.user.city.lon; cityName = session.user.city.name;
      }
      if (!lat || !lon) {
        const cf = request.cf || {};
        if (cf.latitude && cf.longitude) { lat = cf.latitude; lon = cf.longitude; cityName = cf.city || cityName; }
        else { lat = 35.6892; lon = 51.3890; cityName = cityName || "تهران"; }
      }
      const apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
      const resp = await fetch(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 600, cacheEverything: true } });
      if (!resp.ok) return jsonResponse({ error: "خطا در دریافت آب‌وهوا (HTTP " + resp.status + ")" }, 502);
      const data = await resp.json();
      if (!data.current) return jsonResponse({ error: "پاسخ نامعتبر از سرویس آب‌وهوا" }, 502);
      return jsonResponse({ city: cityName || "موقعیت شما", temperature: data.current.temperature_2m, humidity: data.current.relative_humidity_2m, windSpeed: data.current.wind_speed_10m, weatherCode: data.current.weather_code });
    } catch (e) { return jsonResponse({ error: "خطا: " + e.message }, 500); }
  }
  return jsonResponse({ error: "Not found" }, 404);
}

// ─────────────────────────────────────────────────────────────
// توابع کمکی KV
// ─────────────────────────────────────────────────────────────
async function getChannels(env) {
  try { if (!env.IPTV_KV) return DEFAULT_CHANNELS; const r = await env.IPTV_KV.get("channels"); return r ? JSON.parse(r) : DEFAULT_CHANNELS; } catch { return DEFAULT_CHANNELS; }
}
async function getSettings(env) {
  try { if (!env.IPTV_KV) return DEFAULT_SETTINGS; const r = await env.IPTV_KV.get("settings"); return r ? { ...DEFAULT_SETTINGS, ...JSON.parse(r) } : DEFAULT_SETTINGS; } catch { return DEFAULT_SETTINGS; }
}
async function getCategories(env) {
  try { if (!env.IPTV_KV) return []; const r = await env.IPTV_KV.get("categories"); return r ? JSON.parse(r) : []; } catch { return []; }
}
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders } });
}

// ─────────────────────────────────────────────────────────────
// سیستم احراز هویت
// ─────────────────────────────────────────────────────────────
const SESSION_COOKIE_NAME = "iptv_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
async function getUserByUsername(env, username) {
  try { if (!env.IPTV_KV) return null; const r = await env.IPTV_KV.get("user:" + username.toLowerCase()); return r ? JSON.parse(r) : null; } catch { return null; }
}
async function saveUser(env, user) {
  await env.IPTV_KV.put("user:" + user.username.toLowerCase(), JSON.stringify(user));
}
async function createSession(env, username) {
  const token = randomToken();
  await env.IPTV_KV.put("session:" + token, JSON.stringify({ username, createdAt: Date.now() }), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}
async function getSessionUser(env, request) {
  try {
    const cookieHeader = request.headers.get("Cookie") || "";
    const match = cookieHeader.match(new RegExp(SESSION_COOKIE_NAME + "=([^;]+)"));
    if (!match) return null;
    const raw = await env.IPTV_KV.get("session:" + match[1]);
    if (!raw) return null;
    const session = JSON.parse(raw);
    const user    = await getUserByUsername(env, session.username);
    if (!user) return null;
    return { user, token: match[1] };
  } catch { return null; }
}
async function destroySession(env, request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(SESSION_COOKIE_NAME + "=([^;]+)"));
  if (match) await env.IPTV_KV.delete("session:" + match[1]);
}
function sessionCookieHeader(token) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax; Secure`;
}
function clearSessionCookieHeader() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}
function publicUser(user, env) {
  const owner = isOwner(env, user);
  return {
    username: user.username,
    tier: user.tier || "none",
    role: owner ? "owner" : "user",
    favorites: user.favorites || [],
    city: user.city || null,
    avatarUrl: user.avatarKey ? "/api/uploads/avatar/" + user.username.toLowerCase() : null,
  };
}

async function logTierChange(env, username, fromTier, toTier, source) {
  try {
    const raw  = await env.IPTV_KV.get("tier_logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.push({ username, fromTier, toTier, source, at: Date.now() });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await env.IPTV_KV.put("tier_logs", JSON.stringify(logs));
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// پروکسی مستقیم
// ─────────────────────────────────────────────────────────────
async function handleProxyPath(request, restPath, queryString, settings) {
  const encodedUrl = restPath.replace("__proxy__/", "");
  let decodedUrl;
  try { decodedUrl = decodeURIComponent(encodedUrl); new URL(decodedUrl); } catch { return new Response("Invalid proxy URL", { status: 400, headers: CORS_HEADERS }); }
  const cache    = caches.default;
  const cacheKey = new Request(decodedUrl + queryString);
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;
  const upstreamResponse = await fetch(decodedUrl + queryString, { headers: { "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0", "Referer": new URL(decodedUrl).origin + "/" }, cf: { cacheTtl: settings.segmentCacheTTL, cacheEverything: true } });
  const contentType = upstreamResponse.headers.get("content-type") || "application/octet-stream";
  const response = new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: { "Content-Type": contentType, "Cache-Control": `public, max-age=${settings.segmentCacheTTL}`, ...CORS_HEADERS } });
  cache.put(cacheKey, response.clone()).catch(() => {});
  return response;
}

// ─────────────────────────────────────────────────────────────
// پارسر M3U
// ─────────────────────────────────────────────────────────────
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = []; const groups = new Set(); let currentMeta = null; let idCounter = Date.now();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const nameMatch = line.match(/,(.+)$/); const groupMatch = line.match(/group-title="([^"]*)"/i); const logoMatch = line.match(/tvg-logo="([^"]*)"/i); const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i); const tvgNameMatch = line.match(/tvg-name="([^"]*)"/i);
      currentMeta = { name: (tvgNameMatch?.[1] || nameMatch?.[1] || "بدون نام").trim(), group: (groupMatch?.[1] || "بدون گروه").trim(), logo: logoMatch?.[1] || "", tvgId: tvgIdMatch?.[1] || "" };
    } else if (line.startsWith("http") && currentMeta) {
      let id = currentMeta.tvgId ? currentMeta.tvgId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) : String(idCounter++);
      if (!id) id = String(idCounter++);
      const urlObj = (() => { try { return new URL(line); } catch { return null; } })();
      let baseUrl = line, suffix = "";
      if (urlObj) {
        const pathname = urlObj.pathname;
        if (pathname.endsWith(".m3u8") || pathname.endsWith(".m3u")) { const ls = pathname.lastIndexOf("/"); baseUrl = urlObj.origin + pathname.substring(0, ls); suffix = pathname.substring(ls) + urlObj.search; }
        else { suffix = "/index.m3u8"; }
      }
      groups.add(currentMeta.group);
      channels.push({ id, name: currentMeta.name, url: baseUrl, playlistSuffix: suffix || "/index.m3u8", icon: "📺", status: "live", access: "public", group: currentMeta.group, logo: currentMeta.logo, type: "hls" });
      currentMeta = null;
    } else if (!line.startsWith("#")) { currentMeta = null; }
  }
  return { channels, groups: Array.from(groups).sort(), total: channels.length };
}

// ─────────────────────────────────────────────────────────────
// اخبار بی‌بی‌سی فارسی و ایران اینترنشنال — فقط برای VIP/ادمین
// ─────────────────────────────────────────────────────────────
async function handleNews(request, env) {
  const session = await getSessionUser(env, request);
  const allowed = session && (isOwner(env, session.user) || session.user.tier === "vip");
  if (!allowed)
    return jsonResponse({ error: "اخبار فقط برای کاربران VIP در دسترس است", needVip: true }, 403);

  const [bbc, intl] = await Promise.all([fetchBBCNews(), fetchIranIntlNews()]);
  const combined = [...bbc, ...intl];
  return jsonResponse(combined);
}

async function fetchBBCNews() {
  try {
    const resp = await fetch("https://feeds.bbci.co.uk/persian/rss.xml", { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 600, cacheEverything: true } });
    if (!resp.ok) return [];
    return parseRSS(await resp.text(), "بی‌بی‌سی فارسی");
  } catch { return []; }
}
async function fetchIranIntlNews() {
  try {
    const resp = await fetch("https://www.iranintl.com/fa/rss.xml", { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 600, cacheEverything: true } });
    if (!resp.ok) return [];
    return parseRSS(await resp.text(), "ایران اینترنشنال");
  } catch { return []; }
}
function parseRSS(xml, sourceName) {
  const items = []; const itemBlocks = xml.split("<item>").slice(1);
  const decode = s => (s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
  for (const block of itemBlocks.slice(0, 15)) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/); const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/); const descMatch = block.match(/<description>([\s\S]*?)<\/description>/); const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (titleMatch) items.push({ title: decode(titleMatch[1]), link: decode(linkMatch?.[1] || ""), description: decode(descMatch?.[1] || "").replace(/<[^>]+>/g, "").slice(0, 200), pubDate: decode(dateMatch?.[1] || ""), source: sourceName || "" });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────
// سیستم دوستیابی
// ─────────────────────────────────────────────────────────────
async function handleFriends(request, env, pathParts) {
  const session = await getSessionUser(env, request);
  if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);

  const action = pathParts[2] || "";
  const me = session.user;
  me.friends = me.friends || [];
  me.friendRequests = me.friendRequests || [];

  if (action === "list" && request.method === "GET") {
    return jsonResponse({ friends: me.friends, requests: me.friendRequests });
  }

  if (action === "request" && request.method === "POST") {
    try {
      const body = await request.json();
      const targetUsername = String(body.targetUsername || "").trim();
      if (!targetUsername) return jsonResponse({ error: "نام کاربری نامعتبر است" }, 400);
      if (targetUsername.toLowerCase() === me.username.toLowerCase())
        return jsonResponse({ error: "نمی‌توانید به خودتان درخواست بدهید" }, 400);
      if (me.friends.includes(targetUsername))
        return jsonResponse({ error: "شما قبلاً دوست شده‌اید" }, 400);

      const targetUser = await getUserByUsername(env, targetUsername);
      if (!targetUser) return jsonResponse({ error: "کاربری با این نام یافت نشد" }, 404);

      targetUser.friendRequests = targetUser.friendRequests || [];
      if (targetUser.friendRequests.includes(me.username))
        return jsonResponse({ error: "درخواست قبلاً ارسال شده است" }, 400);

      targetUser.friendRequests.push(me.username);
      await saveUser(env, targetUser);
      return jsonResponse({ ok: true, message: "درخواست دوستی ارسال شد" });
    } catch (e) {
      return jsonResponse({ error: "خطا: " + e.message }, 500);
    }
  }

  if (action === "accept" && request.method === "POST") {
    try {
      const body = await request.json();
      const targetUsername = String(body.targetUsername || "").trim();
      if (!me.friendRequests.includes(targetUsername))
        return jsonResponse({ error: "درخواستی یافت نشد" }, 400);

      me.friendRequests = me.friendRequests.filter(u => u !== targetUsername);
      if (!me.friends.includes(targetUsername)) me.friends.push(targetUsername);
      await saveUser(env, me);

      const targetUser = await getUserByUsername(env, targetUsername);
      if (targetUser) {
        targetUser.friends = targetUser.friends || [];
        if (!targetUser.friends.includes(me.username)) targetUser.friends.push(me.username);
        await saveUser(env, targetUser);
      }
      return jsonResponse({ ok: true });
    } catch (e) {
      return jsonResponse({ error: "خطا: " + e.message }, 500);
    }
  }

  if (action === "reject" && request.method === "POST") {
    try {
      const body = await request.json();
      const targetUsername = String(body.targetUsername || "").trim();
      me.friendRequests = me.friendRequests.filter(u => u !== targetUsername);
      await saveUser(env, me);
      return jsonResponse({ ok: true });
    } catch (e) {
      return jsonResponse({ error: "خطا: " + e.message }, 500);
    }
  }

  if (action === "remove" && request.method === "POST") {
    try {
      const body = await request.json();
      const targetUsername = String(body.targetUsername || "").trim();
      me.friends = me.friends.filter(u => u !== targetUsername);
      await saveUser(env, me);
      const targetUser = await getUserByUsername(env, targetUsername);
      if (targetUser) {
        targetUser.friends = (targetUser.friends || []).filter(u => u !== me.username);
        await saveUser(env, targetUser);
      }
      return jsonResponse({ ok: true });
    } catch (e) {
      return jsonResponse({ error: "خطا: " + e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ─────────────────────────────────────────────────────────────
// سیستم چت خصوصی (DM)
// ─────────────────────────────────────────────────────────────
async function handleChat(request, env, pathParts, url) {
  const session = await getSessionUser(env, request);
  if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);

  const action = pathParts[2] || "";
  const me = session.user.username;

  if (action === "history" && request.method === "GET") {
    const friend = url.searchParams.get("friend") || "";
    if (!friend) return jsonResponse({ error: "نام دوست الزامی است" }, 400);
    const myUser = session.user;
    if (!(myUser.friends || []).map(f => f.toLowerCase()).includes(friend.toLowerCase()))
      return jsonResponse({ error: "این کاربر در لیست دوستان شما نیست" }, 403);
    const chatKey = "chat:" + [me, friend].map(u => u.toLowerCase()).sort().join("_");
    try {
      const raw = await env.IPTV_KV.get(chatKey);
      const messages = raw ? JSON.parse(raw) : [];
      return jsonResponse({ messages });
    } catch (e) {
      return jsonResponse({ messages: [] });
    }
  }

  if (action === "send" && request.method === "POST") {
    try {
      const body = await request.json();
      const friend = String(body.friend || "").trim();
      const text = String(body.text || "").trim();
      if (!friend || !text) return jsonResponse({ error: "اطلاعات ناقص است" }, 400);
      if (text.length > 1000) return jsonResponse({ error: "پیام خیلی طولانی است (حداکثر ۱۰۰۰ کاراکتر)" }, 400);
      const myUser = session.user;
      if (!(myUser.friends || []).map(f => f.toLowerCase()).includes(friend.toLowerCase()))
        return jsonResponse({ error: "این کاربر در لیست دوستان شما نیست" }, 403);

      const chatKey = "chat:" + [me, friend].map(u => u.toLowerCase()).sort().join("_");
      let messages = [];
      try {
        const raw = await env.IPTV_KV.get(chatKey);
        messages = raw ? JSON.parse(raw) : [];
      } catch {}

      messages.push({ from: me, text, time: Date.now() });
      if (messages.length > 200) messages.splice(0, messages.length - 200);

      await env.IPTV_KV.put(chatKey, JSON.stringify(messages), { expirationTtl: 60 * 60 * 24 * 90 });
      return jsonResponse({ ok: true, messages });
    } catch (e) {
      return jsonResponse({ error: "خطا: " + e.message }, 500);
    }
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ═══════════════════════════════════════════════════════════════
// HTML فرانت‌اند کاربر — با ثبت بازدید کانال
// ═══════════════════════════════════════════════════════════════
function getFrontendHTML(workerOrigin, channelsData, categoriesData) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StreamFa — پخش زنده</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.4.12/dist/hls.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#0b0d10;--bg2:#13161c;--bg3:#1c2029;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --accent:#e8ff47;--accent2:#c8e000;--text:#f0f2f5;--muted:#7a8090;
  --red:#ff4d4d;--green:#3ddc84;--orange:#ffaa33;
  --blue:#4da6ff;--gold:#ffcc00;--gray:#9aa3b2;--card-radius:16px;
}
body{font-family:'Vazirmatn',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;direction:rtl;}
nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 2rem;height:60px;background:rgba(11,13,16,0.9);backdrop-filter:blur(16px);border-bottom:1px solid var(--border);}
.logo{font-size:20px;font-weight:700;letter-spacing:-0.5px;}
.logo span{color:var(--accent);}
.nav-actions{display:flex;gap:10px;align-items:center;}
.btn-admin{background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:7px 16px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;}
.btn-admin:hover{background:var(--accent2);}
.live-dot{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 1.8s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}
.tier-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border-radius:20px;font-weight:700;white-space:nowrap;}
.tier-sub{background:rgba(77,166,255,0.15);color:var(--blue);border:1px solid rgba(77,166,255,0.3);}
.tier-vip{background:rgba(255,204,0,0.15);color:var(--gold);border:1px solid rgba(255,204,0,0.3);}
.tier-owner{background:rgba(154,163,178,0.18);color:var(--gray);border:1px solid rgba(154,163,178,0.35);}
.tick{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;font-size:9px;flex-shrink:0;}
.tick-sub{background:var(--blue);color:#fff;}
.tick-vip{background:var(--gold);color:#3a2e00;}
.tick-owner{background:var(--gray);color:#1a1d22;}
.weather-widget{display:flex;align-items:center;gap:5px;font-size:12.5px;background:var(--bg2);border:1px solid var(--border);border-radius:20px;padding:5px 12px;cursor:default;}
.weather-temp{font-weight:700;}
.weather-city{color:var(--muted);}
.weather-widget.err{color:var(--muted);font-size:11px;}
.btn-account{background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:20px;padding:5px 12px 5px 5px;font-family:inherit;font-size:13px;cursor:pointer;transition:border-color 0.15s;display:inline-flex;align-items:center;gap:7px;}
.btn-account:hover{border-color:var(--border2);}
.avatar-circle{width:28px;height:28px;border-radius:50%;background:var(--bg3);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:13px;overflow:hidden;flex-shrink:0;color:var(--muted);}
.avatar-circle img{width:100%;height:100%;object-fit:cover;}
.account-name-wrap{display:flex;align-items:center;gap:4px;}
.account-role-label{font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;background:rgba(154,163,178,0.18);color:var(--gray);letter-spacing:0.5px;}
.modal-overlay{display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.85);align-items:center;justify-content:center;padding:1rem;}
.modal-overlay.open{display:flex;}
.modal{background:var(--bg2);border:1px solid var(--border2);border-radius:20px;width:100%;max-width:680px;max-height:90vh;overflow-y:auto;}
.modal.narrow{max-width:440px;}
.modal-header{position:sticky;top:0;background:var(--bg2);display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;border-bottom:1px solid var(--border);z-index:2;}
.modal-title{font-size:15px;font-weight:500;}
.modal-close{background:var(--bg3);border:none;width:32px;height:32px;border-radius:8px;color:var(--muted);cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.modal-close:hover{color:var(--text);}
.auth-modal-body{padding:1.25rem;}
.auth-tabs{display:flex;gap:4px;background:var(--bg3);border-radius:10px;padding:4px;margin-bottom:1.1rem;}
.auth-tab{flex:1;padding:8px;border:none;border-radius:7px;background:transparent;color:var(--muted);font-family:inherit;font-size:13px;cursor:pointer;transition:all 0.15s;}
.auth-tab.active{background:var(--bg2);color:var(--text);font-weight:700;}
.auth-field{margin-bottom:12px;display:flex;flex-direction:column;gap:6px;}
.auth-field label{font-size:12px;color:var(--muted);}
.auth-field input{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-family:inherit;font-size:14px;outline:none;}
.auth-field input:focus{border-color:var(--border2);}
.auth-error{color:var(--red);font-size:12.5px;min-height:18px;margin-bottom:8px;}
.auth-success{color:var(--green);font-size:12.5px;min-height:18px;margin-bottom:8px;}
.btn-auth-submit{width:100%;background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:11px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;}
.btn-auth-submit:hover{background:var(--accent2);}
.btn-auth-submit:disabled{opacity:0.6;cursor:not-allowed;}
.up-section{border-top:1px solid var(--border);padding-top:14px;margin-top:14px;}
.up-section:first-child{border-top:none;padding-top:0;margin-top:0;}
.up-title{font-size:13px;font-weight:700;margin-bottom:10px;}
.up-profile-row{display:flex;align-items:center;gap:12px;}
.up-avatar-wrap{position:relative;width:60px;height:60px;flex-shrink:0;}
.up-avatar-big{width:60px;height:60px;border-radius:50%;background:var(--bg3);border:2px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:24px;overflow:hidden;color:var(--muted);}
.up-avatar-big img{width:100%;height:100%;object-fit:cover;}
.up-avatar-edit{position:absolute;bottom:-2px;left:-2px;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#0b0d10;border:2px solid var(--bg2);display:flex;align-items:center;justify-content:center;font-size:11px;cursor:pointer;}
.payment-card{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:1rem;}
.payment-address{font-family:monospace;font-size:12px;color:var(--text);word-break:break-all;background:var(--bg);border-radius:6px;padding:8px 10px;margin:8px 0;cursor:pointer;border:1px solid var(--border);}
.payment-address:hover{border-color:var(--border2);}
.payment-note{font-size:12px;color:var(--muted);line-height:1.6;}
.trust-code-wrap{display:flex;gap:8px;}
.trust-code-wrap input{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:monospace;font-size:13px;outline:none;letter-spacing:2px;}
.trust-code-wrap input:focus{border-color:var(--border2);}
.btn-sm{padding:7px 14px;font-size:13px;}
.access-gate{position:absolute;inset:0;background:rgba(11,13,16,0.88);backdrop-filter:blur(4px);border-radius:var(--card-radius);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;z-index:3;}
.access-gate-icon{font-size:28px;}
.access-gate-text{font-size:13px;color:var(--muted);text-align:center;padding:0 16px;}
.access-gate-btn{background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:8px 18px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;margin-top:4px;}
.access-gate-btn.blue{background:var(--blue);color:#fff;}
.city-search-wrap{position:relative;}
.city-search-wrap input{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:inherit;font-size:13px;outline:none;}
.city-search-results{position:absolute;top:100%;right:0;left:0;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;margin-top:4px;max-height:180px;overflow-y:auto;z-index:10;display:none;}
.city-search-results.show{display:block;}
.city-result-item{padding:8px 12px;font-size:12.5px;cursor:pointer;border-bottom:1px solid var(--border);}
.city-result-item:last-child{border-bottom:none;}
.city-result-item:hover{background:var(--bg2);}
.current-city-display{font-size:12px;color:var(--muted);margin-top:8px;}
.upload-drop{border:2px dashed var(--border2);border-radius:12px;padding:1.5rem;text-align:center;cursor:pointer;transition:all 0.2s;background:var(--bg3);font-size:12.5px;color:var(--muted);}
.upload-drop:hover{border-color:var(--accent);color:var(--text);}
.up-file-list{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;margin-top:10px;}
.up-file-item{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg3);border-radius:8px;font-size:12px;}
.up-file-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.up-file-size{color:var(--muted);font-size:11px;flex-shrink:0;}
.up-file-item a{color:var(--blue);text-decoration:none;flex-shrink:0;}
.up-file-item button{background:transparent;border:none;color:var(--red);cursor:pointer;font-size:12px;flex-shrink:0;}
.up-file-empty{font-size:12px;color:var(--muted);text-align:center;padding:0.75rem 0;}
.upload-progress-wrap{background:var(--bg3);border-radius:20px;height:5px;overflow:hidden;margin-top:8px;display:none;}
.upload-progress-bar{height:100%;background:var(--accent);width:0%;transition:width 0.2s;}
.guest-timer-banner{position:fixed;bottom:20px;right:20px;z-index:140;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:10px 16px;font-size:12.5px;display:none;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);}
.guest-timer-banner.show{display:flex;}
.guest-timer-dot{width:7px;height:7px;border-radius:50%;background:var(--orange);animation:pulse 1.2s ease-in-out infinite;flex-shrink:0;}
.guest-timer-text strong{color:var(--orange);font-family:monospace;}
.guest-timer-btn{background:var(--accent);color:#0b0d10;border:none;border-radius:7px;padding:5px 11px;font-size:11.5px;font-weight:700;cursor:pointer;}
.hero{padding:4rem 2rem 2rem;max-width:960px;margin:0 auto;animation:fadeUp 0.5s ease both;}
@keyframes fadeUp{from{opacity:0;transform:translateY(18px);}to{opacity:1;transform:translateY(0);}}
.hero h1{font-size:clamp(28px,5vw,46px);font-weight:700;line-height:1.2;margin-bottom:12px;}
.hero h1 em{color:var(--accent);font-style:normal;}
.hero p{color:var(--muted);font-size:15px;font-weight:300;}
.controls{max-width:960px;margin:2rem auto 0.75rem;padding:0 2rem;display:flex;gap:10px;flex-wrap:wrap;animation:fadeUp 0.5s 0.1s ease both;}
.search-wrap{flex:1;min-width:200px;position:relative;}
.search-wrap svg{position:absolute;right:12px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;}
.search-wrap input{width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 40px 10px 14px;color:var(--text);font-family:inherit;font-size:14px;outline:none;}
.search-wrap input:focus{border-color:var(--border2);}
.search-wrap input::placeholder{color:var(--muted);}
.filter-btns{display:flex;gap:6px;flex-wrap:wrap;}
.filter-btn{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;color:var(--muted);font-family:inherit;font-size:13px;cursor:pointer;transition:all 0.15s;}
.filter-btn:hover{border-color:var(--border2);color:var(--text);}
.filter-btn.active{background:var(--accent);color:#0b0d10;border-color:var(--accent);font-weight:700;}
.cat-bar{max-width:960px;margin:0.75rem auto 1.25rem;padding:0 2rem;display:flex;gap:8px;flex-wrap:wrap;animation:fadeUp 0.5s 0.15s ease both;}
.cat-chip{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:20px;border:1px solid var(--border);background:var(--bg2);color:var(--muted);font-family:inherit;font-size:13px;cursor:pointer;transition:all 0.15s;}
.cat-chip:hover{border-color:var(--border2);color:var(--text);}
.cat-chip.active{font-weight:700;color:#0b0d10;border-color:transparent;}
.news-fab-wrap{position:fixed;top:76px;left:20px;z-index:150;direction:rtl;}
.news-fab{width:48px;height:48px;border-radius:50%;background:var(--accent);color:#0b0d10;border:none;font-size:21px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:transform 0.15s;}
.news-fab:hover{background:var(--accent2);transform:scale(1.06);}
.news-fab.locked{background:var(--bg2);color:var(--gold);border:1px solid rgba(255,204,0,0.4);}
.news-panel{position:absolute;top:58px;left:0;width:320px;max-height:0;opacity:0;overflow:hidden;background:var(--bg2);border:1px solid var(--border2);border-radius:16px;box-shadow:0 12px 32px rgba(0,0,0,0.5);transition:max-height 0.25s ease,opacity 0.2s ease;pointer-events:none;}
.news-panel.open{max-height:480px;opacity:1;pointer-events:auto;}
.news-panel-header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border);font-size:13px;font-weight:700;}
.news-panel-close{background:var(--bg3);border:none;width:26px;height:26px;border-radius:7px;color:var(--muted);cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;}
.news-panel-links{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:1px solid var(--border);}
.news-source-link{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text);text-decoration:none;padding:7px 8px;border-radius:8px;transition:background 0.15s;}
.news-source-link:hover{background:var(--bg3);}
.news-panel-list{max-height:320px;overflow-y:auto;padding:6px;}
.news-loading{padding:1.5rem;text-align:center;color:var(--muted);font-size:12.5px;}
.news-locked-box{padding:1.5rem 1rem;text-align:center;}
.news-locked-box .icon{font-size:26px;margin-bottom:8px;}
.news-locked-box p{font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.6;}
.news-item{display:block;padding:10px 12px;border-radius:9px;text-decoration:none;color:var(--text);transition:background 0.15s;border-bottom:1px solid var(--border);}
.news-item:hover{background:var(--bg3);}
.news-source-tag{font-size:9.5px;color:var(--gold);font-weight:700;margin-bottom:3px;display:block;}
.news-title{font-size:12.5px;font-weight:500;line-height:1.55;margin-bottom:4px;}
.news-date{font-size:10.5px;color:var(--muted);}
.grid{max-width:960px;margin:0 auto;padding:0 2rem 4rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--card-radius);padding:1.25rem;cursor:pointer;transition:border-color 0.2s,transform 0.15s;animation:fadeUp 0.4s ease both;position:relative;overflow:hidden;}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:transparent;transition:background 0.2s;}
.card:hover{border-color:var(--border2);transform:translateY(-2px);}
.card:hover::before{background:var(--accent);}
.card.vip-card::before{background:linear-gradient(90deg,var(--gold),transparent);}
.card.sub-card::before{background:linear-gradient(90deg,var(--blue),transparent);}
.card-header{display:flex;align-items:center;gap:12px;margin-bottom:10px;}
.ch-icon{width:44px;height:44px;border-radius:10px;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
.ch-info{flex:1;min-width:0;}
.ch-name{font-size:15px;font-weight:500;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ch-id{font-size:12px;color:var(--muted);font-family:monospace;}
.status-badge{font-size:11px;padding:3px 8px;border-radius:20px;font-weight:500;display:flex;align-items:center;gap:4px;flex-shrink:0;}
.status-live{background:rgba(61,220,132,0.12);color:var(--green);}
.status-error{background:rgba(255,77,77,0.12);color:var(--red);}
.status-warn{background:rgba(255,170,51,0.12);color:var(--orange);}
.status-dot{width:5px;height:5px;border-radius:50%;background:currentColor;}
.ch-meta{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;}
.ch-category{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500;}
.ch-views{font-size:10.5px;color:var(--muted);display:flex;align-items:center;gap:3px;}
.ch-url{font-size:11px;color:var(--muted);background:var(--bg3);border-radius:6px;padding:6px 10px;margin-bottom:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;}
.card-actions{display:flex;gap:8px;}
.btn-play{flex:1;background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:9px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;}
.btn-play:hover{background:var(--accent2);}
.btn-copy{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--muted);cursor:pointer;font-size:13px;display:flex;align-items:center;gap:5px;}
.btn-copy:hover{border-color:var(--border2);color:var(--text);}
.fav-star-btn{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:17px;line-height:1;padding:2px;transition:color 0.15s,transform 0.15s;}
.fav-star-btn:hover{transform:scale(1.15);}
.fav-star-btn.active{color:var(--accent);}
.player-area{background:#000;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;position:relative;}
#video-player{width:100%;height:100%;display:none;object-fit:contain;}
.player-placeholder{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--muted);font-size:14px;position:absolute;z-index:1;pointer-events:none;}
.player-placeholder svg{opacity:0.3;}
.player-guest-badge{position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.7);color:var(--orange);font-size:11px;padding:5px 10px;border-radius:8px;z-index:4;font-family:monospace;display:none;}
.modal-footer{padding:1rem 1.25rem;display:flex;gap:8px;align-items:center;}
.modal-url{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--muted);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.btn-vlc{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 14px;color:var(--text);font-family:inherit;font-size:13px;cursor:pointer;white-space:nowrap;}
.btn-vlc:hover{border-color:var(--border2);}
.up-fav-list{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;}
.up-fav-item{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg3);border-radius:8px;font-size:12.5px;}
.up-fav-item button{margin-right:auto;background:transparent;border:none;color:var(--red);cursor:pointer;font-size:12px;}
.up-fav-empty{font-size:12.5px;color:var(--muted);text-align:center;padding:1rem 0;}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--text);color:var(--bg);border-radius:10px;padding:10px 20px;font-size:13px;font-weight:500;z-index:999;transition:transform 0.3s ease;pointer-events:none;}
.toast.show{transform:translateX(-50%) translateY(0);}
.empty{grid-column:1/-1;text-align:center;padding:4rem 0;color:var(--muted);font-size:14px;}
@media(max-width:600px){.hero,.controls,.cat-bar,.grid{padding-right:1rem;padding-left:1rem;}nav{padding:0 1rem;}.weather-city{display:none;}.nav-actions{gap:6px;}.btn-account,.btn-admin{padding:7px 10px;font-size:12px;}.guest-timer-banner{right:10px;bottom:10px;}}
.friends-modal-body{padding:1.25rem;}
.friends-tabs{display:flex;gap:4px;background:var(--bg3);border-radius:10px;padding:4px;margin-bottom:1rem;}
.friends-tab{flex:1;padding:8px;border:none;border-radius:7px;background:transparent;color:var(--muted);font-family:inherit;font-size:13px;cursor:pointer;transition:all 0.15s;}
.friends-tab.active{background:var(--bg2);color:var(--text);font-weight:700;}
.friend-item{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg3);border-radius:10px;margin-bottom:6px;}
.friend-avatar{width:36px;height:36px;border-radius:50%;background:var(--bg);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;overflow:hidden;}
.friend-avatar img{width:100%;height:100%;object-fit:cover;}
.friend-info{flex:1;min-width:0;}
.friend-name{font-size:13px;font-weight:600;}
.friend-actions{display:flex;gap:6px;flex-shrink:0;}
.btn-chat-open{background:var(--accent);color:#0b0d10;border:none;border-radius:7px;padding:6px 12px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;}
.btn-chat-open:hover{background:var(--accent2);}
.btn-remove-friend{background:transparent;border:1px solid rgba(255,77,77,0.3);border-radius:7px;padding:6px 10px;color:var(--red);font-size:12px;cursor:pointer;}
.btn-remove-friend:hover{background:rgba(255,77,77,0.1);}
.btn-accept-friend{background:rgba(61,220,132,0.12);border:1px solid rgba(61,220,132,0.3);border-radius:7px;padding:6px 10px;color:var(--green);font-size:12px;cursor:pointer;}
.btn-accept-friend:hover{background:rgba(61,220,132,0.22);}
.btn-reject-friend{background:transparent;border:1px solid var(--border);border-radius:7px;padding:6px 10px;color:var(--muted);font-size:12px;cursor:pointer;}
.req-badge{background:rgba(255,170,51,0.15);color:var(--orange);border:1px solid rgba(255,170,51,0.3);border-radius:20px;font-size:11px;padding:2px 8px;font-weight:700;display:inline-flex;align-items:center;gap:4px;}
.add-friend-wrap{display:flex;gap:8px;margin-bottom:1rem;}
.add-friend-wrap input{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:inherit;font-size:13px;outline:none;}
.add-friend-wrap input:focus{border-color:var(--border2);}
.btn-send-req{background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:9px 16px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;}
.btn-send-req:hover{background:var(--accent2);}
.friends-empty{text-align:center;padding:2rem 0;color:var(--muted);font-size:13px;}
.chat-back-btn{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 14px;color:var(--text2);font-family:inherit;font-size:12.5px;cursor:pointer;margin-bottom:12px;display:inline-flex;align-items:center;gap:6px;}
.chat-back-btn:hover{border-color:var(--border2);color:var(--text);}
.chat-with-label{font-size:13px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:7px;}
.chat-box{background:var(--bg);border:1px solid var(--border);border-radius:12px;height:300px;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;margin-bottom:10px;}
.msg-bubble{max-width:78%;padding:9px 13px;border-radius:14px;font-size:13px;line-height:1.55;word-break:break-word;}
.msg-me{background:var(--accent);color:#0b0d10;align-self:flex-start;border-bottom-right-radius:3px;}
.msg-friend{background:var(--bg3);color:var(--text);align-self:flex-end;border-bottom-left-radius:3px;}
.msg-time{font-size:10px;opacity:0.6;margin-top:3px;display:block;}
.chat-input-row{display:flex;gap:8px;}
.chat-input-row input{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-family:inherit;font-size:13px;outline:none;}
.chat-input-row input:focus{border-color:var(--border2);}
.btn-msg-send{background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:10px 18px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0;}
.btn-msg-send:hover{background:var(--accent2);}
.friends-notif-dot{width:8px;height:8px;border-radius:50%;background:var(--orange);display:inline-block;margin-right:4px;animation:pulse 1.5s ease-in-out infinite;}
</style>
</head>
<body>

<nav>
  <div class="logo">Stream<span>Fa</span></div>
  <div class="nav-actions">
    <div class="live-dot"><div class="dot"></div> زنده</div>
    <div id="weather-widget" class="weather-widget" title="آب و هوا">
      <span id="weather-icon">⏳</span>
      <span class="weather-temp" id="weather-temp">—</span>
      <span class="weather-city" id="weather-city"></span>
    </div>
    <button class="btn-account" id="btn-account-guest" onclick="openAuthModal('login')">ورود / ثبت‌نام</button>
    <button class="btn-account" id="btn-account-user" style="display:none;" onclick="openUserPanel()">
      <span class="avatar-circle" id="account-avatar">👤</span>
      <span class="account-name-wrap">
        <span id="account-username"></span>
        <span id="account-tick"></span>
        <span id="account-role-label" style="display:none;" class="account-role-label"></span>
      </span>
    </button>
    <a href="/admin" class="btn-admin" id="btn-admin-link" style="display:none;">پنل مدیریت</a>
  </div>
</nav>

<!-- مودال ورود / ثبت‌نام -->
<div class="modal-overlay" id="auth-modal" onclick="closeAuthModal(event)">
  <div class="modal narrow">
    <div class="modal-header">
      <span class="modal-title" id="auth-modal-title">ورود به حساب کاربری</span>
      <button class="modal-close" onclick="closeAuthModal(null)">✕</button>
    </div>
    <div class="auth-modal-body">
      <div class="auth-tabs">
        <button class="auth-tab active" id="auth-tab-login" onclick="switchAuthTab('login')">ورود</button>
        <button class="auth-tab" id="auth-tab-signup" onclick="switchAuthTab('signup')">ثبت‌نام</button>
      </div>
      <div class="auth-field"><label>نام کاربری</label><input type="text" id="auth-username" placeholder="نام کاربری" autocomplete="username"></div>
      <div class="auth-field"><label>رمز عبور</label><input type="password" id="auth-password" placeholder="رمز عبور" autocomplete="current-password"></div>
      <div class="auth-error" id="auth-error"></div>
      <button class="btn-auth-submit" id="auth-submit-btn" onclick="submitAuth()">ورود</button>
    </div>
  </div>
</div>

<!-- پنل کاربری -->
<div class="modal-overlay" id="user-panel-modal" onclick="closeUserPanel(event)">
  <div class="modal narrow">
    <div class="modal-header">
      <span class="modal-title">پنل کاربری</span>
      <button class="modal-close" onclick="closeUserPanel(null)">✕</button>
    </div>
    <div class="auth-modal-body">
      <div class="up-section">
        <div class="up-profile-row">
          <div class="up-avatar-wrap">
            <div class="up-avatar-big" id="up-avatar-big">👤</div>
            <div class="up-avatar-edit" onclick="document.getElementById('avatar-file-input').click()" title="تغییر عکس پروفایل">✏️</div>
            <input type="file" id="avatar-file-input" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none;" onchange="onAvatarFileSelected(event)">
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:15px;font-weight:700;display:flex;align-items:center;gap:6px;" id="up-username-display"></div>
            <div id="up-tier-badge" style="margin-top:5px;"></div>
          </div>
          <button class="btn-vlc btn-sm" onclick="logoutUser()">خروج</button>
        </div>
        <div class="auth-error" id="avatar-error" style="margin-top:8px;"></div>
      </div>
      <div class="up-section" id="up-sub-section">
        <div class="up-title">💳 خرید اشتراک (تیک آبی)</div>
        <div class="payment-card" id="payment-card-content"><div style="font-size:12.5px;color:var(--muted);">در حال بارگذاری...</div></div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:8px;">پس از واریز، رسید را به ادمین ارسال کنید تا اشتراک شما فعال شود.</div>
      </div>
      <div class="up-section" id="up-vip-section">
        <div class="up-title">🌟 فعال‌سازی دسترسی VIP (تیک طلایی)</div>
        <div class="trust-code-wrap">
          <input type="text" id="trust-code-input" placeholder="کد اعتماد..." autocomplete="off">
          <button class="btn-vlc btn-sm" onclick="submitTrustCode()">تأیید</button>
        </div>
        <div class="auth-error" id="trust-code-error"></div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:4px;">کد اعتماد از طریق ادمین به شما داده می‌شود.</div>
      </div>
      <div class="up-section" id="up-upload-section" style="display:none;">
        <div class="up-title">📁 آپلود سنتر (ویژه VIP)</div>
        <div class="upload-drop" id="upload-drop-zone" onclick="document.getElementById('upload-file-input').click()">📤 برای آپلود فایل کلیک کنید (حداکثر ۵۰ مگابایت)</div>
        <input type="file" id="upload-file-input" style="display:none;" onchange="onUploadFileSelected(event)">
        <div class="upload-progress-wrap" id="upload-progress-wrap"><div class="upload-progress-bar" id="upload-progress-bar"></div></div>
        <div class="auth-error" id="upload-error"></div>
        <div id="up-file-list" class="up-file-list"></div>
      </div>
      <div class="up-section">
        <div class="up-title">🌍 شهر برای آب‌وهوا</div>
        <div class="city-search-wrap">
          <input type="text" id="city-search-input" placeholder="نام شهر..." oninput="onCitySearchInput()">
          <div class="city-search-results" id="city-search-results"></div>
        </div>
        <div class="current-city-display" id="current-city-display"></div>
      </div>
      <div class="up-section">
        <div class="up-title">💬 دوستان و چت خصوصی</div>
        <button class="btn-auth-submit" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);font-weight:500;" onclick="closeUserPanel(null);openFriendsModal()">
          <span id="friends-panel-btn-label">مشاهده دوستان و چت</span>
        </button>
      </div>
      <div class="up-section">
        <div class="up-title">⭐ کانال‌های مورد علاقه</div>
        <div id="up-favorites-list" class="up-fav-list"></div>
      </div>
      <div class="up-section">
        <div class="up-title">🔒 تغییر رمز عبور</div>
        <div class="auth-field"><label>رمز فعلی</label><input type="password" id="cp-current" autocomplete="current-password"></div>
        <div class="auth-field"><label>رمز جدید</label><input type="password" id="cp-new" autocomplete="new-password"></div>
        <div class="auth-error" id="cp-error"></div>
        <button class="btn-auth-submit" onclick="submitChangePassword()">تغییر رمز</button>
      </div>
    </div>
  </div>
</div>

<div class="hero">
  <h1>پخش زنده<br><em>بدون مرز</em></h1>
  <p>کانال مورد نظرت رو انتخاب کن و مستقیم تماشا کن</p>
</div>

<div class="controls">
  <div class="search-wrap">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" id="search" placeholder="جستجوی کانال..." oninput="renderCards()">
  </div>
  <div class="filter-btns">
    <button class="filter-btn active" onclick="setFilter('all',this)">همه</button>
    <button class="filter-btn" onclick="setFilter('live',this)">فعال</button>
    <button class="filter-btn" onclick="setFilter('error',this)">خطا</button>
  </div>
</div>

<div class="cat-bar" id="cat-bar"></div>
<div class="grid" id="grid"></div>

<!-- پلیر -->
<div class="modal-overlay" id="modal" onclick="closeModal(event)">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title" id="modal-title">نام کانال</span>
      <button class="modal-close" onclick="closeModal(null)">✕</button>
    </div>
    <div class="player-area">
      <div class="player-guest-badge" id="player-guest-badge"></div>
      <video id="video-player" controls autoplay playsinline></video>
      <div class="player-placeholder" id="player-placeholder">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
        <span id="player-note">در حال بارگذاری استریم...</span>
      </div>
    </div>
    <div class="modal-footer">
      <div class="modal-url" id="modal-url"></div>
      <button class="btn-vlc" onclick="copyModalUrl()">کپی لینک</button>
      <button class="btn-vlc" onclick="openVLC()">باز در VLC</button>
    </div>
  </div>
</div>

<!-- اخبار -->
<div class="news-fab-wrap">
  <button class="news-fab" id="news-fab" onclick="toggleNewsPanel()" title="سرخط اخبار (ویژه VIP)">📰</button>
  <div class="news-panel" id="news-panel">
    <div class="news-panel-header">
      <span>سرخط اخبار</span>
      <button class="news-panel-close" onclick="toggleNewsPanel()">✕</button>
    </div>
    <div class="news-panel-links" id="news-panel-links" style="display:none;">
      <a href="https://feeds.bbci.co.uk/persian/rss.xml" target="_blank" rel="noopener" class="news-source-link"><span style="width:8px;height:8px;border-radius:50%;background:#bb1919;display:inline-block;"></span> RSS بی‌بی‌سی فارسی</a>
      <a href="https://www.iranintl.com/fa" target="_blank" rel="noopener" class="news-source-link"><span style="width:8px;height:8px;border-radius:50%;background:#0072bc;display:inline-block;"></span> ایران اینترنشنال</a>
    </div>
    <div class="news-panel-list" id="news-panel-list"><div class="news-loading">در حال بارگذاری...</div></div>
  </div>
</div>

<!-- بنر تایمر مهمان -->
<div class="guest-timer-banner" id="guest-timer-banner">
  <div class="guest-timer-dot"></div>
  <div class="guest-timer-text">تماشای رایگان: <strong id="guest-timer-value">۵:۰۰</strong></div>
  <button class="guest-timer-btn" onclick="openAuthModal('signup')">ثبت‌نام رایگان</button>
</div>

<!-- مودال دوستان و چت خصوصی -->
<div class="modal-overlay" id="friends-modal" onclick="closeFriendsModal(event)">
  <div class="modal narrow">
    <div class="modal-header">
      <span class="modal-title" id="friends-modal-title">💬 دوستان من</span>
      <button class="modal-close" onclick="closeFriendsModal(null)">✕</button>
    </div>
    <div id="friends-view" class="friends-modal-body">
      <div class="friends-tabs">
        <button class="friends-tab active" id="ftab-friends" onclick="switchFriendsTab('friends')">دوستان</button>
        <button class="friends-tab" id="ftab-requests" onclick="switchFriendsTab('requests')">درخواست‌ها <span id="req-count-badge" style="display:none;" class="req-badge">0</span></button>
        <button class="friends-tab" id="ftab-add" onclick="switchFriendsTab('add')">افزودن دوست</button>
      </div>
      <div id="ftab-friends-content"><div id="friends-list-container"><div class="friends-empty">در حال بارگذاری...</div></div></div>
      <div id="ftab-requests-content" style="display:none;"><div id="requests-list-container"><div class="friends-empty">درخواستی وجود ندارد</div></div></div>
      <div id="ftab-add-content" style="display:none;">
        <div class="add-friend-wrap">
          <input type="text" id="add-friend-input" placeholder="نام کاربری دوستتان..." autocomplete="off">
          <button class="btn-send-req" onclick="sendFriendRequest()">ارسال درخواست</button>
        </div>
        <div class="auth-error" id="add-friend-error"></div>
        <div class="auth-success" id="add-friend-success"></div>
      </div>
    </div>
    <div id="chat-view" style="display:none;" class="friends-modal-body">
      <button class="chat-back-btn" onclick="backToFriendsList()">← بازگشت به دوستان</button>
      <div class="chat-with-label" id="chat-with-label">👤 —</div>
      <div class="chat-box" id="chat-box"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="پیام..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChatMessage();}">
        <button class="btn-msg-send" onclick="sendChatMessage()">ارسال</button>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const WORKER_BASE = '${workerOrigin}';
const channels   = ${JSON.stringify(channelsData)};
const categories = ${JSON.stringify(categoriesData)};

let hlsInstance   = null;
let activeFilter  = 'all';
let activeCat     = '__all__';
let activeChannel = null;
let newsLoaded    = false;
let currentUser   = null;
let guestTimerInterval = null;
let guestExpired  = false;
let activeChannelIsGuestFree = false;
const viewedChannels = new Set();

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove('show'),2500);
}
function proxyUrl(ch) { return WORKER_BASE+'/'+ch.id+'/master.m3u8'; }
function isOwnerUser() { return currentUser && currentUser.role === 'owner'; }
function tierTickHtml(user) {
  if(!user) return '';
  if(user.role==='owner') return '<span class="tick tick-owner" title="ادمین">✓</span>';
  if(user.tier==='vip') return '<span class="tick tick-vip" title="VIP">✓</span>';
  if(user.tier==='sub') return '<span class="tick tick-sub" title="اشتراک فعال">✓</span>';
  return '';
}
function tierLabel(user) {
  if(!user) return '';
  if(user.role==='owner') return '<span class="tier-badge tier-owner">⚙️ ادمین</span>';
  if(user.tier==='vip') return '<span class="tier-badge tier-vip">🌟 VIP</span>';
  if(user.tier==='sub') return '<span class="tier-badge tier-sub">✅ اشتراک فعال</span>';
  return '<span style="font-size:12px;color:var(--muted);">بدون اشتراک</span>';
}
function avatarHtml(user) {
  if(user && user.avatarUrl) return '<img src="'+escHtml(user.avatarUrl)+'" alt="">';
  return '👤';
}

async function recordChannelView(channelId) {
  if(viewedChannels.has(channelId)) return;
  viewedChannels.add(channelId);
  try {
    await fetch(WORKER_BASE+'/api/stats/view', {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({channelId})
    });
  } catch(e) {}
}

function canSeeNews() { return currentUser && (currentUser.role==='owner' || currentUser.tier==='vip'); }
function toggleNewsPanel() {
  const panel = document.getElementById('news-panel');
  const isOpen = panel.classList.toggle('open');
  if(isOpen) loadNews();
}
document.addEventListener('click', e => {
  const wrap = document.querySelector('.news-fab-wrap');
  const panel = document.getElementById('news-panel');
  if(panel&&panel.classList.contains('open')&&wrap&&!wrap.contains(e.target)) panel.classList.remove('open');
});
function updateNewsFabStyle() {
  const fab = document.getElementById('news-fab');
  fab.classList.toggle('locked', !canSeeNews());
}
async function loadNews() {
  const list = document.getElementById('news-panel-list');
  const linksWrap = document.getElementById('news-panel-links');
  if(!canSeeNews()) {
    linksWrap.style.display='none';
    list.innerHTML = '<div class="news-locked-box"><div class="icon">🌟</div><p>سرخط اخبار فقط برای کاربران VIP در دسترس است.</p>'
      + (currentUser ? '<button class="btn-vlc btn-sm" onclick="openUserPanel()">فعال‌سازی VIP</button>' : '<button class="btn-vlc btn-sm" onclick="openAuthModal(\\'login\\')">ورود به حساب</button>')
      + '</div>';
    return;
  }
  linksWrap.style.display='flex';
  if(newsLoaded) return;
  try {
    const res = await fetch(WORKER_BASE+'/api/news',{credentials:'include'});
    if(res.status===403){ newsLoaded=false; list.innerHTML='<div class="news-loading">دسترسی به اخبار نیاز به VIP دارد</div>'; return; }
    const items = await res.json();
    newsLoaded = true;
    if(!items.length){list.innerHTML='<div class="news-loading">خبری یافت نشد</div>';return;}
    list.innerHTML = items.map(n=>\`<a class="news-item" href="\${escHtml(n.link)}" target="_blank" rel="noopener"><span class="news-source-tag">\${escHtml(n.source||'')}</span><div class="news-title">\${escHtml(n.title)}</div><div class="news-date">\${escHtml(n.pubDate)}</div></a>\`).join('');
  } catch(e){document.getElementById('news-panel-list').innerHTML='<div class="news-loading">خطا در بارگذاری ❌</div>';}
}

function statusLabel(s){
  if(s==='live') return{cls:'status-live',text:'زنده'};
  if(s==='error') return{cls:'status-error',text:'خطا'};
  return{cls:'status-warn',text:'هشدار'};
}
function setFilter(f,btn){
  activeFilter=f;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderCards();
}
function setCat(c){activeCat=c;renderCatBar();renderCards();}

function renderCatBar(){
  const bar=document.getElementById('cat-bar');
  if(!categories.length){bar.style.display='none';return;}
  bar.style.display='flex';
  const allCount=channels.length;
  bar.innerHTML=\`<button class="cat-chip\${activeCat==='__all__'?' active':''}" style="\${activeCat==='__all__'?'background:var(--accent)':''}" onclick="setCat('__all__')">همه (\${allCount})</button>\`
    +categories.map(cat=>{
      const cnt=channels.filter(c=>c.category===cat.id).length;
      const isActive=activeCat===cat.id;
      return\`<button class="cat-chip\${isActive?' active':''}" style="\${isActive?'background:'+cat.color+';color:#0b0d10':''}" onclick="setCat('\${cat.id}')">\${escHtml(cat.icon)} \${escHtml(cat.name)} (\${cnt})</button>\`;
    }).join('');
}

function renderCards(){
  const q = document.getElementById('search').value.trim().toLowerCase();
  const grid = document.getElementById('grid');
  let list = channels.filter(ch=>{
    const matchQ = !q || ch.name.toLowerCase().includes(q) || ch.id.includes(q);
    const matchF = activeFilter==='all' || ch.status===activeFilter;
    const matchC = activeCat==='__all__' || ch.category===activeCat;
    return matchQ && matchF && matchC;
  });

  if(!list.length){grid.innerHTML='<div class="empty">کانالی یافت نشد</div>';return;}

  grid.innerHTML=list.map((ch,i)=>{
    const s    = statusLabel(ch.status);
    const cat  = categories.find(c=>c.id===ch.category);
    const catBadge = cat?\`<span class="ch-category" style="background:\${cat.color}22;color:\${cat.color}">\${cat.icon} \${cat.name}</span>\`:'';
    const latency = ch.lastCheck?.latency?\`<span style="font-size:11px;color:var(--muted);font-family:monospace;">\${ch.lastCheck.latency}ms</span>\`:'';
    const isFav = currentUser && (currentUser.favorites||[]).includes(ch.id);
    const favBtn = currentUser?\`<button class="fav-star-btn\${isFav?' active':''}" onclick="event.stopPropagation();toggleFavorite('\${ch.id}')">\${isFav?'★':'☆'}</button>\`:'';

    const access = ch.access || 'public';
    let gateOverlay = '';
    if(!currentUser && access!=='public') {
      gateOverlay=\`<div class="access-gate"><div class="access-gate-icon">🔒</div><div class="access-gate-text">برای پخش این کانال ابتدا وارد شوید</div><button class="access-gate-btn" onclick="event.stopPropagation();openAuthModal('login')">ورود</button></div>\`;
    } else if(currentUser && access==='sub' && currentUser.tier==='none' && currentUser.role!=='owner') {
      gateOverlay=\`<div class="access-gate"><div class="access-gate-icon">💳</div><div class="access-gate-text">این کانال نیاز به اشتراک دارد</div><button class="access-gate-btn blue" onclick="event.stopPropagation();openUserPanel()">خرید اشتراک</button></div>\`;
    }

    const cardClass = access==='vip'?'card vip-card':(access==='sub'?'card sub-card':'card');
    return\`<div class="\${cardClass}" style="animation-delay:\${i*0.04}s" onclick="openModal('\${ch.id}')">
      \${gateOverlay}
      <div class="card-header">
        <div class="ch-icon">\${ch.icon||'📺'}</div>
        <div class="ch-info">
          <div class="ch-name">\${escHtml(ch.name)}</div>
          <div class="ch-id">#\${ch.id}</div>
        </div>
        \${favBtn}
        <div class="status-badge \${s.cls}"><div class="status-dot"></div>\${s.text}</div>
      </div>
      \${(catBadge||latency)?\`<div class="ch-meta">\${catBadge}\${latency}</div>\`:''}
      <div class="ch-url">\${proxyUrl(ch)}</div>
      <div class="card-actions">
        <button class="btn-play" onclick="event.stopPropagation();openModal('\${ch.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          پخش
        </button>
        <button class="btn-copy" onclick="event.stopPropagation();copyLink('\${ch.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          کپی
        </button>
      </div>
    </div>\`;
  }).join('');
}

async function toggleFavorite(channelId){
  if(!currentUser){openAuthModal('login');return;}
  try{
    const res=await fetch(WORKER_BASE+'/api/favorites',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId})});
    const data=await res.json();
    if(res.ok){currentUser.favorites=data.favorites;renderCards();if(document.getElementById('user-panel-modal').classList.contains('open'))renderFavoritesList();}
    else showToast(data.error||'خطا ❌');
  }catch(e){showToast('خطا در ارتباط با سرور ❌');}
}

function copyLink(id){
  const ch=channels.find(c=>c.id===id);if(!ch)return;
  navigator.clipboard.writeText(proxyUrl(ch)).catch(()=>{});
  showToast('لینک کپی شد ✓');
}

async function refreshGuestTimer(){
  if(currentUser){ stopGuestTimerUI(); return; }
  try{
    const res=await fetch(WORKER_BASE+'/api/guest-token',{credentials:'include'});
    const data=await res.json();
    guestExpired = !!data.expired;
    startGuestTimerUI(data.remainingMs);
  }catch(e){}
}
function startGuestTimerUI(remainingMs){
  clearInterval(guestTimerInterval);
  const banner=document.getElementById('guest-timer-banner');
  if(currentUser){banner.classList.remove('show');return;}
  let remaining=Math.max(0,remainingMs);
  banner.classList.add('show');
  updateGuestTimerLabel(remaining);
  guestTimerInterval=setInterval(()=>{
    remaining-=1000;
    if(remaining<=0){
      remaining=0; guestExpired=true; clearInterval(guestTimerInterval);
      updateGuestTimerLabel(0);
      if(activeChannelIsGuestFree && document.getElementById('modal').classList.contains('open')){
        showToast('زمان تماشای رایگان به پایان رسید 🔒');
        closeModal(null); openAuthModal('signup');
      }
      return;
    }
    updateGuestTimerLabel(remaining);
  },1000);
}
function stopGuestTimerUI(){
  clearInterval(guestTimerInterval);
  document.getElementById('guest-timer-banner').classList.remove('show');
}
function updateGuestTimerLabel(ms){
  const totalSec=Math.ceil(ms/1000);
  const m=Math.floor(totalSec/60), s=totalSec%60;
  document.getElementById('guest-timer-value').textContent=m+':'+String(s).padStart(2,'0');
}

function openModal(id){
  const ch=channels.find(c=>c.id===id);if(!ch)return;

  const access=ch.access||'public';
  if(access!=='public' && currentUser?.role!=='owner'){
    if(!currentUser){showToast('برای پخش باید وارد شوید 🔒');openAuthModal('login');return;}
    if(access==='sub'&&currentUser.tier==='none'){showToast('برای پخش این کانال اشتراک تهیه کنید 💳');openUserPanel();return;}
  }
  if(!currentUser && access==='public' && guestExpired){
    showToast('زمان تماشای رایگان شما به پایان رسیده. وارد شوید 🔒');
    openAuthModal('signup');
    return;
  }

  activeChannel=ch;
  activeChannelIsGuestFree = !currentUser && access==='public';

  recordChannelView(id);

  const url=proxyUrl(ch);
  document.getElementById('modal-title').textContent=(ch.icon||'📺')+' '+ch.name;
  document.getElementById('modal-url').textContent=url;
  const video=document.getElementById('video-player');
  const placeholder=document.getElementById('player-placeholder');
  const guestBadge=document.getElementById('player-guest-badge');
  video.style.display='none';placeholder.style.display='flex';
  if(activeChannelIsGuestFree){
    guestBadge.style.display='block';
    guestBadge.textContent='تماشای مهمان — محدود به ۵ دقیقه';
  } else { guestBadge.style.display='none'; }
  document.getElementById('modal').classList.add('open');
  document.title='درحال پخش: '+ch.name;
  if(Hls.isSupported()){
    if(hlsInstance)hlsInstance.destroy();
    hlsInstance=new Hls({maxMaxBufferLength:10,xhrSetup:xhr=>{xhr.withCredentials=true;}});
    hlsInstance.loadSource(url);hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED,()=>{placeholder.style.display='none';video.style.display='block';video.play().catch(()=>{});});
    hlsInstance.on(Hls.Events.ERROR,(e,data)=>{
      if(data.fatal){
        if(data.response&&data.response.code===403){
          document.getElementById('player-note').textContent='دسترسی مسدود است 🔒';
          showToast('دسترسی به این کانال نیاز به ارتقا حساب دارد');
        } else {
          document.getElementById('player-note').textContent='خطا در بارگذاری ❌';
        }
      }
    });
  }else if(video.canPlayType('application/vnd.apple.mpegurl')){
    video.src=url;
    video.addEventListener('loadedmetadata',()=>{placeholder.style.display='none';video.style.display='block';video.play().catch(()=>{});});
  }
}
function closeModal(e){
  if(e&&e.target!==document.getElementById('modal'))return;
  document.getElementById('modal').classList.remove('open');
  const v=document.getElementById('video-player');v.pause();v.src='';
  if(hlsInstance){hlsInstance.destroy();hlsInstance=null;}
  document.title='StreamFa — پخش زنده';
}
function copyModalUrl(){if(!activeChannel)return;navigator.clipboard.writeText(proxyUrl(activeChannel)).catch(()=>{});showToast('لینک کپی شد ✓');}
function openVLC(){if(!activeChannel)return;window.location.href='vlc://'+proxyUrl(activeChannel).replace(/^https?:\\/\\//,'');}

let authMode='login';
function openAuthModal(mode){
  authMode=mode;switchAuthTab(mode);
  document.getElementById('auth-error').textContent='';
  document.getElementById('auth-username').value='';
  document.getElementById('auth-password').value='';
  document.getElementById('auth-modal').classList.add('open');
}
function closeAuthModal(e){if(e&&e.target!==document.getElementById('auth-modal'))return;document.getElementById('auth-modal').classList.remove('open');}
function switchAuthTab(mode){
  authMode=mode;
  document.getElementById('auth-tab-login').classList.toggle('active',mode==='login');
  document.getElementById('auth-tab-signup').classList.toggle('active',mode==='signup');
  document.getElementById('auth-modal-title').textContent=mode==='login'?'ورود به حساب کاربری':'ساخت حساب کاربری جدید';
  document.getElementById('auth-submit-btn').textContent=mode==='login'?'ورود':'ثبت‌نام';
  document.getElementById('auth-error').textContent='';
}
async function submitAuth(){
  const username=document.getElementById('auth-username').value.trim();
  const password=document.getElementById('auth-password').value;
  const errEl=document.getElementById('auth-error');
  const btn=document.getElementById('auth-submit-btn');
  errEl.textContent='';
  if(!username||!password){errEl.textContent='نام کاربری و رمز عبور را وارد کن';return;}
  const endpoint=authMode==='login'?'/api/auth/login':'/api/auth/signup';
  btn.disabled=true;
  try{
    const res=await fetch(WORKER_BASE+endpoint,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    let data;
    try{ data=await res.json(); }catch(parseErr){ errEl.textContent='پاسخ نامعتبر از سرور (کد '+res.status+')'; btn.disabled=false; return; }
    if(!res.ok){errEl.textContent=data.error||('خطایی رخ داد (کد '+res.status+')');btn.disabled=false;return;}
    currentUser=data.user;closeAuthModal(null);updateAccountUI();renderCards();updateNewsFabStyle();
    showToast(authMode==='login'?'خوش آمدی ✓':'حساب ساخته شد ✓');loadWeather();refreshGuestTimer();
  }catch(e){errEl.textContent='خطا در ارتباط با سرور: '+e.message;}
  btn.disabled=false;
}
async function logoutUser(){
  try{await fetch(WORKER_BASE+'/api/auth/logout',{method:'POST',credentials:'include'});}catch(e){}
  currentUser=null;closeUserPanel(null);updateAccountUI();renderCards();updateNewsFabStyle();showToast('خروج موفق');loadWeather();refreshGuestTimer();
  document.getElementById('btn-admin-link').style.display='none';
}
function updateAccountUI(){
  const guest=document.getElementById('btn-account-guest');
  const user=document.getElementById('btn-account-user');
  const adminLink=document.getElementById('btn-admin-link');
  if(currentUser){
    guest.style.display='none';user.style.display='inline-flex';
    document.getElementById('account-avatar').innerHTML=avatarHtml(currentUser);
    document.getElementById('account-username').textContent=currentUser.username;
    document.getElementById('account-tick').innerHTML=tierTickHtml(currentUser);
    const roleLabel=document.getElementById('account-role-label');
    if(currentUser.role==='owner'){roleLabel.style.display='inline-block';roleLabel.textContent='OWNER';}
    else{roleLabel.style.display='none';}
    adminLink.style.display=currentUser.role==='owner'?'inline-block':'none';
  }else{
    guest.style.display='inline-block';user.style.display='none';
    adminLink.style.display='none';
  }
}
async function checkAuthStatus(){
  try{
    const res=await fetch(WORKER_BASE+'/api/auth/me',{credentials:'include'});
    const data=await res.json();
    currentUser=data.user||null;
  }catch(e){currentUser=null;}
  updateAccountUI();renderCards();updateNewsFabStyle();refreshGuestTimer();
}

function openUserPanel(){
  if(!currentUser)return;
  document.getElementById('up-username-display').innerHTML='👤 '+escHtml(currentUser.username)+' '+tierTickHtml(currentUser);
  document.getElementById('up-tier-badge').innerHTML=tierLabel(currentUser);
  document.getElementById('up-avatar-big').innerHTML=avatarHtml(currentUser);
  document.getElementById('avatar-error').textContent='';
  document.getElementById('cp-current').value='';
  document.getElementById('cp-new').value='';
  document.getElementById('cp-error').textContent='';
  document.getElementById('trust-code-input').value='';
  document.getElementById('trust-code-error').textContent='';
  document.getElementById('city-search-input').value='';
  document.getElementById('city-search-results').classList.remove('show');

  const subSec=document.getElementById('up-sub-section');
  const vipSec=document.getElementById('up-vip-section');
  const uploadSec=document.getElementById('up-upload-section');
  const isOwnerOrVip = currentUser.role==='owner' || currentUser.tier==='vip';

  if(currentUser.role==='owner'){subSec.style.display='none';vipSec.style.display='none';}
  else if(currentUser.tier==='vip'){subSec.style.display='none';vipSec.style.display='none';}
  else if(currentUser.tier==='sub'){subSec.style.display='none';vipSec.style.display='block';}
  else{subSec.style.display='block';vipSec.style.display='block';}

  uploadSec.style.display = isOwnerOrVip ? 'block' : 'none';
  if(isOwnerOrVip) loadUploadsList();

  renderCurrentCity();renderFavoritesList();loadPaymentInfo();
  document.getElementById('user-panel-modal').classList.add('open');
}
function closeUserPanel(e){
  if(e&&e.target!==document.getElementById('user-panel-modal'))return;
  document.getElementById('user-panel-modal').classList.remove('open');
}
function renderFavoritesList(){
  const wrap=document.getElementById('up-favorites-list');
  const favs=(currentUser?.favorites||[]).map(id=>channels.find(c=>c.id===id)).filter(Boolean);
  if(!favs.length){wrap.innerHTML='<div class="up-fav-empty">هنوز کانالی اضافه نشده</div>';return;}
  wrap.innerHTML=favs.map(ch=>\`<div class="up-fav-item"><span>\${ch.icon||'📺'}</span><span>\${escHtml(ch.name)}</span><button onclick="toggleFavorite('\${ch.id}')">حذف</button></div>\`).join('');
}
function renderCurrentCity(){
  const el=document.getElementById('current-city-display');
  if(currentUser&&currentUser.city){el.textContent='📍 شهر فعلی: '+currentUser.city.name;}
  else{el.textContent='هنوز شهری انتخاب نشده';}
}

async function onAvatarFileSelected(e){
  const file=e.target.files[0];if(!file)return;
  const errEl=document.getElementById('avatar-error');errEl.textContent='';
  const fd=new FormData();fd.append('file',file);
  try{
    const res=await fetch(WORKER_BASE+'/api/profile/avatar',{method:'POST',credentials:'include',body:fd});
    const data=await res.json();
    if(!res.ok){errEl.textContent=data.error||'خطا در آپلود عکس';return;}
    currentUser.avatarUrl=data.avatarUrl+'?t='+Date.now();
    document.getElementById('up-avatar-big').innerHTML=avatarHtml(currentUser);
    document.getElementById('account-avatar').innerHTML=avatarHtml(currentUser);
    showToast('عکس پروفایل بروزرسانی شد ✓');
  }catch(err){errEl.textContent='خطا در ارتباط با سرور';}
  e.target.value='';
}

async function onUploadFileSelected(e){
  const file=e.target.files[0];if(!file)return;
  const errEl=document.getElementById('upload-error');errEl.textContent='';
  const wrap=document.getElementById('upload-progress-wrap');
  const bar=document.getElementById('upload-progress-bar');
  wrap.style.display='block';bar.style.width='20%';
  const fd=new FormData();fd.append('file',file);
  try{
    bar.style.width='60%';
    const res=await fetch(WORKER_BASE+'/api/uploads/upload',{method:'POST',credentials:'include',body:fd});
    bar.style.width='100%';
    const data=await res.json();
    if(!res.ok){errEl.textContent=data.error||'خطا در آپلود فایل';setTimeout(()=>wrap.style.display='none',400);return;}
    showToast('فایل آپلود شد ✓');
    setTimeout(()=>{wrap.style.display='none';bar.style.width='0%';},500);
    loadUploadsList();
  }catch(err){errEl.textContent='خطا در ارتباط با سرور';wrap.style.display='none';}
  e.target.value='';
}
function fmtBytes(n){
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
  return (n/1024/1024).toFixed(1)+' MB';
}
async function loadUploadsList(){
  const wrap=document.getElementById('up-file-list');
  try{
    const res=await fetch(WORKER_BASE+'/api/uploads/list',{credentials:'include'});
    const data=await res.json();
    const files=data.files||[];
    if(!files.length){wrap.innerHTML='<div class="up-file-empty">هنوز فایلی آپلود نشده</div>';return;}
    wrap.innerHTML=files.map(f=>\`<div class="up-file-item">
      <span class="up-file-name" title="\${escHtml(f.name)}">📄 \${escHtml(f.name)}</span>
      <span class="up-file-size">\${fmtBytes(f.size||0)}</span>
      <a href="/api/uploads/file/\${f.id}" target="_blank" rel="noopener">دانلود</a>
      <button onclick="deleteUpload('\${f.id}')">حذف</button>
    </div>\`).join('');
  }catch(e){wrap.innerHTML='<div class="up-file-empty">خطا در بارگذاری فایل‌ها</div>';}
}
async function deleteUpload(fileId){
  try{
    const res=await fetch(WORKER_BASE+'/api/uploads/delete',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId})});
    if(res.ok){showToast('فایل حذف شد ✓');loadUploadsList();}else{const d=await res.json();showToast(d.error||'خطا ❌');}
  }catch(e){showToast('خطا در ارتباط با سرور ❌');}
}

async function loadPaymentInfo(){
  try{
    const res=await fetch(WORKER_BASE+'/api/payment-info');
    const data=await res.json();
    document.getElementById('payment-card-content').innerHTML=\`
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:4px;">قیمت اشتراک: <strong style="color:var(--text);">\${escHtml(data.subPrice||'10')} \${escHtml(data.currency||'USDT TRC20')}</strong></div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">آدرس کیف پول ترون (TRC20):</div>
      <div class="payment-address" onclick="copyText('\${escHtml(data.tronAddress)}',this)" title="کلیک برای کپی">\${escHtml(data.tronAddress)}</div>
      <div class="payment-note">\${escHtml(data.instructions||'')}</div>
    \`;
  }catch(e){
    document.getElementById('payment-card-content').innerHTML='<div style="font-size:12px;color:var(--red);">خطا در بارگذاری اطلاعات پرداخت</div>';
  }
}

function copyText(text, el){
  navigator.clipboard.writeText(text).catch(()=>{});
  const orig=el.textContent;el.textContent='کپی شد ✓';setTimeout(()=>el.textContent=orig,1500);
}

async function submitTrustCode(){
  const code=document.getElementById('trust-code-input').value.trim();
  const errEl=document.getElementById('trust-code-error');
  errEl.textContent='';
  if(!code){errEl.textContent='کد را وارد کن';return;}
  try{
    const res=await fetch(WORKER_BASE+'/api/verify',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const data=await res.json();
    if(!res.ok){errEl.textContent=data.error||'خطا';return;}
    currentUser.tier='vip';
    closeUserPanel(null);updateAccountUI();renderCards();updateNewsFabStyle();
    showToast('🌟 دسترسی VIP فعال شد!');
  }catch(e){errEl.textContent='خطا در ارتباط با سرور';}
}

async function submitChangePassword(){
  const cur=document.getElementById('cp-current').value;
  const nw=document.getElementById('cp-new').value;
  const errEl=document.getElementById('cp-error');
  errEl.textContent='';
  if(!cur||!nw){errEl.textContent='هر دو فیلد را پر کن';return;}
  try{
    const res=await fetch(WORKER_BASE+'/api/auth/change-password',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cur,newPassword:nw})});
    const data=await res.json();
    if(!res.ok){errEl.textContent=data.error||'خطا';return;}
    document.getElementById('cp-current').value='';document.getElementById('cp-new').value='';
    showToast('رمز تغییر کرد ✓');
  }catch(e){errEl.textContent='خطا در ارتباط با سرور';}
}

let citySearchTimer=null;
function onCitySearchInput(){
  clearTimeout(citySearchTimer);
  const q=document.getElementById('city-search-input').value.trim();
  const resultsEl=document.getElementById('city-search-results');
  if(q.length<2){resultsEl.classList.remove('show');return;}
  citySearchTimer=setTimeout(async()=>{
    try{
      const res=await fetch(WORKER_BASE+'/api/weather/search-city?q='+encodeURIComponent(q),{credentials:'include'});
      const data=await res.json();
      const results=data.results||[];
      if(!results.length){resultsEl.innerHTML='<div class="city-result-item" style="color:var(--muted)">شهری یافت نشد</div>';resultsEl.classList.add('show');return;}
      resultsEl.innerHTML=results.map(r=>\`<div class="city-result-item" onclick='selectCity(\${JSON.stringify(r).replace(/'/g,"&#39;")})'>📍 \${escHtml(r.name)}\${r.admin1?'، '+escHtml(r.admin1):''}\${r.country?'، '+escHtml(r.country):''}</div>\`).join('');
      resultsEl.classList.add('show');
    }catch(e){}
  },350);
}
async function selectCity(r){
  const city={name:r.name,lat:r.lat,lon:r.lon};
  try{
    const res=await fetch(WORKER_BASE+'/api/auth/set-city',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({city})});
    if(res.ok){currentUser.city=city;document.getElementById('city-search-input').value='';document.getElementById('city-search-results').classList.remove('show');renderCurrentCity();showToast('شهر ثبت شد ✓');loadWeather();}
  }catch(e){}
}
document.addEventListener('click',e=>{const w=document.querySelector('.city-search-wrap');const r=document.getElementById('city-search-results');if(r&&w&&!w.contains(e.target))r.classList.remove('show');});

const WEATHER_ICONS={0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌦️',61:'🌧️',63:'🌧️',65:'🌧️',71:'🌨️',73:'🌨️',75:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',95:'⛈️',96:'⛈️',99:'⛈️'};
async function loadWeather(){
  const widget=document.getElementById('weather-widget');
  widget.classList.remove('err');
  document.getElementById('weather-icon').textContent='⏳';
  try{
    const res=await fetch(WORKER_BASE+'/api/weather/current',{credentials:'include'});
    let data;
    try{ data=await res.json(); }catch(e){ throw new Error('invalid-json'); }
    if(!res.ok || data.temperature===undefined || data.temperature===null){
      widget.classList.add('err');
      document.getElementById('weather-icon').textContent='⚠️';
      document.getElementById('weather-temp').textContent='—';
      document.getElementById('weather-city').textContent=data.error?'':'نامشخص';
      return;
    }
    document.getElementById('weather-icon').textContent=WEATHER_ICONS[data.weatherCode]||'🌡️';
    document.getElementById('weather-temp').textContent=Math.round(data.temperature)+'°C';
    document.getElementById('weather-city').textContent=data.city||'';
  }catch(e){
    widget.classList.add('err');
    document.getElementById('weather-icon').textContent='⚠️';
    document.getElementById('weather-temp').textContent='—';
    document.getElementById('weather-city').textContent='خطا';
  }
}

let activeChatFriend = null;
let chatPollingInterval = null;
let friendsData = { friends: [], requests: [] };

function openFriendsModal() {
  if (!currentUser) { openAuthModal('login'); return; }
  document.getElementById('friends-view').style.display = 'block';
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('friends-modal-title').textContent = '💬 دوستان من';
  document.getElementById('add-friend-error').textContent = '';
  document.getElementById('add-friend-success').textContent = '';
  document.getElementById('friends-modal').classList.add('open');
  loadFriendsList();
}
function closeFriendsModal(e) {
  if (e && e.target !== document.getElementById('friends-modal')) return;
  document.getElementById('friends-modal').classList.remove('open');
  clearInterval(chatPollingInterval);
  activeChatFriend = null;
}
function switchFriendsTab(tab) {
  ['friends','requests','add'].forEach(t => {
    document.getElementById('ftab-' + t).classList.toggle('active', t === tab);
    document.getElementById('ftab-' + t + '-content').style.display = t === tab ? 'block' : 'none';
  });
}
async function loadFriendsList() {
  try {
    const res = await fetch(WORKER_BASE + '/api/friends/list', { credentials: 'include' });
    if (!res.ok) return;
    friendsData = await res.json();
    renderFriendsTab();
    renderRequestsTab();
    const cnt = (friendsData.requests || []).length;
    const badge = document.getElementById('req-count-badge');
    const btnLabel = document.getElementById('friends-panel-btn-label');
    if (cnt > 0) {
      badge.style.display = 'inline-flex';
      badge.textContent = cnt;
      if (btnLabel) btnLabel.innerHTML = '<span class="friends-notif-dot"></span>دوستان و چت (' + cnt + ' درخواست)';
    } else {
      badge.style.display = 'none';
      if (btnLabel) btnLabel.textContent = 'مشاهده دوستان و چت';
    }
  } catch (e) {}
}
function renderFriendsTab() {
  const wrap = document.getElementById('friends-list-container');
  const friends = friendsData.friends || [];
  if (!friends.length) {
    wrap.innerHTML = '<div class="friends-empty">هنوز دوستی اضافه نکرده‌اید 🙁<br><small style="color:var(--muted)">از تب «افزودن دوست» شروع کنید</small></div>';
    return;
  }
  wrap.innerHTML = friends.map(fr => \`
    <div class="friend-item">
      <div class="friend-avatar">👤</div>
      <div class="friend-info"><div class="friend-name">\${escHtml(fr)}</div></div>
      <div class="friend-actions">
        <button class="btn-chat-open" onclick="openChatWith('\${escHtml(fr)}')">💬 چت</button>
        <button class="btn-remove-friend" onclick="removeFriend('\${escHtml(fr)}')">✕</button>
      </div>
    </div>
  \`).join('');
}
function renderRequestsTab() {
  const wrap = document.getElementById('requests-list-container');
  const reqs = friendsData.requests || [];
  if (!reqs.length) {
    wrap.innerHTML = '<div class="friends-empty">هیچ درخواست جدیدی ندارید</div>';
    return;
  }
  wrap.innerHTML = reqs.map(req => \`
    <div class="friend-item">
      <div class="friend-avatar">👤</div>
      <div class="friend-info"><div class="friend-name">\${escHtml(req)}</div><div style="font-size:11px;color:var(--muted);">درخواست دوستی فرستاده</div></div>
      <div class="friend-actions">
        <button class="btn-accept-friend" onclick="acceptFriendReq('\${escHtml(req)}')">✓ قبول</button>
        <button class="btn-reject-friend" onclick="rejectFriendReq('\${escHtml(req)}')">رد</button>
      </div>
    </div>
  \`).join('');
}
async function sendFriendRequest() {
  const inp = document.getElementById('add-friend-input');
  const errEl = document.getElementById('add-friend-error');
  const okEl = document.getElementById('add-friend-success');
  const username = inp.value.trim();
  errEl.textContent = ''; okEl.textContent = '';
  if (!username) { errEl.textContent = 'نام کاربری را وارد کن'; return; }
  try {
    const res = await fetch(WORKER_BASE + '/api/friends/request', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUsername: username })
    });
    const data = await res.json();
    if (res.ok) { okEl.textContent = '✓ درخواست دوستی ارسال شد'; inp.value = ''; }
    else { errEl.textContent = data.error || 'خطا'; }
  } catch (e) { errEl.textContent = 'خطا در ارتباط با سرور'; }
}
async function acceptFriendReq(username) {
  try {
    const res = await fetch(WORKER_BASE + '/api/friends/accept', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUsername: username })
    });
    if (res.ok) { showToast('✓ دوست شدید!'); await loadFriendsList(); }
    else { const d = await res.json(); showToast(d.error || 'خطا ❌'); }
  } catch (e) {}
}
async function rejectFriendReq(username) {
  try {
    const res = await fetch(WORKER_BASE + '/api/friends/reject', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUsername: username })
    });
    if (res.ok) { showToast('درخواست رد شد'); await loadFriendsList(); }
  } catch (e) {}
}
async function removeFriend(username) {
  if (!confirm('«' + username + '» از لیست دوستان حذف شود؟')) return;
  try {
    const res = await fetch(WORKER_BASE + '/api/friends/remove', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUsername: username })
    });
    if (res.ok) { showToast('از لیست دوستان حذف شد'); await loadFriendsList(); }
  } catch (e) {}
}
function openChatWith(friend) {
  activeChatFriend = friend;
  document.getElementById('friends-view').style.display = 'none';
  document.getElementById('chat-view').style.display = 'block';
  document.getElementById('friends-modal-title').textContent = '💬 چت';
  document.getElementById('chat-with-label').innerHTML = '👤 ' + escHtml(friend);
  document.getElementById('chat-input').value = '';
  loadChatHistory();
  clearInterval(chatPollingInterval);
  chatPollingInterval = setInterval(loadChatHistory, 3000);
}
function backToFriendsList() {
  clearInterval(chatPollingInterval);
  activeChatFriend = null;
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('friends-view').style.display = 'block';
  document.getElementById('friends-modal-title').textContent = '💬 دوستان من';
}
async function loadChatHistory() {
  if (!activeChatFriend) return;
  try {
    const res = await fetch(WORKER_BASE + '/api/chat/history?friend=' + encodeURIComponent(activeChatFriend), { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    renderChatMessages(data.messages || []);
  } catch (e) {}
}
function renderChatMessages(messages) {
  const box = document.getElementById('chat-box');
  const wasAtBottom = box.scrollHeight - box.clientHeight <= box.scrollTop + 30;
  if (!messages.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:12.5px;padding:2rem 0;">اولین پیام را بفرستید 👋</div>';
    return;
  }
  box.innerHTML = messages.map(msg => {
    const isMe = msg.from.toLowerCase() === currentUser.username.toLowerCase();
    const cls = isMe ? 'msg-me' : 'msg-friend';
    const t = new Date(msg.time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    return \`<div class="msg-bubble \${cls}">\${escHtml(msg.text)}<span class="msg-time">\${t}</span></div>\`;
  }).join('');
  if (wasAtBottom) box.scrollTop = box.scrollHeight;
}
async function sendChatMessage() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text || !activeChatFriend) return;
  inp.value = '';
  try {
    const res = await fetch(WORKER_BASE + '/api/chat/send', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friend: activeChatFriend, text })
    });
    const data = await res.json();
    if (res.ok) {
      renderChatMessages(data.messages || []);
      const box = document.getElementById('chat-box');
      box.scrollTop = box.scrollHeight;
    } else {
      showToast(data.error || 'خطا در ارسال پیام ❌');
    }
  } catch (e) { showToast('خطا در ارتباط با سرور ❌'); }
}

renderCatBar();
renderCards();
checkAuthStatus();
loadWeather();
updateNewsFabStyle();
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// HTML پنل مدیریت — با آمار بازدید + پشتیبان‌گیری + تلگرام
// ═══════════════════════════════════════════════════════════════
function getAdminHTML(workerOrigin) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StreamFa — پنل مدیریت</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#0b0d10;--bg2:#13161c;--bg3:#1c2029;--bg4:#232835;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --accent:#e8ff47;--accent2:#c8e000;--text:#f0f2f5;--text2:#a8b0be;--muted:#5a6070;
  --red:#ff4d4d;--red-bg:rgba(255,77,77,0.1);--green:#3ddc84;--green-bg:rgba(61,220,132,0.1);
  --orange:#ffaa33;--orange-bg:rgba(255,170,51,0.1);--blue:#4da6ff;--blue-bg:rgba(77,166,255,0.1);
  --gold:#ffcc00;--gold-bg:rgba(255,204,0,0.1);
  --r:12px;--r2:8px;--sidebar:220px;
}
body{font-family:'Vazirmatn',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;direction:rtl;}
.sidebar{width:var(--sidebar);flex-shrink:0;background:var(--bg2);border-left:1px solid var(--border);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;}
.sidebar-logo{padding:1.25rem 1.25rem 0.5rem;display:flex;align-items:center;gap:10px;}
.logo-mark{width:32px;height:32px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.logo-text{font-size:15px;font-weight:700;}
.logo-sub{font-size:10px;color:var(--muted);}
.sidebar-section{padding:1rem 0.75rem 0.25rem;font-size:10px;letter-spacing:1px;color:var(--muted);text-transform:uppercase;}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 1rem;margin:1px 0.5rem;border-radius:var(--r2);font-size:13px;color:var(--text2);cursor:pointer;transition:all 0.15s;border:none;background:transparent;width:calc(100% - 1rem);font-family:inherit;text-align:right;}
.nav-item:hover{background:var(--bg3);color:var(--text);}
.nav-item.active{background:rgba(232,255,71,0.1);color:var(--accent);font-weight:600;}
.sidebar-footer{margin-top:auto;padding:1rem;border-top:1px solid var(--border);}
.worker-status{background:var(--bg3);border-radius:var(--r2);padding:10px 12px;}
.worker-label{font-size:11px;color:var(--muted);margin-bottom:4px;}
.worker-url{font-size:11px;color:var(--text2);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;}
.status-row{display:flex;align-items:center;gap:6px;margin-top:6px;}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:blink 1.8s ease-in-out infinite;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:0.3;}}
.main{flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden;}
.topbar{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 1.5rem;border-bottom:1px solid var(--border);background:rgba(11,13,16,0.8);backdrop-filter:blur(12px);position:sticky;top:0;z-index:50;}
.page-title{font-size:16px;font-weight:600;}
.topbar-actions{display:flex;gap:8px;align-items:center;}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:var(--r2);font-family:inherit;font-size:13px;cursor:pointer;transition:all 0.15s;border:1px solid transparent;}
.btn-primary{background:var(--accent);color:#0b0d10;border-color:var(--accent);font-weight:700;}
.btn-primary:hover{background:var(--accent2);}
.btn-ghost{background:transparent;border-color:var(--border);color:var(--text2);}
.btn-ghost:hover{border-color:var(--border2);color:var(--text);background:var(--bg3);}
.btn-danger{background:var(--red-bg);border-color:rgba(255,77,77,0.3);color:var(--red);}
.btn-danger:hover{background:rgba(255,77,77,0.18);}
.btn-blue{background:var(--blue-bg);border-color:rgba(77,166,255,0.3);color:var(--blue);}
.btn-blue:hover{background:rgba(77,166,255,0.18);}
.btn-gold{background:var(--gold-bg);border-color:rgba(255,204,0,0.3);color:var(--gold);}
.btn-gold:hover{background:rgba(255,204,0,0.18);}
.btn-tg{background:rgba(41,182,246,0.12);border-color:rgba(41,182,246,0.3);color:#29b6f6;}
.btn-tg:hover{background:rgba(41,182,246,0.2);}
.btn-sm{padding:6px 10px;font-size:12px;}
.content{flex:1;padding:1.5rem;overflow-y:auto;}
.section{display:none;}
.section.active{display:block;}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:1.5rem;}
.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1rem 1.25rem;position:relative;overflow:hidden;}
.stat-card::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;}
.stat-card.green::after{background:var(--green);}
.stat-card.red::after{background:var(--red);}
.stat-card.orange::after{background:var(--orange);}
.stat-card.blue::after{background:var(--blue);}
.stat-card.gold::after{background:var(--gold);}
.stat-label{font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;}
.stat-val{font-size:28px;font-weight:700;line-height:1;}
.stat-sub{font-size:11px;color:var(--muted);margin-top:4px;}
.table-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;}
.table-toolbar{display:flex;align-items:center;gap:10px;padding:1rem 1.25rem;border-bottom:1px solid var(--border);flex-wrap:wrap;}
.search-box{flex:1;min-width:180px;position:relative;}
.search-box input{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);padding:8px 12px;color:var(--text);font-family:inherit;font-size:13px;outline:none;}
.search-box input:focus{border-color:var(--border2);}
.search-box input::placeholder{color:var(--muted);}
table{width:100%;border-collapse:collapse;}
thead tr{border-bottom:1px solid var(--border);}
th{text-align:right;padding:10px 1.25rem;font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.4px;text-transform:uppercase;white-space:nowrap;}
td{padding:12px 1.25rem;font-size:13px;border-bottom:1px solid var(--border);vertical-align:middle;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(255,255,255,0.02);}
.ch-cell{display:flex;align-items:center;gap:10px;}
.ch-icon-sm{width:34px;height:34px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}
.ch-name-sm{font-weight:500;font-size:13px;}
.ch-id-sm{font-size:11px;color:var(--muted);font-family:monospace;}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 9px;border-radius:20px;font-weight:500;white-space:nowrap;}
.badge-dot{width:5px;height:5px;border-radius:50%;background:currentColor;}
.b-live{background:var(--green-bg);color:var(--green);}
.b-error{background:var(--red-bg);color:var(--red);}
.b-warn{background:var(--orange-bg);color:var(--orange);}
.b-sub{background:var(--blue-bg);color:var(--blue);}
.b-vip{background:var(--gold-bg);color:var(--gold);}
.b-none{background:var(--bg3);color:var(--muted);}
.url-cell{font-size:11px;color:var(--muted);font-family:monospace;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.actions-cell{display:flex;gap:6px;flex-wrap:wrap;}
.views-cell{display:flex;flex-direction:column;gap:3px;min-width:100px;}
.views-bar-wrap{background:var(--bg3);border-radius:20px;height:5px;overflow:hidden;width:100%;}
.views-bar{height:100%;background:var(--accent);border-radius:20px;transition:width 0.4s;}
.views-nums{font-size:11px;color:var(--muted);font-family:monospace;display:flex;gap:8px;}
.views-today{color:var(--green);}
.rank-cell{font-weight:700;color:var(--muted);font-family:monospace;width:32px;text-align:center;}
.rank-cell.top1{color:var(--gold);}
.rank-cell.top2{color:#c0c0c0;}
.rank-cell.top3{color:#cd7f32;}
.form-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1.5rem;}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;}
.form-group{display:flex;flex-direction:column;gap:6px;}
.form-group.full{grid-column:1/-1;}
label{font-size:12px;color:var(--text2);}
input[type=text],select,textarea{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);padding:9px 12px;color:var(--text);font-family:inherit;font-size:13px;outline:none;transition:border-color .2s;}
input[type=text]:focus,select:focus,textarea:focus{border-color:rgba(232,255,71,0.4);}
input[type=text]::placeholder,textarea::placeholder{color:var(--muted);}
select option{background:var(--bg3);}
textarea{resize:vertical;min-height:80px;}
.field-error{font-size:11px;color:var(--red);display:none;}
.icon-picker{display:flex;gap:6px;flex-wrap:wrap;}
.icon-opt{width:36px;height:36px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;transition:all .15s;}
.icon-opt:hover,.icon-opt.selected{border-color:var(--accent);background:rgba(232,255,71,0.08);}
.form-actions{display:flex;gap:10px;justify-content:flex-end;padding-top:1rem;border-top:1px solid var(--border);}
.overlay{display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.75);align-items:center;justify-content:center;padding:1rem;}
.overlay.open{display:flex;}
.modal-box{background:var(--bg2);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:480px;overflow:hidden;}
.modal-hdr{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;border-bottom:1px solid var(--border);}
.modal-hdr h3{font-size:15px;font-weight:600;}
.modal-close-btn{background:var(--bg3);border:none;width:30px;height:30px;border-radius:8px;color:var(--muted);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;}
.modal-close-btn:hover{color:var(--text);}
.modal-body{padding:1.25rem;}
.modal-footer{padding:.75rem 1.25rem;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--text);color:var(--bg);border-radius:10px;padding:10px 20px;font-size:13px;font-weight:600;z-index:999;transition:transform .3s ease;pointer-events:none;}
.toast.show{transform:translateX(-50%) translateY(0);}
.tbl-empty td{text-align:center;padding:3rem;color:var(--muted);}
.health-toolbar{display:flex;gap:10px;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid var(--border);flex-wrap:wrap;}
.hc-spin{display:inline-block;width:14px;height:14px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
.health-summary{display:flex;gap:16px;font-size:13px;flex-wrap:wrap;align-items:center;}
.hc-stat{display:flex;align-items:center;gap:6px;}
.hc-dot{width:8px;height:8px;border-radius:50%;}
.hc-badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;min-width:50px;text-align:center;}
.hc-live{background:var(--green-bg);color:var(--green);}
.hc-error{background:var(--red-bg);color:var(--red);}
.hc-pending{background:var(--bg3);color:var(--muted);}
.hc-checking{background:rgba(232,255,71,.1);color:var(--accent);}
.hc-latency{font-size:12px;font-family:monospace;min-width:60px;}
.hc-latency.good{color:var(--green);}
.hc-latency.slow{color:var(--orange);}
.hc-latency.bad{color:var(--red);}
.user-row-tier{display:flex;gap:6px;align-items:center;}
.tier-select{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--text);font-family:inherit;font-size:12px;outline:none;}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:1.5rem;}
.cat-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1rem;display:flex;align-items:center;gap:10px;}
.cat-icon-big{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
.cat-info{flex:1;min-width:0;}
.cat-name-disp{font-size:14px;font-weight:600;margin-bottom:2px;}
.cat-count-disp{font-size:12px;color:var(--muted);}
.color-row{display:flex;gap:8px;flex-wrap:wrap;}
.color-opt{width:28px;height:28px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:all .15s;}
.color-opt:hover,.color-opt.selected{border-color:#fff;transform:scale(1.15);}
.import-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-bottom:1.25rem;}
.import-card-header{padding:1rem 1.25rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;}
.import-card-header h3{font-size:14px;font-weight:600;}
.import-card-body{padding:1.25rem;}
.tab-row{display:flex;gap:4px;background:var(--bg3);border-radius:var(--r2);padding:4px;margin-bottom:1.25rem;}
.tab-btn{flex:1;padding:8px;border:none;border-radius:6px;font-family:inherit;font-size:13px;cursor:pointer;background:transparent;color:var(--text2);transition:all .15s;}
.tab-btn.active{background:var(--bg2);color:var(--text);font-weight:600;}
.drop-zone{border:2px dashed var(--border2);border-radius:var(--r);padding:2.5rem;text-align:center;cursor:pointer;transition:all .2s;background:var(--bg3);}
.drop-zone:hover,.drop-zone.drag-over{border-color:var(--accent);background:rgba(232,255,71,0.04);}
#file-input{display:none;}
.progress-bar-wrap{background:var(--bg3);border-radius:20px;height:6px;overflow:hidden;margin:12px 0;}
.progress-bar{height:100%;background:var(--accent);width:0%;transition:width .3s;}
.group-filter-row{display:flex;gap:6px;flex-wrap:wrap;padding:1rem 1.25rem;border-bottom:1px solid var(--border);background:var(--bg3);}
.group-chip{padding:5px 12px;border-radius:20px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--bg2);color:var(--text2);transition:all .15s;}
.group-chip.active{background:var(--accent);color:#0b0d10;border-color:var(--accent);font-weight:700;}
.import-table-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;}
.import-summary{display:flex;align-items:center;gap:16px;padding:.75rem 1.25rem;background:var(--bg3);border-bottom:1px solid var(--border);font-size:13px;flex-wrap:wrap;}
.imp-count{font-weight:700;color:var(--accent);}
.imp-label{color:var(--muted);}
.sel-all-btn{margin-right:auto;background:transparent;border:1px solid var(--border);border-radius:6px;padding:5px 12px;color:var(--text2);font-size:12px;cursor:pointer;font-family:inherit;}
.bulk-cat-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:.85rem 1.25rem;border-bottom:1px solid var(--border);background:rgba(232,255,71,0.04);}
.bulk-cat-label{font-size:12.5px;color:var(--text2);font-weight:600;white-space:nowrap;}
.bulk-cat-row select{background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:7px 10px;color:var(--text);font-family:inherit;font-size:12.5px;outline:none;}
.imp-cat-select{background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:5px 8px;color:var(--text);font-family:inherit;font-size:11.5px;outline:none;max-width:130px;flex-shrink:0;}
.import-ch-row{display:flex;align-items:center;gap:10px;padding:10px 1.25rem;border-bottom:1px solid var(--border);}
.import-ch-row:last-child{border-bottom:none;}
.import-ch-row:hover{background:rgba(255,255,255,.02);}
.import-ch-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;}
.imp-logo{width:32px;height:32px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;overflow:hidden;}
.imp-logo img{width:100%;height:100%;object-fit:cover;}
.imp-ch-name{font-size:13px;font-weight:500;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.import-actions{display:flex;gap:10px;padding:1rem 1.25rem;border-top:1px solid var(--border);background:var(--bg3);align-items:center;}
.import-result{font-size:13px;color:var(--text2);}
.log-row{display:flex;align-items:center;gap:12px;padding:10px 1.25rem;border-bottom:1px solid var(--border);font-size:12.5px;}
.log-row:last-child{border-bottom:none;}
.log-user{font-weight:600;min-width:100px;}
.log-arrow{color:var(--muted);}
.log-source{font-size:11px;color:var(--muted);font-style:italic;}
.log-time{font-size:11px;color:var(--muted);margin-right:auto;}
.views-hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:1.5rem;}
.tg-status-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1.25rem;margin-bottom:1.25rem;}
.tg-status-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
.tg-indicator{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
.tg-indicator.on{background:var(--green);}
.tg-indicator.off{background:var(--muted);}
.backup-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1.5rem;margin-bottom:1.25rem;}
.backup-card-title{font-size:14px;font-weight:600;margin-bottom:12px;}
.backup-actions{display:flex;gap:10px;flex-wrap:wrap;}
.backup-note{font-size:12px;color:var(--muted);margin-top:10px;line-height:1.6;}
.drop-zone-import{border:2px dashed var(--border2);border-radius:var(--r);padding:2rem;text-align:center;cursor:pointer;transition:all .2s;background:var(--bg3);font-size:13px;color:var(--muted);}
.drop-zone-import:hover{border-color:var(--accent);color:var(--text);}
.drop-zone-import.drag-over{border-color:var(--accent);background:rgba(232,255,71,0.04);}
.backup-result-box{margin-top:1rem;background:var(--bg3);border-radius:10px;padding:1rem;font-size:12.5px;color:var(--text2);line-height:1.8;display:none;}
@media(max-width:700px){.sidebar{display:none;}.form-grid{grid-template-columns:1fr;}}
</style>
</head>
<body>

<aside class="sidebar">
  <div class="sidebar-logo">
    <div class="logo-mark">▶</div>
    <div><div class="logo-text">StreamFa</div><div class="logo-sub">پنل مدیریت</div></div>
  </div>
  <div class="sidebar-section">منو</div>
  <button class="nav-item active" onclick="goto('channels',this)">📺 کانال‌ها</button>
  <button class="nav-item" onclick="goto('add',this)">➕ افزودن کانال</button>
  <button class="nav-item" onclick="goto('import',this)">📥 Import پلی‌لیست</button>
  <button class="nav-item" onclick="goto('health',this)">💓 بررسی سلامت</button>
  <button class="nav-item" onclick="goto('categories',this)">📂 دسته‌بندی‌ها</button>
  <button class="nav-item" onclick="goto('views',this)">📊 آمار بازدید</button>
  <button class="nav-item" onclick="goto('users',this)">👥 مدیریت کاربران</button>
  <button class="nav-item" onclick="goto('payment',this)">💳 تنظیمات پرداخت</button>
  <button class="nav-item" onclick="goto('telegram',this)">🤖 تلگرام</button>
  <button class="nav-item" onclick="goto('backup',this)">💾 پشتیبان‌گیری</button>
  <button class="nav-item" onclick="goto('logs',this)">📋 لاگ تغییرات</button>
  <div class="sidebar-section">لینک‌ها</div>
  <button class="nav-item" onclick="window.location.href='/'">↗ صفحه کاربری</button>
  <div class="sidebar-footer">
    <div class="worker-status">
      <div class="worker-label">آدرس Worker</div>
      <div class="worker-url" id="worker-url-display"></div>
      <div class="status-row"><div class="live-dot"></div><span style="font-size:11px;color:var(--green);">متصل به KV</span></div>
    </div>
  </div>
</aside>

<main class="main">
  <div class="topbar">
    <div class="page-title" id="page-title">کانال‌ها</div>
    <div class="topbar-actions">
      <button class="btn btn-primary btn-sm" onclick="goto('add',document.querySelectorAll('.nav-item')[1])">➕ کانال جدید</button>
    </div>
  </div>
  <div class="content">

    <!-- ── کانال‌ها ── -->
    <div class="section active" id="sec-channels">
      <div class="stats-row" id="stats-row"></div>
      <div class="table-wrap">
        <div class="table-toolbar">
          <div class="search-box"><input type="text" id="tbl-search" placeholder="جستجو..." oninput="renderTable()"></div>
          <select id="tbl-filter" onchange="renderTable()"><option value="all">همه وضعیت‌ها</option><option value="live">فعال</option><option value="error">خطا</option></select>
          <select id="tbl-cat-filter" onchange="renderTable()"><option value="all">همه دسته‌ها</option></select>
          <select id="tbl-access-filter" onchange="renderTable()"><option value="all">همه سطوح</option><option value="public">عمومی</option><option value="sub">اشتراک</option><option value="vip">VIP</option></select>
        </div>
        <div class="bulk-cat-row" id="bulk-delete-row" style="display:none;">
          <span class="bulk-cat-label" id="bulk-selected-count">۰ کانال انتخاب شده</span>
          <button class="btn btn-danger btn-sm" onclick="bulkDeleteSelected()">🗑 حذف انتخاب‌شده‌ها</button>
          <button class="btn btn-ghost btn-sm" onclick="clearChannelSelection()">لغو انتخاب</button>
        </div>
        <div style="overflow-x:auto;">
          <table>
            <thead><tr><th style="width:34px;"><input type="checkbox" id="ch-select-all" onchange="onSelectAllChannels(this)"></th><th>کانال</th><th>وضعیت</th><th>سطح دسترسی</th><th>دسته</th><th>آدرس</th><th>عملیات</th></tr></thead>
            <tbody id="ch-tbody"><tr><td colspan="7" style="text-align:center;padding:3rem;color:var(--muted);">در حال بارگذاری...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── افزودن/ویرایش کانال ── -->
    <div class="section" id="sec-add">
      <div class="form-card">
        <div style="margin-bottom:1.25rem;">
          <div style="font-size:15px;font-weight:600;margin-bottom:4px;" id="form-heading">افزودن کانال جدید</div>
          <div style="font-size:13px;color:var(--text2);">اطلاعات کانال در دیتابیس KV ذخیره می‌شود</div>
        </div>
        <div class="form-grid">
          <div class="form-group"><label>شناسه (ID)</label><input type="text" id="f-id" placeholder="مثلاً 5001" oninput="validateAddForm()"><span class="field-error" id="e-id">این شناسه قبلاً ثبت شده</span></div>
          <div class="form-group"><label>نام کانال</label><input type="text" id="f-name" placeholder="مثلاً BBC News" oninput="validateAddForm()"><span class="field-error" id="e-name">نام الزامی است</span></div>
          <div class="form-group full"><label>آدرس Base URL</label><input type="text" id="f-url" placeholder="https://stream.example.com/live" oninput="validateAddForm()"></div>
          <div class="form-group full"><label>پسوند (Playlist Suffix)</label><input type="text" id="f-suffix" placeholder="/index.m3u8"></div>
          <div class="form-group"><label>وضعیت</label><select id="f-status"><option value="live">فعال</option><option value="warn">هشدار</option><option value="error">خطا</option></select></div>
          <div class="form-group"><label>سطح دسترسی</label>
            <select id="f-access">
              <option value="public">🌍 عمومی (همه می‌بینند)</option>
              <option value="sub">✅ اشتراک (تیک آبی)</option>
              <option value="vip">🌟 VIP (تیک طلایی، مخفی از بقیه)</option>
            </select>
          </div>
          <div class="form-group"><label>دسته‌بندی</label><select id="f-category"><option value="">بدون دسته</option></select></div>
          <div class="form-group full"><label>آیکون</label><div class="icon-picker" id="icon-picker"></div></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-ghost" onclick="resetForm()">انصراف</button>
          <button class="btn btn-primary" id="btn-submit" onclick="submitForm()" disabled style="opacity:.4;"><span id="submit-label">ذخیره کانال</span></button>
        </div>
      </div>
    </div>

    <!-- ── Health Check ── -->
    <div class="section" id="sec-health">
      <div class="table-wrap">
        <div class="health-toolbar">
          <button class="btn btn-primary" id="btn-run-health" onclick="runHealthCheck()">💓 بررسی همه</button>
          <button class="btn btn-danger" onclick="deleteErrorChannels()">🗑 حذف خطادارها</button>
          <div class="health-summary" id="health-summary" style="margin-right:auto;"></div>
        </div>
        <div style="overflow-x:auto;"><table><thead><tr><th>کانال</th><th>وضعیت</th><th>زمان پاسخ</th><th>HTTP</th><th>آخرین چک</th><th>عملیات</th></tr></thead><tbody id="health-tbody"></tbody></table></div>
      </div>
    </div>

    <!-- ── دسته‌بندی‌ها ── -->
    <div class="section" id="sec-categories">
      <div class="cat-grid" id="cat-grid"></div>
      <div class="form-card">
        <div style="font-size:14px;font-weight:600;margin-bottom:1rem;" id="cat-form-heading">افزودن دسته جدید</div>
        <div class="form-grid">
          <div class="form-group"><label>نام دسته</label><input type="text" id="cf-name" placeholder="مثلاً خبری" oninput="validateCatForm()"></div>
          <div class="form-group"><label>آیکون</label><input type="text" id="cf-icon" placeholder="📂" maxlength="2" style="max-width:80px;"></div>
          <div class="form-group full"><label>رنگ دسته</label><div class="color-row" id="color-row"></div></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-ghost" onclick="resetCatForm()">انصراف</button>
          <button class="btn btn-primary" id="btn-cat-submit" onclick="submitCat()" disabled style="opacity:.4;">ذخیره</button>
        </div>
      </div>
      <div class="table-wrap" style="margin-top:1.5rem;">
        <div class="table-toolbar"><span style="font-size:13px;color:var(--text2);font-weight:600;">📦 گروه‌های وارد شده از M3U (حذف دسته‌جمعی)</span></div>
        <div id="import-groups-list" style="padding:1rem 1.25rem;"></div>
      </div>
    </div>

    <!-- ── آمار بازدید ── -->
    <div class="section" id="sec-views">
      <div class="views-hero" id="views-hero"></div>
      <div class="table-wrap">
        <div class="table-toolbar">
          <span style="font-size:13px;color:var(--text2);font-weight:600;">📊 پربازدیدترین کانال‌ها</span>
          <button class="btn btn-ghost btn-sm" onclick="loadViewStats()">🔄 بروزرسانی</button>
        </div>
        <div style="overflow-x:auto;">
          <table>
            <thead><tr><th>رتبه</th><th>کانال</th><th>وضعیت</th><th>سطح دسترسی</th><th>امروز vs دیروز</th><th>کل بازدید</th></tr></thead>
            <tbody id="views-tbody"><tr><td colspan="6" style="text-align:center;padding:3rem;color:var(--muted);">در حال بارگذاری...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── مدیریت کاربران ── -->
    <div class="section" id="sec-users">
      <div class="stats-row" id="user-stats-row"></div>
      <div class="table-wrap">
        <div class="table-toolbar">
          <div class="search-box"><input type="text" id="user-search" placeholder="جستجوی کاربر..." oninput="renderUsersTable()"></div>
          <select id="user-tier-filter" onchange="renderUsersTable()">
            <option value="all">همه سطوح</option>
            <option value="none">بدون اشتراک</option>
            <option value="sub">اشتراک (تیک آبی)</option>
            <option value="vip">VIP (تیک طلایی)</option>
          </select>
          <button class="btn btn-ghost btn-sm" onclick="loadUsers()">🔄 بروزرسانی</button>
        </div>
        <div style="overflow-x:auto;">
          <table>
            <thead><tr><th>نام کاربری</th><th>سطح دسترسی</th><th>علاقه‌مندی‌ها</th><th>تاریخ عضویت</th><th>عملیات</th></tr></thead>
            <tbody id="users-tbody"><tr><td colspan="5" style="text-align:center;padding:3rem;color:var(--muted);">در حال بارگذاری...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── تنظیمات پرداخت ── -->
    <div class="section" id="sec-payment">
      <div class="form-card">
        <div style="font-size:15px;font-weight:600;margin-bottom:1.25rem;">💳 تنظیمات پرداخت و اشتراک</div>
        <div class="form-grid">
          <div class="form-group full">
            <label>آدرس کیف پول ترون (TRC20) — از طریق متغیر TRON_ADDRESS تنظیم کنید</label>
            <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-family:monospace;font-size:12.5px;color:var(--muted);" id="tron-address-display">در حال بارگذاری...</div>
            <div style="font-size:11.5px;color:var(--muted);margin-top:4px;">برای تغییر آدرس کیف پول، متغیر محیطی TRON_ADDRESS را در Cloudflare Workers ویرایش کنید.</div>
          </div>
          <div class="form-group"><label>قیمت اشتراک (USDT TRC20)</label><input type="text" id="sub-price" placeholder="مثلاً 10"></div>
          <div class="form-group full"><label>توضیحات پرداخت (نمایش داده می‌شود برای کاربر)</label><textarea id="payment-instructions" placeholder="پس از واریز، رسید را به ادمین ارسال کنید..."></textarea></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" onclick="savePaymentSettings()">ذخیره تنظیمات</button>
        </div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1.25rem;margin-top:1.25rem;font-size:12.5px;color:var(--text2);line-height:1.8;">
        💡 وقتی رسید پرداخت یک کاربر را تأیید کردید، از تب «مدیریت کاربران» سطح دسترسی او را به «اشتراک» تغییر دهید. این کار هم اشتراک کاربر را فعال می‌کند و هم (در صورت تنظیم بودن تلگرام) یک اعلان «پرداخت تأیید شد» برای شما ارسال می‌شود.
      </div>
    </div>

    <!-- ── تلگرام ── -->
    <div class="section" id="sec-telegram">
      <div class="tg-status-card" id="tg-status-card">
        <div style="font-size:15px;font-weight:600;margin-bottom:1rem;">🤖 اعلان‌های تلگرام</div>
        <div class="tg-status-row" id="tg-status-row">
          <div class="tg-indicator off" id="tg-indicator"></div>
          <span id="tg-status-text" style="font-size:13px;color:var(--muted);">در حال بررسی وضعیت...</span>
        </div>
        <div style="background:var(--bg3);border-radius:10px;padding:1rem;margin-bottom:1rem;font-size:12.5px;color:var(--text2);line-height:2;">
          <div>🔑 <strong>TELEGRAM_BOT_TOKEN</strong> — توکن ربات (از @BotFather دریافت کنید)</div>
          <div>💬 <strong>TELEGRAM_CHAT_ID</strong> — آیدی چت یا کانال (عدد منفی برای گروه/کانال)</div>
          <div style="margin-top:8px;color:var(--muted);">این متغیرها را در بخش <strong>Settings → Variables</strong> پروژه Cloudflare Workers تنظیم کنید.</div>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;">چه رویدادهایی اعلان ارسال می‌کنند:</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:1rem;">
          <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;"><span style="color:var(--green);">✓</span> ثبت‌نام کاربر جدید</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;"><span style="color:var(--green);">✓</span> فعال‌سازی VIP با کد اعتماد</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;"><span style="color:var(--green);">✓</span> تأیید پرداخت (تغییر سطح کاربر به «اشتراک» توسط ادمین)</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;"><span style="color:var(--green);">✓</span> هر تغییر سطح دسترسی دیگر توسط ادمین</div>
        </div>
        <button class="btn btn-tg" onclick="testTelegram()">📨 ارسال پیام تست</button>
        <div id="tg-test-result" style="margin-top:10px;font-size:12.5px;"></div>
      </div>
    </div>

    <!-- ── پشتیبان‌گیری ── -->
    <div class="section" id="sec-backup">
      <div class="backup-card">
        <div class="backup-card-title">📤 خروجی گرفتن (Export)</div>
        <p style="font-size:12.5px;color:var(--text2);line-height:1.7;margin-bottom:1rem;">یک فایل JSON شامل تمام کانال‌ها، دسته‌بندی‌ها، تنظیمات پرداخت و لیست کاربران (بدون رمزهای عبور) دانلود می‌شود.</p>
        <div class="backup-actions">
          <button class="btn btn-primary" onclick="exportBackup()">⬇️ دانلود فایل پشتیبان</button>
        </div>
        <div class="backup-note">نام فایل به‌صورت خودکار شامل تاریخ امروز است (مثلاً streamfa-backup-2026-06-28.json).</div>
      </div>

      <div class="backup-card">
        <div class="backup-card-title">📥 بازگردانی (Import)</div>
        <p style="font-size:12.5px;color:var(--text2);line-height:1.7;margin-bottom:1rem;">یک فایل پشتیبان JSON که قبلاً export کرده‌اید را انتخاب کنید. کانال‌ها و دسته‌بندی‌ها به‌طور کامل جایگزین می‌شوند. برای کاربران، فقط سطح دسترسی/شهر/علاقه‌مندی‌های کاربرانی که از قبل وجود دارند بروزرسانی می‌شود (رمز عبور دست‌نخورده باقی می‌ماند).</p>
        <div class="drop-zone-import" id="backup-drop-zone" onclick="document.getElementById('backup-file-input').click()" ondragover="onBackupDragOver(event)" ondragleave="onBackupDragLeave(event)" ondrop="onBackupDrop(event)">
          📁 فایل پشتیبان (.json) را اینجا رها کنید یا کلیک کنید
        </div>
        <input type="file" id="backup-file-input" accept=".json,application/json" style="display:none;" onchange="onBackupFileSelected(event)">
        <div class="backup-result-box" id="backup-result-box"></div>
      </div>
    </div>

    <!-- ── لاگ تغییرات ── -->
    <div class="section" id="sec-logs">
      <div class="table-wrap">
        <div class="table-toolbar">
          <span style="font-size:13px;color:var(--text2);">آخرین تغییرات سطح دسترسی کاربران</span>
          <button class="btn btn-ghost btn-sm" onclick="loadLogs()">🔄 بروزرسانی</button>
        </div>
        <div id="logs-list" style="max-height:600px;overflow-y:auto;"></div>
      </div>
    </div>

    <!-- ── Import M3U ── -->
    <div class="section" id="sec-import">
      <div class="import-card">
        <div class="import-card-header">📥 <h3>وارد کردن پلی‌لیست M3U</h3></div>
        <div class="import-card-body">
          <div class="tab-row">
            <button class="tab-btn active" id="tab-file-btn" onclick="switchImportTab('file')">📁 آپلود فایل</button>
            <button class="tab-btn" id="tab-url-btn" onclick="switchImportTab('url')">🔗 لینک URL</button>
          </div>
          <div id="tab-file">
            <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-input').click()" ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event)">
              <p>فایل <strong>.m3u</strong> را اینجا رها کن یا کلیک کن</p>
            </div>
            <input type="file" id="file-input" accept=".m3u,.m3u8,.txt" onchange="handleFileSelect(event)">
          </div>
          <div id="tab-url" style="display:none;">
            <div style="display:flex;gap:8px;">
              <input type="text" id="import-url" placeholder="https://example.com/playlist.m3u" style="flex:1;">
              <button class="btn btn-primary" onclick="fetchFromUrl()">دریافت</button>
            </div>
          </div>
          <div id="import-progress" style="display:none;margin-top:14px;">
            <div style="font-size:13px;color:var(--text2);margin-bottom:6px;" id="progress-text">در حال پردازش...</div>
            <div class="progress-bar-wrap"><div class="progress-bar" id="progress-bar"></div></div>
          </div>
        </div>
      </div>
      <div id="import-results" style="display:none;">
        <div class="import-table-wrap">
          <div class="import-summary">
            <span class="imp-count" id="imp-total">0</span><span class="imp-label">کانال</span>
            <span style="color:var(--border2)">|</span>
            <span class="imp-count" id="imp-selected-count">0</span><span class="imp-label">انتخاب شده</span>
            <button class="sel-all-btn" onclick="toggleSelectAll()">انتخاب / لغو همه</button>
          </div>
          <div class="group-filter-row" id="group-filter-row"></div>
          <div class="bulk-cat-row">
            <span class="bulk-cat-label">📂 دسته‌بندی برای انتخاب‌شده‌ها:</span>
            <select id="bulk-cat-select" onchange="onBulkCatChange()">
              <option value="">— بدون تغییر —</option>
              <option value="__new__">+ ساخت دسته جدید…</option>
            </select>
            <span class="bulk-cat-label">سطح دسترسی:</span>
            <select id="bulk-access-select">
              <option value="">— بدون تغییر —</option>
              <option value="public">🌍 عمومی</option>
              <option value="sub">✅ اشتراک</option>
              <option value="vip">🌟 VIP</option>
            </select>
            <input type="text" id="bulk-cat-new-name" placeholder="نام دسته جدید..." style="display:none;background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:7px 10px;color:var(--text);font-family:inherit;font-size:12.5px;outline:none;min-width:180px;">
            <button class="btn btn-primary btn-sm" onclick="applyBulkSettings()">اعمال</button>
          </div>
          <div id="import-ch-list" style="max-height:420px;overflow-y:auto;"></div>
          <div class="import-actions">
            <div class="import-result" id="import-result-msg"></div>
            <button class="btn btn-ghost" onclick="resetImport()">پاک کردن</button>
            <button class="btn btn-primary" id="btn-save-import" onclick="saveImport()">✓ ذخیره انتخابی‌ها</button>
          </div>
        </div>
      </div>
    </div>

  </div>
</main>

<!-- مودال حذف کانال -->
<div class="overlay" id="del-modal">
  <div class="modal-box">
    <div class="modal-hdr"><h3>حذف کانال</h3><button class="modal-close-btn" onclick="closeDelModal()">✕</button></div>
    <div class="modal-body"><p style="font-size:14px;color:var(--text2);line-height:1.7;">آیا مطمئنی؟ کانال <strong id="del-name" style="color:var(--text)"></strong> حذف شود؟</p></div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="closeDelModal()">انصراف</button><button class="btn btn-danger" onclick="confirmDelete()">بله، حذف کن</button></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const WORKER_BASE = '${workerOrigin}';
document.getElementById('worker-url-display').textContent = WORKER_BASE.replace('https://','');

let channels=[], categories=[], users=[];
let editingId=null, deleteTargetId=null, selectedIcon='📺';
let healthResults={}, editingCatId=null, selectedColor='#4da6ff';
let selectedChannelIds=new Set();
const CAT_COLORS=['#4da6ff','#3ddc84','#e8ff47','#ff4d4d','#ffaa33','#c77dff','#ff6b9d','#00d4ff','#ff9500','#a8ff78'];

let importedChannels=[], activeGroupFilter='__all__', selectedIds=new Set(), pendingCategories=[];

function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2500);}
function toPersianDigits(n){const map={'0':'۰','1':'۱','2':'۲','3':'۳','4':'۴','5':'۵','6':'۶','7':'۷','8':'۸','9':'۹'};return String(n).replace(/[0-9]/g,d=>map[d]);}

async function loadChannels(){
  try{
    const [cr,catr]=await Promise.all([fetch('/admin/api/channels',{credentials:'include'}),fetch('/admin/api/categories',{credentials:'include'})]);
    if(cr.ok) channels=await cr.json();
    if(catr.ok) categories=await catr.json();
    renderStats();renderTable();renderCatFilter();renderCategorySelect();renderHealthTable();renderCatGrid();renderImportGroupsList();
  }catch(err){showToast('خطا در ارتباط با دیتابیس ❌');}
}

function goto(name,btn){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.getElementById('sec-'+name).classList.add('active');
  if(btn)btn.classList.add('active');
  const titles={channels:'کانال‌ها',add:'افزودن کانال',import:'Import پلی‌لیست',health:'بررسی سلامت',categories:'دسته‌بندی‌ها',views:'آمار بازدید',users:'مدیریت کاربران',payment:'تنظیمات پرداخت',telegram:'تلگرام',backup:'پشتیبان‌گیری',logs:'لاگ تغییرات'};
  document.getElementById('page-title').textContent=titles[name]||'';
  if(name==='channels'){renderStats();renderTable();}
  if(name==='health')renderHealthTable();
  if(name==='categories')renderCatGrid();
  if(name==='views')loadViewStats();
  if(name==='users')loadUsers();
  if(name==='payment')loadPaymentSettings();
  if(name==='telegram')loadTelegramStatus();
  if(name==='logs')loadLogs();
}

function renderStats(){
  const live=channels.filter(c=>c.status==='live').length;
  const error=channels.filter(c=>c.status==='error').length;
  const vip=channels.filter(c=>c.access==='vip').length;
  const sub=channels.filter(c=>c.access==='sub').length;
  document.getElementById('stats-row').innerHTML=\`
    <div class="stat-card green"><div class="stat-label">فعال</div><div class="stat-val">\${live}</div></div>
    <div class="stat-card red"><div class="stat-label">خطا</div><div class="stat-val">\${error}</div></div>
    <div class="stat-card blue"><div class="stat-label">اشتراک</div><div class="stat-val">\${sub}</div></div>
    <div class="stat-card gold"><div class="stat-label">VIP</div><div class="stat-val">\${vip}</div></div>
  \`;
}

function accessBadge(access){
  if(access==='vip') return '<span class="badge b-vip">🌟 VIP</span>';
  if(access==='sub') return '<span class="badge b-sub">✅ اشتراک</span>';
  return '<span class="badge b-none">🌍 عمومی</span>';
}

function renderCatFilter(){
  const sel=document.getElementById('tbl-cat-filter');
  sel.innerHTML='<option value="all">همه دسته‌ها</option>'+categories.map(c=>\`<option value="\${c.id}">\${c.icon} \${c.name}</option>\`).join('');
}
function renderCategorySelect(){
  const sel=document.getElementById('f-category');
  const cur=sel.value;
  sel.innerHTML='<option value="">بدون دسته</option>'+categories.map(c=>\`<option value="\${c.id}">\${c.icon} \${c.name}</option>\`).join('');
  sel.value=cur;
}

function renderTable(){
  const q=(document.getElementById('tbl-search').value||'').toLowerCase();
  const f=document.getElementById('tbl-filter').value;
  const fc=document.getElementById('tbl-cat-filter').value;
  const fa=document.getElementById('tbl-access-filter').value;
  const list=channels.filter(c=>{
    const mq=!q||c.name.toLowerCase().includes(q)||c.id.includes(q);
    const mf=f==='all'||c.status===f;
    const mc=fc==='all'||c.category===fc;
    const ma=fa==='all'||(c.access||'public')===fa;
    return mq&&mf&&mc&&ma;
  });
  const tbody=document.getElementById('ch-tbody');
  if(!list.length){tbody.innerHTML='<tr class="tbl-empty"><td colspan="7">کانالی یافت نشد</td></tr>';updateBulkDeleteUI();return;}
  tbody.innerHTML=list.map(ch=>{
    const s=statusBadge(ch.status);
    const cat=categories.find(c=>c.id===ch.category);
    const catCell=cat?\`<span class="badge" style="background:\${cat.color}22;color:\${cat.color}">\${cat.icon} \${cat.name}</span>\`:'<span style="color:var(--muted);font-size:12px;">—</span>';
    const checked=selectedChannelIds.has(ch.id)?'checked':'';
    return\`<tr>
      <td><input type="checkbox" \${checked} onchange="onSelectChannel('\${ch.id}',this)"></td>
      <td><div class="ch-cell"><div class="ch-icon-sm">\${ch.icon||'📺'}</div><div><div class="ch-name-sm">\${escHtml(ch.name)}</div><div class="ch-id-sm">#\${ch.id}</div></div></div></td>
      <td><span class="badge \${s.cls}"><span class="badge-dot"></span>\${s.label}</span></td>
      <td>\${accessBadge(ch.access||'public')}</td>
      <td>\${catCell}</td>
      <td><div class="url-cell" title="\${escHtml(ch.url)}">\${escHtml(ch.url)}</div></td>
      <td><div class="actions-cell"><button class="btn btn-ghost btn-sm" onclick="editChannel('\${ch.id}')">ویرایش</button><button class="btn btn-danger btn-sm" onclick="askDelete('\${ch.id}')">حذف</button></div></td>
    </tr>\`;
  }).join('');
  updateBulkDeleteUI();
}

function onSelectChannel(id,el){
  if(el.checked) selectedChannelIds.add(id); else selectedChannelIds.delete(id);
  updateBulkDeleteUI();
}
function onSelectAllChannels(el){
  const rows=document.querySelectorAll('#ch-tbody input[type=checkbox]');
  rows.forEach(cb=>{
    const tr=cb.closest('tr');
    const idCell=tr?.querySelector('.ch-id-sm');
    if(!idCell) return;
    const id=idCell.textContent.replace('#','');
    cb.checked=el.checked;
    if(el.checked) selectedChannelIds.add(id); else selectedChannelIds.delete(id);
  });
  updateBulkDeleteUI();
}
function clearChannelSelection(){
  selectedChannelIds=new Set();
  document.getElementById('ch-select-all').checked=false;
  renderTable();
}
function updateBulkDeleteUI(){
  const row=document.getElementById('bulk-delete-row');
  const countEl=document.getElementById('bulk-selected-count');
  if(selectedChannelIds.size>0){
    row.style.display='flex';
    countEl.textContent=toPersianDigits(selectedChannelIds.size)+' کانال انتخاب شده';
  } else {
    row.style.display='none';
  }
}
async function bulkDeleteSelected(){
  if(!selectedChannelIds.size)return;
  if(!confirm(toPersianDigits(selectedChannelIds.size)+' کانال انتخاب‌شده حذف شوند؟ این عملیات قابل بازگشت نیست.'))return;
  try{
    const res=await fetch('/admin/api/channels/delete-bulk',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:Array.from(selectedChannelIds)})});
    const data=await res.json();
    if(res.ok){selectedChannelIds=new Set();await loadChannels();showToast(data.removed+' کانال حذف شد ✓');}
    else showToast(data.error||'خطا ❌');
  }catch(e){showToast('خطا در ارتباط با سرور ❌');}
}

function statusBadge(s){
  if(s==='live')return{cls:'b-live',label:'فعال'};
  if(s==='error')return{cls:'b-error',label:'خطا'};
  return{cls:'b-warn',label:'هشدار'};
}

function initIconPicker(){
  const icons=['📺','📡','🎬','📻','🌍','🇬🇧','🇮🇷','🇺🇸','🇹🇷','🎥','🏆','🎭','🎵','📰','⚡'];
  document.getElementById('icon-picker').innerHTML=icons.map(ic=>\`<div class="icon-opt\${ic===selectedIcon?' selected':''}" onclick="selectIcon('\${ic}',this)">\${ic}</div>\`).join('');
}
function selectIcon(ic,el){selectedIcon=ic;document.querySelectorAll('.icon-opt').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');}

function validateAddForm(){
  const id=document.getElementById('f-id').value.trim();
  const name=document.getElementById('f-name').value.trim();
  const idTaken=channels.some(c=>c.id===id&&c.id!==editingId);
  document.getElementById('e-id').style.display=(id&&idTaken)?'block':'none';
  const ok=id&&!idTaken&&name;
  const btn=document.getElementById('btn-submit');
  btn.disabled=!ok;btn.style.opacity=ok?'1':'.4';
}

async function submitForm(){
  const id=document.getElementById('f-id').value.trim();
  const name=document.getElementById('f-name').value.trim();
  const url=document.getElementById('f-url').value.trim();
  const suffix=document.getElementById('f-suffix').value.trim();
  const status=document.getElementById('f-status').value;
  const access=document.getElementById('f-access').value;
  const category=document.getElementById('f-category').value;
  const payload={id,name,url,playlistSuffix:suffix,status,access,icon:selectedIcon,category};
  try{
    let res;
    if(editingId) res=await fetch('/admin/api/channels/'+editingId,{method:'PUT',credentials:'include',body:JSON.stringify(payload)});
    else res=await fetch('/admin/api/channels',{credentials:'include',method:'POST',body:JSON.stringify(payload)});
    if(res.ok){showToast(editingId?'ویرایش شد ✓':'اضافه شد ✓');await loadChannels();resetForm();goto('channels',document.querySelectorAll('.nav-item')[0]);}
    else showToast('خطا در ذخیره ❌');
  }catch(e){showToast('خطا در سرور ❌');}
}

function resetForm(){
  editingId=null;selectedIcon='📺';
  document.getElementById('f-id').value='';document.getElementById('f-id').disabled=false;
  document.getElementById('f-name').value='';document.getElementById('f-url').value='';
  document.getElementById('f-suffix').value='';document.getElementById('f-status').value='live';
  document.getElementById('f-access').value='public';document.getElementById('f-category').value='';
  document.getElementById('form-heading').textContent='افزودن کانال جدید';
  initIconPicker();validateAddForm();
}

function editChannel(id){
  const ch=channels.find(c=>c.id===id);if(!ch)return;
  editingId=id;selectedIcon=ch.icon||'📺';
  document.getElementById('f-id').value=ch.id;document.getElementById('f-id').disabled=true;
  document.getElementById('f-name').value=ch.name;
  document.getElementById('f-url').value=ch.url;
  document.getElementById('f-suffix').value=ch.playlistSuffix||'';
  document.getElementById('f-status').value=ch.status;
  document.getElementById('f-access').value=ch.access||'public';
  document.getElementById('f-category').value=ch.category||'';
  document.getElementById('form-heading').textContent='ویرایش: '+ch.name;
  initIconPicker();validateAddForm();goto('add',document.querySelectorAll('.nav-item')[1]);
}

function askDelete(id){const ch=channels.find(c=>c.id===id);if(!ch)return;deleteTargetId=id;document.getElementById('del-name').textContent=ch.name;document.getElementById('del-modal').classList.add('open');}
function closeDelModal(){document.getElementById('del-modal').classList.remove('open');deleteTargetId=null;}
async function confirmDelete(){
  try{const res=await fetch('/admin/api/channels/'+deleteTargetId,{method:'DELETE',credentials:'include'});if(res.ok){await loadChannels();closeDelModal();showToast('حذف شد');}}catch(e){showToast('خطا ❌');}
}

// ── Health Check ─────────────────────────────────────────────
let healthRunning=false;
function renderHealthTable(){
  const tbody=document.getElementById('health-tbody');
  if(!channels.length){tbody.innerHTML='<tr class="tbl-empty"><td colspan="6">کانالی وجود ندارد</td></tr>';return;}
  tbody.innerHTML=channels.map(ch=>healthRow(ch)).join('');updateHealthSummary();
}
function healthRow(ch){
  const r=healthResults[ch.id];
  let badge,latHtml,codeHtml,timeHtml;
  if(!r){badge='<span class="hc-badge hc-pending">—</span>';latHtml='<span class="hc-latency">—</span>';codeHtml='<span style="font-size:11px;color:var(--muted);">—</span>';timeHtml='<span style="font-size:11px;color:var(--muted);">—</span>';}
  else if(r.checking){badge='<span class="hc-badge hc-checking"><span class="hc-spin"></span></span>';latHtml='...';codeHtml='...';timeHtml='در حال چک...';}
  else{
    badge=r.status==='live'?'<span class="hc-badge hc-live">✓ فعال</span>':'<span class="hc-badge hc-error">✗ خطا</span>';
    const latCls=!r.latency?'bad':r.latency<800?'good':r.latency<2000?'slow':'bad';
    latHtml=\`<span class="hc-latency \${latCls}">\${r.latency?r.latency+'ms':'—'}</span>\`;
    codeHtml=\`<span style="font-size:11px;color:var(--muted);font-family:monospace;">\${r.httpCode||'—'}</span>\`;
    timeHtml=\`<span style="font-size:11px;color:var(--muted);">\${r.checkedAt?new Date(r.checkedAt).toLocaleTimeString('fa-IR'):'—'}</span>\`;
  }
  if(!r&&ch.lastCheck){
    const s=ch.lastCheck;
    const lc=!s.latency?'bad':s.latency<800?'good':s.latency<2000?'slow':'bad';
    latHtml=\`<span class="hc-latency \${lc}">\${s.latency+'ms'}</span>\`;
    codeHtml=\`<span style="font-size:11px;color:var(--muted);font-family:monospace;">\${s.httpCode||'—'}</span>\`;
    timeHtml=\`<span style="font-size:11px;color:var(--muted);">\${new Date(s.checkedAt).toLocaleTimeString('fa-IR')}</span>\`;
    badge=ch.status==='live'?'<span class="hc-badge hc-live">✓ فعال</span>':'<span class="hc-badge hc-error">✗ خطا</span>';
  }
  return\`<tr id="hrow-\${ch.id}"><td><div class="ch-cell"><div class="ch-icon-sm">\${ch.icon||'📺'}</div><div><div class="ch-name-sm">\${escHtml(ch.name)}</div><div class="ch-id-sm">#\${ch.id}</div></div></div></td><td>\${badge}</td><td>\${latHtml}</td><td>\${codeHtml}</td><td>\${timeHtml}</td><td><button class="btn btn-ghost btn-sm" onclick="checkOne('\${ch.id}')">چک مجدد</button></td></tr>\`;
}
function updateHealthSummary(){
  const checked=Object.values(healthResults).filter(r=>!r.checking).length;
  const live=Object.values(healthResults).filter(r=>r.status==='live').length;
  const err=Object.values(healthResults).filter(r=>r.status==='error').length;
  document.getElementById('health-summary').innerHTML=checked?\`<div class="hc-stat"><div class="hc-dot" style="background:var(--green)"></div>\${live} فعال</div><div class="hc-stat"><div class="hc-dot" style="background:var(--red)"></div>\${err} خطا</div>\`:'';
}
async function runHealthCheck(){
  if(healthRunning)return;healthRunning=true;
  const btn=document.getElementById('btn-run-health');btn.disabled=true;btn.textContent='در حال بررسی...';
  channels.forEach(ch=>{healthResults[ch.id]={checking:true};});renderHealthTable();
  try{const res=await fetch('/admin/api/health/run',{credentials:'include',method:'POST'});const data=await res.json();if(data.results)data.results.forEach(r=>{healthResults[r.id]=r;});await loadChannels();}catch(e){showToast('خطا ❌');}
  healthRunning=false;btn.disabled=false;btn.textContent='💓 بررسی همه';renderHealthTable();
}
async function checkOne(id){
  healthResults[id]={checking:true};
  const row=document.getElementById('hrow-'+id);if(row)row.outerHTML=healthRow(channels.find(c=>c.id===id));
  try{const res=await fetch('/admin/api/health/check-one',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});const data=await res.json();healthResults[id]={status:data.status,latency:data.latency,httpCode:data.httpCode,checkedAt:Date.now()};const idx=channels.findIndex(c=>c.id===id);if(idx>-1)channels[idx].status=data.status;updateHealthSummary();const nr=document.getElementById('hrow-'+id);if(nr)nr.outerHTML=healthRow(channels.find(c=>c.id===id));}catch(e){showToast('خطا ❌');}
}
async function deleteErrorChannels(){
  const errorCount=channels.filter(c=>c.status==='error').length;
  if(!errorCount){showToast('هیچ کانال خطاداری نیست');return;}
  if(!confirm(errorCount+' کانال خطادار حذف شوند؟'))return;
  try{const res=await fetch('/admin/api/channels/delete-errors',{credentials:'include',method:'POST'});const data=await res.json();if(res.ok){await loadChannels();renderHealthTable();showToast(data.removed+' کانال حذف شد ✓');}else showToast('خطا ❌');}catch(e){showToast('خطا ❌');}
}

// ── Categories ──────────────────────────────────────────────
function initColorPicker(){document.getElementById('color-row').innerHTML=CAT_COLORS.map(c=>\`<div class="color-opt\${c===selectedColor?' selected':''}" style="background:\${c}" onclick="selectColor('\${c}',this)"></div>\`).join('');}
function selectColor(c,el){selectedColor=c;document.querySelectorAll('.color-opt').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');}
function validateCatForm(){const n=document.getElementById('cf-name').value.trim();const btn=document.getElementById('btn-cat-submit');btn.disabled=!n;btn.style.opacity=n?'1':'.4';}
async function submitCat(){
  const name=document.getElementById('cf-name').value.trim();const icon=document.getElementById('cf-icon').value.trim()||'📂';if(!name)return;
  try{
    let res;
    if(editingCatId) res=await fetch('/admin/api/categories/'+editingCatId,{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,icon,color:selectedColor})});
    else res=await fetch('/admin/api/categories',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,icon,color:selectedColor})});
    if(res.ok){showToast(editingCatId?'دسته ویرایش شد ✓':'دسته اضافه شد ✓');await loadChannels();resetCatForm();}
    else{const d=await res.json();showToast(d.error||'خطا ❌');}
  }catch(e){showToast('خطا ❌');}
}
function resetCatForm(){editingCatId=null;selectedColor='#4da6ff';document.getElementById('cf-name').value='';document.getElementById('cf-icon').value='';document.getElementById('cat-form-heading').textContent='افزودن دسته جدید';initColorPicker();validateCatForm();}
function renderCatGrid(){
  const grid=document.getElementById('cat-grid');
  if(!categories.length){grid.innerHTML='<div style="color:var(--muted);font-size:13px;">هنوز دسته‌ای اضافه نشده</div>';return;}
  grid.innerHTML=categories.map(cat=>{
    const cnt=channels.filter(c=>c.category===cat.id).length;
    return\`<div class="cat-card"><div class="cat-icon-big" style="background:\${cat.color}22;">\${cat.icon}</div><div class="cat-info"><div class="cat-name-disp" style="color:\${cat.color}">\${escHtml(cat.name)}</div><div class="cat-count-disp">\${cnt} کانال</div></div><div style="display:flex;gap:4px;flex-shrink:0;"><button class="btn btn-ghost btn-sm" onclick="editCat('\${cat.id}')">ویرایش</button><button class="btn btn-danger btn-sm" onclick="deleteCat('\${cat.id}')">حذف</button></div></div>\`;
  }).join('');
}
function editCat(id){const cat=categories.find(c=>c.id===id);if(!cat)return;editingCatId=id;selectedColor=cat.color||'#4da6ff';document.getElementById('cf-name').value=cat.name;document.getElementById('cf-icon').value=cat.icon||'';document.getElementById('cat-form-heading').textContent='ویرایش: '+cat.name;initColorPicker();validateCatForm();document.querySelector('.form-card').scrollIntoView({behavior:'smooth'});}
async function deleteCat(id){
  const cat=categories.find(c=>c.id===id);if(!cat)return;
  const cnt=channels.filter(c=>c.category===id).length;
  if(!confirm((cnt>0?\`دسته "\${cat.name}" و \${cnt} کانال آن\`:\`دسته "\${cat.name}"\`)+' حذف شوند؟'))return;
  try{const res=await fetch('/admin/api/categories/'+id,{method:'DELETE',credentials:'include'});const d=await res.json();if(res.ok){await loadChannels();showToast('حذف شد ✓');}}catch(e){showToast('خطا ❌');}
}

// ══ آمار بازدید کانال‌ها ═════════════════════════════════════
async function loadViewStats(){
  const tbody=document.getElementById('views-tbody');
  tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:3rem;color:var(--muted);">در حال بارگذاری...</td></tr>';
  try{
    const res=await fetch('/admin/api/stats/views',{credentials:'include'});
    if(!res.ok){tbody.innerHTML='<tr class="tbl-empty"><td colspan="6">خطا در بارگذاری آمار</td></tr>';return;}
    const data=await res.json();
    renderViewsHero(data);
    renderViewsTable(data);
  }catch(e){tbody.innerHTML='<tr class="tbl-empty"><td colspan="6">خطا در ارتباط با سرور</td></tr>';}
}
function renderViewsHero(data){
  const totalAll=data.reduce((s,c)=>s+c.views.total,0);
  const todayAll=data.reduce((s,c)=>s+c.views.today,0);
  const yesterdayAll=data.reduce((s,c)=>s+c.views.yesterday,0);
  const diff=todayAll-yesterdayAll;
  const diffLabel=diff===0?'بدون تغییر':(diff>0?'+'+diff+' نسبت به دیروز':diff+' نسبت به دیروز');
  const diffColor=diff>0?'var(--green)':(diff<0?'var(--red)':'var(--muted)');
  document.getElementById('views-hero').innerHTML=\`
    <div class="stat-card blue"><div class="stat-label">بازدید کل (همه کانال‌ها)</div><div class="stat-val">\${totalAll.toLocaleString('fa-IR')}</div></div>
    <div class="stat-card green"><div class="stat-label">بازدید امروز</div><div class="stat-val">\${todayAll.toLocaleString('fa-IR')}</div><div class="stat-sub" style="color:\${diffColor}">\${diffLabel}</div></div>
    <div class="stat-card orange"><div class="stat-label">بازدید دیروز</div><div class="stat-val">\${yesterdayAll.toLocaleString('fa-IR')}</div></div>
  \`;
}
function renderViewsTable(data){
  const tbody=document.getElementById('views-tbody');
  if(!data.length){tbody.innerHTML='<tr class="tbl-empty"><td colspan="6">کانالی وجود ندارد</td></tr>';return;}
  const maxTotal=Math.max(1,...data.map(c=>c.views.total));
  tbody.innerHTML=data.map((c,i)=>{
    const rank=i+1;
    const rankCls=rank===1?'top1':rank===2?'top2':rank===3?'top3':'';
    const s=statusBadge(c.status);
    const pct=Math.round((c.views.total/maxTotal)*100);
    const todayVsYesterday=\`<div class="views-nums"><span class="views-today">امروز: \${c.views.today.toLocaleString('fa-IR')}</span><span>دیروز: \${c.views.yesterday.toLocaleString('fa-IR')}</span></div>\`;
    return\`<tr>
      <td><span class="rank-cell \${rankCls}">#\${rank}</span></td>
      <td><div class="ch-cell"><div class="ch-icon-sm">\${c.icon||'📺'}</div><div><div class="ch-name-sm">\${escHtml(c.name)}</div><div class="ch-id-sm">#\${c.id}</div></div></div></td>
      <td><span class="badge \${s.cls}"><span class="badge-dot"></span>\${s.label}</span></td>
      <td>\${accessBadge(c.access||'public')}</td>
      <td>\${todayVsYesterday}</td>
      <td><div class="views-cell"><div class="views-bar-wrap"><div class="views-bar" style="width:\${pct}%"></div></div><span style="font-size:12.5px;font-weight:700;">\${c.views.total.toLocaleString('fa-IR')}</span></div></td>
    </tr>\`;
  }).join('');
}

// ══ مدیریت کاربران ══════════════════════════════════════════
async function loadUsers(){
  try{
    const res=await fetch('/admin/api/users',{credentials:'include'});
    if(res.ok) users=await res.json();
    renderUserStats();renderUsersTable();
  }catch(e){showToast('خطا در بارگذاری کاربران ❌');}
}
function renderUserStats(){
  const total=users.length;
  const subs=users.filter(u=>u.tier==='sub').length;
  const vips=users.filter(u=>u.tier==='vip').length;
  const none=users.filter(u=>!u.tier||u.tier==='none').length;
  document.getElementById('user-stats-row').innerHTML=\`
    <div class="stat-card"><div class="stat-label">کل کاربران</div><div class="stat-val">\${total}</div></div>
    <div class="stat-card blue"><div class="stat-label">اشتراک (تیک آبی)</div><div class="stat-val">\${subs}</div></div>
    <div class="stat-card gold"><div class="stat-label">VIP (تیک طلایی)</div><div class="stat-val">\${vips}</div></div>
    <div class="stat-card"><div class="stat-label">بدون اشتراک</div><div class="stat-val">\${none}</div></div>
  \`;
}
function renderUsersTable(){
  const q=(document.getElementById('user-search').value||'').toLowerCase();
  const tf=document.getElementById('user-tier-filter').value;
  const list=users.filter(u=>{
    const mq=!q||u.username.toLowerCase().includes(q);
    const mt=tf==='all'||(u.tier||'none')===tf;
    return mq&&mt;
  });
  const tbody=document.getElementById('users-tbody');
  if(!list.length){tbody.innerHTML='<tr class="tbl-empty"><td colspan="5">کاربری یافت نشد</td></tr>';return;}
  tbody.innerHTML=list.map(u=>{
    const tier=u.tier||'none';
    const tierBadge=tier==='vip'?'<span class="badge b-vip">🌟 VIP</span>':tier==='sub'?'<span class="badge b-sub">✅ اشتراک</span>':'<span class="badge b-none">بدون اشتراک</span>';
    const dateStr=u.createdAt?new Date(u.createdAt).toLocaleDateString('fa-IR'):'—';
    return\`<tr>
      <td><strong>\${escHtml(u.username)}</strong></td>
      <td>
        <div class="user-row-tier">
          \${tierBadge}
          <select class="tier-select" onchange="changeTier('\${escHtml(u.username)}',this.value)">
            <option value="none"\${tier==='none'?' selected':''}>بدون اشتراک</option>
            <option value="sub"\${tier==='sub'?' selected':''}>✅ اشتراک</option>
            <option value="vip"\${tier==='vip'?' selected':''}>🌟 VIP</option>
          </select>
        </div>
      </td>
      <td><span style="font-size:12px;color:var(--muted);">\${u.favorites||0} کانال</span></td>
      <td><span style="font-size:12px;color:var(--muted);">\${dateStr}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteUser('\${escHtml(u.username)}')">حذف کاربر</button></td>
    </tr>\`;
  }).join('');
}
async function changeTier(username,newTier){
  try{
    const res=await fetch('/admin/api/users/'+encodeURIComponent(username),{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({tier:newTier})});
    if(res.ok){
      const msg=newTier==='sub'?('اشتراک '+username+' فعال شد و اعلان پرداخت ارسال شد (اگر تلگرام تنظیم باشد) ✓'):('سطح دسترسی '+username+' تغییر کرد ✓');
      showToast(msg);await loadUsers();
    }
    else showToast('خطا ❌');
  }catch(e){showToast('خطا ❌');}
}
async function deleteUser(username){
  if(!confirm('کاربر "'+username+'" برای همیشه حذف شود؟'))return;
  try{
    const res=await fetch('/admin/api/users/'+encodeURIComponent(username),{method:'DELETE',credentials:'include'});
    if(res.ok){showToast('کاربر حذف شد ✓');await loadUsers();}else showToast('خطا ❌');
  }catch(e){showToast('خطا ❌');}
}

// ══ تنظیمات پرداخت ══════════════════════════════════════════
async function loadPaymentSettings(){
  try{
    const res=await fetch('/admin/api/settings/payment',{credentials:'include'});
    const data=await res.json();
    document.getElementById('tron-address-display').textContent=data.tronAddress||'(تنظیم نشده — متغیر TRON_ADDRESS را اضافه کنید)';
    document.getElementById('sub-price').value=data.subPrice||'10';
    document.getElementById('payment-instructions').value=data.paymentInstructions||'';
  }catch(e){}
}
async function savePaymentSettings(){
  const subPrice=document.getElementById('sub-price').value.trim();
  const instructions=document.getElementById('payment-instructions').value;
  try{
    const res=await fetch('/admin/api/settings/payment',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subPrice,paymentInstructions:instructions})});
    if(res.ok) showToast('تنظیمات ذخیره شد ✓');else showToast('خطا ❌');
  }catch(e){showToast('خطا ❌');}
}

// ══ تلگرام ═══════════════════════════════════════════════════
async function loadTelegramStatus(){
  const indicator=document.getElementById('tg-indicator');
  const text=document.getElementById('tg-status-text');
  document.getElementById('tg-test-result').textContent='';
  try{
    const res=await fetch('/admin/api/settings/telegram',{credentials:'include'});
    const data=await res.json();
    const ready=data.botTokenSet&&data.chatIdSet;
    indicator.classList.toggle('on',ready);
    indicator.classList.toggle('off',!ready);
    if(ready) text.textContent='✅ تلگرام تنظیم شده و آماده ارسال اعلان است';
    else if(data.botTokenSet&&!data.chatIdSet) text.textContent='⚠️ توکن ربات تنظیم شده، اما TELEGRAM_CHAT_ID تنظیم نشده';
    else if(!data.botTokenSet&&data.chatIdSet) text.textContent='⚠️ آیدی چت تنظیم شده، اما TELEGRAM_BOT_TOKEN تنظیم نشده';
    else text.textContent='❌ هیچ‌کدام از متغیرهای تلگرام تنظیم نشده‌اند';
  }catch(e){
    text.textContent='خطا در بررسی وضعیت تلگرام';
  }
}
async function testTelegram(){
  const resultEl=document.getElementById('tg-test-result');
  resultEl.style.color='var(--muted)';
  resultEl.textContent='در حال ارسال...';
  try{
    const res=await fetch('/admin/api/settings/telegram',{credentials:'include',method:'POST'});
    const data=await res.json();
    if(res.ok){resultEl.style.color='var(--green)';resultEl.textContent='✓ '+(data.message||'پیام تست ارسال شد');showToast('پیام تست تلگرام ارسال شد ✓');}
    else{resultEl.style.color='var(--red)';resultEl.textContent='✗ '+(data.error||'خطا در ارسال');}
  }catch(e){resultEl.style.color='var(--red)';resultEl.textContent='✗ خطا در ارتباط با سرور';}
}

// ══ پشتیبان‌گیری ═════════════════════════════════════════════
function exportBackup(){
  window.open('/admin/api/backup/export','_blank');
  showToast('در حال دانلود فایل پشتیبان...');
}
function onBackupDragOver(e){e.preventDefault();document.getElementById('backup-drop-zone').classList.add('drag-over');}
function onBackupDragLeave(e){document.getElementById('backup-drop-zone').classList.remove('drag-over');}
function onBackupDrop(e){
  e.preventDefault();
  document.getElementById('backup-drop-zone').classList.remove('drag-over');
  const file=e.dataTransfer.files[0];
  if(file) processBackupFile(file);
}
function onBackupFileSelected(e){
  const file=e.target.files[0];
  if(file) processBackupFile(file);
}
function processBackupFile(file){
  const reader=new FileReader();
  reader.onload=async(e)=>{
    let parsed;
    try{ parsed=JSON.parse(e.target.result); }
    catch(err){ showToast('فایل JSON معتبر نیست ❌'); return; }
    await importBackup(parsed);
  };
  reader.readAsText(file,'UTF-8');
}
async function importBackup(parsed){
  const box=document.getElementById('backup-result-box');
  box.style.display='block';
  box.innerHTML='در حال بازگردانی...';
  try{
    const res=await fetch('/admin/api/backup/import',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed)});
    const data=await res.json();
    if(!res.ok){box.innerHTML='❌ '+(data.error||'خطا در بازگردانی');showToast('خطا در بازگردانی ❌');return;}
    const r=data.results||{};
    box.innerHTML=\`✅ بازگردانی با موفقیت انجام شد:<br>
      📺 \${r.channels||0} کانال<br>
      📂 \${r.categories||0} دسته‌بندی<br>
      ⚙️ تنظیمات: \${r.settings?'بروزرسانی شد':'بدون تغییر'}<br>
      👥 \${r.users||0} کاربر بروزرسانی شد (تیر/شهر/علاقه‌مندی)\`;
    showToast('بازگردانی با موفقیت انجام شد ✓');
    await loadChannels();
  }catch(e){
    box.innerHTML='❌ خطا در ارتباط با سرور: '+e.message;
    showToast('خطا در ارتباط با سرور ❌');
  }
}

// ══ لاگ ═════════════════════════════════════════════════════
async function loadLogs(){
  try{
    const res=await fetch('/admin/api/tier-logs',{credentials:'include'});
    const logs=await res.json();
    const container=document.getElementById('logs-list');
    if(!logs.length){container.innerHTML='<div style="text-align:center;padding:3rem;color:var(--muted);font-size:13px;">هیچ لاگی وجود ندارد</div>';return;}
    container.innerHTML=logs.map(l=>{
      const tierLabel=t=>t==='vip'?'🌟 VIP':t==='sub'?'✅ اشتراک':'👤 بدون اشتراک';
      const timeStr=new Date(l.at).toLocaleString('fa-IR');
      const src=l.source==='admin'?'توسط ادمین':(l.source==='trust_code'?'کد اعتماد':'سیستم');
      return\`<div class="log-row"><span class="log-user">\${escHtml(l.username)}</span><span class="log-arrow">\${tierLabel(l.fromTier)} → \${tierLabel(l.toTier)}</span><span class="log-source">\${src}</span><span class="log-time">\${timeStr}</span></div>\`;
    }).join('');
  }catch(e){showToast('خطا در بارگذاری لاگ ❌');}
}

// ══ Import M3U ══════════════════════════════════════════════
function switchImportTab(tab){document.getElementById('tab-file').style.display=tab==='file'?'block':'none';document.getElementById('tab-url').style.display=tab==='url'?'block':'none';document.getElementById('tab-file-btn').classList.toggle('active',tab==='file');document.getElementById('tab-url-btn').classList.toggle('active',tab==='url');}
function onDragOver(e){e.preventDefault();document.getElementById('drop-zone').classList.add('drag-over');}
function onDragLeave(e){document.getElementById('drop-zone').classList.remove('drag-over');}
function onDrop(e){e.preventDefault();document.getElementById('drop-zone').classList.remove('drag-over');const file=e.dataTransfer.files[0];if(file)processFile(file);}
function handleFileSelect(e){const file=e.target.files[0];if(file)processFile(file);}
function processFile(file){const reader=new FileReader();reader.onload=async(e)=>{showProgress('در حال پردازش...');await sendParseRequest({text:e.target.result});};reader.readAsText(file,'UTF-8');}
async function fetchFromUrl(){const url=document.getElementById('import-url').value.trim();if(!url)return showToast('آدرس URL را وارد کن');showProgress('در حال دریافت...');await sendParseRequest({url});}
function showProgress(msg){document.getElementById('import-progress').style.display='block';document.getElementById('progress-text').textContent=msg;document.getElementById('progress-bar').style.width='30%';document.getElementById('import-results').style.display='none';}
async function sendParseRequest(body){
  try{
    document.getElementById('progress-bar').style.width='60%';
    const res=await fetch('/admin/api/import/parse',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    document.getElementById('progress-bar').style.width='100%';
    if(!res.ok){const err=await res.json();showToast(err.error||'خطا ❌');document.getElementById('import-progress').style.display='none';return;}
    const data=await res.json();
    setTimeout(()=>{document.getElementById('import-progress').style.display='none';renderImportResults(data);},400);
  }catch(e){showToast('خطا ❌');document.getElementById('import-progress').style.display='none';}
}
function renderImportResults(data){
  importedChannels=(data.channels||[]).map(ch=>({...ch,category:'',access:'public'}));
  activeGroupFilter='__all__';selectedIds=new Set(importedChannels.map(c=>c.id));
  document.getElementById('imp-total').textContent=data.total||0;updateSelectedCount();
  const groupRow=document.getElementById('group-filter-row');
  groupRow.innerHTML=\`<span class="group-chip active" onclick="filterImportGroup('__all__',this)">همه (\${importedChannels.length})</span>\`+(data.groups||[]).map(g=>\`<span class="group-chip" onclick="filterImportGroup('\${escHtml(g)}',this)">\${escHtml(g)} (\${importedChannels.filter(c=>c.group===g).length})</span>\`).join('');
  renderBulkCatOptions();renderImportList();document.getElementById('import-results').style.display='block';
}
function importCatOptionsHtml(selectedVal){return'<option value="">— انتخاب دسته —</option>'+categories.map(c=>\`<option value="\${c.id}"\${selectedVal===c.id?' selected':''}>\${c.icon} \${escHtml(c.name)}</option>\`).join('')+'<option value="__new__">+ دسته جدید…</option>';}
function renderBulkCatOptions(){const sel=document.getElementById('bulk-cat-select');sel.innerHTML='<option value="">— بدون تغییر —</option>'+categories.map(c=>\`<option value="\${c.id}">\${c.icon} \${escHtml(c.name)}</option>\`).join('')+'<option value="__new__">+ ساخت دسته جدید…</option>';}
function onBulkCatChange(){document.getElementById('bulk-cat-new-name').style.display=document.getElementById('bulk-cat-select').value==='__new__'?'inline-block':'none';}
function applyBulkSettings(){
  let catId=document.getElementById('bulk-cat-select').value;
  const access=document.getElementById('bulk-access-select').value;
  if(catId==='__new__'){const n=document.getElementById('bulk-cat-new-name').value.trim();if(!n){showToast('نام دسته را وارد کن');return;}catId=ensurePendingCategory(n);}
  if(!selectedIds.size){showToast('هیچ کانالی انتخاب نشده');return;}
  importedChannels=importedChannels.map(ch=>{
    if(!selectedIds.has(ch.id))return ch;
    return{...ch,...(catId?{category:catId}:{}),...(access?{access}:{})};
  });
  renderImportList();showToast('اعمال شد ✓');
}
function ensurePendingCategory(name){
  const id=name.trim().toLowerCase().replace(/\\s+/g,'-').replace(/[^a-z0-9\\u0600-\\u06FF-]/g,'');
  if(!id)return'';
  const already=categories.find(c=>c.id===id)||pendingCategories.find(c=>c.id===id);
  if(!already){const color=CAT_COLORS[(categories.length+pendingCategories.length)%CAT_COLORS.length];pendingCategories.push({id,name:name.trim(),icon:'📂',color,pending:true});categories.push({id,name:name.trim(),icon:'📂',color,pending:true});renderBulkCatOptions();}
  return id;
}
function onChannelCatChange(id,sel){
  const val=sel.value;
  if(val==='__new__'){const n=prompt('نام دسته جدید:');if(!n||!n.trim()){sel.value='';return;}const catId=ensurePendingCategory(n);importedChannels=importedChannels.map(ch=>ch.id===id?{...ch,category:catId}:ch);renderImportList();return;}
  importedChannels=importedChannels.map(ch=>ch.id===id?{...ch,category:val}:ch);
}
function onChannelAccessChange(id,sel){importedChannels=importedChannels.map(ch=>ch.id===id?{...ch,access:sel.value}:ch);}
function filterImportGroup(g,el){activeGroupFilter=g;document.querySelectorAll('.group-chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');renderImportList();}
function renderImportList(){
  const list=activeGroupFilter==='__all__'?importedChannels:importedChannels.filter(c=>c.group===activeGroupFilter);
  const container=document.getElementById('import-ch-list');
  if(!list.length){container.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">کانالی در این گروه نیست</div>';return;}
  container.innerHTML=list.map(ch=>{
    const checked=selectedIds.has(ch.id)?'checked':'';
    const logoHtml=ch.logo?\`<img src="\${escHtml(ch.logo)}" onerror="this.parentElement.textContent='📺'" alt="">\`:'📺';
    return\`<div class="import-ch-row">
      <input type="checkbox" \${checked} onchange="toggleSelect('\${escHtml(ch.id)}',this)">
      <div class="imp-logo">\${logoHtml}</div>
      <div style="flex:1;min-width:0;"><div class="imp-ch-name">\${escHtml(ch.name)}</div></div>
      <select class="imp-cat-select" onchange="onChannelCatChange('\${escHtml(ch.id)}',this)">\${importCatOptionsHtml(ch.category)}</select>
      <select class="imp-cat-select" onchange="onChannelAccessChange('\${escHtml(ch.id)}',this)">
        <option value="public"\${ch.access==='public'?' selected':''}>🌍 عمومی</option>
        <option value="sub"\${ch.access==='sub'?' selected':''}>✅ اشتراک</option>
        <option value="vip"\${ch.access==='vip'?' selected':''}>🌟 VIP</option>
      </select>
    </div>\`;
  }).join('');
}
function toggleSelect(id,el){if(el.checked)selectedIds.add(id);else selectedIds.delete(id);updateSelectedCount();}
function toggleSelectAll(){
  const vis=activeGroupFilter==='__all__'?importedChannels:importedChannels.filter(c=>c.group===activeGroupFilter);
  const allSel=vis.every(c=>selectedIds.has(c.id));
  vis.forEach(c=>{if(allSel)selectedIds.delete(c.id);else selectedIds.add(c.id);});
  renderImportList();updateSelectedCount();
}
function updateSelectedCount(){document.getElementById('imp-selected-count').textContent=selectedIds.size;}
async function saveImport(){
  const toSave=importedChannels.filter(c=>selectedIds.has(c.id));
  if(!toSave.length){showToast('هیچ کانالی انتخاب نشده');return;}
  const btn=document.getElementById('btn-save-import');btn.disabled=true;btn.textContent='در حال ذخیره...';
  try{
    const res=await fetch('/admin/api/import/save',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channels:toSave,newCategories:pendingCategories})});
    const data=await res.json();
    if(res.ok){document.getElementById('import-result-msg').innerHTML=\`✅ \${data.added} کانال اضافه شد | \${data.skipped} تکراری رد شد\`;showToast(data.added+' کانال ذخیره شد ✓');pendingCategories=[];await loadChannels();}
    else showToast(data.error||'خطا ❌');
  }catch(e){showToast('خطا ❌');}
  btn.disabled=false;btn.innerHTML='✓ ذخیره انتخابی‌ها';
}
function resetImport(){importedChannels=[];selectedIds=new Set();categories=categories.filter(c=>!c.pending);pendingCategories=[];document.getElementById('import-results').style.display='none';document.getElementById('import-progress').style.display='none';document.getElementById('import-result-msg').textContent='';document.getElementById('file-input').value='';}

document.querySelectorAll('.overlay').forEach(o=>{o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open');});});
initIconPicker();initColorPicker();loadChannels();
</script>
</body>
</html>`;
}