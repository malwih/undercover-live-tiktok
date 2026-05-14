import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
} from "discord.js";
import {
  TikTokLiveConnection,
  ControlEvent,
  WebcastEvent,
} from "tiktok-live-connector";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

/* =========================================================
   PATH + FONT
========================================================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const regularFontPath = path.join(__dirname, "assets/fonts/Poppins-Regular.ttf");
const boldFontPath = path.join(__dirname, "assets/fonts/Poppins-Bold.ttf");

try {
  GlobalFonts.registerFromPath(regularFontPath, "Poppins");
  GlobalFonts.registerFromPath(boldFontPath, "Poppins Bold");
  console.log("Fonts registered:", GlobalFonts.families);
} catch (e) {
  console.warn("Font register skipped:", e?.message || e);
}

/* =========================================================
   ENV
========================================================= */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const LIVE_ANNOUNCE_CHANNEL_ID = process.env.LIVE_ANNOUNCE_CHANNEL_ID;
const TIKTOK_TICKET_CATEGORY_ID = process.env.TIKTOK_TICKET_CATEGORY_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;

const TIKTOK_USERNAMES = String(process.env.TIKTOK_USERNAMES || "")
  .split(",")
  .map((x) => x.trim().replace(/^@/, ""))
  .filter(Boolean);

const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 90);
const OFFLINE_CONFIRM_TICKS = Number(process.env.OFFLINE_CONFIRM_TICKS || 2);
const CONNECT_COOLDOWN_MS = Number(process.env.CONNECT_COOLDOWN_MS || 10 * 60 * 1000);
const PROFILE_REFRESH_COOLDOWN_MS = Number(
  process.env.PROFILE_REFRESH_COOLDOWN_MS || 30 * 60 * 1000
);

const MENTION_EVERYONE =
  String(process.env.MENTION_EVERYONE || "true").toLowerCase() === "true";

const DEBUG_TIKTOK_RAW =
  String(process.env.DEBUG_TIKTOK_RAW || "false").toLowerCase() === "true";

const SERVER_NAME = process.env.SERVER_NAME || "UNDERCOVER";
const LIVE_BG_URL =
  process.env.LIVE_BG_URL ||
  "https://images.unsplash.com/photo-1511512578047-dfb367046420?q=80&w=1600&auto=format&fit=crop";

/**
 * Tetap pakai keyword filter.
 * Pisahkan dengan koma.
 * Contoh:
 * REQUIRED_LIVE_KEYWORDS=undercover,event undercover
 */
const REQUIRED_LIVE_KEYWORDS = String(process.env.REQUIRED_LIVE_KEYWORDS || "undercover")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!LIVE_ANNOUNCE_CHANNEL_ID) throw new Error("Missing LIVE_ANNOUNCE_CHANNEL_ID");
if (!TIKTOK_USERNAMES.length) throw new Error("Missing TIKTOK_USERNAMES");
if (!TIKTOK_TICKET_CATEGORY_ID) throw new Error("Missing TIKTOK_TICKET_CATEGORY_ID");
if (!STAFF_ROLE_ID) throw new Error("Missing STAFF_ROLE_ID");

/* =========================================================
   DISCORD CLIENT
========================================================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

/* =========================================================
   GLOBAL STATE
========================================================= */
const liveStates = new Map();

/* =========================================================
   HELPERS
========================================================= */
function nowIso() {
  return new Date().toISOString();
}

function fmtDateID(dateLike) {
  return new Date(dateLike).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
  });
}

function fmtNumber(num) {
  if (num == null) return "0";
  return new Intl.NumberFormat("id-ID").format(Number(num) || 0);
}

function fmtDuration(start, end) {
  if (!start || !end) return "-";

  const ms = new Date(end) - new Date(start);
  if (Number.isNaN(ms) || ms < 0) return "-";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}

function getTikTokUrl(username) {
  return `https://www.tiktok.com/@${username}/live`;
}

function getTikTokProfileUrl(username) {
  return `https://www.tiktok.com/@${username}`;
}

function getFontFamily(weight = "regular") {
  return weight === "bold" ? '"Poppins Bold", sans-serif' : '"Poppins", sans-serif';
}

function sanitizeText(text, max = 40) {
  return String(text || "")
    .replace(/[`*_~|>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function fitText(ctx, text, maxWidth, startSize = 64, minSize = 18, weight = "bold") {
  let size = startSize;
  const family = getFontFamily(weight);

  while (size >= minSize) {
    ctx.font = `${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }

  return minSize;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickFirstUrl(...candidates) {
  for (const item of candidates) {
    if (!item) continue;

    if (typeof item === "string" && item.trim()) return item.trim();

    if (Array.isArray(item)) {
      const found = item.find((x) => typeof x === "string" && x.trim());
      if (found) return found.trim();
    }
  }
  return null;
}

function normalizeImageUrl(url) {
  if (!url) return null;

  let finalUrl = String(url).trim();
  finalUrl = finalUrl.replace(/\\u002F/g, "/").replace(/&amp;/g, "&");

  if (finalUrl.startsWith("//")) finalUrl = `https:${finalUrl}`;
  if (!/^https?:\/\//i.test(finalUrl)) return null;

  return finalUrl;
}

function normalizeSpace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUsername(text) {
  return String(text || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isGenericTikTokTitle(text) {
  const value = normalizeSpace(text).toLowerCase();
  return (
    !value ||
    value === "tiktok" ||
    value === "tiktok - make your day" ||
    value === "make your day" ||
    value.startsWith("tiktok - make your day")
  );
}

function cleanLiveText(text) {
  const value = normalizeSpace(text);
  if (!value) return null;
  if (isGenericTikTokTitle(value)) return null;
  return value;
}

function isValidDisplayName(text, username = "") {
  const value = normalizeSpace(text);
  if (!value) return false;
  if (isGenericTikTokTitle(value)) return false;
  if (value.toLowerCase() === String(username || "").toLowerCase()) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildKeywordCheckText(state) {
  return normalizeSpace(
    [state.liveTitle, state.liveDescription, state.lastSeenLiveText]
      .filter(Boolean)
      .join(" ")
  ).toLowerCase();
}

function matchesRequiredKeyword(state) {
  const text = buildKeywordCheckText(state);
  if (!text) return false;
  if (!REQUIRED_LIVE_KEYWORDS.length) return true;

  return REQUIRED_LIVE_KEYWORDS.some((keyword) => text.includes(keyword));
}

/* =========================================================
   TICKET META
========================================================= */
function buildTicketChannelName(username, userId) {
  const safeUsername =
    normalizeUsername(username).replace(/[^a-z0-9._-]/g, "").slice(0, 40) || "unknown";
  return `livetiktok-${safeUsername}-${String(userId).slice(-4)}`;
}

function parseTicketMeta(channelTopic = "") {
  const meta = {
    type: null,
    username: null,
    requesterId: null,
    status: null,
    doneAt: null,
  };

  const chunks = String(channelTopic || "")
    .split("|")
    .map((x) => x.trim());

  for (const part of chunks) {
    const [key, ...rest] = part.split("=");
    if (!key) continue;
    meta[key] = rest.join("=");
  }

  return meta;
}

function buildTicketMeta(meta = {}) {
  return [
    `type=${meta.type || "livetiktok"}`,
    `username=${meta.username || ""}`,
    `requesterId=${meta.requesterId || ""}`,
    `status=${meta.status || "open"}`,
    `doneAt=${meta.doneAt || ""}`,
  ].join(" | ");
}

function memberHasStaffRole(member) {
  if (!member || !STAFF_ROLE_ID) return false;
  return member.roles?.cache?.has(STAFF_ROLE_ID) || false;
}

function canUseDoneButton(member, channel) {
  if (!member || !channel) return false;
  if (memberHasStaffRole(member)) return true;

  const perms = channel.permissionsFor(member);
  if (!perms) return false;

  return (
    perms.has(PermissionsBitField.Flags.Administrator) ||
    perms.has(PermissionsBitField.Flags.ManageChannels) ||
    perms.has(PermissionsBitField.Flags.ManageMessages)
  );
}

/* =========================================================
   TERMS / BUTTONS
========================================================= */
function buildTermsEmbed(username) {
  return new EmbedBuilder()
    .setColor(0xfe2c55)
    .setTitle("📝 Daftar TikTok Live Broadcast")
    .setDescription(
      [
        `**Username TikTok:** \`${username}\``,
        "",
        "**S&K Daftar TikTok Live Broadcast:**",
        `1. Broadcast hanya berjalan saat akun live dan mengandung keyword yang diizinkan.`,
        `2. Keyword aktif saat ini: ${REQUIRED_LIVE_KEYWORDS.map((x) => `\`${x}\``).join(", ") || "-"}`,
        "3. Pesan broadcast tidak menampilkan judul/deskripsi live.",
        "4. Gunakan **username TikTok**. Jika ada perubahan username, wajib hubungi Owner untuk update.",
        "",
        "Silakan klik **Saya Setuju**, lalu klik **Submit**.",
      ].join("\n")
    )
    .setFooter({ text: `Diajukan pada ${fmtDateID(nowIso())} WIB` })
    .setTimestamp();
}

function buildTermsButtons(username, agreed = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`livetiktok_agree:${username}`)
        .setLabel(agreed ? "✅ Sudah Setuju" : "☑️ Saya Setuju")
        .setStyle(agreed ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`livetiktok_submit:${username}:${agreed ? "1" : "0"}`)
        .setLabel("✅ Submit")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`livetiktok_cancel:${username}`)
        .setLabel("❌ Cancel")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildTicketButtons(username, isDone = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`copy_username:${username}`)
        .setLabel("📋 Copy Username")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ticket_done:${username}`)
        .setLabel(isDone ? "✅ DONE" : "✅ Mark DONE")
        .setStyle(ButtonStyle.Success)
        .setDisabled(isDone),
      new ButtonBuilder()
        .setCustomId(`close_ticket:${username}`)
        .setLabel("🔒 Close Ticket")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

/* =========================================================
   HTTP / PROFILE FALLBACK
========================================================= */
async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      pragma: "no-cache",
      "cache-control": "no-cache",
      referer: "https://www.google.com/",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }

  return await res.text();
}

async function fetchImageBuffer(url) {
  const normalized = normalizeImageUrl(url);
  if (!normalized) throw new Error("Invalid image url");

  const res = await fetch(normalized, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      referer: "https://www.tiktok.com/",
      origin: "https://www.tiktok.com",
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      pragma: "no-cache",
      "cache-control": "no-cache",
    },
  });

  if (!res.ok) throw new Error(`Image request failed with status ${res.status}`);

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function extractUserLikeAvatar(userLike) {
  if (!userLike) return null;

  return pickFirstUrl(
    userLike?.avatarThumb?.urlList,
    userLike?.avatarMedium?.urlList,
    userLike?.avatarLarge?.urlList,
    userLike?.avatarLarger?.urlList,
    userLike?.avatar?.urlList,
    userLike?.avatar_thumb?.url_list,
    userLike?.avatar_medium?.url_list,
    userLike?.avatar_large?.url_list,
    userLike?.avatar_larger?.url_list,
    userLike?.avatarUrl,
    userLike?.avatar_url,
    userLike?.avatarUri,
    userLike?.avatar_uri,
    userLike?.profilePictureUrl,
    userLike?.profile_picture_url
  );
}

function debugSourceSnapshot(state, source, label = "SOURCE") {
  if (!DEBUG_TIKTOK_RAW || !source) return;

  try {
    const snapshot = {
      sourceKeys: Object.keys(source || {}),
      title: source?.title,
      description: source?.description,
      desc: source?.desc,
      roomInfoTitle: source?.roomInfo?.title,
      roomInfoDescription: source?.roomInfo?.description,
      roomInfoDesc: source?.roomInfo?.desc,
      dataTitle: source?.data?.title,
      dataDescription: source?.data?.description,
      dataDesc: source?.data?.desc,
      shareMetaTitle: source?.shareMeta?.title,
      shareMetaDescription: source?.shareMeta?.description,
      liveRoomTitle: source?.liveRoom?.title,
      liveRoomDescription: source?.liveRoom?.description,
      ownerNickname: source?.owner?.nickname,
      userNickname: source?.user?.nickname,
    };

    console.log(`[${state.username}] ${label}: ${JSON.stringify(snapshot, null, 2)}`);
  } catch (err) {
    console.warn(`[${state.username}] debugSourceSnapshot failed:`, err?.message || err);
  }
}

function extractLiveTextsFromSource(source) {
  const rawTitle = pickFirstString(
    source?.title,
    source?.roomInfo?.title,
    source?.data?.title,
    source?.owner?.roomTitle,
    source?.user?.roomTitle,
    source?.shareMeta?.title,
    source?.liveRoom?.title,
    source?.roomData?.title
  );

  const rawDescription = pickFirstString(
    source?.description,
    source?.desc,
    source?.roomInfo?.description,
    source?.roomInfo?.desc,
    source?.data?.description,
    source?.data?.desc,
    source?.owner?.description,
    source?.user?.description,
    source?.shareMeta?.description,
    source?.shareMeta?.desc,
    source?.liveRoom?.description,
    source?.liveRoom?.desc,
    source?.roomData?.description,
    source?.roomData?.desc
  );

  return {
    liveTitle: cleanLiveText(rawTitle),
    liveDescription: cleanLiveText(rawDescription),
  };
}

function extractProfileFromAny(state, source) {
  if (!source) return;

  debugSourceSnapshot(state, source, "RAW PAYLOAD");

  const possibleUsers = [
    source?.owner,
    source?.host,
    source?.user,
    source?.userInfo,
    source?.anchor,
    source?.broadcaster,
    source?.ownerInfo,
    source?.hostInfo,
    source?.roomInfo?.owner,
    source?.roomInfo?.host,
    source?.roomInfo?.user,
    source?.roomInfo?.userInfo,
    source?.data?.owner,
    source?.data?.user,
  ].filter(Boolean);

  for (const user of possibleUsers) {
    const nextName = pickFirstString(
      user?.nickname,
      user?.displayName,
      user?.uniqueId,
      user?.unique_id
    );

    const nextAvatar = normalizeImageUrl(extractUserLikeAvatar(user));

    if (isValidDisplayName(nextName, state.username)) {
      state.displayName = nextName;
    }

    if (nextAvatar) {
      state.avatarUrl = nextAvatar;
    }

    if (state.displayName && state.avatarUrl) break;
  }

  const texts = extractLiveTextsFromSource(source);

  if (texts.liveTitle) state.liveTitle = texts.liveTitle;
  if (texts.liveDescription) state.liveDescription = texts.liveDescription;

  const combined = normalizeSpace([texts.liveTitle, texts.liveDescription].filter(Boolean).join(" "));
  if (combined) {
    state.lastSeenLiveText = combined;
  }

  updateLiveMetrics(state, source);
}

async function fetchTikTokProfileFallback(username) {
  try {
    const html = await fetchText(getTikTokProfileUrl(username));

    let avatarUrl = null;
    let displayName = null;

    const ogImageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    if (ogImageMatch?.[1]) {
      avatarUrl = normalizeImageUrl(ogImageMatch[1]);
    }

    const sigiMatch = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s
    );

    if (sigiMatch?.[1]) {
      try {
        const data = JSON.parse(sigiMatch[1]);
        const whole = JSON.stringify(data);

        const avatarCandidates = [
          ...whole.matchAll(/"avatarLarger":"(https?:[^"]+)"/g),
          ...whole.matchAll(/"avatarLarge":"(https?:[^"]+)"/g),
          ...whole.matchAll(/"avatarMedium":"(https?:[^"]+)"/g),
          ...whole.matchAll(/"avatarThumb":"(https?:[^"]+)"/g),
          ...whole.matchAll(/"avatar":"(https?:[^"]+)"/g),
        ].map((m) => normalizeImageUrl(m[1]));

        avatarUrl = avatarUrl || avatarCandidates.find(Boolean) || null;

        const nicknameMatch = whole.match(/"nickname":"([^"]+)"/);
        if (nicknameMatch?.[1] && isValidDisplayName(nicknameMatch[1], username)) {
          displayName = nicknameMatch[1];
        }
      } catch {}
    }

    return {
      avatarUrl: avatarUrl || null,
      displayName: isValidDisplayName(displayName, username) ? displayName : null,
    };
  } catch (err) {
    console.warn(`[${username}] profile fallback failed:`, err?.message || err);
    return {
      avatarUrl: null,
      displayName: null,
    };
  }
}

async function refreshProfileIfNeeded(state, force = false) {
  const now = Date.now();

  if (
    !force &&
    state.lastProfileRefreshAt &&
    now - state.lastProfileRefreshAt < PROFILE_REFRESH_COOLDOWN_MS
  ) {
    return;
  }

  state.lastProfileRefreshAt = now;

  const fallback = await fetchTikTokProfileFallback(state.username);
  if (fallback.displayName) state.displayName = fallback.displayName;
  if (fallback.avatarUrl) state.avatarUrl = fallback.avatarUrl;

  if (!isValidDisplayName(state.displayName, state.username)) {
    state.displayName = state.username;
  }
}

/* =========================================================
   IMAGE HELPERS
========================================================= */
async function safeLoadImage(url, width = 1280, height = 720, fallbackType = "bg") {
  try {
    if (!url) throw new Error("Empty image url");
    const buffer = await fetchImageBuffer(url);
    return await loadImage(buffer);
  } catch (error) {
    console.warn("safeLoadImage fallback:", error?.message || error);

    const fallback = createCanvas(width, height);
    const ctx = fallback.getContext("2d");

    if (fallbackType === "avatar") {
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, "#111827");
      grad.addColorStop(1, "#374151");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `96px ${getFontFamily("bold")}`;
      ctx.fillText("?", width / 2, height / 2 + 6);
      return fallback;
    }

    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, "#111827");
    grad.addColorStop(0.5, "#0f172a");
    grad.addColorStop(1, "#020617");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    return fallback;
  }
}

function drawBadge(ctx, text, x, y, fill = "rgba(255,255,255,0.14)") {
  ctx.save();
  ctx.font = `24px ${getFontFamily("bold")}`;
  const paddingX = 18;
  const boxH = 46;
  const textWidth = ctx.measureText(text).width;
  const boxW = textWidth + paddingX * 2;

  ctx.fillStyle = fill;
  roundRect(ctx, x, y, boxW, boxH, 14);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + paddingX, y + boxH / 2 + 1);
  ctx.restore();
}

function drawCenteredText(ctx, text, x, y, options = {}) {
  const {
    font = `60px ${getFontFamily("bold")}`,
    fillStyle = "#ffffff",
    strokeStyle = "rgba(0,0,0,0.75)",
    lineWidth = 8,
  } = options;

  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.fillStyle = fillStyle;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
  ctx.restore();
}

async function createLiveBanner({ username, displayName, avatarUrl }) {
  const width = 1280;
  const height = 720;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = await safeLoadImage(LIVE_BG_URL, width, height, "bg");
  ctx.drawImage(bg, 0, 0, width, height);

  const overlay = ctx.createLinearGradient(0, 0, 0, height);
  overlay.addColorStop(0, "rgba(0,0,0,0.20)");
  overlay.addColorStop(0.55, "rgba(0,0,0,0.45)");
  overlay.addColorStop(1, "rgba(0,0,0,0.82)");
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createLinearGradient(0, 0, width, height);
  glow.addColorStop(0, "rgba(37,244,238,0.10)");
  glow.addColorStop(0.5, "rgba(0,0,0,0)");
  glow.addColorStop(1, "rgba(254,44,85,0.18)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 2;
  roundRect(ctx, 28, 28, width - 56, height - 56, 28);
  ctx.stroke();
  ctx.restore();

  drawBadge(ctx, "TIKTOK LIVE", 55, 52, "rgba(254,44,85,0.22)");

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `36px ${getFontFamily("bold")}`;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fillText(SERVER_NAME, width / 2, 56);
  ctx.restore();

  const avatar = await safeLoadImage(avatarUrl, 512, 512, "avatar");
  const avatarSize = 220;
  const avatarX = width / 2 - avatarSize / 2;
  const avatarY = 132;
  const avatarCenterX = width / 2;
  const avatarCenterY = avatarY + avatarSize / 2;

  ctx.save();
  ctx.shadowColor = "#fe2c55";
  ctx.shadowBlur = 42;
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 12, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 6, 0, Math.PI * 2);
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.restore();

  drawCenteredText(ctx, "LIVE NOW", width / 2, 470, {
    font: `92px ${getFontFamily("bold")}`,
    fillStyle: "#ffffff",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 12,
  });

  const safeDisplayName = sanitizeText(displayName || username, 32);
  const nameFont = fitText(ctx, safeDisplayName, 900, 54, 20, "bold");
  drawCenteredText(ctx, safeDisplayName, width / 2, 555, {
    font: `${nameFont}px ${getFontFamily("bold")}`,
    fillStyle: "#f8fafc",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 8,
  });

  const handle = `@${sanitizeText(username, 32)}`;
  const handleFont = fitText(ctx, handle, 700, 32, 18, "regular");
  drawCenteredText(ctx, handle, width / 2, 610, {
    font: `${handleFont}px ${getFontFamily("regular")}`,
    fillStyle: "rgba(255,255,255,0.95)",
    strokeStyle: "rgba(0,0,0,0.65)",
    lineWidth: 6,
  });

  ctx.save();
  const lineGrad = ctx.createLinearGradient(width / 2 - 190, 0, width / 2 + 190, 0);
  lineGrad.addColorStop(0, "#25f4ee");
  lineGrad.addColorStop(1, "#fe2c55");
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(width / 2 - 185, 650);
  ctx.lineTo(width / 2 + 185, 650);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `28px ${getFontFamily("regular")}`;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.fillText("Jangan sampai ketinggalan live-nya!", width / 2, 686);
  ctx.restore();

  return canvas.encode("png");
}

async function createEndLiveBanner({ username, displayName, avatarUrl }) {
  const width = 1280;
  const height = 720;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = await safeLoadImage(LIVE_BG_URL, width, height, "bg");
  ctx.drawImage(bg, 0, 0, width, height);

  const overlay = ctx.createLinearGradient(0, 0, 0, height);
  overlay.addColorStop(0, "rgba(0,0,0,0.30)");
  overlay.addColorStop(0.55, "rgba(0,0,0,0.55)");
  overlay.addColorStop(1, "rgba(0,0,0,0.88)");
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, width, height);

  const grayGlow = ctx.createLinearGradient(0, 0, width, height);
  grayGlow.addColorStop(0, "rgba(255,255,255,0.05)");
  grayGlow.addColorStop(1, "rgba(120,120,120,0.14)");
  ctx.fillStyle = grayGlow;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 2;
  roundRect(ctx, 28, 28, width - 56, height - 56, 28);
  ctx.stroke();
  ctx.restore();

  drawBadge(ctx, "LIVE ENDED", 55, 52, "rgba(160,160,160,0.20)");

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `36px ${getFontFamily("bold")}`;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fillText(SERVER_NAME, width / 2, 56);
  ctx.restore();

  const avatar = await safeLoadImage(avatarUrl, 512, 512, "avatar");
  const avatarSize = 220;
  const avatarX = width / 2 - avatarSize / 2;
  const avatarY = 132;
  const avatarCenterX = width / 2;
  const avatarCenterY = avatarY + avatarSize / 2;

  ctx.save();
  ctx.shadowColor = "#9ca3af";
  ctx.shadowBlur = 38;
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 12, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 6, 0, Math.PI * 2);
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.restore();

  drawCenteredText(ctx, "LIVE ENDED", width / 2, 470, {
    font: `86px ${getFontFamily("bold")}`,
    fillStyle: "#ffffff",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 12,
  });

  const safeDisplayName = sanitizeText(displayName || username, 32);
  const nameFont = fitText(ctx, safeDisplayName, 900, 54, 20, "bold");
  drawCenteredText(ctx, safeDisplayName, width / 2, 555, {
    font: `${nameFont}px ${getFontFamily("bold")}`,
    fillStyle: "#f8fafc",
    strokeStyle: "rgba(0,0,0,0.78)",
    lineWidth: 8,
  });

  const handle = `@${sanitizeText(username, 32)}`;
  const handleFont = fitText(ctx, handle, 700, 32, 18, "regular");
  drawCenteredText(ctx, handle, width / 2, 610, {
    font: `${handleFont}px ${getFontFamily("regular")}`,
    fillStyle: "rgba(255,255,255,0.92)",
    strokeStyle: "rgba(0,0,0,0.65)",
    lineWidth: 6,
  });

  ctx.save();
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(width / 2 - 185, 650);
  ctx.lineTo(width / 2 + 185, 650);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `28px ${getFontFamily("regular")}`;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText("Live sudah selesai. Sampai jumpa di live berikutnya!", width / 2, 686);
  ctx.restore();

  return canvas.encode("png");
}

/* =========================================================
   STATE
========================================================= */
function createState(username) {
  const conn = new TikTokLiveConnection(username);

  const state = {
    username,
    conn,

    isLive: false,
    isConnecting: false,
    announcedLive: false,
    endAnnounced: false,
    liveMessageSent: false,
    isSendingLiveAnnouncement: false,

    roomId: null,
    lastLiveAt: null,
    lastEndedAt: null,
    lastProfileRefreshAt: 0,
    lastConnectAttemptAt: 0,

    displayName: username,
    avatarUrl: null,

    liveTitle: null,
    liveDescription: null,
    lastSeenLiveText: null,

    viewers: null,
    likes: 0,
    diamonds: 0,

    sessionStartAt: null,
    sessionEndAt: null,
    peakViewers: 0,
    lastKnownViewers: 0,
    totalLikes: 0,

    lastPollLive: false,
    offlineTicks: 0,
    activeSessionId: null,
  };

  bindTikTokEvents(state);
  return state;
}

function getState(username) {
  if (!liveStates.has(username)) {
    liveStates.set(username, createState(username));
  }
  return liveStates.get(username);
}

function resetSessionMetrics(state) {
  state.sessionStartAt = nowIso();
  state.sessionEndAt = null;
  state.peakViewers = 0;
  state.lastKnownViewers = 0;
  state.likes = 0;
  state.totalLikes = 0;
  state.diamonds = 0;
}

function updateLiveMetrics(state, source) {
  if (!source) return;

  const viewersNow =
    source?.stats?.userCount ??
    source?.stats?.viewerCount ??
    source?.stats?.totalUser ??
    source?.viewerCount ??
    source?.total ??
    source?.roomInfo?.stats?.userCount ??
    null;

  const likesNow =
    source?.stats?.likeCount ??
    source?.stats?.totalLikeCount ??
    source?.likeCount ??
    source?.totalLikeCount ??
    source?.roomInfo?.stats?.likeCount ??
    null;

  const diamondsNow =
    source?.stats?.diamondCount ??
    source?.diamondCount ??
    source?.roomInfo?.stats?.diamondCount ??
    null;

  if (viewersNow != null) {
    state.viewers = viewersNow;
    state.lastKnownViewers = viewersNow;
    state.peakViewers = Math.max(state.peakViewers || 0, viewersNow);
  }

  if (likesNow != null) {
    state.likes = likesNow;
    state.totalLikes = Math.max(state.totalLikes || 0, likesNow);
  }

  if (diamondsNow != null) {
    state.diamonds = diamondsNow;
  }
}

/* =========================================================
   DISCORD MESSAGE BUILDERS
========================================================= */
function buildLiveEmbed(state) {
  const lines = [
    `**Nama Profil:** ${state.displayName || state.username}`,
    `**Username:** [@${state.username}](${getTikTokUrl(state.username)})`,
    state.roomId ? `**Room ID:** \`${state.roomId}\`` : null,
    state.viewers != null ? `**Viewer:** ${fmtNumber(state.viewers)}` : null,
    "",
    "🔴 **Sedang LIVE sekarang**",
    "",
    "Klik tombol di bawah untuk langsung masuk ke TikTok LIVE.",
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(0xfe2c55)
    .setTitle("🔴 TikTok LIVE Terdeteksi")
    .setDescription(lines.join("\n"))
    .setURL(getTikTokUrl(state.username))
    .setFooter({ text: `Detected at ${fmtDateID(nowIso())} WIB` })
    .setTimestamp();

  if (state.avatarUrl) {
    embed.setThumbnail(state.avatarUrl);
  }

  return embed;
}

function buildEndLiveEmbed(state) {
  const lines = [
    `**Nama Profil:** ${state.displayName || state.username}`,
    `**Username:** [@${state.username}](${getTikTokUrl(state.username)})`,
    state.roomId ? `**Room ID:** \`${state.roomId}\`` : null,
    "",
    "📊 **Rekap Hasil Live**",
    `**Mulai Live:** ${state.sessionStartAt ? `${fmtDateID(state.sessionStartAt)} WIB` : "-"}`,
    `**Selesai Live:** ${state.sessionEndAt ? `${fmtDateID(state.sessionEndAt)} WIB` : "-"}`,
    `**Durasi Live:** ${fmtDuration(state.sessionStartAt, state.sessionEndAt)}`,
    `**Viewer Terakhir:** ${fmtNumber(state.lastKnownViewers)}`,
    `**Peak Viewer:** ${fmtNumber(state.peakViewers)}`,
    `**Total Like:** ${fmtNumber(state.totalLikes)}`,
    `**Diamond:** ${fmtNumber(state.diamonds)}`,
    "",
    "Live barusan sudah berakhir.",
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(0x9ca3af)
    .setTitle("⏹️ TikTok LIVE Selesai")
    .setDescription(lines.join("\n"))
    .setURL(getTikTokUrl(state.username))
    .setFooter({ text: `Ended at ${fmtDateID(nowIso())} WIB` })
    .setTimestamp();

  if (state.avatarUrl) {
    embed.setThumbnail(state.avatarUrl);
  }

  return embed;
}

function buildButtons(state) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("🎥 Buka TikTok")
        .setStyle(ButtonStyle.Link)
        .setURL(getTikTokUrl(state.username)),
      new ButtonBuilder()
        .setCustomId(`register_tiktok_live:${state.username}`)
        .setLabel("📝 Daftarkan TikTok Live Saya")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

/* =========================================================
   ANNOUNCE CHANNEL
========================================================= */
async function getAnnounceChannel() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(LIVE_ANNOUNCE_CHANNEL_ID);

  if (!channel) throw new Error("LIVE_ANNOUNCE_CHANNEL_ID not found");

  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    throw new Error("LIVE_ANNOUNCE_CHANNEL_ID must be text/announcement channel");
  }

  return channel;
}

async function sendAndPublish(channel, payload) {
  const message = await channel.send(payload);

  if (channel.type === ChannelType.GuildAnnouncement) {
    try {
      await message.crosspost();
      console.log(`[channel:${channel.id}] published`);
    } catch (err) {
      console.warn(`[channel:${channel.id}] crosspost failed:`, err?.message || err);
    }
  }

  return message;
}

/* =========================================================
   ANNOUNCEMENTS
========================================================= */
async function sendLiveAnnouncement(state) {
  const channel = await getAnnounceChannel();

  await refreshProfileIfNeeded(state, true);

  const bannerBuffer = await createLiveBanner({
    username: state.username,
    displayName: state.displayName || state.username,
    avatarUrl: state.avatarUrl,
  });

  const bannerAttachment = new AttachmentBuilder(bannerBuffer, {
    name: `tiktok-live-${state.username}-${Date.now()}.png`,
  });

  const intro = `🔴 **${state.displayName || state.username}** sedang LIVE di TikTok!`;

  await sendAndPublish(channel, {
    content: MENTION_EVERYONE ? `🚨 @everyone\n${intro}` : intro,
    files: [bannerAttachment],
    embeds: [buildLiveEmbed(state)],
    components: buildButtons(state),
    allowedMentions: MENTION_EVERYONE ? { parse: ["everyone"] } : {},
  });

  return true;
}

async function sendEndLiveAnnouncement(state) {
  const channel = await getAnnounceChannel();

  await refreshProfileIfNeeded(state, false);
  state.sessionEndAt = state.sessionEndAt || nowIso();

  const bannerBuffer = await createEndLiveBanner({
    username: state.username,
    displayName: state.displayName || state.username,
    avatarUrl: state.avatarUrl,
  });

  const bannerAttachment = new AttachmentBuilder(bannerBuffer, {
    name: `tiktok-ended-${state.username}-${Date.now()}.png`,
  });

  await sendAndPublish(channel, {
    content:
      `⏹️ **${state.displayName || state.username}** sudah selesai LIVE di TikTok.\n\n` +
      `📊 **Rekap Live**\n` +
      `• Durasi: ${fmtDuration(state.sessionStartAt, state.sessionEndAt)}\n` +
      `• Viewer terakhir: ${fmtNumber(state.lastKnownViewers)}\n` +
      `• Peak viewer: ${fmtNumber(state.peakViewers)}\n` +
      `• Total like: ${fmtNumber(state.totalLikes)}\n` +
      `• Diamond: ${fmtNumber(state.diamonds)}`,
    files: [bannerAttachment],
    embeds: [buildEndLiveEmbed(state)],
    components: buildButtons(state),
  });

  return true;
}

function resetLiveFlagsAfterEnd(state) {
  state.isLive = false;
  state.isConnecting = false;
  state.announcedLive = false;
  state.liveMessageSent = false;
  state.isSendingLiveAnnouncement = false;
  state.endAnnounced = false;

  state.roomId = null;
  state.viewers = null;
  state.likes = 0;
  state.diamonds = 0;

  state.liveTitle = null;
  state.liveDescription = null;
  state.lastSeenLiveText = null;

  state.sessionStartAt = null;
  state.sessionEndAt = null;
  state.peakViewers = 0;
  state.lastKnownViewers = 0;
  state.totalLikes = 0;

  state.lastEndedAt = nowIso();
  state.activeSessionId = null;
  state.offlineTicks = 0;

  try {
    state.conn.disconnect();
  } catch {}
}

async function announceLiveIfNeeded(state) {
  if (state.liveMessageSent || state.isSendingLiveAnnouncement) return;

  if (!matchesRequiredKeyword(state)) {
    console.log(
      `[${state.username}] skip broadcast: keyword not matched | title="${state.liveTitle || "-"}" desc="${state.liveDescription || "-"}" text="${state.lastSeenLiveText || "-"}"`
    );
    return;
  }

  state.isSendingLiveAnnouncement = true;

  try {
    const sent = await sendLiveAnnouncement(state);
    if (!sent) return;

    state.liveMessageSent = true;
    state.announcedLive = true;
    console.log(`[${state.username}] live announcement sent`);
  } catch (err) {
    console.error(`[${state.username}] failed live announcement:`, err);
  } finally {
    state.isSendingLiveAnnouncement = false;
  }
}

async function announceEndIfNeeded(state) {
  if (state.endAnnounced) return;

  const canSendEndAnnouncement =
    state.liveMessageSent || state.announcedLive || !!state.activeSessionId || !!state.sessionStartAt;

  if (!canSendEndAnnouncement) {
    console.log(`[${state.username}] end not sent because no active live session was recorded`);
    return;
  }

  try {
    const sent = await sendEndLiveAnnouncement(state);
    if (!sent) return;

    state.endAnnounced = true;
    console.log(`[${state.username}] end announcement sent`);
  } catch (err) {
    console.error(`[${state.username}] failed end announcement:`, err);
  }
}

/* =========================================================
   TIKTOK EVENTS
========================================================= */
function bindTikTokEvents(state) {
  const { conn, username } = state;

  conn.on(ControlEvent.CONNECTED, async (connState) => {
    state.isConnecting = false;
    state.isLive = true;
    state.offlineTicks = 0;
    state.lastPollLive = true;
    state.roomId = connState?.roomId || state.roomId;
    state.lastLiveAt = state.lastLiveAt || nowIso();
    state.activeSessionId = state.activeSessionId || `${username}:${Date.now()}`;

    if (!state.sessionStartAt) {
      resetSessionMetrics(state);
    }

    state.endAnnounced = false;

    extractProfileFromAny(state, connState);

    console.log(`[${username}] CONNECTED roomId=${state.roomId || "-"}`);

    await announceLiveIfNeeded(state);
  });

  conn.on(ControlEvent.DISCONNECTED, ({ code, reason }) => {
    console.log(`[${username}] DISCONNECTED code=${code} reason=${reason || "-"}`);
    state.isConnecting = false;
  });

  conn.on(ControlEvent.ERROR, ({ info, exception }) => {
    console.error(`[${username}] ERROR:`, info || exception || "unknown error");
    state.isConnecting = false;
  });

  conn.on(WebcastEvent.LIVE_INTRO, async (msg) => {
    extractProfileFromAny(state, msg);
    await announceLiveIfNeeded(state);
  });

  conn.on(WebcastEvent.ROOM_USER, async (msg) => {
    extractProfileFromAny(state, msg);
    await announceLiveIfNeeded(state);
  });

  conn.on(WebcastEvent.LIKE, async (msg) => {
    updateLiveMetrics(state, msg);
  });

  conn.on(WebcastEvent.SOCIAL, async (msg) => {
    updateLiveMetrics(state, msg);
  });

  conn.on(WebcastEvent.GIFT, async (msg) => {
    updateLiveMetrics(state, msg);
  });

  conn.on(WebcastEvent.ROOM_STATS, async (msg) => {
    updateLiveMetrics(state, msg);
  });

  conn.on(WebcastEvent.STREAM_END, async ({ action }) => {
    console.log(`[${username}] STREAM_END action=${action}`);
    state.sessionEndAt = nowIso();
    await announceEndIfNeeded(state);
    resetLiveFlagsAfterEnd(state);
  });
}

async function connectToLiveRoomIfNeeded(state) {
  if (state.isConnecting) return;

  const isConnected = !!state.conn.getState?.()?.isConnected;
  if (isConnected) return;

  const now = Date.now();

  if (
    state.lastConnectAttemptAt &&
    now - state.lastConnectAttemptAt < CONNECT_COOLDOWN_MS
  ) {
    console.log(`[${state.username}] connect skipped by cooldown`);
    return;
  }

  state.lastConnectAttemptAt = now;
  state.isConnecting = true;

  try {
    await state.conn.connect();
  } catch (err) {
    console.warn(`[${state.username}] connect failed:`, err?.message || err);
  } finally {
    state.isConnecting = false;
  }
}

/* =========================================================
   POLLING
========================================================= */
async function handlePolledOffline(state) {
  state.offlineTicks += 1;
  state.lastPollLive = false;

  const hadActiveSession =
    state.isLive || state.liveMessageSent || state.announcedLive || !!state.activeSessionId;

  if (!hadActiveSession) {
    return;
  }

  if (state.offlineTicks < OFFLINE_CONFIRM_TICKS) {
    console.log(
      `[${state.username}] offline tick ${state.offlineTicks}/${OFFLINE_CONFIRM_TICKS}`
    );
    return;
  }

  console.log(`[${state.username}] confirmed offline, sending end announcement`);
  state.sessionEndAt = nowIso();
  await announceEndIfNeeded(state);
  resetLiveFlagsAfterEnd(state);
}

async function handlePolledLive(state) {
  state.offlineTicks = 0;
  state.lastPollLive = true;
  state.isLive = true;
  state.lastLiveAt = state.lastLiveAt || nowIso();
  state.activeSessionId = state.activeSessionId || `${state.username}:${Date.now()}`;

  if (!state.sessionStartAt) {
    resetSessionMetrics(state);
  }

  state.endAnnounced = false;

  await refreshProfileIfNeeded(state, false);
  await announceLiveIfNeeded(state);
  await connectToLiveRoomIfNeeded(state);
}

async function sweepTikTokLives() {
  for (const username of TIKTOK_USERNAMES) {
    const state = getState(username);

    try {
      const liveNow = await state.conn.fetchIsLive();
      console.log(`[${username}] poll live=${liveNow}`);

      if (liveNow) {
        await handlePolledLive(state);
      } else {
        await handlePolledOffline(state);
      }

      await sleep(1200);
    } catch (err) {
      console.warn(`[${username}] fetchIsLive failed:`, err?.message || err);
    }
  }
}

/* =========================================================
   TICKET HELPERS
========================================================= */
async function createLiveTikTokTicket({ guild, requester, username }) {
  const cleanUsername = normalizeUsername(username);

  const channel = await guild.channels.create({
    name: buildTicketChannelName(cleanUsername, requester.id),
    type: ChannelType.GuildText,
    parent: TIKTOK_TICKET_CATEGORY_ID,
    topic: buildTicketMeta({
      type: "livetiktok",
      username: cleanUsername,
      requesterId: requester.id,
      status: "open",
      doneAt: "",
    }),
  });

  await channel.permissionOverwrites.edit(requester.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });

  await channel.permissionOverwrites.edit(client.user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    ManageChannels: true,
    ManageMessages: true,
  });

  const embed = new EmbedBuilder()
    .setColor(0xfe2c55)
    .setTitle("🎫 Ticket Pendaftaran TikTok Live")
    .setDescription(
      [
        `**Pemohon:** ${requester}`,
        `**User ID:** \`${requester.id}\``,
        `**Username TikTok:** \`${cleanUsername}\``,
        "",
        `<@&${STAFF_ROLE_ID}> silakan proses ticket ini.`,
        "Jika sudah selesai, klik tombol **DONE** di bawah.",
      ].join("\n")
    )
    .setFooter({ text: `Created at ${fmtDateID(nowIso())} WIB` })
    .setTimestamp();

  await channel.send({
    content: `${requester} <@&${STAFF_ROLE_ID}>`,
    embeds: [embed],
    components: buildTicketButtons(cleanUsername, false),
    allowedMentions: {
      users: [requester.id],
      roles: [STAFF_ROLE_ID],
    },
  });

  return channel;
}

async function lockTicketForUser(channel, requesterId) {
  try {
    await channel.permissionOverwrites.edit(requesterId, {
      SendMessages: false,
    });
  } catch (err) {
    console.warn("Failed locking ticket for user:", err?.message || err);
  }
}

async function closeTicketChannel(channel, reason = "Closed") {
  try {
    await channel.send(`🔒 Ticket akan ditutup. Alasan: **${reason}**`);
  } catch {}

  setTimeout(async () => {
    try {
      await channel.delete(`Auto close ticket: ${reason}`);
    } catch (err) {
      console.warn("Failed deleting ticket channel:", err?.message || err);
    }
  }, 5_000).unref();
}

async function scheduleAutoCloseTicket(channel) {
  setTimeout(async () => {
    try {
      const fresh = await channel.guild.channels.fetch(channel.id).catch(() => null);
      if (!fresh) return;

      const meta = parseTicketMeta(fresh.topic || "");
      if (meta.status !== "done") return;

      await fresh.send("⏰ 30 menit telah berlalu. Ticket akan ditutup otomatis.");
      await closeTicketChannel(fresh, "Auto close setelah DONE");
    } catch (err) {
      console.warn("Failed auto close ticket:", err?.message || err);
    }
  }, 30 * 60 * 1000).unref();
}

async function markTicketDone({ interaction, channel, meta, username }) {
  await channel.setTopic(
    buildTicketMeta({
      type: "livetiktok",
      username: meta.username,
      requesterId: meta.requesterId,
      status: "done",
      doneAt: nowIso(),
    })
  );

  await lockTicketForUser(channel, meta.requesterId);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle("✅ Pendaftaran TikTok Live Sudah Diproses")
        .setDescription(
          [
            `Pendaftaran untuk username TikTok \`${meta.username}\` sudah diproses oleh ${interaction.user}.`,
            "",
            `<@${meta.requesterId}> sekarang ticket ini telah selesai diproses.`,
            "Kamu sudah tidak bisa mengirim chat lagi di ticket ini.",
            "Ticket akan otomatis ditutup dalam **30 menit**.",
          ].join("\n")
        )
        .setTimestamp(),
    ],
    components: buildTicketButtons(username || meta.username, true),
  });

  await interaction.reply({
    content:
      "✅ Ticket ditandai selesai, user sudah diberi info, channel dikunci, dan auto close 30 menit dijadwalkan.",
    ephemeral: true,
  });

  await scheduleAutoCloseTicket(channel);
}

/* =========================================================
   INTERACTIONS
========================================================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const parts = String(interaction.customId || "").split(":");
      const action = parts[0];
      const value = parts[1];

      if (action === "register_tiktok_live") {
        const modal = new ModalBuilder()
          .setCustomId(`register_tiktok_live_modal:${value || ""}`)
          .setTitle("Daftarkan TikTok Live Saya");

        const usernameInput = new TextInputBuilder()
          .setCustomId("tiktok_username")
          .setLabel("Masukkan username TikTok")
          .setPlaceholder("contoh: undercoverlive")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50);

        modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));

        await interaction.showModal(modal);
        return;
      }

      if (action === "livetiktok_agree") {
        const username = normalizeUsername(value);

        await interaction.update({
          embeds: [buildTermsEmbed(username)],
          components: buildTermsButtons(username, true),
          content: "✅ Kamu sudah menyetujui S&K. Sekarang klik **Submit**.",
        });
        return;
      }

      if (action === "livetiktok_cancel") {
        await interaction.update({
          content: "❌ Pendaftaran dibatalkan.",
          embeds: [],
          components: [],
        });
        return;
      }

      if (action === "livetiktok_submit") {
        const username = normalizeUsername(parts[1]);
        const agreed = parts[2] === "1";

        if (!agreed) {
          await interaction.reply({
            content: "❌ Kamu harus klik **Saya Setuju** dulu sebelum submit.",
            ephemeral: true,
          });
          return;
        }

        if (!username) {
          await interaction.reply({
            content: "❌ Username TikTok tidak valid.",
            ephemeral: true,
          });
          return;
        }

        const guild = interaction.guild;
        const requester = interaction.user;

        const existing = guild.channels.cache.find((ch) => {
          if (ch.type !== ChannelType.GuildText) return false;
          const meta = parseTicketMeta(ch.topic || "");
          return (
            meta.type === "livetiktok" &&
            meta.requesterId === requester.id &&
            meta.username === username &&
            meta.status === "open"
          );
        });

        if (existing) {
          await interaction.reply({
            content: `⚠️ Kamu sudah punya ticket aktif untuk username \`${username}\`: ${existing}`,
            ephemeral: true,
          });
          return;
        }

        const ticketChannel = await createLiveTikTokTicket({
          guild,
          requester,
          username,
        });

        await interaction.update({
          content: `✅ Ticket berhasil dibuat: ${ticketChannel}`,
          embeds: [],
          components: [],
        });
        return;
      }

      if (action === "copy_username") {
        await interaction.reply({
          content: `📋 Username TikTok: \`${value}\``,
          ephemeral: true,
        });
        return;
      }

      if (action === "ticket_done") {
        const member = interaction.member;
        const channel = interaction.channel;

        if (!canUseDoneButton(member, channel)) {
          await interaction.reply({
            content: "❌ Hanya staff yang memiliki role yang sesuai yang bisa klik tombol DONE.",
            ephemeral: true,
          });
          return;
        }

        const meta = parseTicketMeta(channel.topic || "");
        if (meta.type !== "livetiktok") {
          await interaction.reply({
            content: "❌ Tombol ini hanya bisa dipakai di channel ticket TikTok Live.",
            ephemeral: true,
          });
          return;
        }

        if (!meta.requesterId) {
          await interaction.reply({
            content: "❌ Data requester ticket tidak ditemukan.",
            ephemeral: true,
          });
          return;
        }

        if (meta.status === "done") {
          await interaction.reply({
            content: "⚠️ Ticket ini sudah ditandai DONE sebelumnya.",
            ephemeral: true,
          });
          return;
        }

        await markTicketDone({
          interaction,
          channel,
          meta,
          username: normalizeUsername(value || meta.username),
        });
        return;
      }

      if (action === "close_ticket") {
        const member = interaction.member;
        const channel = interaction.channel;

        if (!canUseDoneButton(member, channel)) {
          await interaction.reply({
            content: "❌ Kamu tidak punya izin untuk menutup ticket ini.",
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: "🔒 Ticket akan ditutup.",
          ephemeral: true,
        });

        await closeTicketChannel(channel, "Ditutup manual");
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const [action] = String(interaction.customId || "").split(":");

      if (action === "register_tiktok_live_modal") {
        const username = normalizeUsername(
          interaction.fields.getTextInputValue("tiktok_username")
        );

        if (!username) {
          await interaction.reply({
            content: "❌ Username TikTok tidak valid. Gunakan username, bukan nama profil.",
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          ephemeral: true,
          embeds: [buildTermsEmbed(username)],
          components: buildTermsButtons(username, false),
        });
        return;
      }
    }
  } catch (err) {
    console.error("interaction error:", err);

    if (interaction.isRepliable()) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: "❌ Terjadi error saat memproses permintaan.",
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: "❌ Terjadi error saat memproses permintaan.",
            ephemeral: true,
          });
        }
      } catch {}
    }
  }
});

/* =========================================================
   STARTUP
========================================================= */
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Monitoring: ${TIKTOK_USERNAMES.join(", ")}`);
  console.log(`STAFF_ROLE_ID: ${STAFF_ROLE_ID}`);
  console.log(`POLL_INTERVAL_SECONDS: ${POLL_INTERVAL_SECONDS}`);
  console.log(`OFFLINE_CONFIRM_TICKS: ${OFFLINE_CONFIRM_TICKS}`);
  console.log(`CONNECT_COOLDOWN_MS: ${CONNECT_COOLDOWN_MS}`);
  console.log(`PROFILE_REFRESH_COOLDOWN_MS: ${PROFILE_REFRESH_COOLDOWN_MS}`);
  console.log(`REQUIRED_LIVE_KEYWORDS: ${REQUIRED_LIVE_KEYWORDS.join(", ") || "-"}`);
  console.log(`DEBUG_TIKTOK_RAW: ${DEBUG_TIKTOK_RAW}`);

  try {
    await getAnnounceChannel();
    console.log("Announcement channel OK");
  } catch (err) {
    console.error("Announcement channel error:", err);
    process.exit(1);
  }

  await sweepTikTokLives();

  setInterval(async () => {
    try {
      await sweepTikTokLives();
    } catch (err) {
      console.error("sweepTikTokLives error:", err);
    }
  }, POLL_INTERVAL_SECONDS * 1000).unref();
});

client.login(DISCORD_TOKEN);