// ═══════════════════════════════════════════════════════════════════
//  3D2Y Bot — Standalone
//
//  Cài đặt:
//    npm install mineflayer mineflayer-pathfinder mineflayer-collectblock mineflayer-pvp minecraft-data
//
//  Chạy:
//    node bot.js
//
//  Env vars (tuỳ chọn):
//    BOT_HOST, BOT_PORT, BOT_USERNAME, BOT_VERSION, GEMINI_API_KEY
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── TRẠNG THÁI CỐT LÕI (phải khai báo trước error guard) ──────────
let isRejoining = false;
let lastError = '';

// ── GLOBAL ERROR GUARD (ngăn crash vì EPIPE / mất mạng) ───────────
process.on('uncaughtException', (err) => {
  const msg = `UncaughtException: ${err.code||''} ${err.message}`.trim();
  lastError = msg;
  console.error(`[GUARD] ${msg}`);
  // Chỉ rejoin với lỗi mạng và khi chưa đang rejoin
  // (bot.on('error') cũng bắt các lỗi này — guard này là lưới bảo vệ)
  if (!isRejoining && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT')) {
    handleRejoin();
  }
  // Với mọi lỗi khác: chỉ log, KHÔNG crash
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[GUARD] UnhandledRejection: ${msg}`);
});

// ── CẤU HÌNH ──────────────────────────────────────────────────────
const CONFIG = {
  host:       process.env.BOT_HOST      || 'Khanh-Khi.aternos.me',
  port:       parseInt(process.env.BOT_PORT  || '52717'),
  username:   process.env.BOT_USERNAME  || 'KhanhKhi',
  version:    process.env.BOT_VERSION   || '1.21.11',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  aiDecisionKey: process.env.AI_DECISION_KEY || '',
  // Multi-key rotation: tự chuyển key khi hết quota (mỗi key cách nhau bằng dấu phẩy trong env)
  chatKeys: (process.env.GEMINI_CHAT_KEYS || '').split(',').map(k=>k.trim()).filter(Boolean),
  decisionKeys: (process.env.GEMINI_DECISION_KEYS || '').split(',').map(k=>k.trim()).filter(Boolean),
  allowedDropUsers: [],
};
// ──────────────────────────────────────────────────────────────────

const http         = require('http');
const Vec3         = require('vec3');
const mineflayer   = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalXZ, GoalLookAtBlock, GoalNear } = goals;
const collectBlock = require('mineflayer-collectblock').plugin;
const pvp          = require('mineflayer-pvp').plugin;
const mcDataLoader = require('minecraft-data');
const fs           = require('fs');
const util         = require('util');
const path         = require('path');
const zlib         = require('zlib');
const gunzip       = util.promisify(zlib.gunzip);

// ── PRISMARINE-NBT (lazy-load, optional) ──────────────────────────
let _nbt = null;
async function getNbt() {
  if (_nbt) return _nbt;
  try { _nbt = require('prismarine-nbt'); return _nbt; } catch(e) {
    try { _nbt = (await import('prismarine-nbt')).default || (await import('prismarine-nbt')); return _nbt; } catch(_) {}
  }
  return null;
}

// ── CONFIG PERSISTENCE ────────────────────────────────────────────
const BOT_CONFIG_FILE     = 'bot_config.json';
const BUILD_PROGRESS_FILE = 'build_progress.json'; // lưu tiến trình xây để resume
try {
  if (fs.existsSync(BOT_CONFIG_FILE)) {
    const _sc = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8'));
    if (_sc.host)     CONFIG.host     = _sc.host;
    if (_sc.port)     CONFIG.port     = _sc.port;
    if (_sc.username) CONFIG.username = _sc.username;
    if (_sc.version)  CONFIG.version  = _sc.version;
  }
} catch(_) {}
// Env vars từ bot-manager server luôn có độ ưu tiên cao hơn file
if (process.env.BOT_HOST)     CONFIG.host     = process.env.BOT_HOST;
if (process.env.BOT_PORT)     CONFIG.port     = parseInt(process.env.BOT_PORT, 10);
if (process.env.BOT_USERNAME) CONFIG.username = process.env.BOT_USERNAME;
if (process.env.BOT_VERSION)  CONFIG.version  = process.env.BOT_VERSION;

const fetchFn = typeof fetch !== 'undefined'
  ? fetch
  : (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// ── MOB THÙ ───────────────────────────────────────────────────────
const HOSTILE_MOBS = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','enderman','witch',
  'slime','magma_cube','blaze','ghast','wither_skeleton','stray','husk',
  'drowned','phantom','pillager','vindicator','ravager','evoker','vex',
  'guardian','elder_guardian','shulker','silverfish','endermite','hoglin',
  'zoglin','piglin_brute','warden','zombified_piglin','zombie_pigman',
]);

// ── TRẠNG THÁI ────────────────────────────────────────────────────
let bot = null, mcData = null;
let isBusy = false, stopTask = false, isFollowing = false, isEating = false, isHunting = false;
let _autoLootBusy = false; // mutex: ngăn autoLootNearby chạy đồng thời
let _autoLootNearbyFn = null; // proxy: startAutoAttack (module-level) gọi được autoLootNearby
let _autoReturning = false; // mutex: ngăn invCheckInterval và autoReturn chạy cùng lúc
let _cmdPending = false;   // cooldown: ngăn startWander ngay sau resetState
let wanderInterval = null, armorInterval = null, eatInterval = null, autoAttackInterval = null;
let pvpChallengeInterval = null, invCheckInterval = null, statusBarInterval = null, huntInterval = null;
let spawnWaitInterval = null; // interval log "đang chờ server tải" mỗi 30s
let pendingDuel = null;  // { player, timeout }
let activeDuel  = null;  // { player, fightTimeout, deathHandler }
let isFleeing   = false; // đang chạy trốn khi HP thấp trong PvP
let autoAttackEnabled = true, autoEatEnabled = true;
let rejoinAttempts = 0;
let botOnline = false; // true chỉ sau khi spawn, false khi end/kick/rejoin
let bodyguardInterval = null, bodyguardTarget = null, isFishing = false;
const pendingTrades = new Map();
const _botPlacedWaterPositions = []; // vị trí nước bot đã đặt — phải thu hồi sau khi dùng
let _waterClutchActive  = false;      // mutex: tránh clutch chồng nhau
let _waterClutchFalling = false;      // đang theo dõi rơi để kích clutch
// lastError và isRejoining đã khai báo ở trên (trước error guard)
let spawnTimeout = null; // module-level so handleRejoin can always clear it
const MAX_REJOIN = 10, REJOIN_DELAY = 2000;
let pingLoopInterval = null; // interval ping server status trước khi kết nối

// ── AI MODE ───────────────────────────────────────────────────────
let aiModeEnabled = false;       // bật/tắt AI mode
let aiDecisionInterval = null;   // interval gọi AI quyết định
let aiDecisionCooldown = false;  // chống spam quyết định liên tiếp
let aiLastDecision = null;       // { action, reason, stage, time } — lưu quyết định cuối
let aiDecisionLog  = [];         // lịch sử 50 quyết định gần nhất (broadcast qua WS)
let aiGameStage = 'early';       // giai đoạn game hiện tại
let _craftLoopInterval = null;   // interval chạy smartCraftItems
let _emergencyInterval = null;   // interval sinh tồn khẩn cấp (không tốn API)
let _aiStatusLogInterval = null; // interval broadcast AI status định kỳ
let _aiLastAction = null;        // action cuối AI chọn (chống lặp)
let _aiRepeatCount = 0;          // số lần lặp action giống nhau liên tiếp
// ── State cache để tránh gọi API khi không có gì thay đổi ────────
let _aiStateCache = null;        // { hp, food, mobCount, stage, time }
const AI_STATE_FORCE_INTERVAL = 4 * 60 * 1000; // gọi API bắt buộc mỗi 4 phút dù state không đổi
let _aiIsRetreating = false;     // đang trong quá trình retreat
let _manualOverrideUntil = 0;   // timestamp: AI nhường quyền điều khiển tới thời điểm này

// ── AI MEMORY (học hỏi theo thời gian, lưu file) ──────────────────
const AI_MEMORY_FILE = 'ai_memory.json';
let aiMemory = {
  actionCounts:   {},   // { action: số lần dùng }
  stageReached:   {},   // { stage: timestamp } — khi đạt giai đoạn nào
  craftedItems:   [],   // [{ item, time, reason }] — lịch sử craft
  notes:          [],   // ghi chú ngắn về session (max 10)
  totalDecisions: 0,
};

function loadAIMemory() {
  try {
    if (fs.existsSync(AI_MEMORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(AI_MEMORY_FILE, 'utf8'));
      aiMemory = { ...aiMemory, ...raw };
    }
  } catch(_) {}
}
function saveAIMemory() {
  try { fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(aiMemory, null, 2), 'utf8'); } catch(_) {}
}
// Ghi nhận một quyết định vào memory + broadcast realtime qua WebSocket
function recordDecision(action, stage, reason, stageTip, source) {
  aiMemory.totalDecisions = (aiMemory.totalDecisions || 0) + 1;
  aiMemory.actionCounts[action] = (aiMemory.actionCounts[action] || 0) + 1;
  if (!aiMemory.stageReached[stage]) {
    aiMemory.stageReached[stage] = Date.now();
    aiMemory.notes.push(`Đạt giai đoạn ${stage} sau ${aiMemory.totalDecisions} quyết định`);
    if (aiMemory.notes.length > 12) aiMemory.notes = aiMemory.notes.slice(-12);
  }
  // Thêm vào log lịch sử (giữ 50 gần nhất)
  const entry = { action, stage, reason: reason||'', stageTip: stageTip||'', source: source||'gemini', time: Date.now(), total: aiMemory.totalDecisions };
  aiDecisionLog.push(entry);
  if (aiDecisionLog.length > 50) aiDecisionLog = aiDecisionLog.slice(-50);
  // Broadcast realtime đến WebSocket clients qua server
  try { process.stdout.write(JSON.stringify({ __STATUS__: true, aiDecision: entry }) + '\n'); } catch(_){}
  // Lưu mỗi 5 quyết định để giảm I/O
  if (aiMemory.totalDecisions % 5 === 0) saveAIMemory();
}

// ── SMART CRAFT SYSTEM (không tốn API call) ────────────────────────
// Tìm hoặc đặt bàn crafting gần bot
async function findOrPlaceCraftingTable() {
  if (!bot || !mcData) return null;
  const tableId = mcData.blocksByName['crafting_table']?.id;
  if (!tableId) return null;
  // Tìm bàn đã đặt
  let block = bot.findBlock({ matching: tableId, maxDistance: 6 });
  if (block) return block;
  // Thử đặt từ inventory
  const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (!tableItem) return null;
  const bp = bot.entity.position.floored();
  const candidates = [
    [0,-1,1],[1,-1,0],[-1,-1,0],[0,-1,-1],
    [0,0,1],[1,0,0],[-1,0,0],[0,0,-1],
  ];
  for (const [dx, dy, dz] of candidates) {
    const target = bp.offset(dx, dy, dz);
    const b = bot.blockAt(target);
    if (b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava') {
      try {
        await bot.equip(tableItem, 'hand');
        await bot.placeBlock(b, new Vec3(0, 1, 0));
        await new Promise(r => setTimeout(r, 400));
        return bot.findBlock({ matching: tableId, maxDistance: 6 });
      } catch(_) {}
    }
  }
  return null;
}

// Danh sách ưu tiên craft theo giai đoạn (deterministic, không cần AI)
function getCraftPriority() {
  if (!bot || !mcData) return [];
  const inv = bot.inventory?.items() || [];
  const exact  = (name) => inv.filter(i => i.name === name).reduce((s,i) => s + i.count, 0);
  const hasAny = (name) => inv.some(i => i.name === name);

  const logItem = inv.find(i => i.name.endsWith('_log'));
  const plankName = logItem ? logItem.name.replace('_log', '_planks') : 'oak_planks';
  const planksTotal = inv.filter(i => i.name.endsWith('_planks')).reduce((s,i) => s + i.count, 0);
  const sticks = exact('stick');
  const stage  = detectGameStage();

  const list = [];

  // === Luôn hữu ích ===
  if (logItem && exact(plankName) < 12)
    list.push({ item: plankName, needsTable: false, reason: 'gỗ ván cơ bản', priority: 100 });

  if (planksTotal >= 2 && sticks < 8)
    list.push({ item: 'stick', needsTable: false, reason: 'cần que', priority: 95 });

  if (!hasAny('crafting_table') && planksTotal >= 4)
    list.push({ item: 'crafting_table', needsTable: false, reason: 'bàn craft cơ bản', priority: 90 });

  if (!hasAny('furnace') && exact('cobblestone') >= 8)
    list.push({ item: 'furnace', needsTable: true, reason: 'lò nung', priority: 85 });

  if (!hasAny('torch') && exact('coal') >= 1 && sticks >= 1)
    list.push({ item: 'torch', needsTable: false, reason: 'đuốc sáng', priority: 70 });

  // === Stone stage ===
  if (['wood','stone','iron','diamond','nether','pre_end'].includes(stage)) {
    if (!hasAny('stone_pickaxe') && exact('cobblestone') >= 3 && sticks >= 2)
      list.push({ item: 'stone_pickaxe', needsTable: true, reason: 'cuốc đá mạnh hơn', priority: 88 });
    if (!hasAny('stone_sword') && exact('cobblestone') >= 2 && sticks >= 1)
      list.push({ item: 'stone_sword', needsTable: true, reason: 'kiếm đá chiến đấu', priority: 75 });
    if (!hasAny('stone_axe') && exact('cobblestone') >= 3 && sticks >= 2)
      list.push({ item: 'stone_axe', needsTable: true, reason: 'rìu đá chặt gỗ', priority: 65 });
  }

  // === Iron stage ===
  if (['iron','diamond','nether','pre_end','end_done'].includes(stage)) {
    if (!hasAny('iron_pickaxe') && exact('iron_ingot') >= 3 && sticks >= 2)
      list.push({ item: 'iron_pickaxe', needsTable: true, reason: 'cuốc sắt đào quặng', priority: 92 });
    if (!hasAny('iron_sword') && exact('iron_ingot') >= 2 && sticks >= 1)
      list.push({ item: 'iron_sword', needsTable: true, reason: 'kiếm sắt chiến đấu', priority: 80 });
    if (!hasAny('iron_chestplate') && exact('iron_ingot') >= 8)
      list.push({ item: 'iron_chestplate', needsTable: true, reason: 'giáp ngực sắt', priority: 78 });
    if (!hasAny('iron_helmet') && exact('iron_ingot') >= 5)
      list.push({ item: 'iron_helmet', needsTable: true, reason: 'mũ sắt', priority: 72 });
    if (!hasAny('iron_leggings') && exact('iron_ingot') >= 7)
      list.push({ item: 'iron_leggings', needsTable: true, reason: 'quần sắt', priority: 71 });
    if (!hasAny('iron_boots') && exact('iron_ingot') >= 4)
      list.push({ item: 'iron_boots', needsTable: true, reason: 'giày sắt', priority: 70 });
    if (!hasAny('bucket') && exact('iron_ingot') >= 3)
      list.push({ item: 'bucket', needsTable: true, reason: 'xô nước/dung nham', priority: 60 });
    if (!hasAny('shield') && planksTotal >= 6 && exact('iron_ingot') >= 1)
      list.push({ item: 'shield', needsTable: true, reason: 'khiên bảo vệ', priority: 68 });
  }

  // === Diamond stage ===
  if (['diamond','nether','pre_end','end_done'].includes(stage)) {
    if (!hasAny('diamond_pickaxe') && exact('diamond') >= 3 && sticks >= 2)
      list.push({ item: 'diamond_pickaxe', needsTable: true, reason: 'cuốc kim cương', priority: 95 });
    if (!hasAny('diamond_sword') && exact('diamond') >= 2 && sticks >= 1)
      list.push({ item: 'diamond_sword', needsTable: true, reason: 'kiếm kim cương', priority: 90 });
    if (!hasAny('diamond_chestplate') && exact('diamond') >= 8)
      list.push({ item: 'diamond_chestplate', needsTable: true, reason: 'giáp ngực kim cương', priority: 85 });
    if (!hasAny('diamond_helmet') && exact('diamond') >= 5)
      list.push({ item: 'diamond_helmet', needsTable: true, reason: 'mũ kim cương', priority: 83 });
    if (!hasAny('diamond_leggings') && exact('diamond') >= 7)
      list.push({ item: 'diamond_leggings', needsTable: true, reason: 'quần kim cương', priority: 82 });
    if (!hasAny('diamond_boots') && exact('diamond') >= 4)
      list.push({ item: 'diamond_boots', needsTable: true, reason: 'giày kim cương', priority: 81 });
    if (!hasAny('enchanting_table') && exact('diamond') >= 2 && exact('obsidian') >= 4 && exact('book') >= 1)
      list.push({ item: 'enchanting_table', needsTable: true, reason: 'bàn enchant', priority: 75 });
  }

  // === Nether / End stage ===
  if (['nether','pre_end'].includes(stage)) {
    if (hasAny('blaze_rod') && !hasAny('blaze_powder'))
      list.push({ item: 'blaze_powder', needsTable: false, reason: 'bột blaze cho potion', priority: 96 });
    if (hasAny('blaze_powder') && hasAny('ender_pearl'))
      list.push({ item: 'eye_of_ender', needsTable: false, reason: 'mắt Ender tiến End', priority: 98 });
    if (!hasAny('brewing_stand') && hasAny('blaze_rod') && exact('cobblestone') >= 3)
      list.push({ item: 'brewing_stand', needsTable: true, reason: 'bàn pha thuốc', priority: 72 });
  }

  // Sắp xếp theo priority giảm dần
  return list.sort((a, b) => b.priority - a.priority);
}

// Thực hiện craft item đầu tiên trong danh sách ưu tiên
async function smartCraftItems() {
  if (!bot || !botOnline || !mcData || isBusy) return;
  const priority = getCraftPriority();
  if (priority.length === 0) return;

  for (const target of priority.slice(0, 3)) { // thử tối đa 3 item
    const itemData = mcData.itemsByName[target.item];
    if (!itemData) continue;

    let craftingTable = null;
    if (target.needsTable) {
      craftingTable = await findOrPlaceCraftingTable();
      if (!craftingTable) continue; // không có bàn, thử item tiếp theo
    }

    const recipes = bot.recipesFor(itemData.id, null, 1, craftingTable);
    if (!recipes || recipes.length === 0) continue;

    try {
      await bot.craft(recipes[0], 1, craftingTable);
      const done = `✅ Craft: ${target.item} — ${target.reason}`;
      logS(`[CRAFT] ${done}`);
      console.log(`🔨 ${done}`);
      aiMemory.craftedItems.push({ item: target.item, time: Date.now(), reason: target.reason });
      if (aiMemory.craftedItems.length > 50) aiMemory.craftedItems = aiMemory.craftedItems.slice(-50);
      saveAIMemory();
      // Tự mặc giáp/cầm tool mới ngay
      if (target.item.includes('_pickaxe') || target.item.includes('_sword') || target.item.includes('_axe')) {
        setTimeout(() => equipBestArmor().catch(()=>{}), 500);
      } else if (target.item.includes('helmet') || target.item.includes('chestplate') || target.item.includes('leggings') || target.item.includes('boots')) {
        setTimeout(() => equipBestArmor().catch(()=>{}), 500);
      }
      return; // craft xong 1 item là đủ mỗi lần
    } catch(e) {
      logW(`[CRAFT] ❌ ${target.item}: ${e.message?.slice(0,60)}`);
    }
  }
}

// ── FARM ORIGIN (module-level, lưu file) ──────────────────────────
let _savedFarmOrigin = null; // vị trí gốc farm đặt bằng "farm set"
let _stopMobFarmFn = null; // proxy: resetState gọi được stopMobFarmAFK
let _stopPatrolFn  = null; // proxy: resetState gọi được stopPatrol
let isStandingStill = false; // true → bot đứng yên, không wander
let _jumpAssistTimer = null; // interval jump-assist khi follow
let _jumpCooldown    = false; // tránh spam jump liên tục

// ── TERMINAL COLORS ───────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  // 256-color foregrounds
  cyan:   '\x1b[38;5;81m',
  orange: '\x1b[38;5;214m',
  green:  '\x1b[38;5;82m',
  red:    '\x1b[38;5;196m',
  purple: '\x1b[38;5;183m',
  yellow: '\x1b[38;5;226m',
  gray:   '\x1b[38;5;240m',
  white:  '\x1b[38;5;255m',
  blue:   '\x1b[38;5;117m',
  mint:   '\x1b[38;5;156m',
};

// ── LOG ───────────────────────────────────────────────────────────
const ts  = () => `${C.gray}${new Date().toLocaleTimeString()}${C.reset}`;
const tag = (lbl, col) => `${col}[${lbl}]${C.reset}`;

const logS = (m) => { console.log(`${ts()} ${tag('SYS ', C.cyan)}  ${C.white}${m}${C.reset}`);  };
const logJ = (m) => { console.log(`${ts()} ${tag('JOIN', C.green)} ${C.mint}${m}${C.reset}`);   };
const logC = (u, m) => { console.log(`${ts()} ${tag('CHAT', C.purple)} ${C.blue}${u}${C.gray}: ${C.white}${m}${C.reset}`); };
const logW = (m) => { console.log(`${ts()} ${tag('WARN', C.orange)} ${C.orange}${m}${C.reset}`); };
const logE = (m) => { console.log(`${ts()} ${tag('ERR ', C.red)}  ${C.red}${m}${C.reset}`);     };

// ── TERMINAL STATUS BAR ───────────────────────────────────────────
function printStatusBar() {
  if (!bot || !bot.entity) return;
  const task    = (bot._task || '—').substring(0, 20);
  const hp      = bot.health != null ? Math.round(bot.health * 10) / 10 : '—';
  const food    = bot.food   != null ? Math.round(bot.food)             : '—';
  const hpColor = (hp < 6 ? C.red : hp < 12 ? C.orange : C.green);
  const fColor  = (food < 6 ? C.red : food < 12 ? C.orange : C.yellow);
  let pos = '—';
  try { const p = bot.entity.position; pos = `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`; } catch(e){}
  const time = new Date().toLocaleTimeString('vi-VN');

  const W  = '\x1b[38;5;255m';
  const G1 = '\x1b[38;5;81m';

  console.log('');
  console.log(`${G1}  ╔═══════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${G1}  ║${C.reset}  ${C.green}● ONLINE${C.reset}  ${C.gray}│${C.reset}  ${W}${task.padEnd(22)}${C.reset}  ${C.gray}│${C.reset}  ${C.gray}${time}${C.reset}  ${G1}║${C.reset}`);
  console.log(`${G1}  ╠═══════════════════════════════════════════════════════╣${C.reset}`);
  console.log(`${G1}  ║${C.reset}  ${hpColor}❤  HP   ${hp}/20${C.reset}    ${fColor}⬛ Food ${food}/20${C.reset}    ${C.gray}📍 ${pos}${C.reset}`);
  console.log(`${G1}  ╚═══════════════════════════════════════════════════════╝${C.reset}`);
}

// ── ASCII BANNER ──────────────────────────────────────────────────
function printBanner() {
  const now      = new Date();
  const timeStr  = now.toLocaleTimeString('vi-VN');
  const dateStr  = now.toLocaleDateString('vi-VN');
  const nodeVer  = process.version;
  const platform = process.platform;

  // Gradient palette (cyan → blue-purple từ trên xuống)
  const G1 = '\x1b[38;5;51m';
  const G2 = '\x1b[38;5;81m';
  const G3 = '\x1b[38;5;75m';
  const G4 = '\x1b[38;5;69m';
  const G5 = '\x1b[38;5;63m';
  const G6 = '\x1b[38;5;57m';

  process.stdout.write('\n');
  process.stdout.write(`${G1}   ██████╗ ██████╗ ██████╗ ██╗   ██╗${C.reset}\n`);
  process.stdout.write(`${G2}   ╚════██╗██╔══██╗╚════██╗╚██╗ ██╔╝${C.reset}\n`);
  process.stdout.write(`${G3}    █████╔╝██║  ██║ █████╔╝ ╚████╔╝ ${C.reset}\n`);
  process.stdout.write(`${G4}    ╚═══██╗██║  ██║██╔═══╝   ╚██╔╝  ${C.reset}\n`);
  process.stdout.write(`${G5}   ██████╔╝██████╔╝███████╗   ██║   ${C.reset}\n`);
  process.stdout.write(`${G6}   ╚═════╝ ╚═════╝ ╚══════╝   ╚═╝   ${C.reset}\n`);
  process.stdout.write('\n');

  const TOP = `${C.cyan}  ╔════════════════════════════════════════════╗${C.reset}`;
  const BOT = `${C.cyan}  ╚════════════════════════════════════════════╝${C.reset}`;
  const DIV = `${C.cyan}  ╠════════════════════════════════════════════╣${C.reset}`;
  const row = (label, value, valColor) => {
    const col = valColor || C.mint;
    const lbl = (label + ' ').padEnd(10);
    return `${C.cyan}  ║${C.reset}  ${C.bold}${C.white}${lbl}${C.reset}${C.gray} → ${C.reset}${col}${value}${C.reset}`;
  };

  console.log(TOP);
  console.log(row('SERVER',   `${CONFIG.host}:${CONFIG.port}`,         C.mint));
  console.log(row('BOT',      CONFIG.username,                          C.green));
  console.log(row('VERSION',  CONFIG.version,                          C.yellow));
  console.log(DIV);
  const chatKeyDisplay = CONFIG.geminiApiKey
    ? `${C.reset}${C.green}✅ ${CONFIG.geminiApiKey.slice(0,4)}${'*'.repeat(8)}...${C.reset}` : `${C.reset}\x1b[31m❌ chưa set — gõ: set ai <key>...${C.reset}`;
  const aiKeyDisplay   = CONFIG.aiDecisionKey
    ? `${C.reset}${C.green}✅ ${CONFIG.aiDecisionKey.slice(0,4)}${'*'.repeat(8)}... (key riêng)${C.reset}` : `${C.reset}${C.yellow}(dùng chung chat key)${C.reset}`;
  console.log(`${C.cyan}  ║${C.reset}  ${C.bold}${C.white}${'CHAT KEY  '}${C.reset}${C.gray} → ${C.reset}${chatKeyDisplay}`);
  console.log(`${C.cyan}  ║${C.reset}  ${C.bold}${C.white}${'AI KEY    '}${C.reset}${C.gray} → ${C.reset}${aiKeyDisplay}`);
  console.log(DIV);
  console.log(row('NODE',     nodeVer,                                  C.blue));
  console.log(row('PLATFORM', platform,                                 C.purple));
  console.log(row('STARTED',  `${dateStr}  ${timeStr}`,                C.gray));
  console.log(BOT);
  console.log('');
}

// ── AI CHAT ───────────────────────────────────────────────────────
const chatHistory = [];
let lastReplyAt = 0;

function pushHistory(role, content) {
  chatHistory.push({ role, content });
  if (chatHistory.length > 20) chatHistory.shift();
}

function buildSys() {
  const task = bot?._task || (botOnline ? 'idle' : 'connecting');
  let pos = '';
  try { if (bot?.entity) { const p = bot.entity.position; pos = ` tại (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`; } } catch(e){}
  const hp = Math.round(bot?.health ?? 0), food = Math.round(bot?.food ?? 0);
  const held = bot?.heldItem ? bot.heldItem.name.replace(/_/g,' ') : 'tay trống';
  return `Bạn là ${CONFIG.username} — bot Minecraft, bạn phải trả lời bằng từ ngữ hơi tục tĩu chút, hài hước và không nói chuyện như kiểu mình là một bot hay AI.
Đang: ${task}${pos}. HP: ${hp}/20, Food: ${food}/20, Cầm: ${held}. Server: ${CONFIG.host} (${CONFIG.version}).
Quy tắc: Trả lời tiếng Việt ngắn gọn (tối đa 20 từ). KHÔNG dùng ngoặc kép. Tự tin, hài hước, dựa trên trạng thái thực.`;
}

// ── RPD QUOTA EXHAUSTION TRACKER ─────────────────────────────────
// Khi một key hết RPD (daily quota), bỏ qua key đó đến 00:00 UTC hôm sau
const _keyRpdExhaustedUntil = new Map(); // key → timestamp reset

function _isKeyRpdExhausted(key) {
  const until = _keyRpdExhaustedUntil.get(key);
  if (!until) return false;
  if (Date.now() >= until) { _keyRpdExhaustedUntil.delete(key); return false; }
  return true;
}

function _markKeyRpdExhausted(key) {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  _keyRpdExhaustedUntil.set(key, midnight);
  const hoursLeft = Math.ceil((midnight - Date.now()) / 3600000);
  logW(`[AI] 🔴 Key ${key.slice(0,4)}**** hết RPD → bỏ qua ~${hoursLeft}h đến 00:00 UTC`);
}

function _isRpdErrorMsg(errMsg) {
  // Gemini trả 429 cho cả RPM (tạm thời) lẫn RPD (hết ngày)
  // RPD exhausted thường có từ khoá: quota / exceeded / daily / per_day
  const m = (errMsg || '').toLowerCase();
  return m.includes('quota') || m.includes('exceeded your') || m.includes('per day') || m.includes('daily');
}

// ── API USAGE TRACKER ────────────────────────────────────────────
// Đếm số lần gọi API mỗi ngày theo từng key, reset lúc 00:00 UTC
const _keyUsageCount = new Map(); // key → { chat: n, decision: n, date: 'YYYY-MM-DD' }
function _getTodayUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function _trackKeyUsage(key, role) {
  if (!key) return;
  const today = _getTodayUTC();
  const cur = _keyUsageCount.get(key) || { chat: 0, decision: 0, date: today };
  if (cur.date !== today) { cur.chat = 0; cur.decision = 0; cur.date = today; }
  if (role === 'chat') cur.chat++;
  else if (role === 'decision') cur.decision++;
  _keyUsageCount.set(key, cur);
}
function _getKeyUsage(key) {
  if (!key) return { chat: 0, decision: 0 };
  const today = _getTodayUTC();
  const cur = _keyUsageCount.get(key);
  if (!cur || cur.date !== today) return { chat: 0, decision: 0 };
  return cur;
}
// Free tier giới hạn tham khảo (Gemini AI Studio)
const _FREE_TIER_RPD = { chat: 500, decision: 500 }; // gemini-3.1-flash-lite = 500 RPD

// ── ROUND-ROBIN KEY INDEX ─────────────────────────────────────────
// Lưu vị trí key tiếp theo trong vòng xoay — phân tải đều qua tất cả key
let _chatKeyRRIndex = 0;
let _decKeyRRIndex  = 0;

// ── GLOBAL GEMINI RATE LIMITER ────────────────────────────────────
// gemini-3.1-flash-lite: 15 RPM → 1 req / 4s (≈15 RPM max)
const _aiQueue = [];
let _aiLastCall = 0;
let _aiRunning = false;
function _scheduleAI(fn) {
  return new Promise((resolve, reject) => {
    _aiQueue.push({ fn, resolve, reject });
    if (!_aiRunning) _drainAIQueue();
  });
}
async function _drainAIQueue() {
  _aiRunning = true;
  while (_aiQueue.length > 0) {
    const now = Date.now();
    const wait = Math.max(0, _aiLastCall + 4000 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const { fn, resolve, reject } = _aiQueue.shift();
    _aiLastCall = Date.now();
    try { resolve(await fn()); } catch(e) { reject(e); }
  }
  _aiRunning = false;
}
// ─────────────────────────────────────────────────────────────────

async function getAI(prompt, sys, useHist = false) {
  if (!CONFIG.geminiApiKey) return null;
  return _scheduleAI(() => _getAIRaw(prompt, sys, useHist));
}

async function _getAIRaw(prompt, sys, useHist = false) {
  try {
    const systemText = sys || buildSys();
    const contents = [];
    if (useHist) {
      for (const h of chatHistory.slice(-12)) {
        contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
      }
    }
    contents.push({ role: 'user', parts: [{ text: prompt }] });
    // gemini-3.1-flash-lite ưu tiên số 1: 15 RPM + 500 RPD (25x RPD so với các model khác)
    const MODELS = [
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.0-flash',
      'gemini-2.5-flash',
    ];
    // Round-robin rotation: phân tải đều qua tất cả key, bỏ qua key đã hết RPD
    const _chatPool  = [CONFIG.geminiApiKey, ...CONFIG.chatKeys].filter(Boolean);
    const _chatAvail = _chatPool.filter(k => !_isKeyRpdExhausted(k));
    if (_chatAvail.length === 0) {
      logW('[AI] Tất cả chat key đều hết RPD hôm nay — chờ đến 00:00 UTC');
      return null;
    }
    const _rrStart = _chatKeyRRIndex % _chatAvail.length;
    const _chatAllKeys = [..._chatAvail.slice(_rrStart), ..._chatAvail.slice(0, _rrStart)];
    let d = null, lastErr = '';
    for (const _chatKey of _chatAllKeys) {
    let allModels429 = true; // theo dõi xem key này có bị RPD không
    for (const model of MODELS) {
      try {
        const res = await fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${_chatKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemText }] },
              contents,
              generationConfig: { maxOutputTokens: 120, temperature: 0.85 },
            }),
          }
        );
        const json = await res.json();
        if (!res.ok) {
          const errMsg = json?.error?.message || JSON.stringify(json);
          lastErr = `(${res.status}) ${errMsg}`;
          if (res.status === 429) {
            if (_isRpdErrorMsg(errMsg)) {
              // RPD exhausted: bỏ qua toàn bộ key này
              logW(`[AI] 🔴 RPD hết key=${_chatKey.slice(0,4)}... model=${model} → chuyển key`);
              break; // thoát model loop, đánh dấu key bên dưới
            }
            // RPM rate limit (tạm thời): chờ ngắn rồi thử model tiếp
            allModels429 = false; // không phải RPD exhausted
            logW(`[AI] ⏱ RPM limit ${model} key=${_chatKey.slice(0,4)}... → chờ 2s`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          allModels429 = false;
          if (res.status === 404 || res.status === 400) continue;
          logW(`[AI] Lỗi API Gemini model=${model}: ${lastErr}`);
          break;
        }
        allModels429 = false;
        d = json;
        _trackKeyUsage(_chatKey, 'chat'); // đếm lần dùng thành công
        // Round-robin: chuyển sang key tiếp theo cho lần gọi sau
        _chatKeyRRIndex = (_chatAvail.indexOf(_chatKey) + 1) % _chatAvail.length;
        break; // thành công
      } catch(e) {
        allModels429 = false;
        lastErr = e.message;
        continue;
      }
    }
    if (d) break; // key này thành công
    if (allModels429) _markKeyRpdExhausted(_chatKey);
    else logW(`[AI] Key ${_chatKey.slice(0,4)}... lỗi → thử key tiếp`);
    } // end key loop
    if (!d) {
      logW(`[AI] Tất cả model đều lỗi. Lỗi cuối: ${lastErr}`);
      return null;
    }
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) {
      const finishReason = d?.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== 'STOP') {
        logW(`[AI] Response bị chặn: finishReason=${finishReason}`);
      }
      return null;
    }
    return text;
  } catch(err) {
    logW(`[AI] Lỗi kết nối Gemini: ${err.message}`);
    return null;
  }
}

async function botSay(p) {
  if (!bot) return;
  // Bỏ qua nếu queue chat đang bận (flavor text — không đáng chờ đợi, tránh lấn át AI decision)
  if (_aiQueue.length > 0) return;
  const r = await getAI(p, `Bạn là ${CONFIG.username} — bot Minecraft. Viết 1 câu dưới 12 từ, thể hiện đang làm việc đó, cá tính. Không dùng ngoặc kép.`);
  if (r) bot.chat(r);
}

async function replyToChat(user, msg) {
  if (Date.now() - lastReplyAt < 3000) return;
  lastReplyAt = Date.now();
  pushHistory('user', `${user}: ${msg}`);
  const r = await getAI(`${user} nói: "${msg}"`, null, true);
  if (r) { try { if (bot && botOnline) bot.chat(r.slice(0, 256)); pushHistory('assistant', r); } catch(_){} }
}

function shouldReply(user, msg) {
  // Bỏ qua nếu không lấy được tên người chơi (server dùng custom chat format)
  if (!bot || !user || !user.trim()) return false;
  if (user === bot.username) return false;
  const t = msg.toLowerCase();
  const myName = CONFIG.username.toLowerCase();
  // Chỉ reply khi được nhắc tên trực tiếp
  if (t.includes(myName)) return true;
  // Chào trực tiếp bot (tên phải có trong tin nhắn)
  if (/^(hi|hello|hey|chào|alo)/i.test(t) && t.includes(myName) && msg.length < 60) return true;
  return false;
}

// ── KIỂM TRA GIÁP ─────────────────────────────────────────────────
function isFullyArmored() {
  if (!bot) return false;
  const s = bot.inventory.slots;
  return !!(s[5] && s[6] && s[7] && s[8]);
}

function getMissingArmorNames() {
  if (!bot) return ['tất cả'];
  const s = bot.inventory.slots;
  const missing = [];
  if (!s[5]) missing.push('mũ');
  if (!s[6]) missing.push('áo');
  if (!s[7]) missing.push('quần');
  if (!s[8]) missing.push('giày');
  return missing;
}

// ── AI MODE: GAME STAGE DETECTION ────────────────────────────────
function detectGameStage() {
  if (!bot) return 'early';

  // Dimension override — luôn ưu tiên trước item check
  let dim = 'overworld';
  try { dim = bot.game?.dimension || 'overworld'; } catch(_){}
  if (dim === 'the_end') {
    const inv0 = bot.inventory?.items() || [];
    if (inv0.some(i => i.name === 'elytra')) return 'end_done';
    return 'pre_end'; // đang trong End → vẫn cần diệt Dragon
  }
  if (dim === 'the_nether') return 'nether'; // đang trong Nether dù chưa có item

  const inv = bot.inventory?.items() || [];
  const has  = (substr) => inv.some(i => i.name.includes(substr));
  const count = (substr) => inv.filter(i => i.name.includes(substr)).reduce((s,i)=>s+i.count, 0);
  const hasExact = (name) => inv.some(i => i.name === name);

  if (hasExact('dragon_egg') || hasExact('elytra')) return 'end_done';
  if (has('eye_of_ender') && count('eye_of_ender') >= 3) return 'pre_end';
  // Nether items (overworld): blaze rod/powder hoặc ender pearl ≥ 3 chứng minh đã vào Nether
  if (has('blaze_rod') || has('blaze_powder')) return 'nether';
  if (count('ender_pearl') >= 3) return 'nether';
  if (has('nether_brick') || has('nether_quartz')) return 'nether';
  // soul_sand có thể mua từ Wandering Trader nên không dùng làm indicator nether
  if (has('diamond_pickaxe') || has('diamond_sword') || count('diamond') >= 3) return 'diamond';
  if (has('iron_pickaxe') || has('iron_sword') || has('iron_chestplate') || count('iron_ingot') >= 5) return 'iron';
  if (has('stone_pickaxe') || has('stone_sword') || count('cobblestone') >= 8) return 'stone';
  if (count('_log') >= 3 || count('_planks') >= 8 || has('wooden_pickaxe') || has('crafting_table')) return 'wood';
  return 'early';
}

function getToolTier() {
  if (!bot) return 'tay trần';
  const names = (bot.inventory?.items() || []).map(i => i.name);
  if (names.some(n => n === 'netherite_pickaxe')) return 'netherite';
  if (names.some(n => n === 'diamond_pickaxe')) return 'diamond';
  if (names.some(n => n === 'iron_pickaxe')) return 'iron';
  if (names.some(n => n === 'stone_pickaxe')) return 'stone';
  if (names.some(n => n === 'wooden_pickaxe')) return 'wooden';
  return 'tay trần';
}

function getArmorTier() {
  if (!bot) return 'không có';
  const slots = bot.inventory?.slots || [];
  const worn  = [slots[5],slots[6],slots[7],slots[8]].filter(Boolean).map(i => i.name);
  if (worn.some(n => n.includes('netherite'))) return 'netherite';
  if (worn.some(n => n.includes('diamond')))   return 'diamond';
  if (worn.some(n => n.includes('iron')))      return 'iron';
  if (worn.length > 0)                          return 'leather/gold/chain';
  return 'không có';
}

function buildAIContext() {
  if (!bot) return 'Bot chưa online.';
  const hp   = Math.round(bot.health ?? 0);
  const food = Math.round(bot.food   ?? 0);
  const task = bot._task || 'idle';
  let pos = '?', dimension = 'overworld', posY = 64;
  try { const p = bot.entity?.position; if (p) { pos = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`; posY = Math.round(p.y); } } catch(_){}
  try { dimension = bot.game?.dimension || 'overworld'; } catch(_){}

  // Thời gian trong ngày
  let timeOfDay = 'ngày', isNight = false;
  try {
    const tod = bot.time?.timeOfDay ?? 0;
    isNight = tod >= 13000 && tod <= 23000;
    if (tod >= 0 && tod < 6000)        timeOfDay = 'sáng sớm';
    else if (tod < 12000)              timeOfDay = 'ban ngày';
    else if (tod < 13000)              timeOfDay = 'hoàng hôn';
    else if (tod < 18000)              timeOfDay = 'đêm sớm';
    else if (tod < 22000)              timeOfDay = 'nửa đêm';
    else                               timeOfDay = 'gần sáng';
  } catch(_){}

  // Phân vùng Y
  let yZone = 'mặt đất';
  if (dimension === 'overworld') {
    if (posY > 120)        yZone = 'trên cao (không tìm quặng ở đây)';
    else if (posY > 60)    yZone = 'mặt đất (Y>60)';
    else if (posY > 16)    yZone = 'dưới đất (Y 16-60, nhiều sắt/đồng)';
    else if (posY > -20)   yZone = 'sâu (Y 0-16, nhiều vàng)';
    else                   yZone = 'rất sâu (Y<-20, nhiều kim cương/deepslate ore)';
  }

  const invItems = bot.inventory?.items() || [];
  const invCount = invItems.length;
  const invFull  = invCount >= 32;
  const items    = invItems.map(i => `${i.name}×${i.count}`).join(', ') || 'trống'; // hiển thị toàn bộ túi

  // Thông tin đồ ăn chi tiết
  const COOKED_FOOD = ['cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken','cooked_salmon','cooked_cod','cooked_rabbit','bread','baked_potato','apple'];
  const RAW_FOOD    = ['raw_beef','raw_porkchop','raw_mutton','raw_chicken','raw_salmon','raw_cod','raw_rabbit'];
  const hasRawFood    = invItems.some(i => RAW_FOOD.includes(i.name));
  const hasCookedFood = invItems.some(i => COOKED_FOOD.includes(i.name));
  const foodCount     = invItems.filter(i => COOKED_FOOD.includes(i.name)).reduce((s,i)=>s+i.count,0);

  // Vũ khí đang cầm
  const heldItem = bot.heldItem?.name || 'tay trần';
  const hasWeaponEquipped = heldItem.includes('sword') || heldItem.includes('axe') || heldItem.includes('mace') || heldItem.includes('trident');
  const bestWeaponInInv = invItems.find(i => ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','netherite_axe','diamond_axe','iron_axe'].includes(i.name));

  // Slot giáp còn trống
  const armorSlots = bot.inventory?.slots || [];
  const wornArmor  = [armorSlots[5],armorSlots[6],armorSlots[7],armorSlots[8]].filter(Boolean);
  const armorSlotsEmpty = 4 - wornArmor.length;
  const hasArmorInInv = invItems.some(i => ['helmet','chestplate','leggings','boots'].some(s => i.name.includes(s)));

  // Thông tin mob thù
  const _myPos = bot.entity?.position;
  const allHostiles = _myPos ? Object.values(bot.entities || {})
    .filter(e => e.type === 'mob' && HOSTILE_MOBS.has(e.name || e.mobType || '') && e.position?.distanceTo(_myPos) < 24)
    .sort((a,b) => a.position.distanceTo(_myPos) - b.position.distanceTo(_myPos)) : [];
  const hostileCount = allHostiles.length;
  const hostiles = _myPos ? allHostiles.slice(0, 5).map(e => `${e.name}(${Math.round(e.position.distanceTo(_myPos))}m)`).join(', ') || 'không có' : 'không có';
  const nearestHostileDist = (hostileCount > 0 && _myPos) ? Math.round(allHostiles[0].position.distanceTo(_myPos)) : 99;
  const hasCreeper = _myPos && allHostiles.some(e => e.name === 'creeper' && e.position.distanceTo(_myPos) < 10);
  const hasDangerousMob = allHostiles.some(e => ['warden','elder_guardian'].includes(e.name));

  // Mức nguy hiểm
  let dangerLevel = 'AN TOÀN';
  if (hp < 4)                                               dangerLevel = 'NGUY HIỂM CHẾT NGƯỜI';
  else if (hp < 8 && hostileCount >= 3)                     dangerLevel = 'NGUY CAO - áp đảo';
  else if (hp < 8 && hostileCount >= 1)                     dangerLevel = 'NGUY CAO - HP thấp có mob';
  else if (hasDangerousMob)                                 dangerLevel = 'NGUY CAO - mob nguy hiểm';
  else if (hostileCount >= 3)                               dangerLevel = 'NGUY CAO - nhiều mob';
  else if (hp < 10 || food < 5)                             dangerLevel = 'TRUNG BÌNH - sinh tồn';
  else if (hostileCount >= 1 && nearestHostileDist < 8)     dangerLevel = 'CÓ MOB GẦN';

  const players = Object.values(bot.players || {})
    .filter(p => p.entity && p.username !== bot.username).slice(0, 3).map(p => p.username).join(', ') || 'không có';

  const stage    = detectGameStage();
  aiGameStage    = stage;
  const toolTier = getToolTier();
  const armor    = getArmorTier();

  // Kiểm tra furnace/rương/giường gần
  const hasFurnace = mcData && !!bot.findBlock({ matching: mcData.blocksByName['furnace']?.id, maxDistance: 32 });
  const hasChest   = mcData && !!bot.findBlock({ matching: mcData.blocksByName['chest']?.id,   maxDistance: 32 });
  const hasBedNear = mcData && ['red_bed','white_bed','orange_bed','magenta_bed','blue_bed','green_bed','cyan_bed'].some(b => mcData.blocksByName[b] && bot.findBlock({ matching: mcData.blocksByName[b].id, maxDistance: 16 }));
  const hasCraftingTable = mcData && !!bot.findBlock({ matching: mcData.blocksByName['crafting_table']?.id, maxDistance: 16 });

  // Biome
  let biome = 'không rõ';
  try {
    const bId = bot.world?.getBiome?.(bot.entity.position);
    if (bId != null && mcData?.biomes?.[bId]) biome = mcData.biomes[bId].name.replace(/_/g, ' ');
  } catch(_){}

  // Tài nguyên gần (trong 16 block)
  let nearbyResources = [];
  if (mcData) {
    const resCheck = [
      { key: 'log', label: 'gỗ', ids: ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log'].map(n=>mcData.blocksByName[n]?.id).filter(Boolean) },
      { key: 'iron_ore', label: 'iron_ore', ids: [mcData.blocksByName['iron_ore']?.id, mcData.blocksByName['deepslate_iron_ore']?.id].filter(Boolean) },
      { key: 'coal_ore', label: 'coal_ore', ids: [mcData.blocksByName['coal_ore']?.id, mcData.blocksByName['deepslate_coal_ore']?.id].filter(Boolean) },
      { key: 'diamond_ore', label: 'diamond_ore', ids: [mcData.blocksByName['diamond_ore']?.id, mcData.blocksByName['deepslate_diamond_ore']?.id].filter(Boolean) },
      { key: 'gold_ore', label: 'gold_ore', ids: [mcData.blocksByName['gold_ore']?.id, mcData.blocksByName['deepslate_gold_ore']?.id].filter(Boolean) },
    ];
    for (const r of resCheck) {
      if (!r.ids.length) continue;
      try {
        const found = bot.findBlock({ matching: r.ids, maxDistance: 16 });
        if (found) nearbyResources.push(r.label);
      } catch(_){}
    }
  }
  const nearbyResourcesStr = nearbyResources.length ? nearbyResources.join(', ') : 'không thấy trong 16m';

  // Khoảng cách tới base/home
  let homeDist = 'chưa đặt nhà';
  try {
    const homeData = fs.existsSync('home.json') ? JSON.parse(fs.readFileSync('home.json','utf8')) : null;
    if (homeData && bot.entity?.position) {
      const dx = bot.entity.position.x - homeData.x;
      const dz = bot.entity.position.z - homeData.z;
      homeDist = `${Math.round(Math.sqrt(dx*dx+dz*dz))}m từ nhà`;
    }
  } catch(_){}

  // Độ bền công cụ
  let toolDurability = '';
  try {
    const mainHand = bot.inventory?.slots?.[36];
    if (mainHand?.durabilityUsed != null && mainHand?.maxDurability) {
      const pct = Math.round((1 - mainHand.durabilityUsed/mainHand.maxDurability)*100);
      toolDurability = ` (độ bền ${pct}%)`;
    }
  } catch(_){}

  // Chi tiết vật liệu quan trọng trong túi
  const matCount = (names) => names.reduce((s,n)=>{
    const it = invItems.find(i=>i.name===n); return s+(it?it.count:0);
  }, 0);
  const woodCount    = matCount(['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','oak_planks','birch_planks','spruce_planks']);
  const stoneCount   = matCount(['cobblestone','stone','deepslate','cobbled_deepslate']);
  const ironIngots   = matCount(['iron_ingot']);
  const diamonds     = matCount(['diamond']);
  const coalCount    = matCount(['coal','charcoal']);
  const stringCount  = matCount(['string']);
  const enderPearls  = matCount(['ender_pearl']);

  // Lần lặp action gần nhất (chống lặp)
  const repeatWarning = _aiRepeatCount >= 2 ? `⚠️ AI đã chọn "${_aiLastAction}" ${_aiRepeatCount} lần liên tiếp — hãy chọn action KHÁC!` : '';

  const STAGE_GUIDE = {
    early:    'MỚI BẮT ĐẦU: PHẢI chặt gỗ (chop) ngay. log→planks→crafting_table→wooden_pickaxe→cobblestone→stone_pickaxe.',
    wood:     'CÓ GỖ: Đào đá (mine) lấy cobblestone để craft stone tools. Sau đó tìm sắt.',
    stone:    'CÔNG CỤ ĐÁ: Đào sâu tìm sắt (mine) ở Y=11-16. Săn thú (hunt) nếu food thấp.',
    iron:     'ĐỒ SẮT: strip_mine ở Y=-59 tìm kim cương. Equip giáp sắt nếu chưa. Chuẩn bị food.',
    diamond:  'KIM CƯƠNG: Explore tìm/làm Nether Portal. Cần flint&steel, đủ food, vũ khí kim cương.',
    nether:   'NETHER: Explore tìm Nether Fortress→Blaze Rod. Tìm Enderman→Ender Pearl.',
    pre_end:  'CÓ EYE OF ENDER: Explore tìm Stronghold. Cần đủ gear diamond + bed + thuốc.',
    end_done: 'DRAGON CHẾT: Explore tìm End City lấy Elytra.',
  };

  // Memory context
  const memNotes   = (aiMemory.notes || []).slice(-4).join('; ') || 'chưa có';
  const topActions = Object.entries(aiMemory.actionCounts || {}).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>`${k}:${v}`).join(', ') || 'chưa có';
  const nextCraft  = getCraftPriority().slice(0,2).map(c=>`${c.item}(${c.reason})`).join(', ') || 'không cần';

  return `=== TRẠNG THÁI BOT ===
HP: ${hp}/20  Food: ${food}/20 (đồ ăn chín: ${foodCount})  Đang cầm: ${heldItem}${toolDurability}
Vị trí: ${pos}  Dimension: ${dimension}  Vùng Y: ${yZone}  Biome: ${biome}
Thời gian: ${timeOfDay}${isNight?' [ĐÊM]':''}  Task: ${task}  isBusy: ${isBusy}
Khoảng cách nhà: ${homeDist}

=== TRANG BỊ & CHIẾN ĐẤU ===
Công cụ: ${toolTier}  Giáp đang mặc: ${armor}  Slot giáp trống: ${armorSlotsEmpty}/4
Vũ khí cầm tay: ${hasWeaponEquipped?heldItem:'KHÔNG có'}  Vũ khí tốt nhất trong túi: ${bestWeaponInInv?.name||'không có'}
Có giáp trong túi chưa mặc: ${hasArmorInInv?'CÓ':'KHÔNG'}

⚠️ MỨC NGUY HIỂM: ${dangerLevel}
Mob thù (24m): ${hostileCount} con — ${hostiles}
Mob gần nhất: ${nearestHostileDist}m  Creeper gần: ${hasCreeper?'CÓ - KHÔNG ATTACK!':'KHÔNG'}  Mob nguy hiểm: ${hasDangerousMob?'CÓ - RETREAT NGAY!':'KHÔNG'}
Người chơi gần: ${players}

=== TÀI NGUYÊN ===
Tài nguyên gần (16m): ${nearbyResourcesStr}
Vật liệu trong túi: gỗ×${woodCount} đá×${stoneCount} sắt×${ironIngots} kim_cương×${diamonds} coal×${coalCount} string×${stringCount} ender_pearl×${enderPearls}
Đồ ăn sống: ${hasRawFood?'CÓ':'KHÔNG'}  Đồ ăn chín: ${hasCookedFood?'CÓ':'KHÔNG'}

=== CƠ SỞ HẠ TẦNG ===
Furnace gần: ${hasFurnace?'CÓ':'KHÔNG'}  Rương gần: ${hasChest?'CÓ':'KHÔNG'}  Giường gần: ${hasBedNear?'CÓ':'KHÔNG'}  Bàn craft gần: ${hasCraftingTable?'CÓ':'KHÔNG'}

Inventory (${invCount}/36)${invFull?' [GẦN ĐẦY - cần deposit]':''}:
${items}

=== GIAI ĐOẠN GAME: [${stage.toUpperCase()}] ===
${STAGE_GUIDE[stage]||'Không rõ'}
${repeatWarning}

=== BỘ NHỚ AI (${aiMemory.totalDecisions||0} quyết định) ===
Hay dùng: ${topActions}  Craft tiếp: ${nextCraft}
Ghi chú: ${memNotes}`;
}

// ── AI DECISION ───────────────────────────────────────────────────
// Separate rate-limiter queue for AI Decision key (may differ from chat key)
const _aiDecisionQueue = [];
let _aiDecisionLastCall = 0;
let _aiDecisionRunning = false;
function _scheduleAIDecision(fn) {
  // If using the same key as chat, share the same queue to avoid exceeding 10 RPM
  if (!CONFIG.aiDecisionKey || CONFIG.aiDecisionKey === CONFIG.geminiApiKey) {
    return _scheduleAI(fn);
  }
  return new Promise((resolve, reject) => {
    _aiDecisionQueue.push({ fn, resolve, reject });
    if (!_aiDecisionRunning) _drainAIDecisionQueue();
  });
}
async function _drainAIDecisionQueue() {
  _aiDecisionRunning = true;
  while (_aiDecisionQueue.length > 0) {
    const now = Date.now();
    const wait = Math.max(0, _aiDecisionLastCall + 4000 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const { fn, resolve, reject } = _aiDecisionQueue.shift();
    _aiDecisionLastCall = Date.now();
    try { resolve(await fn()); } catch(e) { reject(e); }
  }
  _aiDecisionRunning = false;
}

async function getAIDecision() {
  const baseKey = CONFIG.aiDecisionKey || CONFIG.geminiApiKey;
  if (!baseKey) return null;
  // Multi-key: nếu có aiDecisionKey riêng thì rotate decisionKeys, ngược lại rotate chatKeys
  const extraKeys = CONFIG.aiDecisionKey ? CONFIG.decisionKeys : CONFIG.chatKeys;
  const allKeys = [baseKey, ...extraKeys].filter(Boolean);
  return _scheduleAIDecision(() => _getAIDecisionRaw(allKeys));
}

async function _getAIDecisionRaw(keys) {
  // Hỗ trợ cả single key (string) lẫn array
  const _decKeys = Array.isArray(keys) ? keys : [keys];
  const context = buildAIContext();

  // Lịch sử 3 quyết định gần nhất (để AI không lặp)
  const recentHistory = (aiDecisionLog || []).slice(-3)
    .map((d,i) => `  ${i+1}. ${d.action} — ${d.reason}`)
    .join('\n') || '  (chưa có)';

  const sysPrompt = `Bạn là AI sinh tồn Minecraft chuyên nghiệp. Nhiệm vụ duy nhất: đưa bot từ điểm 0 đến tiêu diệt Ender Dragon theo con đường ngắn nhất có thể.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUY TẮC DIMENSION (ưu tiên tuyệt đối)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Dimension = the_nether → stage luôn là NETHER, chỉ dùng explore/retreat/eat/smelt
• Dimension = the_end    → stage luôn là PRE_END hoặc END_DONE, chỉ dùng explore/retreat/eat
• Dimension = overworld  → theo các bước dưới

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BƯỚC 1 — KIỂM TRA SINH TỒN KHẨN CẤP (ưu tiên tuyệt đối, dừng ngay khi thoả)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• HP < 5                                     → eat (nếu có đồ ăn chín) | idle (nếu không)
• Mob nguy hiểm = CÓ (warden/elder_guardian) → retreat (không đánh, rút ngay)
• Creeper gần = CÓ                           → retreat (TUYỆT ĐỐI không attack creeper)
• HP < 8 VÀ mob thù ≥ 3 con                 → retreat
• HP < 8 VÀ có đồ ăn chín                   → eat (không đánh khi HP thấp)
• Food = 0                                   → eat (nếu có đồ ăn chín) | hunt
• Food < 5 VÀ không có đồ ăn chín           → hunt (nếu đang trên mặt đất) | surface (nếu Y < 0)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BƯỚC 2 — TỐI ƯU HOÁ TRANG BỊ (khi không nguy hiểm)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Slot giáp trống > 0 VÀ có giáp trong túi  → equip_armor
• Có thịt/quặng sống (raw_*) VÀ furnace gần → smelt
• Inventory ≥ 32 VÀ rương gần = CÓ         → deposit (nếu rương gần = KHÔNG → tiếp tục task)
• Mob thù trong 8m VÀ không phải creeper VÀ HP ≥ 10 → attack_hostile

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BƯỚC 3 — HÀNH ĐỘNG THEO GIAI ĐOẠN (khi an toàn)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
early   → chop (cần ≥16 log → planks → crafting_table → wooden_pickaxe → cobblestone → stone_pickaxe)
         Nếu đã có ≥8 gỗ nhưng KHÔNG có bàn craft gần → chop thêm để tìm bàn craft
wood    → mine (lấy cobblestone → furnace → stone_pickaxe → đào tìm sắt)
stone   → mine ở Y=15 trở xuống (tìm sắt); nếu food < 10 → hunt trước
iron    → strip_mine ở Y=-59 (tìm kim cương); đảm bảo đủ food và giáp sắt trước
diamond → explore (cần Nether Portal: obsidian×10, flint&steel; cần vũ khí kim cương)
nether  → explore (Nether Fortress→Blaze Rod; Enderman→Ender Pearl; cảnh giác ghast/lava)
pre_end → explore (tìm Stronghold bằng Eye of Ender; cần ≥12 eye + đồ diamond + bed + potion)
end_done→ explore (End City→Elytra)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NGUYÊN TẮC CHIẾN LƯỢC QUAN TRỌNG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ĐÊM + giáp yếu (không có/leather/gold) + có giường gần  → sleep
• ĐÊM + không giường                                       → mine (tránh ra ngoài đêm)
• Đang dưới đất (Y < 0) VÀ food < 5 → surface trước, rồi hunt
• Tài nguyên trong túi đủ craft → craft tự động (craft loop chạy 30s/lần, không cần AI chọn)
• BẬN = KHÔNG override task đang chạy trừ khẩn cấp (HP < 5 hoặc mob nguy hiểm)
• KHÔNG idle khi an toàn — luôn có task hữu ích
• KHÔNG lặp action ≥ 2 lần vô kết quả — đổi strategy

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACTION HỢP LỆ (chỉ dùng tên chính xác):
idle • eat • hunt • chop • mine • strip_mine • fish • explore • surface • equip_armor • deposit • attack_hostile • retreat • smelt • sleep • brew

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT (JSON thuần, không markdown, không giải thích thêm):
{"action":"<tên>","reason":"<≤10 từ tiếng Việt>","stage_tip":"<≤12 từ gợi ý tiến trình>"}`;

  // gemini-3.1-flash-lite ưu tiên số 1: 15 RPM + 500 RPD (25x RPD so với các model khác)
  const MODELS = ['gemini-3.1-flash-lite','gemini-2.5-flash-lite','gemini-3.5-flash','gemini-3.0-flash','gemini-2.5-flash'];

  // Nguy hiểm = temperature thấp hơn (nhất quán hơn)
  const hp = bot?.health ?? 20;
  const hostileNear = Object.values(bot?.entities || {}).some(e =>
    e.type === 'mob' && HOSTILE_MOBS.has(e.name || '') && e.position?.distanceTo(bot.entity?.position) < 16);
  const tempValue = (hp < 8 || hostileNear) ? 0.1 : 0.3;

  // Round-robin rotation: phân tải đều qua tất cả decision key
  const _decAvail = _decKeys.filter(k => !_isKeyRpdExhausted(k));
  if (_decAvail.length === 0) {
    logW('[AI] Tất cả decision key đều hết RPD hôm nay → heuristic fallback');
    return heuristicFallbackDecision();
  }
  const _decRRStart = _decKeyRRIndex % _decAvail.length;
  const _activeDecKeys = [..._decAvail.slice(_decRRStart), ..._decAvail.slice(0, _decRRStart)];
  for (const _decKey of _activeDecKeys) {
  let allModels429 = true;
  for (const model of MODELS) {
    try {
      const res = await fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${_decKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: sysPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `${context}\n\n=== 3 QUYẾT ĐỊNH VỪA RỒI (KHÔNG LẶP LẠI) ===\n${recentHistory}` }] }],
            generationConfig: { maxOutputTokens: 180, temperature: tempValue },
          }),
        }
      );
      if (!res.ok) {
        const decErrMsg = (await res.json().catch(()=>({}))).error?.message || '';
        if (res.status === 429) {
          if (_isRpdErrorMsg(decErrMsg)) {
            logW(`[AI] 🔴 RPD hết key=${_decKey.slice(0,4)}... model=${model} → chuyển key`);
            break; // thoát model loop, đánh dấu key bên dưới
          }
          allModels429 = false;
          logW(`[AI] ⏱ RPM limit ${model} key=${_decKey.slice(0,4)}... → chờ 2s`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        allModels429 = false;
        if (res.status === 404) { continue; }
        logW(`[AI] API lỗi ${res.status} → thử key tiếp`);
        break;
      }
      allModels429 = false;
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) continue;
      const clean = text.replace(/```json?|```/g, '').trim();
      try {
        const parsed = JSON.parse(clean);
        const VALID = new Set(['idle','eat','hunt','chop','mine','strip_mine','fish','explore','surface','equip_armor','deposit','attack_hostile','retreat','smelt','sleep','brew']);
        if (!VALID.has(parsed.action)) {
          logW(`[AI] Action không hợp lệ "${parsed.action}" → heuristic fallback`);
          return heuristicFallbackDecision();
        }
        _trackKeyUsage(_decKey, 'decision'); // đếm lần dùng thành công
        // Round-robin: chuyển sang key tiếp theo cho lần gọi sau
        _decKeyRRIndex = (_decAvail.indexOf(_decKey) + 1) % _decAvail.length;
        return parsed;
      } catch(_) { continue; }
    } catch(_) { allModels429 = false; continue; }
  }
  if (allModels429) _markKeyRpdExhausted(_decKey);
  else logW(`[AI] Key ${_decKey.slice(0,4)}... lỗi → thử key tiếp`);
  } // end key loop
  // Tất cả key + model đều thất bại → dùng heuristic
  logW('[AI] Tất cả key+model thất bại → heuristic fallback');
  return heuristicFallbackDecision();
}

// ── AI EXECUTE ────────────────────────────────────────────────────
// ── HEURISTIC FALLBACK — quyết định không cần API (dùng khi rate-limit) ──
function heuristicFallbackDecision() {
  if (!bot || !botOnline) return null;
  const hp    = Math.round(bot.health ?? 0);
  const food  = Math.round(bot.food   ?? 0);
  const inv   = bot.inventory?.items() || [];
  const has   = (n) => inv.some(i => i.name.includes(n));
  const _hPos = bot.entity?.position;

  const hostiles = _hPos ? Object.values(bot.entities || {})
    .filter(e => e.type==='mob' && HOSTILE_MOBS.has(e.name||e.mobType||'')
      && e.position?.distanceTo(_hPos) < 20)
    .sort((a,b) => a.position.distanceTo(_hPos) - b.position.distanceTo(_hPos)) : [];
  const nearestMob = hostiles[0];
  const nearDist   = (nearestMob && _hPos) ? nearestMob.position.distanceTo(_hPos) : 99;
  const isCreeper  = nearestMob?.name === 'creeper';
  const isDangerous = nearestMob && ['warden','elder_guardian'].includes(nearestMob.name);

  const COOKED = ['cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken','cooked_salmon','bread','baked_potato','apple'];
  const hasCookedFood = inv.some(i => COOKED.includes(i.name));
  const hasRawFood    = inv.some(i => i.name.startsWith('raw_'));
  const hasFurnace    = mcData && !!bot.findBlock({ matching: mcData.blocksByName['furnace']?.id, maxDistance: 32 });

  // Ưu tiên 1: HP nguy hiểm
  if (hp < 4)              return { action: hasCookedFood ? 'eat' : 'idle', reason: 'HP cực thấp' };
  // Ưu tiên 2: Retreat mob nguy hiểm
  if (isDangerous)         return { action: 'retreat', reason: 'Mob quá nguy hiểm' };
  if (isCreeper && nearDist < 10) return { action: 'retreat', reason: 'Creeper gần - không attack' };
  // Ưu tiên 3: HP thấp có mob → retreat hoặc ăn
  if (hp < 8 && hostiles.length >= 3) return { action: 'retreat', reason: 'HP thấp nhiều mob' };
  if (hp < 8 && hasCookedFood) return { action: 'eat', reason: 'HP thấp cần ăn' };
  // Ưu tiên 4: Food = 0
  if (food === 0)          return { action: hasCookedFood ? 'eat' : 'hunt', reason: 'Hết thức ăn' };
  // Ưu tiên 5: Food thấp
  if (food < 5)            return { action: hasCookedFood ? 'eat' : 'hunt', reason: 'Food thấp' };
  // Ưu tiên 6: Giáp trong túi chưa mặc
  const hasArmorInInv = inv.some(i => ['helmet','chestplate','leggings','boots'].some(s => i.name.includes(s)));
  const armorSlots    = bot.inventory?.slots || [];
  const wornCount     = [armorSlots[5],armorSlots[6],armorSlots[7],armorSlots[8]].filter(Boolean).length;
  if (hasArmorInInv && wornCount < 4) return { action: 'equip_armor', reason: 'Có giáp chưa mặc' };
  // Ưu tiên 7: Túi đầy VÀ có rương gần
  const hasChestNearby = mcData && !!bot.findBlock({ matching: mcData.blocksByName['chest']?.id, maxDistance: 32 });
  if (inv.length >= 32 && hasChestNearby) return { action: 'deposit', reason: 'Túi sắp đầy' };
  // Ưu tiên 8: Smelt
  if (hasRawFood && hasFurnace) return { action: 'smelt', reason: 'Nướng thịt sống' };
  // Ưu tiên 9: Mob gần tấn công
  if (nearestMob && nearDist < 8 && !isCreeper) return { action: 'attack_hostile', reason: 'Mob gần' };
  // Ưu tiên 10: Làm task theo stage
  const stage = detectGameStage();
  const stageActions = {
    early: 'chop', wood: 'mine', stone: 'mine', iron: 'strip_mine',
    diamond: 'explore', nether: 'explore', pre_end: 'explore', end_done: 'explore'
  };
  return { action: stageActions[stage] || 'chop', reason: `Fallback: stage ${stage}`, _source: 'heuristic' };
}

async function executeAIDecision(decision) {
  if (!decision || !decision.action) return;
  let action   = decision.action;
  const reason   = decision.reason || '';
  const stageTip = decision.stage_tip || '';

  // ── Anti-repeat: nếu lặp action vô ích ≥ 3 lần → ép sang task stage ──
  const NON_REPEAT_OK = new Set(['eat','retreat','attack_hostile','equip_armor','deposit','smelt','sleep']);
  if (action === _aiLastAction && !NON_REPEAT_OK.has(action)) {
    _aiRepeatCount++;
    if (_aiRepeatCount >= 3) {
      const curStage = detectGameStage();
      const forced = { early:'chop',wood:'mine',stone:'mine',iron:'strip_mine',diamond:'explore',nether:'explore',pre_end:'explore',end_done:'explore' };
      const newAction = forced[curStage] || 'chop';
      logW(`[AI] Anti-repeat: "${action}" ×${_aiRepeatCount} → buộc sang "${newAction}"`);
      action = newAction;
      _aiRepeatCount = 0;
      _aiLastAction  = newAction;
    }
  } else {
    _aiRepeatCount = 0;
    _aiLastAction  = action;
  }

  aiLastDecision = { action, reason, stageTip, stage: aiGameStage, time: Date.now() };
  const decisionSource = (decision._source === 'heuristic') ? 'heuristic' : 'gemini';
  recordDecision(action, aiGameStage, reason, stageTip, decisionSource);
  logS(`[AI] [${aiGameStage.toUpperCase()}] ${action} — ${reason}${stageTip?' | '+stageTip:''}${decisionSource==='heuristic'?' [heuristic]':''}`);

  // Chat trong game xác nhận hành động (20% xác suất, dùng GEMINI_API_KEY để tiết kiệm)
  if (bot && botOnline && Math.random() < 0.2) {
    const msg = await getAI(
      `Tôi quyết định ${action} vì: ${reason}`,
      `Bạn là ${CONFIG.username} — bot Minecraft survival. 1 câu ≤8 từ, cá tính. Không ngoặc kép.`
    );
    if (msg) try { bot.chat(msg); } catch(_){}
  }

  switch (action) {
    case 'idle':
      // Không làm gì nhưng giữ đúng task label
      bot._task = '🧠 AI mode';
      break;

    case 'eat':
      try { await autoEat(); } catch(_){}
      break;

    case 'hunt':
      if (!isBusy) { resetState(); setTimeout(()=>{ stopTask=false; startAutoHunt?.(); },150); }
      break;

    case 'chop':
      if (!isBusy) { resetState(); setTimeout(()=>{ stopTask=false; autoTreeFarm?.(bot.username); },150); }
      break;

    case 'mine':
      if (!isBusy) doTask('mine', bot.username);
      break;

    case 'strip_mine':
      if (!isBusy) doTask('strip', bot.username);
      break;

    case 'fish':
      if (!isBusy && !isFishing) { resetState(); setTimeout(()=>{ stopTask=false; startAutoFish?.(bot.username); },150); }
      break;

    case 'explore':
      if (!isBusy) doTask('explore', bot.username);
      break;

    case 'surface':
      if (!isBusy) { resetState(); setTimeout(()=>{ stopTask=false; goToSurface?.(bot.username); },150); }
      break;

    case 'equip_armor':
      try { await equipBestArmor(); } catch(_){}
      break;

    case 'sleep':
      if (!isBusy) try { await goSleep?.(bot.username); } catch(_){}
      break;

    case 'deposit':
      if (!isBusy) { resetState(); setTimeout(()=>{ stopTask=false; depositToChest?.(bot.username); },150); }
      break;

    case 'brew':
      if (!isBusy) try { await autoBrewing?.(bot.username); } catch(_){}
      break;

    case 'attack_hostile': {
      // Equip vũ khí tốt nhất trước khi tấn công
      try { await equipBestWeapon?.(); } catch(_){}
      const hostile = Object.values(bot?.entities||{})
        .filter(e => e.type==='mob' && HOSTILE_MOBS.has(e.name||e.mobType||'')
          && e.position?.distanceTo(bot.entity?.position) < 20
          && e.name !== 'creeper') // không attack creeper
        .sort((a,b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (hostile && bot?.pvp) {
        bot._task = `⚔️ tấn công ${hostile.name}`;
        try { bot.pvp.attack(hostile); } catch(_){}
      }
      break;
    }

    case 'retreat': {
      // Set isFleeing để emergency loop không can thiệp trong lúc chạy
      _aiIsRetreating = true;
      isFleeing       = true;
      bot._task       = '🏃 rút lui';
      try { bot.pvp?.stop(); bot.pathfinder?.setGoal(null); } catch(_){}

      const _retreatPos = bot.entity?.position;
      const retreatHostiles = _retreatPos ? Object.values(bot?.entities||{})
        .filter(e => e.type==='mob' && HOSTILE_MOBS.has(e.name||e.mobType||'')
          && e.position?.distanceTo(_retreatPos) < 30) : [];

      if (retreatHostiles.length > 0 && _retreatPos) {
        const cx = retreatHostiles.reduce((s,e) => s + e.position.x, 0) / retreatHostiles.length;
        const cz = retreatHostiles.reduce((s,e) => s + e.position.z, 0) / retreatHostiles.length;
        const myPos = _retreatPos;
        const dx = myPos.x - cx, dz = myPos.z - cz;
        const len = Math.sqrt(dx*dx + dz*dz) || 1;
        const fleeX = myPos.x + (dx/len) * 30;
        const fleeZ = myPos.z + (dz/len) * 30;
        refreshMovements('follow');
        try {
          bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(fleeX), Math.round(fleeZ)));
          bot.setControlState('sprint', true);
          logS(`[AI] 🏃 Rút lui! ${retreatHostiles.length} mob → (${Math.round(fleeX)}, ${Math.round(fleeZ)})`);
        } catch(_){}
      }

      // Reset isFleeing sau 6 giây
      setTimeout(() => {
        isFleeing = false;
        _aiIsRetreating = false;
        try { bot?.setControlState('sprint', false); } catch(_){}
        if (aiModeEnabled && bot?._task === '🏃 rút lui') bot._task = '🧠 AI mode';
      }, 6000);
      break;
    }

    case 'smelt': {
      if (!isBusy && mcData) {
        const furnaceId    = mcData.blocksByName['furnace']?.id;
        const furnaceBlock = furnaceId ? bot.findBlock({ matching: furnaceId, maxDistance: 32 }) : null;
        if (furnaceBlock) {
          const SMELT_MAP = [
            { raw: 'raw_beef',           cooked: 'cooked_beef'     },
            { raw: 'raw_porkchop',        cooked: 'cooked_porkchop' },
            { raw: 'raw_mutton',          cooked: 'cooked_mutton'   },
            { raw: 'raw_chicken',         cooked: 'cooked_chicken'  },
            { raw: 'raw_salmon',          cooked: 'cooked_salmon'   },
            { raw: 'raw_cod',             cooked: 'cooked_cod'      },
            { raw: 'raw_rabbit',          cooked: 'cooked_rabbit'   },
            { raw: 'iron_ore',            cooked: 'iron_ingot'      },
            { raw: 'deepslate_iron_ore',  cooked: 'iron_ingot'      },
          ];
          const smeltTarget = SMELT_MAP.find(s => bot.inventory.items().some(i => i.name === s.raw));
          const fuelItem    = bot.inventory.items().find(i => i.name==='coal'||i.name==='charcoal'||i.name.endsWith('_log'));
          if (smeltTarget && fuelItem) {
            resetState();
            setTimeout(async () => {
              stopTask = false; isBusy = true;
              bot._task = `🔥 nướng ${smeltTarget.raw.replace('raw_','')}`;
              let furnaceWindow = null;
              try {
                await Promise.race([
                  bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2)),
                  new Promise(r => setTimeout(r, 8000)),
                ]);
                furnaceWindow = await bot.openFurnace(bot.blockAt(furnaceBlock.position));
                if (furnaceWindow) {
                  const rawInfo  = mcData.itemsByName[smeltTarget.raw];
                  const fuelInfo = mcData.itemsByName[fuelItem.name];
                  const rawCount = bot.inventory.items().find(i=>i.name===smeltTarget.raw)?.count || 1;
                  await furnaceWindow.putFuel(fuelInfo.id, null, Math.min(fuelItem.count, 8));
                  await furnaceWindow.putInput(rawInfo.id, null, Math.min(rawCount, 8));
                  await new Promise(r => setTimeout(r, 3500));
                  logS(`[AI] Smelt xong: ${smeltTarget.raw} → ${smeltTarget.cooked}`);
                }
              } catch(e) {
                logW('[AI Smelt] ' + e.message);
              } finally {
                try { furnaceWindow?.close?.(); } catch(_){}
                isBusy = false;
                bot._task = '🧠 AI mode';
                if (!isFollowing) startWander?.();
              }
            }, 200);
          }
        }
      }
      break;
    }

    default: {
      logW(`[AI] Hành động không rõ: "${action}" — dùng heuristic thay thế`);
      const fallback = heuristicFallbackDecision();
      if (fallback) await executeAIDecision({ ...fallback, stage_tip: '' });
      break;
    }
  }
}

// ── START / STOP AI MODE ──────────────────────────────────────────
// Task nào AI tự tạo ra và có thể bị ngắt bởi quyết định AI mới
// KHÔNG bao gồm task do người dùng bắt đầu thủ công
const AI_INTERRUPTIBLE_TASKS = new Set([
  'idle','wandering','🧠 AI mode',
  '🔥 nướng beef','🔥 nướng porkchop','🔥 nướng mutton',
  '🔥 nướng chicken','🔥 nướng salmon','🔥 nướng cod',
]);

// Kiểm tra xem có nên gọi AI không (smart skip)
function shouldCallAI() {
  if (!bot || !botOnline) return false;
  const hp   = Math.round(bot.health ?? 0);
  const food = Math.round(bot.food   ?? 0);

  // Luôn gọi khi khẩn cấp sinh tồn — kể cả đang manual override
  if (hp < 4 || food === 0) return true;

  // Manual override: người dùng vừa ra lệnh thủ công → nhường quyền điều khiển
  if (Date.now() < _manualOverrideUntil) return false;

  // Bỏ qua khi bot đang bận task thủ công hoặc quan trọng
  if (isBusy && !AI_INTERRUPTIBLE_TASKS.has(bot._task || 'idle')) return false;

  // ── State cache: tiết kiệm API call khi không có gì thay đổi ──────
  const mobCount = Object.values(bot.entities || {})
    .filter(e => e.type === 'mob' && HOSTILE_MOBS.has(e.name || e.mobType || '')
      && e.position?.distanceTo(bot.entity?.position) < 20).length;
  const stage = aiGameStage;
  const now   = Date.now();

  if (_aiStateCache) {
    const hpChanged    = Math.abs(hp   - _aiStateCache.hp)   > 2;
    const foodChanged  = Math.abs(food - _aiStateCache.food) > 3;
    const mobChanged   = Math.abs(mobCount - _aiStateCache.mobCount) >= 1;
    const stageChanged = stage !== _aiStateCache.stage;
    const forcedByTime = (now - _aiStateCache.time) >= AI_STATE_FORCE_INTERVAL;

    // Bỏ qua nếu không có gì đáng kể thay đổi VÀ chưa đến lúc force call
    if (!hpChanged && !foodChanged && !mobChanged && !stageChanged && !forcedByTime) {
      return false;
    }
  }

  // Cập nhật cache trước khi gọi
  _aiStateCache = { hp, food, mobCount, stage, time: now };
  return true;
}

// Gọi khi người dùng ra lệnh thủ công trong lúc AI mode bật
// AI nhường quyền trong `durationMs` ms rồi tự tiếp quản lại
function setManualOverride(durationMs = 120000) {
  _manualOverrideUntil = Date.now() + durationMs;
  if (aiModeEnabled) {
    const mins = Math.round(durationMs / 60000);
    logS(`[AI] ⏸ Nhường quyền manual ${mins} phút — AI tiếp quản lại sau đó (gõ "ai resume" để tiếp quản ngay)`);
  }
}

function startAIMode() {
  if (aiModeEnabled) return;
  loadAIMemory(); // Nạp lại bộ nhớ học
  aiModeEnabled = true;
  if (bot) bot._task = '🧠 AI mode'; // Hiển thị đúng status trên web console
  logS(`[AI MODE] ĐÃ BẬT — Tick 20s (state cache skip khi không đổi, force call mỗi 4 phút), craft 30s, emergency 2s`);
  if (bot && botOnline) try { bot.chat(`🧠 AI Mode bật! Giai đoạn: ${detectGameStage().toUpperCase()} — Quyết định ${aiMemory.totalDecisions || 0} lần trước.`); } catch(_){}

  // ── Emergency Survival Loop: 2 giây/lần — KHÔNG tốn API ────────
  // Chỉ xử lý tình huống nguy hiểm TUYỆT ĐỐI, không override manual
  _emergencyInterval = setInterval(async () => {
    if (!bot || !botOnline || !aiModeEnabled || !bot.entity) return;
    const hp   = bot.health ?? 20;
    const food = bot.food   ?? 20;
    const isManualMode = Date.now() < _manualOverrideUntil;

    // Ăn KHẨN CẤP: HP < 5 hoặc food = 0 — làm kể cả khi manual override
    if ((hp < 5 || food === 0) && !isEating) {
      try { await autoEat(); } catch(_){}
      return;
    }

    // Tự vệ KHẨN CẤP: mob đang tấn công trực tiếp (< 3m) — làm kể cả manual override
    // Chỉ khi HP đang bị tổn thương (< 18) và không đang fleeing
    if (hp < 18 && !activeDuel && !isFleeing && autoAttackEnabled && bot.entity) {
      const immediateThreat = Object.values(bot.entities || {})
        .filter(e => e.type === 'mob' && HOSTILE_MOBS.has(e.name || e.mobType || '')
          && e.position?.distanceTo(bot.entity.position) < 3) // chỉ mob sát bên (3m, không phải 5m)
        .sort((a,b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (immediateThreat && bot?.pvp && immediateThreat.name !== 'creeper') {
        try { await equipBestWeapon(); bot.pvp.attack(immediateThreat); } catch(_){}
      }
    }

    // Equip giáp: chỉ làm khi KHÔNG manual override (không interrupt thủ công)
    if (!isManualMode && !isFullyArmored() && !isBusy) {
      try { await equipBestArmor(); } catch(_){}
    }
  }, 2000);

  // ── AI Decision Loop: 20 giây/lần — state cache skip hầu hết, react nhanh khi state đổi ──
  aiDecisionInterval = setInterval(async () => {
    if (!bot || !botOnline || !aiModeEnabled) return;
    if (aiDecisionCooldown) return;
    if (!shouldCallAI()) return; // Smart skip — không tốn API
    aiDecisionCooldown = true;
    try {
      const decision = await getAIDecision();
      if (decision) await executeAIDecision(decision);
    } catch(e) { logW(`[AI MODE] Lỗi: ${e.message}`); }
    finally { aiDecisionCooldown = false; }
  }, 32000);

  // ── Periodic AI Status Broadcast: mỗi 2 phút ────────────────────
  _aiStatusLogInterval = setInterval(() => {
    if (!aiModeEnabled) return;
    const hp   = bot?.health   != null ? Math.round(bot.health)   : '?';
    const food = bot?.food     != null ? Math.round(bot.food)     : '?';
    const pos  = bot?.entity?.position ? `${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}` : '?';
    const overrideLeft = _manualOverrideUntil > Date.now() ? `⏸ pause ${Math.round((_manualOverrideUntil-Date.now())/60000)}ph` : '';
    const lastDec  = aiLastDecision ? `${aiLastDecision.action} — ${aiLastDecision.reason?.slice(0,60)}` : 'chưa có';
    const sinceMin = aiLastDecision ? Math.round((Date.now()-aiLastDecision.time)/60000) : '?';
    const chatKeyOk = CONFIG.geminiApiKey ? '✅' : '❌';
    const decKeyOk  = CONFIG.aiDecisionKey ? '✅(riêng)' : '(chung)';
    logS(`[AI STATUS] 🟢 Stage: ${aiGameStage.toUpperCase()} | HP:${hp} Food:${food} | ${pos} | Quyết định: ${aiMemory.totalDecisions||0} | ${overrideLeft||'đang chạy'}`);
    logS(`[AI STATUS] 📋 Lần cuối (${sinceMin}ph trước): ${lastDec}`);
    logS(`[AI STATUS] 🔑 Chat: ${chatKeyOk} | Decision: ${decKeyOk} | Queue: ${_aiDecisionQueue.length} chờ`);
  }, 120000);

  // ── Craft Loop: 30 giây/lần — không tốn API call ───────────────
  _craftLoopInterval = setInterval(async () => {
    if (!bot || !botOnline || !aiModeEnabled) return;
    if (isBusy && !AI_INTERRUPTIBLE_TASKS.has(bot._task)) return;
    try { await smartCraftItems(); } catch(e) { logW(`[CRAFT LOOP] ${e.message}`); }
  }, 30000);

  // Chạy quyết định đầu tiên ngay sau 3 giây (không phải chờ 45s)
  setTimeout(async () => {
    if (!aiModeEnabled || !bot || !botOnline) return;
    try { await smartCraftItems(); } catch(_){}
    if (!aiDecisionCooldown && shouldCallAI()) {
      aiDecisionCooldown = true;
      try {
        const decision = await getAIDecision();
        if (decision) await executeAIDecision(decision);
      } catch(_) {}
      finally { aiDecisionCooldown = false; }
    }
  }, 3000);
}

function stopAIMode() {
  if (!aiModeEnabled) return;
  aiModeEnabled      = false;
  if (bot) bot._task = 'idle';
  isBusy             = false;
  isFleeing          = false;        // BUG FIX: reset trạng thái retreat do AI gây ra
  _aiIsRetreating    = false;
  _manualOverrideUntil = 0;          // BUG FIX: xóa override để không ảnh hưởng lần bật tiếp
  _aiLastAction      = null;
  _aiRepeatCount     = 0;
  if (aiDecisionInterval)   { clearInterval(aiDecisionInterval);   aiDecisionInterval   = null; }
  if (_craftLoopInterval)   { clearInterval(_craftLoopInterval);   _craftLoopInterval   = null; }
  if (_emergencyInterval)   { clearInterval(_emergencyInterval);   _emergencyInterval   = null; }
  if (_aiStatusLogInterval) { clearInterval(_aiStatusLogInterval); _aiStatusLogInterval = null; }
  try { bot?.clearControlStates?.(); } catch(_){}
  try { bot?.setControlState?.('sprint', false); } catch(_){}
  saveAIMemory();
  logS(`[AI MODE] ĐÃ TẮT — đã học ${aiMemory.totalDecisions || 0} quyết định, lưu bộ nhớ`);
  if (bot && botOnline) try { bot.chat(`🔴 AI tắt. Đã quyết định ${aiMemory.totalDecisions||0} lần, đạt stage: ${Object.keys(aiMemory.stageReached||{}).join('→')||'early'}. Bạn kiểm soát!`); } catch(_){}
  setTimeout(() => { if (!isBusy && !isFollowing && bot && botOnline) startWander?.(); }, 800);
}

// ── GIÁP ──────────────────────────────────────────────────────────
const ARMOR_SLOTS = [
  { dest: 'head',  p: ['netherite_helmet','diamond_helmet','iron_helmet','chainmail_helmet','golden_helmet','leather_helmet'] },
  { dest: 'torso', p: ['netherite_chestplate','diamond_chestplate','iron_chestplate','chainmail_chestplate','golden_chestplate','leather_chestplate'] },
  { dest: 'legs',  p: ['netherite_leggings','diamond_leggings','iron_leggings','chainmail_leggings','golden_leggings','leather_leggings'] },
  { dest: 'feet',  p: ['netherite_boots','diamond_boots','iron_boots','chainmail_boots','golden_boots','leather_boots'] },
];

async function equipBestArmor() {
  if (!bot) return;
  const inv = bot.inventory.slots.slice(9);
  for (const { dest, p } of ARMOR_SLOTS) {
    let best = null, bi = Infinity;
    for (const item of inv) { if (!item) continue; const i = p.indexOf(item.name); if (i !== -1 && i < bi) { bi = i; best = item; } }
    const ws = { head:5, torso:6, legs:7, feet:8 }[dest];
    const worn = bot.inventory.slots[ws];
    const wi = worn ? p.indexOf(worn.name) : Infinity;
    if (best && bi < wi) { try { await bot.equip(best, dest); await new Promise(r => setTimeout(r,200)); logS(`Mặc ${best.name}`); } catch(e) { logW(`Lỗi mặc giáp: ${e.message}`); } }
  }
  // Auto-chuyển khiên sang tay trái nếu chưa cầm
  const offHand = bot.inventory.slots[45];
  if (!offHand || offHand.name !== 'shield') {
    const shield = bot.inventory.items().find(i => i.name === 'shield');
    if (shield) {
      try { await bot.equip(shield, 'off-hand'); logS('🛡 Khiên → tay trái'); } catch(e) {}
    }
  }
}

// ── ĂN ────────────────────────────────────────────────────────────
const FOOD_LIST = [
  'cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken','cooked_salmon','cooked_cod','cooked_rabbit',
  'bread','baked_potato','pumpkin_pie','rabbit_stew','mushroom_stew','beetroot_soup',
  'honey_bottle','sweet_berries','glow_berries','dried_kelp','cookie','melon_slice',
  'apple','carrot','beetroot','tropical_fish','suspicious_stew',
  'raw_beef','raw_porkchop','raw_mutton','raw_chicken','raw_salmon','raw_cod','raw_rabbit',
];

async function autoEat() {
  if (!bot || !autoEatEnabled || isEating || !mcData || !bot.inventory) return;
  if (isDoingSpecialCombo) return; // không ăn giữa chừng combo PvP
  const foodVal = bot.food   ?? 20;
  const hp      = bot.health ?? 20;
  // Ăn khi đói (< 16) hoặc máu yếu (< 8 = 4 trái tim) và có đồ ăn
  if (foodVal >= 16 && hp >= 8) return;
  let food = null;
  for (const n of FOOD_LIST) { const info = mcData.itemsByName[n]; if (!info) continue; const f = bot.inventory.findInventoryItem(info.id, null, false); if (f) { food = f; break; } }
  // Rotten flesh: chỉ ăn khẩn cấp khi HP < 5 và không còn thức ăn nào khác
  if (!food && hp < 5) {
    const rfInfo = mcData.itemsByName['rotten_flesh'];
    if (rfInfo) food = bot.inventory.findInventoryItem(rfInfo.id, null, false);
  }
  if (!food) return;
  isEating = true;
  const prev = bot.heldItem;
  try { await bot.equip(food, 'hand'); await bot.consume(); logS(`🍖 Ăn ${food.name.replace(/_/g,' ')} (food:${Math.round(bot.food)}/20 hp:${Math.round(bot.health)}/20)`); }
  catch(e) {}
  finally { try { if (prev) await bot.equip(prev, 'hand'); } catch(e){} isEating = false; }
}

// ── AUTO HUNT ──────────────────────────────────────────────────────
// Khi đói/máu yếu và không có đồ ăn chín → săn động vật gần nhất, ăn thịt sống
const HUNTABLE_MOBS = new Set(['cow','pig','sheep','chicken','rabbit','mooshroom','hoglin']);
const RAW_MEATS = ['raw_beef','raw_porkchop','raw_mutton','raw_chicken','raw_rabbit'];
const COOKED_FOODS = ['cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken','cooked_salmon','cooked_cod','bread','baked_potato'];

async function tryEatRaw() {
  if (isEating || !mcData) return;
  for (const n of RAW_MEATS) {
    const info = mcData.itemsByName[n]; if (!info) continue;
    const item = bot.inventory.findInventoryItem(info.id, null, false);
    if (item) {
      isEating = true;
      const prev = bot.heldItem;
      try { await bot.equip(item,'hand'); await bot.consume(); logS(`🥩 Ăn thịt sống ${n.replace(/_/g,' ')} (khẩn cấp)`); }
      catch(e){}
      finally { try { if (prev) await bot.equip(prev,'hand'); } catch(e){} isEating = false; }
      return true;
    }
  }
  return false;
}

function hasGoodFood() {
  if (!mcData) return false;
  return COOKED_FOODS.some(n => {
    const info = mcData.itemsByName[n]; if (!info) return false;
    return !!bot.inventory.findInventoryItem(info.id, null, false);
  });
}

async function startAutoHunt() {
  if (huntInterval) clearInterval(huntInterval);
  huntInterval = setInterval(async () => {
    if (!bot || !botOnline || !mcData || isHunting || activeDuel) return;
    const food = bot.food   ?? 20;
    const hp   = bot.health ?? 20;
    const hungry    = food < 10 || hp < 8;   // cần ăn
    const emergency = food < 4  || hp < 5;   // khẩn cấp
    if (!hungry) return;

    // Không săn khi đang bận, trừ khẩn cấp
    if (isBusy && !emergency) return;

    // Nếu có đồ ăn tốt rồi → autoEat lo
    if (hasGoodFood() && !emergency) return;

    // Thịt sống còn trong túi thì ăn luôn
    if (await tryEatRaw()) return;

    // Tìm động vật gần nhất (30m)
    let nearest = null, minD = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position) continue;
      if (!HUNTABLE_MOBS.has(e.name || e.mobType || '')) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d < minD && d <= 30) { minD = d; nearest = e; }
    }
    if (!nearest) return;

    isHunting = true;
    const prevTask = bot._task, prevBusy = isBusy;
    // Không ghi đè isBusy khi emergency — task gốc vẫn đang chạy
    bot._task = 'săn động vật';
    logS(`🏹 Săn ${nearest.name||nearest.mobType} cách ${Math.round(minD)}m (food=${food}/20 hp=${Math.round(hp)}/20)`);
    try {
      await equipBestWeapon();
      bot.pvp.attack(nearest);

      // Chờ con vật chết tối đa 10s
      for (let i = 0; i < 33; i++) {
        await new Promise(r => setTimeout(r, 300));
        if (!bot.entities[nearest.id]) break; // đã chết
      }
      try { bot.pvp.stop(); } catch(_){}

      // Chờ item rơi vào túi (~1.5s)
      await new Promise(r => setTimeout(r, 1500));

      // Ăn ngay nếu vẫn đói/yếu
      if ((bot.food ?? 20) < 14 || (bot.health ?? 20) < 12) {
        // Ưu tiên chín, fallback thịt sống
        await autoEat();
        if ((bot.food ?? 20) < 14) await tryEatRaw();
      }
    } catch(e) {
      logW('[Hunt] ' + e.message);
      try { bot.pvp.stop(); } catch(_){}
    } finally {
      isHunting = false;
      bot._task = prevTask;
      isBusy = prevBusy;
    }
  }, 5000); // kiểm tra mỗi 5 giây
}

function stopAutoHunt() {
  if (huntInterval) { clearInterval(huntInterval); huntInterval = null; }
  isHunting = false;
}

// ── MOVEMENT ──────────────────────────────────────────────────────
// mode: 'default' | 'follow' | 'baritone' | 'build'
// 'baritone': bật scaffold + tower + đào block — y hệt Baritone Java
// 'build'   : bật scaffold, không đào, dùng khi xây công trình
// Các block dùng làm scaffold (leo lên cao) — dùng chung cả baritone & build
const SCAFFOLD_NAMES = [
  'cobblestone','dirt','gravel','sand','oak_planks','spruce_planks','birch_planks',
  'jungle_planks','acacia_planks','dark_oak_planks','stone','granite','diorite','andesite',
  'netherrack','end_stone','cobbled_deepslate','tuff','calcite','deepslate','sandstone',
  'red_sandstone','smooth_stone','polished_granite','polished_diorite','polished_andesite',
];
function getScaffoldIds() {
  const ids = [];
  if (!bot?.inventory) return ids;
  for (const item of bot.inventory.items()) {
    if (SCAFFOLD_NAMES.some(n => item.name.includes(n)) && !ids.includes(item.type))
      ids.push(item.type);
  }
  return ids;
}

// ── Block nguy hiểm: tránh hoàn toàn hoặc tính cost cao ─────────────
// (dùng bởi refreshMovements — định nghĩa 1 lần, tái sử dụng mọi mode)
const DANGER_AVOID_NAMES = [
  'lava','flowing_lava','fire','soul_fire','wither_rose',
];
const DANGER_COST_NAMES = {
  magma_block: 300, cactus: 250, sweet_berry_bush: 120,
  cobweb: 350, powder_snow: 180, campfire: 200, soul_campfire: 200,
};

function _applyDangerBlocks(mov) {
  if (!mcData) return;
  for (const name of DANGER_AVOID_NAMES) {
    const b = mcData.blocksByName[name];
    if (b) { try { mov.blocksToAvoid.add(b.id); } catch(_) {} }
  }
  for (const [name, cost] of Object.entries(DANGER_COST_NAMES)) {
    const b = mcData.blocksByName[name];
    if (b) {
      try {
        if (typeof mov.blocksCost === 'object') mov.blocksCost[b.id] = cost;
      } catch(_) {}
    }
  }
}

function refreshMovements(mode = 'default') {
  if (!bot || !mcData) return;
  if (mode === true)  mode = 'follow';
  if (mode === false) mode = 'default';

  const mov = new Movements(bot);
  mov.allowSprinting  = true;
  mov.allowParkour    = true;
  mov.allowSwim       = true;
  // Bật mở cửa mọi mode — tránh bị kẹt bởi cửa gỗ / trapdoor
  try { mov.canOpenDoors = true; } catch(_) {}
  try { mov.canJump = true; } catch(_) {}

  if (mode === 'follow') {
    // Theo người chơi: đào block cản, không leo cột, không đặt scaffold
    mov.canDig            = true;
    mov.allow1by1towers   = false;
    mov.scaffoldingBlocks = [];
    mov.maxDropDown       = 5;

  } else if (mode === 'baritone') {
    // Baritone full: đào + leo cột + đặt scaffold — dùng cho scaffoldGoto
    mov.canDig            = true;
    mov.allow1by1towers   = true;
    mov.maxDropDown       = 10;
    mov.scaffoldingBlocks = getScaffoldIds();

  } else if (mode === 'build') {
    // Build mode: KHÔNG đào (không phá block đã đặt),
    // NHƯNG vẫn leo cột + scaffold để với tới vị trí cao
    mov.canDig            = false;
    mov.allow1by1towers   = true;
    mov.maxDropDown       = 4;
    mov.scaffoldingBlocks = getScaffoldIds();

  } else {
    // default: wander / farm thông thường — cho phép đào block địa hình cản đường
    mov.canDig            = true;   // đào block tự nhiên cản đường khi wander/farm/mine
    mov.allow1by1towers   = false;  // không đặt scaffold khi wander
    mov.scaffoldingBlocks = [];
    mov.maxDropDown       = 6;      // nhảy xuống cao hơn để qua địa hình dốc
  }

  // Áp dụng tránh block nguy hiểm cho mọi mode
  _applyDangerBlocks(mov);

  bot.pathfinder.setMovements(mov);
}

// Kiểm tra túi có gần đầy không (còn ≤2 ô trống trong 36 slot)
function isInventoryFull() {
  let empty = 0;
  for (let i = 9; i < 45; i++) { if (!bot.inventory.slots[i]) empty++; }
  return empty <= 2;
}

const TOOL_PRI = ['netherite','diamond','iron','stone','wooden','golden'];

// BUG FIX ET-1,2,3: Ưu tiên material field (minecraft-data dùng 'mineable/pickaxe' etc.),
// fallback sang name-based; thêm hyphae/stem/leaves; log khi không có tool
async function equipToolForBlock(block) {
  if (!mcData || !block || !bot) return;
  const bd = mcData.blocks[block.type]; if (!bd) return;
  const name = bd.name || '';
  // BUG FIX ET-1: minecraft-data dùng 'mineable/pickaxe', không phải 'rock'/'stone'
  const mat  = bd.material || '';
  let tt = null;

  // Primary: dùng material field của minecraft-data (chính xác nhất)
  if (mat.includes('mineable/pickaxe') || mat.includes('rock') || mat.includes('stone')) {
    tt = 'pickaxe';
  } else if (mat.includes('mineable/axe') || mat.includes('wood')) {
    tt = 'axe';
  } else if (mat.includes('mineable/shovel') || mat.includes('ground') || mat.includes('sand')) {
    tt = 'shovel';
  }

  // Fallback: name-based (khi material field thiếu hoặc không khớp)
  if (!tt) {
    if (
      name.includes('stone') || name.includes('ore') || name.includes('cobblestone') ||
      name.includes('deepslate') || name.includes('obsidian') || name.includes('brick') ||
      name.includes('terracotta') || name.includes('concrete') || name.includes('glass') ||
      name.includes('basalt') || name.includes('prismarine') || name.includes('purpur') ||
      name.includes('quartz') || name.includes('end_stone') || name.includes('netherrack') ||
      name.includes('blackstone') || name.includes('tuff') || name.includes('calcite') ||
      name.includes('dripstone') || name.includes('amethyst') || name.includes('copper')
    ) tt = 'pickaxe';
    else if (
      name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_hyphae') || // BUG FIX ET-2: thêm hyphae
      name.endsWith('_stem') ||  // warped_stem / crimson_stem
      name.endsWith('_block') && (name.includes('mushroom') || name.includes('hay') || name.includes('bamboo')) ||
      name.includes('planks') || name.includes('chest') || name.includes('_slab') ||
      name.includes('_stairs') || name.includes('_fence') || name.includes('_door') ||
      name.includes('_trapdoor') || name.includes('barrel') || name.includes('bookshelf') ||
      name.includes('crafting_table') || name.includes('jukebox') || name.includes('note_block') ||
      name.includes('_sign') || name.includes('bamboo') || name.includes('ladder') ||
      name.includes('cartography') || name.includes('fletching') || name.includes('smithing') ||
      name.includes('stripped_')
    ) tt = 'axe';
    else if (
      name.includes('dirt') || name.includes('grass') || name.includes('sand') ||
      name.includes('gravel') || name.includes('soul') || name.includes('clay') ||
      name.includes('mud') || name.includes('podzol') || name.includes('mycelium') ||
      name.includes('path') || name.includes('snow') || name.includes('farmland')
    ) tt = 'shovel';
  }

  // BUG FIX ET-3: cảnh báo khi không tìm được loại tool
  if (!tt) {
    logW(`[Tool] Không xác định tool cho ${name} (mat=${mat}) — đào bằng tay`);
    return;
  }

  const invItems = bot.inventory.items();
  for (const m of TOOL_PRI) {
    const tool = invItems.find(i => i.name === `${m}_${tt}`);
    if (tool) {
      try { await bot.equip(tool, 'hand'); return; } catch(e) { logW(`[Tool] equip ${m}_${tt}: ${e.message}`); }
    }
  }
  logW(`[Tool] Không có ${tt} trong túi để đào ${name}`);
}

// ── SMART DIG ──────────────────────────────────────────────────────
// Chọn mặt block tốt nhất (gần mắt bot nhất) → lookAt chính xác → đào
// Giảm thời gian xoay đầu và tăng độ chính xác hit so với forceLook mặc định
async function smartDig(block, forceEquip = true) {
  if (!block || !bot) return;
  if (forceEquip) await equipToolForBlock(block);

  // Vị trí mắt bot (eye height 1.62)
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const bp  = block.position;

  // 6 mặt block: normal vector + tâm mặt để lookAt
  const FACES = [
    { n: new Vec3( 0,  1,  0), c: bp.offset(0.5, 1.0, 0.5) },
    { n: new Vec3( 0, -1,  0), c: bp.offset(0.5, 0.0, 0.5) },
    { n: new Vec3( 1,  0,  0), c: bp.offset(1.0, 0.5, 0.5) },
    { n: new Vec3(-1,  0,  0), c: bp.offset(0.0, 0.5, 0.5) },
    { n: new Vec3( 0,  0,  1), c: bp.offset(0.5, 0.5, 1.0) },
    { n: new Vec3( 0,  0, -1), c: bp.offset(0.5, 0.5, 0.0) },
  ];

  // Hướng từ mắt bot → tâm block
  const toBlock = bp.offset(0.5, 0.5, 0.5).minus(eye).normalize();

  // Chọn mặt có normal ngược chiều nhất với toBlock
  // (dot âm nhất = mặt "đối diện" với bot → mặt bot có thể nhìn thấy)
  let best = FACES[0], bestDot = Infinity;
  for (const f of FACES) {
    const dot = f.n.dot(toBlock);
    if (dot < bestDot) { bestDot = dot; best = f; }
  }

  try { await bot.lookAt(best.c, true); } catch(_) {}
  // forceLook=false vì đã lookAt thủ công — tránh giật đầu 2 lần
  await bot.dig(block, false);
}

// ── SMART PLACE ────────────────────────────────────────────────────
// Thử đặt block vào targetPos bằng cách quét 6 mặt tìm block reference hợp lệ.
// Trả về true nếu đặt thành công. item phải đã được equip trước khi gọi.
async function smartPlace(targetPos) {
  if (!bot || !targetPos) return false;

  const FACE_VECS = [
    new Vec3( 0, -1,  0), // ưu tiên đặt lên mặt trên (block bên dưới làm ref)
    new Vec3( 0,  1,  0),
    new Vec3( 1,  0,  0),
    new Vec3(-1,  0,  0),
    new Vec3( 0,  0,  1),
    new Vec3( 0,  0, -1),
  ];

  // Kiểm tra targetPos đang trống
  const cur = bot.blockAt(targetPos);
  if (cur && cur.name !== 'air') return false;

  for (const fv of FACE_VECS) {
    // refBlock = block liền kề targetPos theo chiều fv (bot đặt lên mặt -fv của ref)
    const refPos = targetPos.minus(fv);
    const ref = bot.blockAt(refPos);
    if (!ref || ref.name === 'air' || ref.boundingBox === 'empty') continue;

    // Điểm lookAt = trung tâm mặt tiếp xúc giữa ref và targetPos
    const lookPt = refPos.offset(
      0.5 + fv.x * 0.5,
      0.5 + fv.y * 0.5,
      0.5 + fv.z * 0.5,
    );
    try {
      await bot.lookAt(lookPt, true);
      await bot.placeBlock(ref, fv);
      return true;
    } catch(_) {}
  }
  return false;
}

function resetState() {
  stopTask = true; isFollowing = false; isBusy = false;
  isStandingStill = false; // lệnh mới → bỏ chế độ đứng yên
  _cmdPending = true; // ngăn startWander chạy trước khi lệnh mới bắt đầu
  setTimeout(() => { _cmdPending = false; }, 600); // hết hiệu lực sau 600ms
  stopBodyguard(); stopAutoFish(); stopJumpAssist();
  // Dừng các task có interval riêng (không truy cập được từ closure ngoài)
  if (_stopMobFarmFn) try { _stopMobFarmFn(); } catch(e){}
  if (_stopPatrolFn)  try { _stopPatrolFn();  } catch(e){}
  if (wanderInterval) { clearInterval(wanderInterval); wanderInterval = null; }
  try { bot.clearControlStates(); } catch(e){}
  try { bot.pathfinder.setGoal(null); } catch(e){}
}

// ── WANDER ────────────────────────────────────────────────────────
let _wanderLastGoalAt = 0; // timestamp lần cuối đặt goal wander
function startWander() {
  if (wanderInterval || isBusy || isFollowing || _cmdPending || isStandingStill) return;
  bot._task = 'wandering';
  wanderInterval = setInterval(() => {
    if (!bot || !botOnline || isBusy || isFollowing || !bot.entity?.position) return;
    // Chỉ bỏ qua nếu đang di chuyển VÀ chưa quá 6s kể từ lần đặt goal gần nhất
    try {
      if (bot.pathfinder.isMoving() && Date.now() - _wanderLastGoalAt < 6000) return;
    } catch(e) { return; }
    refreshMovements();
    const pos = bot.entity.position;
    const target = bot.findBlock({ matching: b => { if (!b?.position) return false; const s=b.name==='grass_block'||b.name==='dirt'||b.name==='stone'; const u1=bot.blockAt(b.position.offset(0,1,0)); const u2=bot.blockAt(b.position.offset(0,2,0)); return s&&u1?.name==='air'&&u2?.name==='air'; }, maxDistance: 12 });
    if (target) { try { bot.pathfinder.setGoal(new GoalXZ(target.position.x, target.position.z)); _wanderLastGoalAt = Date.now(); } catch(e){} }
    else { const rx=pos.x+(Math.random()-.5)*16, rz=pos.z+(Math.random()-.5)*16; try { bot.pathfinder.setGoal(new GoalXZ(rx,rz)); _wanderLastGoalAt = Date.now(); } catch(e){} }
  }, 1500);
}

// ── AUTO ATTACK ───────────────────────────────────────────────────
const WEAPON_PRI = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword',
                    'netherite_axe','diamond_axe','iron_axe'];

async function equipBestWeapon() {
  if (!bot) return;
  for (const w of WEAPON_PRI) {
    const weapon = bot.inventory.slots.find(i => i && i.name === w);
    if (weapon) { try { await bot.equip(weapon, 'hand'); } catch(e){} return; }
  }
}

// Trang bị kiếm tốt nhất (tay chính) + khiên (tay phụ) trước khi đánh nhau
async function equipCombatLoadout() {
  if (!bot) return;
  await equipBestWeapon();
  const shield = bot.inventory.slots.find(i => i && i.name === 'shield');
  if (shield) {
    try {
      await bot.equip(shield, 'off-hand');
      logS('🛡 Đã trang bị khiên tay phụ');
    } catch(e) { logW('Lỗi trang bị khiên: ' + e.message); }
  }
}

// ── WATER BUCKET HELPERS ───────────────────────────────────────────
// Tất cả nước bot đặt ra đều được track → thu hồi đảm bảo

// Múc lại TẤT CẢ nước bot đã đặt (theo vị trí đã ghi + fallback tìm xung quanh)
async function collectBotWater(label) {
  if (!bot || !mcData) return;
  const tag = label || 'Water';
  let collected = 0;
  // Thu hồi theo vị trí đã ghi trước
  while (_botPlacedWaterPositions.length > 0) {
    const pos = _botPlacedWaterPositions.shift();
    const emptyBucket = bot.inventory.items().find(i => i.name === 'bucket');
    if (!emptyBucket) break; // không còn bucket rỗng
    // Tìm source block quanh vị trí đã đặt (nước có thể chảy lệch 1-2 block)
    let wb = null;
    for (let dx = -2; dx <= 2 && !wb; dx++) {
      for (let dz = -2; dz <= 2 && !wb; dz++) {
        for (let dy = 0; dy >= -2 && !wb; dy--) {
          const b = bot.blockAt(pos.offset(dx, dy, dz));
          if (b && b.name === 'water' && b.metadata === 0) wb = b;
        }
      }
    }
    if (!wb) continue;
    try {
      const distToWater = bot.entity.position.distanceTo(wb.position);
      // Dùng timeout tỉ lệ theo khoảng cách (tối thiểu 3s, tối đa 12s)
      const gotoTimeout = Math.min(12000, Math.max(3000, distToWater * 250));
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(wb.position.x, wb.position.y, wb.position.z, 2)),
        new Promise(r => setTimeout(r, gotoTimeout)),
      ]);
      await bot.equip(emptyBucket, 'hand');
      await bot.lookAt(wb.position.offset(0.5, 0.5, 0.5), true);
      bot.activateItem();
      await new Promise(r => setTimeout(r, 450));
      if (bot.inventory.items().some(i => i.name === 'water_bucket')) {
        logS(`[${tag}] ✅ Thu hồi nước tại (${Math.round(wb.position.x)},${Math.round(wb.position.y)},${Math.round(wb.position.z)})`);
        collected++;
      }
    } catch(_) {}
  }
  if (collected > 0) logS(`[${tag}] Thu hồi ${collected} xô nước.`);
}

// ── PvP HELPER: ĐẶT XÔ NƯỚC KHI CHẠY TRỐN ────────────────────────
// Đặt nước dưới chân bot, ghi vị trí để thu hồi sau
async function tryPlaceWaterBucket(enemyPos) {
  if (!bot || !mcData) return false;
  const bucket = bot.inventory.items().find(i => i.name === 'water_bucket');
  if (!bucket) return false;

  const myPos = bot.entity.position;
  const groundBelow = bot.blockAt(myPos.offset(0, -1, 0));
  if (!groundBelow || groundBelow.name === 'air' || groundBelow.name === 'water') return false;

  try {
    await bot.equip(bucket, 'hand');
    // Nhìn XUỐNG để đặt nước dưới chân (góc pitch = PI/2 = nhìn thẳng xuống đất)
    await bot.look(bot.entity.yaw, Math.PI / 2, true);
    await new Promise(r => setTimeout(r, 80));
    bot.activateItem(); // right-click → đặt nước
    // Ghi vị trí để thu hồi sau
    const waterPos = myPos.offset(0, -1, 0);
    _botPlacedWaterPositions.push(waterPos.clone());
    logS('[PvP] 🪣 Đặt nước dưới chân — làm chậm kẻ thù!');
    await new Promise(r => setTimeout(r, 400));
    return true;
  } catch(e) { return false; }
}

// ── PvP HELPER: MÚC LẠI NƯỚC SAU KHI HỒI MÁU ─────────────────────
async function tryPickUpWater() {
  return collectBotWater('PvP');
}

// ── WATER CLUTCH ───────────────────────────────────────────────────
// Khi bot rơi cao ≥ 5 block: đặt nước ngay trước khi chạm đất → không chết
// Sau khi đáp: thu hồi nước ngay lập tức
let _clutchFallStartY = null; // Y khi bắt đầu rơi (để tính chiều cao)
let _clutchGroundY    = null; // Y ước tính của mặt đất

async function waterClutch() {
  if (!bot || _waterClutchActive) return;
  _waterClutchActive = true;
  logS('[Clutch] 🪣 WATER CLUTCH! Đặt nước để hạ cánh an toàn...');
  try {
    const bucket = bot.inventory.items().find(i => i.name === 'water_bucket');
    if (!bucket) { _waterClutchActive = false; return; }

    await bot.equip(bucket, 'hand');
    // Nhìn THẲNG XUỐNG (pitch = PI/2) rồi kích hoạt ngay
    await bot.look(bot.entity.yaw, Math.PI / 2, true);
    bot.activateItem();
    const waterPos = bot.entity.position.offset(0, -1, 0);
    _botPlacedWaterPositions.push(waterPos.clone());
    await new Promise(r => setTimeout(r, 200));

    // Chờ chạm đất (tối đa 4s)
    await new Promise(resolve => {
      let ticks = 0;
      const id = setInterval(() => {
        ticks++;
        if (!bot || bot.entity?.onGround || ticks > 40) { clearInterval(id); resolve(); }
      }, 100);
    });

    // Đợi 1 tick ổn định rồi thu hồi ngay
    await new Promise(r => setTimeout(r, 250));
    await collectBotWater('Clutch');
    // Trang bị lại vũ khí nếu đang PvP
    if (activeDuel) { try { await equipBestWeapon(); } catch(_) {} }
  } catch(e) {
    logW('[Clutch] Lỗi: ' + e.message);
  } finally {
    _waterClutchActive = false;
    _clutchFallStartY  = null;
    _clutchGroundY     = null;
  }
}

// ── PvP HELPER: NÉM ENDER PEARL ───────────────────────────────────
// Nem pearl để gap-close tới địch (hoặc thoát)
async function throwEnderPearl(targetPos) {
  if (!bot || !mcData) return false;
  const pearlInfo = mcData.itemsByName['ender_pearl'];
  if (!pearlInfo) return false;
  const pearl = bot.inventory.findInventoryItem(pearlInfo.id, null, false);
  if (!pearl) return false;
  try {
    await bot.equip(pearl, 'hand');
    await bot.lookAt(targetPos.offset(0, 2.5, 0), true); // aim cao hơn đầu địch để pearl bay tới đúng
    bot.activateItem();
    await new Promise(r => setTimeout(r, 200));
    bot.deactivateItem();
    logS('[PvP] 🟢 Ném Ender Pearl!');
    return true;
  } catch(e) { return false; }
}

// ── MUTEX: chống 2 combo chạy cùng lúc ───────────────────────────
let isDoingSpecialCombo = false;

// ── PvP HELPER: ELYTRA + MACE — BAY THẲNG VÀO ĐỊCH BẰNG PHÁO HOA ─
// Mặc elytra → nhảy mở glide → dùng pháo hoa lao thẳng về phía địch
// Khi sắp tới nơi (~3m) → tháo elytra mặc giáp ngực → đánh mace ngay
async function elytraMaceDive(targetEntity) {
  if (!bot || !mcData || isDoingSpecialCombo) return false;

  const elytra   = bot.inventory.items().find(i => i.name === 'elytra');
  const mace     = bot.inventory.items().find(i => i.name === 'mace');
  // Cần ít nhất 1 pháo hoa để boost
  const fireworkInfo = mcData.itemsByName['firework_rocket'];
  const firework = fireworkInfo
    ? bot.inventory.findInventoryItem(fireworkInfo.id, null, false)
    : null;
  if (!elytra || !mace || !firework) return false;

  isDoingSpecialCombo = true;
  const tName = targetEntity.username || '';
  logS('[PvP] 🦅 ELYTRA MACE — lao thẳng vào địch bằng pháo hoa!');

  const cleanup = async () => {
    try {
      bot.setControlState('forward', false);
      bot.setControlState('jump',    false);
      bot.setControlState('sprint',  false);
      bot.deactivateItem();
    } catch(_) {}
    await equipBestArmor();       // tháo elytra → mặc giáp tốt nhất vào ngực
    await equipCombatLoadout();   // kiếm tay chính + khiên tay phụ
    isDoingSpecialCombo = false;
  };

  try {
    // ── Bước 1: Mặc elytra vào ngực, cầm mace sẵn ─────────────────
    await bot.equip(elytra, 'torso');
    await new Promise(r => setTimeout(r, 120));

    // ── Bước 2: Nhảy lên khỏi mặt đất ─────────────────────────────
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 130));
    bot.setControlState('jump', false);
    await new Promise(r => setTimeout(r, 120)); // đợi rời mặt đất

    // ── Bước 3: Double-tap space để mở elytra glide ────────────────
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 80));
    bot.setControlState('jump', false);
    await new Promise(r => setTimeout(r, 80));

    // ── Bước 4: Aim THẲNG về phía địch (hướng ngang + chút lên) ───
    let freshT = bot.players[tName]?.entity || targetEntity;
    const aimTarget = freshT.position.offset(0, 1.4, 0); // aim ngực địch
    await bot.lookAt(aimTarget, true);

    // ── Bước 5: Dùng pháo hoa để boost lao thẳng vào địch ──────────
    const fw2 = fireworkInfo
      ? bot.inventory.findInventoryItem(fireworkInfo.id, null, false)
      : null;
    if (fw2) {
      await bot.equip(fw2, 'hand');
      bot.activateItem();
      await new Promise(r => setTimeout(r, 100));
      bot.deactivateItem();
    }

    // ── Bước 6: Trong khi bay — cập nhật aim liên tục ──────────────
    // Khi còn ~3m → tháo elytra mặc giáp + đánh mace
    const flyStart = Date.now();
    let switchedArmor = false;

    while (Date.now() - flyStart < 5000) {
      const cur = bot.entity.position;
      freshT = bot.players[tName]?.entity || targetEntity;
      const d = cur.distanceTo(freshT.position.offset(0, 1, 0));

      // Cập nhật aim → luôn chỉ thẳng vào địch
      try { await bot.lookAt(freshT.position.offset(0, 1.4, 0), true); } catch(_){}

      // Khi cách ~4m: tháo elytra → mặc giáp ngực để giữ giáp sau cú đánh
      if (!switchedArmor && d < 4.5) {
        switchedArmor = true;
        // Tìm giáp ngực tốt nhất trong túi (không phải elytra)
        const CHEST_PRI = ['netherite_chestplate','diamond_chestplate','iron_chestplate',
                           'chainmail_chestplate','golden_chestplate','leather_chestplate'];
        const bestChest = CHEST_PRI.map(n => bot.inventory.items().find(i => i.name === n))
                                   .find(Boolean);
        if (bestChest) {
          try { await bot.equip(bestChest, 'torso'); } catch(_){}
        }
        await bot.equip(mace, 'hand');
      }

      // Khi sát địch (~2.5m): đánh ngay
      if (d < 2.8) break;

      // Chạm đất mà chưa đến: break để tránh loop vô hạn
      if (bot.entity.onGround && d > 5) break;

      await new Promise(r => setTimeout(r, 40));
    }

    // ── Bước 7: Đánh mace — momentum từ bay cho thêm sát thương ───
    await bot.equip(mace, 'hand');
    freshT = bot.players[tName]?.entity || targetEntity;
    if (freshT) {
      try {
        await bot.attack(freshT);
        logS('[PvP] 💥 MACE HIT! Cú đánh có momentum từ pháo hoa!');
      } catch(_) {}
    }

    await new Promise(r => setTimeout(r, 300));
    await cleanup();
    return true;
  } catch(e) {
    logW('[PvP] Elytra+Mace lỗi: ' + e.message);
    await cleanup();
    return false;
  }
}

// ── PvP HELPER: GIÁO (TRIDENT) + PHÁO HOA — GAP CLOSE + NÉM ────────
// Dùng elytra + pháo hoa để lao nhanh về phía địch → ném giáo cực chính xác
// Aim bù vận tốc địch + gravity giáo + lead time
async function tridentFireworkCombo(targetEntity) {
  if (!bot || !mcData || isDoingSpecialCombo) return false;

  const tridentInfo  = mcData.itemsByName['trident'];
  const fireworkInfo = mcData.itemsByName['firework_rocket'];
  const elytra = bot.inventory.items().find(i => i.name === 'elytra');
  if (!tridentInfo || !fireworkInfo || !elytra) return false;

  const trident  = bot.inventory.findInventoryItem(tridentInfo.id, null, false);
  const firework = bot.inventory.findInventoryItem(fireworkInfo.id, null, false);
  if (!trident || !firework) return false;

  isDoingSpecialCombo = true;
  const tName = targetEntity.username || '';
  const tPos  = targetEntity.position;
  const myPos = bot.entity.position;
  const dist  = myPos.distanceTo(tPos);

  logS(`[PvP] 🚀 TRIDENT + FIREWORK combo! Khoảng cách ${Math.round(dist)}m`);

  const cleanupT = async () => {
    try {
      bot.setControlState('jump',   false);
      bot.setControlState('sprint', false);
      bot.deactivateItem();
    } catch(_) {}
    await equipBestArmor();
    await equipCombatLoadout();
    isDoingSpecialCombo = false;
  };

  try {
    // 1. Mặc elytra
    await bot.equip(elytra, 'torso');
    await new Promise(r => setTimeout(r, 150));

    // 2. Nhảy lên rồi double-jump để mở elytra glide
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 120));
    bot.setControlState('jump', false);
    await new Promise(r => setTimeout(r, 160));
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 80));
    bot.setControlState('jump', false);
    await new Promise(r => setTimeout(r, 80));

    // 3. Aim về phía địch (tính dẫn trước — lead)
    let freshT0 = bot.players[tName]?.entity || targetEntity;
    const vel0 = freshT0.velocity || new Vec3(0, 0, 0);
    const ft0  = dist / 7; // elytra+firework speed ~7 m/s
    const lead0 = freshT0.position.offset(vel0.x * ft0, vel0.y * ft0 * 0.3 + 1.0, vel0.z * ft0);
    await bot.lookAt(lead0, true);

    // 4. Boost bằng pháo hoa (elytra boost)
    const fw2 = bot.inventory.findInventoryItem(fireworkInfo.id, null, false);
    if (fw2) {
      await bot.equip(fw2, 'hand');
      bot.activateItem();
      await new Promise(r => setTimeout(r, 120));
      bot.deactivateItem();
    }

    // 5. Trong khi bay → cầm giáo sẵn + liên tục cập nhật aim
    await bot.equip(trident, 'hand');

    const flyStart = Date.now();
    let lastLook = 0;
    while (Date.now() - flyStart < 5000) {
      const cur  = bot.entity.position;
      const freshT = bot.players[targetEntity.username || '']?.entity || targetEntity;
      const d = cur.distanceTo(freshT.position);

      // Cập nhật aim mỗi 60ms với dự đoán hướng di chuyển
      const nowL = Date.now();
      if (nowL - lastLook > 60) {
        lastLook = nowL;
        const fv  = freshT.velocity || new Vec3(0, 0, 0);
        const ft2 = d / 25; // tốc độ giáo ~25 m/s
        const grav2 = 0.025 * ft2 * ft2;
        const lead2 = freshT.position.offset(
          fv.x * ft2,
          fv.y * ft2 * 0.4 + grav2 + 1.6, // bù gravity + aim đầu địch
          fv.z * ft2
        );
        try { await bot.lookAt(lead2, true); } catch(_){}
      }

      if (d < 7) break; // đã đủ gần → ném
      await new Promise(r => setTimeout(r, 40));
    }

    // 6. Tính aim cuối cùng rất chính xác trước khi ném
    const freshT2 = bot.players[targetEntity.username || '']?.entity || targetEntity;
    const fv2     = freshT2.velocity || new Vec3(0, 0, 0);
    const fd      = bot.entity.position.distanceTo(freshT2.position);
    const ft3     = fd / 25;
    const grav3   = 0.025 * ft3 * ft3;
    const finalLead = freshT2.position.offset(
      fv2.x * ft3,
      fv2.y * ft3 * 0.4 + grav3 + 1.6,
      fv2.z * ft3
    );
    await bot.lookAt(finalLead, true);

    // 7. Charge giáo 500ms rồi ném (charge tối đa ~1000ms nhưng 600ms đủ lực)
    bot.activateItem(); // bắt đầu charge giáo
    await new Promise(r => setTimeout(r, 700));
    bot.deactivateItem(); // ném!

    logS('[PvP] 🔱 GIÁO ĐÃ PHÓNG! Aim chính xác cực dính!');
    await new Promise(r => setTimeout(r, 900));
    await cleanupT();
    return true;
  } catch(e) {
    logW('[PvP] Trident combo lỗi: ' + e.message);
    await cleanupT();
    return false;
  }
}

// ── PvP HELPER: BẮN CUNG VỚI DỰ ĐOÁN HƯỚNG DI CHUYỂN ────────────
// Tính điểm đặt mũi tên trước (lead) dựa theo vận tốc địch
async function shootBowWithLead(targetEntity, rangedItem) {
  if (!bot) return;
  try {
    const tPos = targetEntity.position.offset(0, targetEntity.height * 0.5, 0);
    const vel  = targetEntity.velocity || new Vec3(0, 0, 0);
    const myPos = bot.entity.position;
    const dist  = myPos.distanceTo(tPos);

    // Arrow speed ~3 blocks/tick → flight time (ticks) ≈ dist / 2.5 (conservative)
    const flightTicks = dist / 2.5;
    // Bù gravity: mũi tên rơi ~0.025 blocks/tick² → aim cao hơn để compensate
    const gravityDrop = 0.025 * flightTicks * flightTicks;
    // Vận tốc entity là blocks/tick — lead = vel * flightTicks
    const leadPos = tPos.offset(vel.x * flightTicks, vel.y * flightTicks * 0.4 + gravityDrop, vel.z * flightTicks);

    await bot.equip(rangedItem, 'hand');
    await bot.lookAt(leadPos, true);

    if (rangedItem.name === 'crossbow') {
      bot.activateItem();
      await new Promise(r => setTimeout(r, 1300));
      bot.deactivateItem();
    } else {
      // Bow: giữ 950ms (đủ charge ~100%)
      bot.activateItem();
      await new Promise(r => setTimeout(r, 950));
      bot.deactivateItem();
    }
    logS(`[PvP] 🏹 Bắn ${rangedItem.name} dẫn trước ${Math.round(dist)}m (lead ~${flightTicks.toFixed(1)} tick)`);
  } catch(e) {}
}

// Cooldown tracking: sword=600ms, axe=900ms (MC 1.9+ attack meter)
  let _lastAttackTime = 0;
  function _getAttackCooldown() {
    const w = bot?.heldItem?.name || '';
    if (w.endsWith('_axe')) return 900;
    if (w.endsWith('_sword')) return 600;
    return 600; // default
  }

  function startAutoAttack() {
    if (autoAttackInterval) return;
    autoAttackInterval = setInterval(async () => {
      if (!bot || !autoAttackEnabled || !bot.entity?.position || activeDuel) return;
      try {
        if (bot.pvp.target) return;
        const now = Date.now();
        // Bỏ qua nếu còn trong cooldown vũ khí (tránh zero-damage hit)
        if (now - _lastAttackTime < _getAttackCooldown()) return;

        // Ưu tiên: mob đang tấn công bot trước, rồi mới chọn gần nhất
        let nearest = null, minD = Infinity;
        let attacker = null, minAttackD = Infinity;
        for (const e of Object.values(bot.entities)) {
          if (!e || e===bot.entity || !e.position) continue;
          if (e.type!=='mob' && e.type!=='hostile') continue;
          if (!HOSTILE_MOBS.has(e.name||e.mobType||'')) continue;
          const d = bot.entity.position.distanceTo(e.position);
          if (d < minD) { minD = d; nearest = e; }
          // Mob đang nhắm vào bot (target của mob là bot entity)
          if (e.metadata && d < minAttackD) { minAttackD = d; attacker = e; }
        }
        const target = (attacker && minAttackD <= 8) ? attacker : nearest;
        if (target && minD <= 8) {
          // Không đổi vũ khí khi đang bận task khác (tránh làm hỏng công cụ đang dùng)
          if (!isBusy && !isFollowing) await equipBestWeapon();
          bot.pvp.attack(target);
          _lastAttackTime = now;
          logS(`⚔ ${target.name||target.mobType} (${Math.round(minD)}m)`);
          setTimeout(() => { if (!isBusy && !_cmdPending && _autoLootNearbyFn) { _autoLootNearbyFn(6); } }, 2500);
        }
      } catch(e){}
    }, 500);
  }
function stopAutoAttack() { if (autoAttackInterval) { clearInterval(autoAttackInterval); autoAttackInterval = null; } try { if (bot?.pvp) bot.pvp.stop(); } catch(e){} }

// ── JUMP ASSIST (proactive 1-block obstacle hopping) ──────────────
// Chạy mỗi 120ms khi follow — phát hiện block 1 tầng phía trước và nhảy
// ngay lập tức thay vì đợi stuck detection (6-10s) mới xử lý.
function startJumpAssist() {
  stopJumpAssist();
  _jumpAssistTimer = setInterval(() => {
    if (!bot?.entity) return;
    if (_jumpCooldown) return;
    // Chạy khi pathfinder đang di chuyển (bất kể follow hay task gì)
    if (!bot.pathfinder?.isMoving()) return;
    // Không nhảy khi đang PvP tích cực (tránh làm lộn strafe)
    if (activeDuel) return;
    // Chỉ nhảy khi đang trên mặt đất
    if (!bot.entity.onGround) return;

    const pos = bot.entity.position;
    const yaw = bot.entity.yaw;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);

    // ── Phát hiện slab / địa hình dốc: Y có phần thập phân ─────────
    // Nếu bot đang ở trên slab (Y = n.5) hoặc địa hình cao dần (Y = n.1~0.9)
    // và đang di chuyển → nhảy để leo lên tiếp
    const fracY = pos.y - Math.floor(pos.y);
    if (fracY > 0.1 && fracY < 0.9) {
      // Bot đang trên slab / địa hình nghiêng — nhảy để leo tiếp
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      _jumpCooldown = true;
      setTimeout(() => {
        if (bot) bot.setControlState('jump', false);
        setTimeout(() => { _jumpCooldown = false; }, 400);
      }, 150);
      return;
    }

    // ── Phát hiện block cứng phía trước tầm chân ────────────────────
    // Kiểm tra ở 3 khoảng cách phía trước (0.3, 0.5, 0.7 blocks)
    for (const dist of [0.3, 0.5, 0.7]) {
      const bFoot = bot.blockAt(pos.offset(dx * dist, 0.1, dz * dist));
      if (!bFoot || bFoot.boundingBox !== 'block') continue;

      // Có block cứng tầm chân → kiểm tra có đủ không gian phía trên không
      const bHead  = bot.blockAt(pos.offset(dx * dist, 1.1, dz * dist)); // tầm đầu phía trước
      const bAbove = bot.blockAt(pos.offset(0,          1.1,         0)); // trên đầu bot
      if ((!bHead  || bHead.boundingBox  !== 'block') &&
          (!bAbove || bAbove.boundingBox !== 'block')) {
        // An toàn để nhảy qua block 1 tầng
        bot.setControlState('sprint', true);
        bot.setControlState('jump',   true);
        _jumpCooldown = true;
        setTimeout(() => {
          if (bot) { bot.setControlState('jump', false); }
          setTimeout(() => { _jumpCooldown = false; }, 450);
        }, 200);
        break;
      }
    }
  }, 120);
}

function stopJumpAssist() {
  if (_jumpAssistTimer) { clearInterval(_jumpAssistTimer); _jumpAssistTimer = null; }
  _jumpCooldown = false;
}

// ── FOLLOW ────────────────────────────────────────────────────────
async function tryUnstuck(targetEntity) {
  if (!bot?.entity || bot._task === 'idle') return;
  try {
    const posAtStart = bot.entity.position.clone();

    // Bật canDig để pathfinder có thể đào block cản đường
    refreshMovements('follow');

    // Nhìn về phía người chơi trước
    if (targetEntity?.position) {
      try { await bot.lookAt(targetEntity.position.offset(0, 1.6, 0), true); } catch(e){}
    }

    // ── Bước 1: Thử pathfind đến vị trí gần target (timeout 3.5s) ──────
    if (targetEntity?.position) {
      const { x: tx, y: ty, z: tz } = targetEntity.position;
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(tx, ty, tz, 3)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('unstuck nav timeout')), 3500)),
        ]);
        try { bot.pathfinder.setGoal(null); } catch(_) {}
        return;
      } catch(_) {
        try { bot.pathfinder.setGoal(null); } catch(_) {}
      }
    }

    // ── Bước 2: Lùi lại trước để thoát kẹp, rồi thử lại ───────────────
    try {
      const backYaw = bot.entity.yaw + Math.PI;
      await bot.look(backYaw, 0, true);
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await new Promise(r => setTimeout(r, 400));
      bot.setControlState('jump', false);
      await new Promise(r => setTimeout(r, 300));
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
    } catch(_){}

    // ── Bước 3: Fallback — Sprint + nhảy 5 hướng ───────────────────────
    const targetYaw = targetEntity?.position
      ? Math.atan2(
          -(targetEntity.position.x - bot.entity.position.x),
          -(targetEntity.position.z - bot.entity.position.z)
        )
      : bot.entity.yaw;

    // Thử nhiều hướng: target, trái, phải, lùi, chéo trái, chéo phải
    const tryYaws = [
      targetYaw,
      targetYaw + Math.PI / 2,
      targetYaw - Math.PI / 2,
      targetYaw + Math.PI / 4,
      targetYaw - Math.PI / 4,
      targetYaw + Math.PI,
    ];
    for (const yaw of tryYaws) {
      if (stopTask) break;
      try { await bot.look(yaw, -0.3, true); } catch(_){}
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
      // Nhảy 3 lần liên tiếp để leo qua block cao 1 và 1.5
      for (let i = 0; i < 3; i++) {
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 300));
        bot.setControlState('jump', false);
        await new Promise(r => setTimeout(r, 120));
      }
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      await new Promise(r => setTimeout(r, 250));

      // Nếu đã di chuyển được đáng kể → dừng
      if (bot.entity.position.distanceTo(posAtStart) > 1.0) break;
    }

    // ── Bước 4: Nếu vẫn kẹt → thử nhảy lên (pillar) nếu có solid block dưới ─
    if (bot.entity.position.distanceTo(posAtStart) < 0.5) {
      try {
        const blockUnder = bot.blockAt(bot.entity.position.offset(0, -0.1, 0));
        if (blockUnder && blockUnder.boundingBox === 'block') {
          // Nhảy nhanh liên tiếp để thoát kẹt dốc
          for (let i = 0; i < 5; i++) {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 200));
            bot.setControlState('jump', false);
            await new Promise(r => setTimeout(r, 100));
          }
        }
      } catch(_){}
    }

    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
    await new Promise(r => setTimeout(r, 350));

  } catch(e) {
    try { bot.setControlState('forward', false); bot.setControlState('sprint', false); bot.setControlState('jump', false); } catch(_){}
  }
}

async function startFollow(user) {
  isFollowing = true; isBusy = true; bot._task = `theo ${user}`;
  refreshMovements(false); // canDig=false: không phá block khi đi theo
  let stuckTimer = null;
  try {
    const player = bot.players[user];
    if (!player?.entity) {
      await botSay('Không tìm thấy người để theo');
      isFollowing = false; isBusy = false; startWander(); return;
    }
    await botSay('Đang theo bạn');
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);

    // ── Jump assist — nhảy proactive qua block 1 tầng ────────────
    startJumpAssist();

    // ── Stuck detection ──────────────────────────────────────────
    let lastPos = bot.entity?.position?.clone?.() || null;
    let stuckTicks = 0;
    const STUCK_THRESHOLD = 3;  // × 2s = 6s không di chuyển → unstuck (phát hiện nhanh hơn)
    const STUCK_MIN_DIST = 0.5;
    const FOLLOW_DIST = 2;

    stuckTimer = setInterval(async () => {
      if (!isFollowing || stopTask || !bot?.entity) return;
      const curPos = bot.entity.position;

      // Không tính stuck nếu đã đứng gần người chơi rồi
      if (player.entity) {
        const distToPlayer = curPos.distanceTo(player.entity.position);
        if (distToPlayer <= FOLLOW_DIST + 1) { stuckTicks = 0; lastPos = curPos.clone(); return; }
      }

      if (lastPos) {
        const moved = curPos.distanceTo(lastPos);
        if (moved < STUCK_MIN_DIST) {
          stuckTicks++;
          if (stuckTicks >= STUCK_THRESHOLD) {
            stuckTicks = 0;
            logW(`[Follow] Bị kẹt! Thử thoát...`);
            try { bot.pathfinder.setGoal(null); } catch(e){}
            await tryUnstuck(player.entity);
            if (isFollowing && !stopTask && player.entity) {
              // Giữ follow mode (canDig=true) sau unstuck để pathfinder tìm đường vòng
              // Chỉ tắt canDig sau khi bot đã di chuyển được hoặc 5s sau
              refreshMovements('follow');
              try { bot.pathfinder.setGoal(new GoalFollow(player.entity, FOLLOW_DIST), true); } catch(e){}
              // Reset về default sau 5s nếu vẫn đang theo
              setTimeout(() => {
                if (isFollowing && !stopTask) refreshMovements(false);
              }, 5000);
            }
          }
        } else {
          stuckTicks = 0;
        }
      }
      lastPos = curPos.clone();
    }, 2000);

    // ── Main follow loop ─────────────────────────────────────────
    while (isFollowing && !stopTask) {
      await new Promise(r => setTimeout(r, 400));

      // Nếu player thoát khỏi tầm nhìn/respawn: chờ và re-path
      if (!player.entity) {
        try { bot.pathfinder.setGoal(null); } catch(e){}
        while (!player.entity && isFollowing && !stopTask) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (isFollowing && !stopTask && player.entity) {
          refreshMovements();
          try { bot.pathfinder.setGoal(new GoalFollow(player.entity, FOLLOW_DIST), true); } catch(e){}
        }
      }
    }

    clearInterval(stuckTimer);
  } catch(e) {}
  finally {
    if (stuckTimer) clearInterval(stuckTimer);
    stopJumpAssist();
    try { bot.pathfinder.setGoal(null); } catch(e){}
    isFollowing = false; isBusy = false;
    startWander();
  }
}

// ── TASK ──────────────────────────────────────────────────────────
// Block tự nhiên / cobblestone LUÔN được bảo vệ, không bao giờ phá
const PROTECTED_BLOCKS = new Set([
  'stone','cobblestone','mossy_cobblestone',
  'cobblestone_slab','cobblestone_stairs','cobblestone_wall',
  'mossy_cobblestone_slab','mossy_cobblestone_stairs','mossy_cobblestone_wall',
  'stone_slab','stone_stairs','stone_wall',
  'granite','diorite','andesite',
  'granite_slab','granite_stairs','granite_wall',
  'diorite_slab','diorite_stairs','diorite_wall',
  'andesite_slab','andesite_stairs','andesite_wall',
  'cobbled_deepslate','cobbled_deepslate_slab','cobbled_deepslate_stairs','cobbled_deepslate_wall',
  'dirt','grass_block','gravel','sand','sandstone','netherrack','bedrock',
  'farmland','soul_sand','soul_soil',
]);

// Danh sách block vật liệu nhà (đã gia công)
function getHouseBlockFilter() {
  return Object.values(mcData.blocksByName).filter(b => {
    const n = b.name || '';
    // Bảo vệ tuyệt đối: đá thô + cobblestone và mọi biến thể
    if (PROTECTED_BLOCKS.has(n)) return false;
    // Gỗ xây dựng
    if (n.endsWith('_planks')) return true;
    if (n.endsWith('_log') || n.endsWith('_wood')) return true;
    // Slab/Stairs chỉ lấy loại GỖ hoặc đã gia công (tránh cobblestone/stone slab)
    if ((n.endsWith('_slab') || n.endsWith('_stairs')) &&
        (n.includes('plank')||n.includes('wood')||n.includes('brick')||n.includes('nether')||
         n.includes('prismarine')||n.includes('purpur')||n.includes('quartz')||n.includes('smooth')||
         n.includes('concrete')||n.includes('terracotta')||n.includes('glass')||n.includes('end_stone')||
         n.includes('bamboo')||n.includes('copper')||n.includes('tuff')||n.includes('mud')||
         ['oak','spruce','birch','jungle','acacia','dark_oak','mangrove','cherry','crimson','warped'].some(w=>n.startsWith(w)))) return true;
    if (n.endsWith('_fence') || n.endsWith('_fence_gate')) return true;
    if (n.endsWith('_door') || n.endsWith('_trapdoor')) return true;
    if (['bookshelf','crafting_table','note_block','jukebox','barrel','chest','trapped_chest'].includes(n)) return true;
    // Đá xây dựng đã gia công
    if (['bricks','stone_bricks','mossy_stone_bricks','cracked_stone_bricks','chiseled_stone_bricks',
         'smooth_stone','smooth_stone_slab','polished_granite','polished_diorite','polished_andesite'].includes(n)) return true;
    if (n.includes('stone_brick')) return true;
    if (n.includes('deepslate_brick')||n.includes('deepslate_tile')||n.includes('polished_deepslate')) return true;
    // Kính
    if (n==='glass'||n==='glass_pane') return true;
    if (n.endsWith('_glass')||n.endsWith('_glass_pane')||n.endsWith('_stained_glass')||n.endsWith('_stained_glass_pane')) return true;
    // Gạch đất nung
    if (n==='terracotta'||n.endsWith('_terracotta')||n.includes('glazed_terracotta')) return true;
    // Bê tông
    if (n.endsWith('_concrete')||n.endsWith('_concrete_powder')) return true;
    // Len / Wool
    if (n==='white_wool'||n.endsWith('_wool')) return true;
    // Gạch nether
    if (n.includes('nether_brick')) return true;
    return false;
  }).map(b => b.id);
}

async function doTask(type, who) {
  if (isBusy) { bot.chat('Bot đang bận! Gõ "dừng" trước.'); return; }
  isBusy = true; stopTask = false;
  bot._task = type==='chop' ? 'chặt gỗ' : type==='demolish' ? 'đào nhà' : 'đào đá';
  let blockFilter;
  if (type==='chop') {
    refreshMovements('follow'); // canDig=true: leo qua cây cản
    blockFilter = Object.values(mcData.blocksByName).filter(b=>b.name?.endsWith('_log')).map(b=>b.id);
    await botSay('Bắt đầu chặt gỗ');
  } else if (type==='demolish') {
    refreshMovements('follow');
    blockFilter = getHouseBlockFilter();
    await botSay('Bắt đầu phá nhà');
  } else {
    // 'mine': canDig=true để pathfinder đục qua đá dày đặc tìm tới block target
    refreshMovements('follow');
    // Danh sách đầy đủ đá + quặng (thu quặng luôn khi gặp, không bỏ qua)
    const MINE_NAMES = new Set([
      'stone','cobblestone','mossy_cobblestone','stone_bricks','mossy_stone_bricks','cracked_stone_bricks',
      'granite','polished_granite','diorite','polished_diorite','andesite','polished_andesite',
      'tuff','calcite','deepslate','cobbled_deepslate','polished_deepslate','deepslate_bricks',
      'deepslate_tiles','chiseled_deepslate','reinforced_deepslate',
      'blackstone','polished_blackstone','polished_blackstone_bricks','gilded_blackstone',
      'basalt','smooth_basalt','netherrack','end_stone','end_stone_bricks',
      // Ores — thu luôn khi gặp khi đang đào đá
      'coal_ore','deepslate_coal_ore','iron_ore','deepslate_iron_ore',
      'gold_ore','deepslate_gold_ore','copper_ore','deepslate_copper_ore',
      'lapis_ore','deepslate_lapis_ore','redstone_ore','deepslate_redstone_ore',
      'diamond_ore','deepslate_diamond_ore','emerald_ore','deepslate_emerald_ore',
      'nether_gold_ore','nether_quartz_ore','ancient_debris',
    ]);
    blockFilter = Object.values(mcData.blocksByName)
      .filter(b => MINE_NAMES.has(b.name || ''))
      .map(b => b.id);
    await botSay('Bắt đầu đào đá');
  }
  logS(`[${who}] ${bot._task}`);
  try {
    await digContinuous(blockFilter, bot._task, who);
  } finally {
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ── MINE ORES ─────────────────────────────────────────────────────
// Ưu tiên từ cao → thấp
const ORE_PRIORITY = [
  'ancient_debris',
  'diamond_ore','deepslate_diamond_ore',
  'emerald_ore','deepslate_emerald_ore',
  'gold_ore','deepslate_gold_ore','nether_gold_ore',
  'lapis_ore','deepslate_lapis_ore',
  'redstone_ore','deepslate_redstone_ore',
  'copper_ore','deepslate_copper_ore',
  'iron_ore','deepslate_iron_ore',
  'coal_ore','deepslate_coal_ore',
  'nether_quartz_ore',
];

// Tên hiển thị tiếng Việt
const ORE_NAMES = {
  ancient_debris:'Mảnh cổ',diamond_ore:'Kim cương',emerald_ore:'Ngọc lục bảo',
  gold_ore:'Vàng',lapis_ore:'Lapis',redstone_ore:'Đá đỏ',
  copper_ore:'Đồng',iron_ore:'Sắt',coal_ore:'Than',nether_quartz_ore:'Thạch anh',
  nether_gold_ore:'Vàng địa ngục',
};
function oreDisplayName(name) {
  const base = name.replace('deepslate_','');
  return ORE_NAMES[base] || ORE_NAMES[name] || name.replace(/_/g,' ');
}

async function mineOres(who, targetOre) {
  if (isBusy) { bot.chat('Bot đang bận! Gõ "dừng" trước.'); return; }
  isBusy = true; stopTask = false;
  bot._task = targetOre ? `đào ${oreDisplayName(targetOre)}` : 'đào quặng';
  // canDig=true: pathfinder có thể đào qua đá xung quanh để đến được ore
  refreshMovements(true);

  const oreList = targetOre
    ? ORE_PRIORITY.filter(o => o === targetOre || o === 'deepslate_'+targetOre || o.includes(targetOre.replace('_ore','')))
    : ORE_PRIORITY;

  const oreIds = [...new Set(oreList.map(n => mcData.blocksByName[n]?.id).filter(Boolean))];

  if (!oreIds.length) {
    bot.chat('Không tìm thấy loại quặng này trong dữ liệu!');
    isBusy = false; return;
  }

  const label = targetOre ? oreDisplayName(targetOre) : 'quặng';
  await botSay(`Bắt đầu đào ${label}!`);
  logS(`[${who}] Đào ${label} (${oreIds.length} loại block)`);

  try {
    await digContinuous(oreIds, `đào ${label}`, who);
  } finally {
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ── DIG CONTINUOUS ─────────────────────────────────────────────────
// Lõi đào liên tục: dùng pathfinder + bot.dig() trực tiếp (không qua collectBlock)
// Tự động khám phá khi hết block gần, chỉ dừng khi stopTask=true hoặc túi đầy
async function digContinuous(blockIds, label, who) {
  const skipped = new Set();
  let notFoundStreak = 0;

  while (!stopTask) {
    // Kiểm tra túi đầy — tự động cất đồ rồi tiếp tục đào
    if (isInventoryFull()) {
      logS(`[${label}] Túi đầy! Đang tự động cất đồ...`);
      bot.chat('Túi đầy! Đang cất đồ rồi tiếp tục đào...');
      const wasBusy = isBusy;
      isBusy = false;
      await depositToChest('[Auto]');
      isBusy = wasBusy;
      if (stopTask) break;
      // Nếu vẫn đầy (không có rương) → dừng để tránh vòng lặp
      if (isInventoryFull()) {
        bot.chat('Không cất được! Cần rương gần đây. Gõ "dừng" để thôi.');
        break;
      }
      continue;
    }

    // Tìm block gần nhất chưa bị bỏ qua
    // Bắt đầu ở 32m, chỉ mở rộng lên 64m khi không tìm thấy (giảm CPU trên server yếu)
    const searchDist = notFoundStreak >= 2 ? 64 : 32;
    const block = bot.findBlock({
      matching: b => b && b.position && blockIds.includes(b.type) && !skipped.has(b.position.toString()),
      maxDistance: searchDist,
    });

    if (!block) {
      notFoundStreak++;
      // Sau 2 lần không tìm thấy: xóa skipped để thử lại các block cũ
      if (notFoundStreak === 2) skipped.clear();
      // Sau 4 lần vẫn không có: di chuyển khám phá (X/Z + thử xuống sâu hơn cho quặng)
      if (notFoundStreak >= 4) {
        const pos = bot.entity.position;
        const angle = Math.random() * Math.PI * 2;
        const dist = 20 + Math.random() * 20;
        const tx = pos.x + Math.cos(angle) * dist;
        const tz = pos.z + Math.sin(angle) * dist;
        // Nếu đang ở trên mặt đất (Y > 0) và tìm quặng → thử đi xuống sâu hơn
        const targetY = pos.y > 20 ? Math.max(pos.y - 30, -64) : pos.y;
        logS(`[${label}] Không tìm thấy block, di chuyển khám phá (Y≈${Math.round(targetY)})...`);
        try {
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(tx, targetY, tz, 3)),
            new Promise(r => setTimeout(r, 6000)),
          ]);
        } catch(e) {}
        notFoundStreak = 0;
        continue;
      }
      await new Promise(r => setTimeout(r, 400));
      continue;
    }

    notFoundStreak = 0;
    await equipToolForBlock(block);

    try {
      const p = block.position;

      // GoalLookAtBlock đặt bot ở vị trí CÓ THỂ nhìn và đào block đó.
      // Nếu bot đã đứng đúng chỗ (kể cả ngay cạnh), goal thoả ngay, không di chuyển.
      // Dùng thay cho GoalNear để tránh lỗi "block ngay cạnh nhưng không đào được".
      await Promise.race([
        bot.pathfinder.goto(new GoalLookAtBlock(p, bot.world)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('nav timeout')), 8000)),
      ]);

      // Huỷ goal ngay sau khi di chuyển xong — pathfinder vẫn giữ goal active
      // và tiếp tục gọi bot.look() mỗi physics tick, làm đầu bot "giật" ra khỏi
      // block đang đào rồi quay lại (bug nhìn vào không khí giữa chừng).
      try { bot.pathfinder.setGoal(null); } catch(_) {}

      if (stopTask) break;

      // Lấy lại block (có thể đã bị phá bởi người khác trong lúc di chuyển)
      const fresh = bot.blockAt(p);
      if (!fresh || !blockIds.includes(fresh.type)) continue;

      // smartDig: chọn mặt tốt nhất → lookAt → đào (tool đã equip ở trên)
      await smartDig(fresh, false);
      // Ghi nhớ vị trí quặng để ưu tiên khu vực này lần sau
      if (mcData.blocks[fresh.type]?.name?.includes('ore')) recordOre(fresh);
      await new Promise(r => setTimeout(r, 100)); // 100ms buffer for server lag (Aternos)

    } catch(e) {
      skipped.add(block.position.toString());
      logW(`[${label}] Bỏ qua ${block.name} @ ${block.position} (${e.message})`);
    }
  }
}

// ── MINE ANY BLOCK TYPE ────────────────────────────────────────────
// Đào bất kỳ loại block nào theo tên (hỗ trợ tiếng Việt và MC name)
async function mineBlockType(blockName, who) {
  if (!bot || !mcData) return;

  const BLOCK_ALIAS = {
    'đá': ['stone','cobblestone','mossy_cobblestone'],
    'đất': ['dirt','grass_block','coarse_dirt','rooted_dirt'],
    'cát': ['sand','red_sand'],
    'sỏi': ['gravel'],
    'gỗ': ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'],
    'gỗ sồi': ['oak_log'], 'gỗ thông': ['spruce_log'], 'gỗ bạch dương': ['birch_log'],
    'gỗ rừng': ['jungle_log'], 'gỗ keo': ['acacia_log'], 'gỗ tối': ['dark_oak_log'],
    'cỏ': ['grass_block'], 'đất bùn': ['mud'], 'đất sét': ['clay'],
    'băng': ['ice','packed_ice','blue_ice'], 'tuyết': ['snow','snow_block'],
    'obsidian': ['obsidian'], 'đá granit': ['granite'], 'đá diorit': ['diorite'],
    'đá andesit': ['andesite'], 'đá vôi': ['calcite'], 'đá tuff': ['tuff'],
    'netherrack': ['netherrack'], 'soul sand': ['soul_sand'], 'basalt': ['basalt'],
    'gạch': ['bricks'], 'gỗ ván': ['oak_planks'],
    'than': ['coal_ore','deepslate_coal_ore'], 'sắt': ['iron_ore','deepslate_iron_ore'],
    'vàng': ['gold_ore','deepslate_gold_ore'], 'kim cương': ['diamond_ore','deepslate_diamond_ore'],
    'đồng': ['copper_ore','deepslate_copper_ore'], 'đá đỏ': ['redstone_ore','deepslate_redstone_ore'],
    'lapis': ['lapis_ore','deepslate_lapis_ore'], 'ngọc lục bảo': ['emerald_ore','deepslate_emerald_ore'],
  };

  let blockIds = [];
  const key = blockName.toLowerCase().trim();

  if (BLOCK_ALIAS[key]) {
    // Tìm theo alias tiếng Việt
    blockIds = BLOCK_ALIAS[key].map(n => mcData.blocksByName[n]?.id).filter(Boolean);
  } else {
    // Tìm theo Minecraft name (exact hoặc prefix match)
    const mcName = key.replace(/ /g, '_');
    if (mcData.blocksByName[mcName]) {
      blockIds = [mcData.blocksByName[mcName].id];
    } else {
      // Khớp một phần: ví dụ "log" → tìm tất cả block có "log" trong tên
      blockIds = Object.values(mcData.blocksByName)
        .filter(b => b.name.includes(mcName))
        .map(b => b.id);
    }
  }

  if (!blockIds.length) {
    bot.chat(`Không biết block "${blockName}" là gì! Dùng tên Minecraft (VD: stone, oak_log, dirt)`);
    return;
  }

  if (isBusy) { bot.chat('Bot đang bận! Gõ "dừng" trước.'); return; }
  isBusy = true; stopTask = false;
  const displayName = key.replace(/_/g, ' ');
  bot._task = `đào ${displayName}`;
  // Nếu đào quặng: canDig=true để pathfinder đục đá xung quanh tới ore
  // Dùng mcData.blocks[id] (O(1)) thay vì duyệt toàn bộ blocksByName (O(n²))
  const isOreMining = blockIds.some(id => {
    const b = mcData.blocks[id];
    return b && b.name.includes('ore');
  });
  refreshMovements(isOreMining);
  await botSay(`Bắt đầu đào ${displayName}!`);
  logS(`[${who}] Đào "${displayName}" (${blockIds.length} loại, liên tục đến khi dừng)`);

  try {
    await digContinuous(blockIds, displayName, who);
  } finally {
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ── FARMING ───────────────────────────────────────────────────────
const FARM_CROPS = [
  { name: 'wheat',       maxAge: 7, seed: 'wheat_seeds'    },
  { name: 'carrots',     maxAge: 7, seed: 'carrot'         },
  { name: 'potatoes',    maxAge: 7, seed: 'potato'         },
  { name: 'beetroots',   maxAge: 3, seed: 'beetroot_seeds' },
  { name: 'nether_wart', maxAge: 3, seed: 'nether_wart'    },
];
const FARM_FRUITS = ['melon','pumpkin','sugar_cane','bamboo'];


  // ── AUTO COMBINE TOOLS — gộp 2 đồ cùng loại không enchant ────────
  // Gộp 2 item cùng tên (không enchant) bằng crafting grid để cộng bền
  // Bỏ qua: elytra, netherite_*, trident, mace
  const COMBINE_EXCLUDE = new Set(['elytra','trident','mace']);
  const isCombineExcluded = n => COMBINE_EXCLUDE.has(n) || n.startsWith('netherite_');
  const hasEnchant = item => {
    try {
      const enc = item.nbt?.value?.Enchantments?.value?.value;
      const sto = item.nbt?.value?.StoredEnchantments?.value?.value;
      return (enc && enc.length > 0) || (sto && sto.length > 0);
    } catch(_) { return false; }
  };

  async function autoCombineTools(who) {
    if (!bot || !mcData) { bot?.chat('Không tìm thấy mcData!'); return; }
    isBusy = true; bot._task = 'gộp đồ';
    logS(`[${who}] Bắt đầu gộp đồ trùng...`);
    let combinedCount = 0;

    try {
      // Lấy tất cả item damageable, không enchant, không nằm trong exclusion
      const candidates = bot.inventory.items().filter(item => {
        if (isCombineExcluded(item.name)) return false;
        if (hasEnchant(item)) return false;
        return (item.maxDurability ?? 0) > 0; // chỉ đồ có durability
      });

      // Nhóm theo tên item
      const groups = {};
      for (const item of candidates) {
        if (!groups[item.name]) groups[item.name] = [];
        groups[item.name].push(item);
      }

      for (const [name, list] of Object.entries(groups)) {
        if (list.length < 2) continue;

        const itemId = list[0].type;
        // null = dùng ô 2×2 ở inventory (không cần crafting table)
        const recipes = bot.recipesFor(itemId, null, 1, null);
        // Tìm repair recipe: đúng 2 item cùng loại trong danh sách nguyên liệu
        const repairRecipe = recipes.find(r => {
          const flat = (r.inShape ? r.inShape.flat() : r.ingredients || []).filter(Boolean);
          return flat.filter(x => x && x.id === itemId).length >= 2;
        });

        if (!repairRecipe) {
          logW(`[Combine] Không tìm thấy repair recipe cho ${name}`);
          continue;
        }

        // Gộp từng cặp — bot.craft(recipe, 1, null) dùng ô 2×2 inventory
        while (list.length >= 2) {
          const [a, b] = list.splice(0, 2);
          const remA  = (a.maxDurability ?? 0) - (a.durabilityUsed ?? 0);
          const remB  = (b.maxDurability ?? 0) - (b.durabilityUsed ?? 0);
          const bonus = Math.floor((a.maxDurability ?? 0) * 0.05);
          const newDur = Math.min((a.maxDurability ?? 0), remA + remB + bonus);
          try {
            await bot.craft(repairRecipe, 1, null); // null = inventory 2×2
            combinedCount++;
            logS(`[Combine] Gộp 2x ${name} → 1x ${name} (bền ~${newDur}/${a.maxDurability})`);
            await new Promise(r => setTimeout(r, 300));
          } catch(e) {
            logW(`[Combine] Lỗi gộp ${name}: ${e.message}`);
            break;
          }
        }
      }

      if (combinedCount > 0) {
        await botSay(`Đã gộp ${combinedCount} cặp đồ, túi gọn hơn rồi!`);
      } else {
        bot.chat('Không tìm thấy cặp đồ nào có thể gộp (cần cùng loại, không enchant).');
      }
    } catch(e) {
      logW(`[Combine] Lỗi: ${e.message}`);
      bot.chat(`Gộp đồ lỗi: ${e.message}`);
    } finally {
      isBusy = false; bot._task = 'idle';
      if (!isFollowing) startWander();
    }
  }

  async function doFarm(who) {
  if (isBusy) { bot.chat('Bot đang bận, dùng "dừng" trước!'); return; }
  if (bot) bot._farmWaitCount = 0; // reset wait counter mỗi lần bắt đầu
  stopTask = false; // đảm bảo vòng lặp không thoát ngay do task trước
  isBusy = true; bot._task = 'làm nông'; refreshMovements();
  await botSay('Bắt đầu thu hoạch nông trại');
  logS(`[${who}] farming`);
  // Dùng vị trí farm đã đặt bằng "farm set"; nếu chưa đặt thì dùng vị trí hiện tại
  const farmOriginPos = _savedFarmOrigin || bot.entity?.position?.clone?.() || null;
  const FARM_RADIUS = 20;
  let harvested = 0, replanted = 0;
  try {
  while (!stopTask) {
    let target = null;

    // Tìm cây chín (chỉ trong phạm vi farm gốc)
    for (const crop of FARM_CROPS) {
      const def = mcData.blocksByName[crop.name];
      if (!def) continue;
      const found = bot.findBlock({
        matching: b => {
          try {
            if (!b) return false;
            // Chỉ lấy block trong bán kính farm gốc
            if (farmOriginPos && b.position.distanceTo(farmOriginPos) > FARM_RADIUS) return false;
            return b.type === def.id && (b.getProperties?.()?.age ?? 0) >= crop.maxAge;
          } catch(_) { return false; }
        },
        maxDistance: 48,
      });
      if (found) { target = { block: found, kind: 'crop', crop }; break; }
    }

    // Tìm dưa/bí/mía (chỉ trong phạm vi farm gốc)
    if (!target) {
      for (const fname of FARM_FRUITS) {
        const def = mcData.blocksByName[fname];
        if (!def) continue;
        let found;
        if (fname === 'sugar_cane' || fname === 'bamboo') {
          // Chỉ thu hoạch block KHÔNG phải gốc (block dưới nó cùng loại → an toàn đào)
          found = bot.findBlock({
            matching: b => {
              if (!b || b.type !== def.id) return false;
              if (farmOriginPos && b.position.distanceTo(farmOriginPos) > FARM_RADIUS) return false;
              const below = bot.blockAt(b.position.offset(0, -1, 0));
              return below && below.type === def.id;
            },
            maxDistance: 48,
          });
        } else {
          found = bot.findBlock({
            matching: b => {
              if (!b || b.type !== def.id) return false;
              if (farmOriginPos && b.position.distanceTo(farmOriginPos) > FARM_RADIUS) return false;
              return true;
            },
            maxDistance: 48,
          });
        }
        if (found) { target = { block: found, kind: 'fruit' }; break; }
      }
    }

    if (!target) {
      if (harvested === 0 && replanted === 0) {
        // Chưa thu hoạch gì cả: nông trại chưa chín hoặc không có
        if (!bot._farmWaitCount) bot._farmWaitCount = 0;
        bot._farmWaitCount++;
        if (bot._farmWaitCount > 3) { // chờ tối đa 3 × 30s = 90s
          bot._farmWaitCount = 0;
          bot.chat('Không tìm thấy cây chín nào trong nông trại!');
          break;
        }
        logS(`[Farm] Không có crop chín, chờ 30s (lần ${bot._farmWaitCount}/3)...`);
        bot.chat(`Chưa có gì chín, chờ thêm ${(4 - bot._farmWaitCount) * 30}s...`);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      bot._farmWaitCount = 0;
      await botSay(`Thu hoạch xong! +${harvested} lượt, trồng lại ${replanted}`);
      logS(`Farm xong: thu ${harvested}, trồng ${replanted}`);
      break;
    }

    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalLookAtBlock(target.block.position, bot.world)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('nav timeout')), 10000)),
      ]);

      // Kiểm tra lại block sau khi di chuyển (có thể ai đó đã thu hoạch trước)
      const freshFarmBlock = bot.blockAt(target.block.position);
      if (!freshFarmBlock || freshFarmBlock.name === 'air') continue;

      if (target.kind === 'crop') {
        const farmlandPos = target.block.position.offset(0, -1, 0);
        // Trang bị hoe để thu hoạch nhanh hơn (nếu có)
        if (mcData) {
          const hoeNames = ['netherite_hoe','diamond_hoe','iron_hoe','stone_hoe','wooden_hoe','golden_hoe'];
          const hoe = bot.inventory.items().find(i => hoeNames.includes(i.name));
          if (hoe) { try { await bot.equip(hoe, 'hand'); } catch(_){} }
        }
        await smartDig(target.block, false); harvested++; // false = không equip lại (hoe đã equip)
        await new Promise(r => setTimeout(r, 250));

        // Trồng lại nếu có hạt giống
        const seedName = target.crop.seed;
        const seedItem = bot.inventory.items().find(i => i.name === seedName);
        if (seedItem) {
          try {
            await bot.equip(seedItem, 'hand');
            const farmland = bot.blockAt(farmlandPos);
            if (farmland && farmland.name === 'farmland') {
              const seedPos = farmland.position.offset(0, 1, 0);
              const placed = await smartPlace(seedPos);
              if (!placed) await bot.placeBlock(farmland, new Vec3(0, 1, 0));
              replanted++;
            }
          } catch(e) { logW(`Không trồng lại được: ${e.message}`); }
        }
      } else {
        // Fruit (dưa/bí/mía/tre): trang bị đúng công cụ rồi dùng smartDig
        await equipToolForBlock(target.block);
        await smartDig(target.block, false); harvested++;
      }
    } catch(e) {
      logW(`Lỗi farm: ${e.message}`);
      await new Promise(r => setTimeout(r, 400));
    }

    await new Promise(r => setTimeout(r, 120));
  }
  } finally {
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ══════════════════════════════════════════════════════════════════
//  9 TÍNH NĂNG MỚI
// ══════════════════════════════════════════════════════════════════

// ── ORE MEMORY ────────────────────────────────────────────────────
// Lưu tọa độ quặng đào được → ưu tiên khu vực đó lần sau
const ORE_MEMORY_FILE = (() => { try { return require('path').resolve(process.cwd(), 'ore_locations.json'); } catch(_) { return 'ore_locations.json'; } })();
let oreMemory = {};
function loadOreMemory() {
  try {
    if (fs.existsSync(ORE_MEMORY_FILE)) {
      oreMemory = JSON.parse(fs.readFileSync(ORE_MEMORY_FILE, 'utf8'));
      logS(`[OreMemory] Đã tải ${Object.keys(oreMemory).length} vị trí quặng`);
    }
  } catch(_) { oreMemory = {}; }
}
function saveOreMemory() {
  try { fs.writeFileSync(ORE_MEMORY_FILE, JSON.stringify(oreMemory)); } catch(_) {}
}

// ── FARM ORIGIN FILE ──────────────────────────────────────────────
const FARM_ORIGIN_FILE = (() => { try { return require('path').resolve(process.cwd(), 'farm_origin.json'); } catch(_) { return 'farm_origin.json'; } })();
(function loadFarmOrigin() {
  try {
    if (fs.existsSync(FARM_ORIGIN_FILE)) {
      const d = JSON.parse(fs.readFileSync(FARM_ORIGIN_FILE, 'utf8'));
      _savedFarmOrigin = new Vec3(d.x, d.y, d.z);
      logS(`[Farm] Vị trí farm: (${d.x}, ${d.y}, ${d.z})`);
    }
  } catch(_) { _savedFarmOrigin = null; }
})();
function setFarmOrigin(who) {
  if (!bot || !bot.entity) return;
  const p = bot.entity.position;
  _savedFarmOrigin = p.clone();
  try { fs.writeFileSync(FARM_ORIGIN_FILE, JSON.stringify({x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z)})); } catch(_) {}
  logS(`[Farm] Đặt vị trí farm: (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`);
  if (bot) bot.chat(`Đã đặt vị trí farm tại (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`);
  logActivity(`Đặt vị trí farm tại (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`);
}
function recordOre(block) {
  const k = `${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)}`;
  oreMemory[k] = { name: block.name, at: Date.now() };
  saveOreMemory();
}
function getBestOreRegion() {
  const entries = Object.entries(oreMemory);
  if (!entries.length) return null;
  let sx = 0, sz = 0;
  for (const [k] of entries) { const [x,,z] = k.split(',').map(Number); sx += x; sz += z; }
  return { x: sx / entries.length, z: sz / entries.length, count: entries.length };
}
// Load ngay khi module khởi động
loadOreMemory();

// ── SMART PvP COMBO ────────────────────────────────────────────────
// HP địch < 6♥ → rush liên tục không strafe; trả về true khi đang rush
function applySmartCombat(targetEntity) {
  if (!bot || !targetEntity) return false;
  const hp = targetEntity.health ?? 20;
  if (hp < 6) {
    bot.setControlState('sprint', true);
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    try { if (!bot.pvp.target || bot.pvp.target.id !== targetEntity.id) bot.pvp.attack(targetEntity); } catch(_) {}
    return true; // đang rush, caller bỏ qua strafe bình thường
  }
  return false;
}

// ── STRIP MINING ──────────────────────────────────────────────────
// Cú pháp: strip mine [y] [chiều dài] [chiều dài nhánh]
// Ví dụ:   strip mine -58 80 16   →  y=-58, main=80, branch=16
// Mặc định: y=-58 (đỉnh kim cương 1.18+), main=64, branch=16

// Quặng quý cần alert khi gặp
const VALUABLE_ORES = new Set([
  'diamond_ore','deepslate_diamond_ore',
  'ancient_debris',
  'emerald_ore','deepslate_emerald_ore',
  'gold_ore','deepslate_gold_ore','nether_gold_ore',
  'iron_ore','deepslate_iron_ore',
  'redstone_ore','deepslate_redstone_ore',
  'lapis_ore','deepslate_lapis_ore',
  'copper_ore','deepslate_copper_ore',
  'coal_ore','deepslate_coal_ore',
]);
const HIGH_VALUE_ORES = new Set(['diamond_ore','deepslate_diamond_ore','ancient_debris','emerald_ore','deepslate_emerald_ore']);

// Helper: đào thẳng xuống đến targetY (đào từng block một)
async function digDownTo(targetY) {
  if (!bot || !mcData) return;
  // BUG FIX #1: dùng 'baritone' mode (canDig=true + allow1by1towers=true + maxDropDown=10)
  refreshMovements('baritone');

  const sp = bot.entity.position;
  const px = Math.round(sp.x), pz = Math.round(sp.z);
  const curYInit = Math.floor(sp.y);

  // Thử pathfinder trước nếu gần (≤15 block)
  if (curYInit <= targetY + 15) {
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(px, targetY, pz, 2)),
        new Promise((_,rej) => setTimeout(rej, 20000)),
      ]);
      if (Math.floor(bot.entity.position.y) <= targetY + 2) return;
    } catch(_) {}
  }
  logS('[digDownTo] Bot y=' + curYInit + ' → target y=' + targetY + ' (đào thủ công)');

  // Fallback: đào thủ công từng bước
  const MAX_STEPS = 500;
  let steps = 0;
  while (!stopTask && steps++ < MAX_STEPS) {
    const curPos = bot.entity.position;
    const curY   = Math.floor(curPos.y);
    if (curY <= targetY + 1) break;
    const bx = Math.round(curPos.x), bz = Math.round(curPos.z);

    // BUG FIX #5: kiểm tra lava trước khi đào
    for (const dy of [-1, -2, -3]) {
      const blkPos = new Vec3(bx, curY + dy, bz);
      try {
        const blk = bot.blockAt(blkPos);
        if (!blk || blk.name === 'air' || blk.name === 'bedrock' || !blk.diggable) continue;
        if (blk.name === 'lava') {
          // Đặt cobblestone/dirt chặn lava trước khi đào tiếp
          const plug = bot.inventory.items().find(i => ['cobblestone','dirt','gravel','sand','stone'].includes(i.name));
          if (plug) {
            try { await bot.equip(plug,'hand'); await bot.placeBlock(bot.blockAt(new Vec3(bx,curY+dy+1,bz)), new Vec3(0,0,0)); } catch(_) {}
          }
          logW('[digDownTo] ⚠️ Gặp lava tại y=' + (curY+dy) + ' — bỏ qua shaft này');
          return; // an toàn hơn là tiếp tục
        }
        if (blk.name === 'water') continue; // nước OK, bơi qua
        await equipToolForBlock(blk);
        await bot.dig(blk, true);
      } catch(_) {}
    }

    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(bx, curY - 2, bz, 1)),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    } catch(_) { await new Promise(r => setTimeout(r, 500)); }

    if (Math.floor(bot.entity.position.y) >= curY) {
      for (const [dx, dz2] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
        const blk = bot.blockAt(new Vec3(bx+dx, curY-1, bz+dz2));
        if (blk && blk.diggable && !['air','water','lava','bedrock'].includes(blk.name)) {
          try { await equipToolForBlock(blk); await bot.dig(blk, true); } catch(_) {}
        }
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

// Helper: đào 2-block-tall tunnel tại (x, y, z)
// BUG FIX #5: kiểm tra lava + BUG FIX #10: alert quặng quý
async function digTunnelStep(x, y, z, oreFoundRef) {
  if (!bot || stopTask) return;
  for (const dy of [0, 1]) {
    try {
      const blk = bot.blockAt(new Vec3(x, y + dy, z));
      if (!blk || blk.name === 'air' || !blk.diggable) continue;
      if (blk.name === 'bedrock') continue;

      // BUG FIX #5: chặn nếu phát hiện lava kề
      if (blk.name === 'lava') {
        logW(`[StripMine] ⚠️ Lava tại ${x},${y+dy},${z} — bỏ qua block này`);
        if (bot) bot.chat(`⚠️ Phát hiện lava! (${x},${y+dy},${z}) — tránh đào vào đó.`);
        continue;
      }
      // Kiểm tra block kề 6 mặt có phải lava không
      const lavaAdjacent = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([dx,ddy,dz2]) => {
        const nb = bot.blockAt(new Vec3(x+dx, y+dy+ddy, z+dz2));
        return nb && nb.name === 'lava';
      });
      if (lavaAdjacent) {
        logW(`[StripMine] ⚠️ Block ${x},${y+dy},${z} tiếp giáp lava — bỏ qua`);
        continue;
      }

      // BUG FIX #10: log quặng quý
      if (VALUABLE_ORES.has(blk.name)) {
        const isHigh = HIGH_VALUE_ORES.has(blk.name);
        logS(`[StripMine] 💎 Gặp ${blk.name} tại ${x},${y+dy},${z}!`);
        if (isHigh && bot) bot.chat(`💎 Tìm thấy ${blk.name.replace(/_/g,' ')} tại ${x},${y+dy},${z}!`);
        if (oreFoundRef) oreFoundRef.count++;
        activityStats.blocksMinedTotal++;
      }

      await smartDig(blk); // equip tool + chọn mặt tốt nhất + đào
    } catch(e) { logW(`[TunnelStep] ${blk.name}@${x},${y+dy},${z}: ${e.message}`); }
  }
}

// Helper: đặt đuốc tại vị trí hiện tại nếu đủ tối
async function placeTorchIfNeeded(x, y, z) {
  if (!bot) return;
  const torch = bot.inventory.items().find(i => i.name === 'torch' || i.name === 'soul_torch');
  if (!torch) return;
  // Chỉ đặt nếu sáng < 8 (block phía dưới là solid)
  const floor = bot.blockAt(new Vec3(x, y - 1, z));
  const here  = bot.blockAt(new Vec3(x, y, z));
  if (!floor || floor.name === 'air') return;
  if (here && here.name !== 'air') return;
  try {
    await bot.equip(torch, 'hand');
    await bot.placeBlock(floor, new Vec3(0, 1, 0));
  } catch(_) {}
}

async function stripMine(who, opts = {}) {
  if (isBusy) return;
  isBusy = true; stopTask = false; bot._task = 'strip mine';

  // BUG FIX #8: tham số có thể truyền từ command hoặc dùng default tốt hơn
  const ty     = opts.y    ?? -58;   // 1.18+ diamond peak
  const MAIN   = opts.len  ?? 64;    // chiều dài tunnel chính
  const BRANCH_INT = 3;              // đào nhánh mỗi 3 block
  const BRANCH_D   = opts.branchLen ?? 16;  // BUG FIX #2: 5 → 16

  // BUG FIX #1: dùng 'baritone' mode thay vì 'follow'
  refreshMovements('baritone');

  await botSay(`Bắt đầu strip mine! y=${ty}, dài=${MAIN}, nhánh=${BRANCH_D} block/bên`);
  logS(`[${who}] Strip mine: y=${ty} main=${MAIN} branch=${BRANCH_D}`);
  sendDiscordAlert(`Strip mine y=${ty}, ${MAIN} block`, { color: 'info', title: '⛏️ Strip Mine', extraFields: getInventoryFields() });

  // BUG FIX #7: kiểm tra có cuốc không
  const hasPick = bot.inventory.items().some(i => i.name.endsWith('_pickaxe'));
  if (!hasPick) {
    bot.chat('❌ Không có cuốc trong túi! Cần ít nhất một chiếc cuốc để đào.');
    isBusy = false; return;
  }

  const sp = bot.entity.position;
  const ax = Math.round(sp.x), az = Math.round(sp.z);
  const oreRef = { count: 0 };

  // ── Bước 1: Đào xuống ───────────────────────────────────────────
  bot.chat(`Đang đào xuống y=${ty}...`);
  await digDownTo(ty);
  try {
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(ax, ty, az, 2)),
      new Promise((_,rej) => setTimeout(rej, 10000)),
    ]);
  } catch(_) {}
  const actualY = Math.floor(bot.entity.position.y);
  bot.chat(`Đã xuống y=${actualY}! Bắt đầu đào tunnel chính...`);

  // ── Bước 2: Tunnel chính theo +X ────────────────────────────────
  try {
    for (let i = 1; i <= MAIN && !stopTask; i++) {
      // BUG FIX #6: ăn định kỳ
      if (i % 15 === 0) await autoEat();

      // Deposit khi đầy túi
      if (isInventoryFull() && !_autoReturning) {
        const _wb = isBusy; isBusy = false; _autoReturning = true;
        try { await depositToChest('[Auto]'); } finally { _autoReturning = false; isBusy = _wb; }
        if (stopTask) break;
      }

      const tx = ax + i;
      // BUG FIX #4: đọc Y hiện tại ngay trước khi dùng (không cache cả session)
      const curY = Math.floor(bot.entity.position.y);

      await digTunnelStep(tx, curY, az, oreRef);
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(tx, curY, az, 1)),
          new Promise((_,rej) => setTimeout(rej, 6000)),
        ]);
      } catch(_) {}

      // BUG FIX #9: đặt đuốc mỗi 8 block chính
      if (i % 8 === 0) await placeTorchIfNeeded(tx, curY, az);

      if (i % BRANCH_INT === 0 && !stopTask) {
        // Rẽ nhánh +Z
        for (let dz = 1; dz <= BRANCH_D && !stopTask; dz++) {
          // BUG FIX #4: đọc Y mỗi bước nhánh
          const bY = Math.floor(bot.entity.position.y);
          await digTunnelStep(tx, bY, az + dz, oreRef);
          try {
            await Promise.race([
              bot.pathfinder.goto(new GoalNear(tx, bY, az+dz, 1)),
              new Promise((_,rej) => setTimeout(rej, 6000)),
            ]);
          } catch(_) {}
          if (dz % 8 === 0) await placeTorchIfNeeded(tx, bY, az+dz);
        }
        // Quay về đường chính (+Z)
        try {
          await Promise.race([
            bot.pathfinder.goto(new GoalNear(tx, curY, az, 1)),
            new Promise((_,rej) => setTimeout(rej, 12000)),
          ]);
        } catch(_) {}

        // Rẽ nhánh -Z
        for (let dz = 1; dz <= BRANCH_D && !stopTask; dz++) {
          const bY = Math.floor(bot.entity.position.y);
          await digTunnelStep(tx, bY, az - dz, oreRef);
          try {
            await Promise.race([
              bot.pathfinder.goto(new GoalNear(tx, bY, az-dz, 1)),
              new Promise((_,rej) => setTimeout(rej, 6000)),
            ]);
          } catch(_) {}
          if (dz % 8 === 0) await placeTorchIfNeeded(tx, bY, az-dz);
        }
        // Quay về đường chính (-Z)
        try {
          await Promise.race([
            bot.pathfinder.goto(new GoalNear(tx, curY, az, 1)),
            new Promise((_,rej) => setTimeout(rej, 12000)),
          ]);
        } catch(_) {}

        // BUG FIX #7: kiểm tra còn cuốc không sau mỗi nhánh
        if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
          bot.chat('⚠️ Cuốc hỏng hết! Dừng strip mine. Ore tìm được: ' + oreRef.count + ' block.');
          break;
        }
        await autoEat();
      }

      if (i % 10 === 0) {
        bot.chat(`Strip mine ${i}/${MAIN} block (${oreRef.count} ore tìm thấy)`);
      }
    }

    if (!stopTask) {
      bot.chat(`✅ Strip mine hoàn thành! Đào ${MAIN} block, tìm ${oreRef.count} block quặng.`);
    } else {
      bot.chat(`⏸ Đã dừng strip mine. Đã đào đến block ${MAIN}, ore: ${oreRef.count}.`);
    }
  } catch(e) {
    logW('[StripMine] Lỗi: ' + e.message);
    bot.chat('Strip mine gặp lỗi: ' + e.message);
  } finally {
    // BUG FIX #3: reset về default mode sau khi xong
    refreshMovements('default');
    isBusy = false; bot._task = 'idle'; if (!isFollowing) startWander();
  }
}

// ── AUTO TREE FARM ─────────────────────────────────────────────────
const LOG_NAMES_FARM = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'];
const SAP_NAMES_FARM = ['oak_sapling','birch_sapling','spruce_sapling','jungle_sapling','acacia_sapling','dark_oak_sapling','cherry_sapling','mangrove_propagule'];
async function autoTreeFarm(who) {
  if (isBusy) return;
  isBusy = true; stopTask = false; bot._task = 'tree farm';
  // BUG FIX TF-1: phải dùng 'follow' (canDig=true) để pathfinder xuyên qua lá cây
  // 'default' có canDig=false → không leo lên được cây cao
  refreshMovements('follow');
  await botSay('Bắt đầu tree farm!');
  // BUG FIX TF-2: tính logIds MỘT LẦN ngoài loop, không cần tính lại mỗi vòng
  const logIds = LOG_NAMES_FARM.map(n => mcData.blocksByName[n]?.id).filter(Boolean);
  let chopCount = 0;
  try {
  while (!stopTask) {
    if (isInventoryFull() && !_autoReturning) { const _wb=isBusy; isBusy=false; _autoReturning=true; try { await depositToChest('[Auto]'); } finally { _autoReturning=false; isBusy=_wb; } if (stopTask) break; }

    // BUG FIX TF-4: ăn định kỳ (cứ 10 cây ăn một lần)
    if (chopCount > 0 && chopCount % 10 === 0) await autoEat();

    const log = bot.findBlock({ matching: logIds, maxDistance: 48 });
    if (log) {
      try {
        // GoalLookAtBlock: bot đứng ở vị trí CÓ THỂ nhìn + đào block đó (chính xác hơn GoalNear 3)
        await Promise.race([
          bot.pathfinder.goto(new GoalLookAtBlock(log.position, bot.world)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('nav timeout')), 8000)),
        ]);
        await smartDig(log); // equip + chọn mặt tốt nhất + đào
        chopCount++;
        // Chặt tiếp lên đỉnh cây (mỗi block đều trang bị tool đúng)
        let ab = bot.blockAt(log.position.offset(0, 1, 0));
        for (let h = 0; h < 32 && ab && logIds.includes(ab.type) && !stopTask; h++) {
          try {
            await bot.pathfinder.goto(new GoalNear(ab.position.x, ab.position.y, ab.position.z, 2));
            await smartDig(ab); // smartDig tự equip + chọn mặt
          } catch(_) { break; }
          ab = bot.blockAt(ab.position.offset(0, 1, 0));
        }
      } catch(e) { logW(`TreeFarm chặt: ${e.message}`); }
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    // Trồng lại sapling nếu có trong túi
    const sapItem = bot.inventory.items().find(i => SAP_NAMES_FARM.includes(i.name));
    if (sapItem) {
      const dirt = bot.findBlock({
        matching: b => b && ['grass_block','dirt','rooted_dirt','podzol','mycelium'].includes(b.name) &&
          bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air',
        maxDistance: 24,
      });
      if (dirt) {
        try {
          await bot.pathfinder.goto(new GoalNear(dirt.position.x, dirt.position.y, dirt.position.z, 2));
          await bot.equip(sapItem, 'hand');
          // smartPlace: thử tất cả mặt, ưu tiên mặt trên của dirt
          const placed = await smartPlace(dirt.position.offset(0, 1, 0));
          if (!placed) await bot.placeBlock(dirt, new Vec3(0, 1, 0)); // fallback
        } catch(e) { logW(`Trồng cây: ${e.message}`); }
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
    }
    // Không tìm thấy cây: chờ cây lớn
    if (chopCount === 0) bot.chat('Không tìm thấy cây trong 48 block. Đứng gần rừng hoặc farm cây rồi thử lại.');
    await new Promise(r => setTimeout(r, 6000));
  }
  } catch(e) { logW('TreeFarm: ' + e.message); }
  finally {
    // BUG FIX TF-5: reset về default mode khi xong
    refreshMovements('default');
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ── AUTO COBBLE FARM ───────────────────────────────────────────────
// Đào cobble liên tục. Nếu không tìm thấy → tự xây cobble generator (cần lava + water bucket)
async function autoCobbleFarm(who) {
  if (isBusy) return;
  isBusy = true; stopTask = false; bot._task = 'cobble farm';
  // BUG FIX CF-1: 'follow' mode (canDig=true) — ghi rõ để tránh nhầm sau này
  refreshMovements('follow');
  await botSay('Bắt đầu farm đá!');
  let digCount = 0;
  try {
  const cobIds = [
    mcData.blocksByName['cobblestone']?.id,
    mcData.blocksByName['stone']?.id,
    mcData.blocksByName['cobbled_deepslate']?.id,
  ].filter(Boolean);
  while (!stopTask) {
    if (isInventoryFull() && !_autoReturning) { const _wb=isBusy; isBusy=false; _autoReturning=true; try { await depositToChest('[Auto]'); } finally { _autoReturning=false; isBusy=_wb; } if (stopTask) break; }
    // BUG FIX CF-2: ăn mỗi 50 block
    if (digCount > 0 && digCount % 50 === 0) await autoEat();

    const block = bot.findBlock({ matching: cobIds, maxDistance: 16 });
    if (block) {
      try {
        await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 2));
        await equipToolForBlock(block);
        await bot.dig(block);
        digCount++;
        activityStats.blocksMinedTotal++;
      } catch(e) { await new Promise(r => setTimeout(r, 200)); }
    } else {
      const lava  = bot.inventory.items().find(i => i.name === 'lava_bucket');
      const water = bot.inventory.items().find(i => i.name === 'water_bucket');
      if (lava && water) {
        const pos = bot.entity.position;
        const bx = Math.floor(pos.x), by = Math.floor(pos.y) - 1, bz = Math.floor(pos.z);
        for (let dx = -1; dx <= 1; dx++) {
          const b = bot.blockAt(new Vec3(bx + dx, by, bz));
          if (b && b.diggable && b.name !== 'air') { try { await bot.dig(b); } catch(_) {} }
        }
        const gl = bot.blockAt(new Vec3(bx - 2, by, bz));
        if (gl) { try { await bot.equip(lava,  'hand'); await bot.placeBlock(gl, new Vec3(1, 0, 0)); } catch(_) {} }
        const gr = bot.blockAt(new Vec3(bx + 2, by, bz));
        if (gr) { try { await bot.equip(water, 'hand'); await bot.placeBlock(gr, new Vec3(-1, 0, 0)); } catch(_) {} }
        bot.chat('Đã xây cobble generator!');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        bot.chat('Cần lava_bucket và water_bucket trong túi để xây cobble gen!');
        break;
      }
    }
  }
  } catch(e) { logW('CobbleFarm: ' + e.message); }
  finally {
    // BUG FIX CF-3: reset về default sau khi xong
    refreshMovements('default');
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ── BUILD FROM SCHEMATIC ───────────────────────────────────────────
// File format: mỗi dòng  x,y,z,blockname   (VD: 10,64,5,oak_planks)
// ══════════════════════════════════════════════════════════════════
// ── SCHEMATIC PARSER (Baritone-style: .litematic / .schem / .txt) ─
// ══════════════════════════════════════════════════════════════════

// Đọc varint từ Buffer, trả về { value, bytesRead }
function readVarint(buf, offset) {
  let result = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    result |= (b & 0x7F) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value: result, bytesRead: offset };
}

// Parse Sponge Schematic v2/v3 (.schem)
function parseSpongeSchem(root) {
  const w = root.Width?.value ?? root.Width;
  const h = root.Height?.value ?? root.Height;
  const l = root.Length?.value ?? root.Length;
  if (!w || !h || !l) throw new Error('Sponge schem thiếu Width/Height/Length');

  // Palette: { "minecraft:stone": {type:'int',value:0}, ... }
  const palette = root.Palette?.value ?? root.Palette;
  const idToName = {};
  for (const [name, v] of Object.entries(palette)) {
    const id = typeof v === 'object' ? v.value : v;
    // strip minecraft: prefix and block state properties for lookup
    idToName[id] = name.replace(/^minecraft:/, '').replace(/\[.*\]$/, '');
  }

  // BlockData: varint-encoded array
  const rawBytes = root.BlockData?.value;
  const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  const blockIds = [];
  let pos = 0;
  while (pos < buf.length) {
    const r = readVarint(buf, pos);
    blockIds.push(r.value);
    pos = r.bytesRead;
  }

  const blocks = [];
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < l; z++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * l + z) * w + x;
        if (idx >= blockIds.length) continue;
        const name = idToName[blockIds[idx]];
        if (!name || name === 'air') continue;
        blocks.push({ x, y, z, blockName: name });
      }
    }
  }
  return blocks;
}

// Parse Litematica (.litematic)
function parseLitematic(root) {
  const regions = root.Regions?.value ?? root.Regions;
  if (!regions) throw new Error('.litematic thiếu Regions');
  const regionName = Object.keys(regions)[0];
  const region = regions[regionName]?.value ?? regions[regionName];

  const palette = region.BlockStatePalette?.value ?? region.BlockStatePalette;
  const paletteList = palette?.value ?? palette; // list of compound tags
  const nameList = paletteList.map(entry => {
    const e = entry?.value ?? entry;
    const name = (e.Name?.value ?? e.Name ?? 'air').replace(/^minecraft:/, '');
    return name;
  });

  const sizeTag = region.Size?.value ?? region.Size;
  const sizeX = Math.abs(sizeTag.x?.value ?? sizeTag.x ?? 0);
  const sizeY = Math.abs(sizeTag.y?.value ?? sizeTag.y ?? 0);
  const sizeZ = Math.abs(sizeTag.z?.value ?? sizeTag.z ?? 0);
  const volume = sizeX * sizeY * sizeZ;
  if (!volume) throw new Error('.litematic Size = 0');

  const bitsPerEntry = Math.max(2, Math.ceil(Math.log2(nameList.length)));
  const mask = (1n << BigInt(bitsPerEntry)) - 1n;

  // BlockStates: Long array (LongArray tag — array of BigInt or number)
  const bsRaw = region.BlockStates?.value ?? region.BlockStates;
  // prismarine-nbt v2 returns LongArray as array of [hi, lo] pairs or BigInt
  const longs = [];
  if (Array.isArray(bsRaw)) {
    for (const entry of bsRaw) {
      if (typeof entry === 'bigint') { longs.push(entry); }
      else if (Array.isArray(entry) && entry.length === 2) {
        // [hi, lo] both 32-bit signed
        longs.push((BigInt(entry[0]) << 32n) | (BigInt(entry[1]) & 0xFFFFFFFFn));
      } else { longs.push(BigInt(entry)); }
    }
  }

  const blocks = [];
  let bitBuffer = 0n, bitsInBuffer = 0, longIdx = 0;

  for (let i = 0; i < volume; i++) {
    // Litematica packs entries LSB-first within each Long
    while (bitsInBuffer < bitsPerEntry && longIdx < longs.length) {
      bitBuffer |= longs[longIdx++] << BigInt(bitsInBuffer);
      bitsInBuffer += 64;
    }
    const paletteIdx = Number(bitBuffer & mask);
    bitBuffer >>= BigInt(bitsPerEntry);
    bitsInBuffer -= bitsPerEntry;

    const name = nameList[paletteIdx] ?? 'air';
    if (!name || name === 'air') continue;

    // Litematica index: (y * SizeZ + z) * SizeX + x
    const x = i % sizeX;
    const z = Math.floor(i / sizeX) % sizeZ;
    const y = Math.floor(i / (sizeX * sizeZ));
    blocks.push({ x, y, z, blockName: name });
  }
  return blocks;
}

// Hàm tổng: đọc và parse bất kỳ định dạng schematic nào
async function parseSchematic(filename) {
  // Resolve path — thử nhiều extension
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, filename),
    path.resolve(cwd, filename + '.litematic'),
    path.resolve(cwd, filename + '.schem'),
    path.resolve(cwd, filename + '.txt'),
    path.resolve(cwd, 'schematics', filename),
    path.resolve(cwd, 'schematics', filename + '.litematic'),
    path.resolve(cwd, 'schematics', filename + '.schem'),
  ];
  let fp = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { fp = c; break; }
  }
  if (!fp) {
    const searched = candidates.map(c => '  • ' + c).join('\n');
    throw new Error(
      `Không tìm thấy file: "${filename}"\n` +
      `Đã tìm ở:\n${searched}\n` +
      `→ Đặt file vào thư mục schematics/ rồi gõ: xây ${filename}`
    );
  }

  const ext = path.extname(fp).toLowerCase();

  // ── .txt format (CSV: x,y,z,blockname) ──────────────────────────
  if (ext === '.txt' || ext === '.csv') {
    const content = await fs.promises.readFile(fp, 'utf8');
    const blocks = [];
    for (const line of content.split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const parts = l.split(',');
      if (parts.length < 4) continue;
      const x = parseInt(parts[0]), y = parseInt(parts[1]), z = parseInt(parts[2]);
      const blockName = parts.slice(3).join(',').trim();
      if (!isNaN(x) && !isNaN(y) && !isNaN(z) && blockName) blocks.push({ x, y, z, blockName });
    }
    return blocks;
  }

  // ── .litematic / .schem (NBT) ────────────────────────────────────
  const nbtLib = await getNbt();
  if (!nbtLib) throw new Error('Thiếu thư viện prismarine-nbt. Chạy: npm install prismarine-nbt');

  let rawBuf = await fs.promises.readFile(fp);
  // NBT thường được nén gzip — thử gunzip
  try { rawBuf = await gunzip(rawBuf); } catch(_) {} // không nén thì thôi

  // parse NBT
  const parseNbt = util.promisify(nbtLib.parse.bind(nbtLib));
  const parsed = await parseNbt(rawBuf);
  const root = parsed.parsed?.value ?? parsed.value ?? parsed;

  if (ext === '.litematic') return parseLitematic(root);
  if (ext === '.schem' || ext === '.schematic') return parseSpongeSchem(root);
  throw new Error(`Định dạng ${ext} chưa được hỗ trợ`);
}

// ══════════════════════════════════════════════════════════════════
// ── SCHEMATIC UTILITIES: list / save / load / resume ──────────────
// ══════════════════════════════════════════════════════════════════

// Liệt kê tất cả file .litematic / .schem / .txt trong cwd + schematics/
function listSchematics() {
  const cwd = process.cwd();
  const dirs = [cwd, path.join(cwd, 'schematics')];
  const exts = new Set(['.litematic', '.schem', '.schematic', '.txt', '.csv']);
  const found = [];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (exts.has(path.extname(f).toLowerCase())) {
          const rel = path.relative(cwd, path.join(dir, f));
          found.push(rel);
        }
      }
    } catch(_) {}
  }
  return found;
}

// Lưu tiến trình xây vào file JSON
function saveProgress(filename, origin, absBlocks, placedSet) {
  try {
    const data = {
      filename,
      origin: { x: origin.x, y: origin.y, z: origin.z },
      absBlocks,                           // toàn bộ danh sách block (đã sort)
      placed: [...placedSet],              // các key "x,y,z" đã xây xong
      savedAt: Date.now(),
    };
    fs.writeFileSync(BUILD_PROGRESS_FILE, JSON.stringify(data));
  } catch(e) { logW('[Resume] Không lưu được tiến trình: ' + e.message); }
}

// Xóa tiến trình
function clearProgress() {
  try { if (fs.existsSync(BUILD_PROGRESS_FILE)) fs.unlinkSync(BUILD_PROGRESS_FILE); } catch(_) {}
}

// Đọc tiến trình — trả null nếu không có
function loadProgress() {
  try {
    if (!fs.existsSync(BUILD_PROGRESS_FILE)) return null;
    return JSON.parse(fs.readFileSync(BUILD_PROGRESS_FILE, 'utf8'));
  } catch(_) { return null; }
}

// Tiếp tục xây từ tiến trình đã lưu
async function resumeBuild(who) {
  if (isBusy) return;
  const prog = loadProgress();
  if (!prog) {
    if (bot) bot.chat('Không có tiến trình xây nào được lưu. Dùng: xây <file>');
    return;
  }
  const { filename, absBlocks, placed } = prog;
  const placedSet = new Set(placed);
  const remaining = absBlocks.filter(b => !placedSet.has(`${b.x},${b.y},${b.z}`));
  const total = absBlocks.length;
  bot.chat(`Resume "${path.basename(filename)}" — đã xây ${placedSet.size}/${total}, còn ${remaining.length} block...`);

  isBusy = true; stopTask = false; bot._task = `resume: ${path.basename(filename)}`;
  const blueprintSet = new Set(absBlocks.map(b => `${b.x},${b.y},${b.z}`));
  const scaffoldLog  = new Set();
  const restorePlace = wrapPlaceBlock(scaffoldLog);
  refreshMovements('build');
  let built = 0, skipped = 0;
  try {
    for (const { x, y, z, blockName } of remaining) {
      if (stopTask) break;
      // Kiểm tra xem block đã có đúng chưa (có thể ai đó đặt hộ)
      const cur = bot.blockAt(new Vec3(x, y, z));
      if (cur && cur.name === blockName) { placedSet.add(`${x},${y},${z}`); built++; continue; }
      const item = bot.inventory.items().find(i => i.name === blockName);
      if (!item) { skipped++; continue; }
      if ((built + skipped) % 30 === 0) refreshMovements('build');
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(x, y, z, 2)),
          new Promise((_,rej) => setTimeout(rej, 12000)),
        ]);
        if (stopTask) break;
        await tryPlaceBlock(x, y, z, item);
        scaffoldLog.delete(`${x},${y},${z}`);
        placedSet.add(`${x},${y},${z}`);
        built++;
      } catch(e) { logW(`Resume đặt ${blockName}@${x},${y},${z}: ${e.message}`); skipped++; }
      // Auto-save mỗi 20 block
      if (built % 20 === 0) saveProgress(filename, prog.origin, absBlocks, placedSet);
      if ((built + skipped) % 10 === 0)
        bot.chat(`Resume ${Math.round((placedSet.size)/total*100)}% (${placedSet.size}/${total})`);
      await new Promise(r => setTimeout(r, 60));
    }
    if (!stopTask) {
      clearProgress();
      bot.chat(`✅ Resume hoàn tất! Tổng: ${placedSet.size}/${total} block.`);
      restorePlace();
      await cleanupScaffold(blueprintSet, scaffoldLog);
    } else {
      saveProgress(filename, prog.origin, absBlocks, placedSet);
      bot.chat(`⏸ Đã dừng. Gõ "xây resume" để tiếp tục (${placedSet.size}/${total} đã xây).`);
    }
  } catch(e) {
    saveProgress(filename, prog.origin, absBlocks, placedSet);
    logW('resumeBuild: ' + e.message);
  } finally {
    restorePlace();
    refreshMovements('default');
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ── HELPER: dọn scaffold tạm sau khi xây xong ──────────────────────
// blueprintSet: Set của "x,y,z" — các vị trí THUỘC blueprint (không được xóa)
// scaffoldLog : Set của "x,y,z" — các vị trí bot đã đặt scaffold trong lúc di chuyển
async function cleanupScaffold(blueprintSet, scaffoldLog) {
  if (!scaffoldLog.size) return;
  // Lọc ra những vị trí scaffold KHÔNG nằm trong blueprint
  const toRemove = [];
  for (const key of scaffoldLog) {
    if (blueprintSet.has(key)) continue;           // thuộc blueprint → giữ lại
    const [x, y, z] = key.split(',').map(Number);
    const blk = bot.blockAt(new Vec3(x, y, z));
    if (blk && blk.name !== 'air' && blk.diggable) toRemove.push({ x, y, z });
  }
  if (!toRemove.length) return;
  // Dọn từ trên xuống (tránh bị treo giữa không trung)
  toRemove.sort((a, b) => b.y - a.y);
  bot.chat(`Dọn ${toRemove.length} block scaffold tạm...`);
  for (const { x, y, z } of toRemove) {
    if (stopTask) break;
    const blk = bot.blockAt(new Vec3(x, y, z));
    if (!blk || blk.name === 'air') continue;
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(x, y, z, 2)),
        new Promise((_,rej) => setTimeout(rej, 6000)),
      ]);
      await equipToolForBlock(blk);
      const fresh = bot.blockAt(new Vec3(x, y, z));
      if (fresh && fresh.diggable && fresh.name !== 'air') await smartDig(fresh, false);
    } catch(e) { logW(`cleanup scaffold@${x},${y},${z}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 40));
  }
  bot.chat('✅ Đã dọn scaffold tạm xong!');
}

// ── HELPER: wrap bot.placeBlock để theo dõi scaffold do pathfinder đặt ─
// Trả về hàm restore. Mọi block scaffold được đặt trong thời gian wrap
// sẽ được ghi vào scaffoldLog (Set<"x,y,z">).
function wrapPlaceBlock(scaffoldLog) {
  const _orig = bot.placeBlock.bind(bot);
  bot.placeBlock = async function(refBlock, faceVec) {
    const result = await _orig(refBlock, faceVec);
    // Tính vị trí block vừa đặt
    const pos = refBlock.position.offset(faceVec.x, faceVec.y, faceVec.z);
    const held = bot.heldItem;
    if (held && SCAFFOLD_NAMES.some(n => held.name.includes(n))) {
      scaffoldLog.add(`${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`);
    }
    return result;
  };
  // Trả về hàm restore
  return () => { bot.placeBlock = _orig; };
}

// ── HELPER: đặt 1 block tại (x,y,z) — thử 6 mặt, ưu tiên mặt dưới
// item: inventory item đã equip sẵn
// Throws nếu không đặt được
async function tryPlaceBlock(x, y, z, item) {
  await bot.equip(item, 'hand');
  // Ưu tiên mặt dưới → trên → 4 cạnh
  const FACE_ORDER = [
    new Vec3(0,-1,0), // đặt lên mặt trên của block bên dưới (phổ biến nhất)
    new Vec3(0, 1,0),
    new Vec3(-1,0,0), new Vec3(1,0,0),
    new Vec3(0,0,-1), new Vec3(0,0, 1),
  ];
  for (const f of FACE_ORDER) {
    const nb = bot.blockAt(new Vec3(x - f.x, y - f.y, z - f.z));
    if (nb && nb.name !== 'air' && nb.boundingBox === 'block') {
      try {
        await Promise.race([
          bot.placeBlock(nb, f),
          new Promise((_,rej) => setTimeout(rej, 3000)),
        ]);
        return; // thành công
      } catch(_) {}
    }
  }
  throw new Error('Không tìm được mặt để đặt block');
}

// ── BUILD SCHEMATIC (hỗ trợ .litematic / .schem / .txt) ──────────
async function buildSchematic(filename, who) {
  if (isBusy) return;
  isBusy = true; stopTask = false; bot._task = 'xây schematic';
  await botSay(`Đọc file ${filename}...`);
  let blocks = [];
  try {
    blocks = await parseSchematic(filename);
  } catch(e) {
    bot.chat(`Không đọc được file: ${e.message}`);
    isBusy = false; if (!isFollowing) startWander(); return;
  }
  if (!blocks.length) {
    bot.chat('File trống hoặc sai định dạng!');
    isBusy = false; if (!isFollowing) startWander(); return;
  }

  // Dịch tọa độ relative → absolute (origin = vị trí bot hiện tại)
  const origin = bot.entity.position.floored();
  const absBlocks = blocks.map(({ x, y, z, blockName }) => ({
    x: origin.x + x, y: origin.y + y, z: origin.z + z, blockName,
  }));
  absBlocks.sort((a, b) => a.y - b.y); // xây từ dưới lên

  const blueprintSet = new Set(absBlocks.map(b => `${b.x},${b.y},${b.z}`));
  const scaffoldLog  = new Set();
  const restorePlaceBlock = wrapPlaceBlock(scaffoldLog);
  // Theo dõi block đã đặt để lưu tiến trình (resume)
  const placedSet = new Set();

  bot.chat(`Xây ${absBlocks.length} block từ ${path.basename(filename)}... (gõ "dừng" để tạm dừng, "xây resume" để tiếp tục)`);
  refreshMovements('build');
  let built = 0, skipped = 0;
  try {
    for (const { x, y, z, blockName } of absBlocks) {
      if (stopTask) break;
      const cur = bot.blockAt(new Vec3(x, y, z));
      if (cur && cur.name === blockName) { placedSet.add(`${x},${y},${z}`); built++; continue; }
      const item = bot.inventory.items().find(i => i.name === blockName);
      if (!item) { skipped++; continue; }
      if ((built + skipped) % 30 === 0) refreshMovements('build');
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(x, y, z, 2)),
          new Promise((_,rej) => setTimeout(rej, 12000)),
        ]);
        if (stopTask) break;
        await tryPlaceBlock(x, y, z, item);
        scaffoldLog.delete(`${x},${y},${z}`);
        placedSet.add(`${x},${y},${z}`);
        built++;
      } catch(e) {
        logW(`Đặt ${blockName}@${x},${y},${z}: ${e.message}`);
        skipped++;
      }
      // Auto-save tiến trình mỗi 20 block đặt thành công
      if (built % 20 === 0 && built > 0)
        saveProgress(filename, origin, absBlocks, placedSet);
      if ((built + skipped) % 10 === 0 && absBlocks.length)
        bot.chat(`${Math.round((built+skipped)/absBlocks.length*100)}% (${built}/${absBlocks.length})`);
      await new Promise(r => setTimeout(r, 60));
    }

    if (stopTask) {
      // Người dùng bấm dừng — lưu tiến trình để resume sau
      saveProgress(filename, origin, absBlocks, placedSet);
      bot.chat(`⏸ Đã dừng. Đã xây ${built}/${absBlocks.length}. Gõ "xây resume" để tiếp tục.`);
    } else {
      clearProgress(); // xây xong → xóa file tiến trình
      bot.chat(`✅ Xây xong! ${built}/${absBlocks.length} block. Không với tới: ${skipped}.`);
      restorePlaceBlock();
      await cleanupScaffold(blueprintSet, scaffoldLog);
    }
  } catch(e) {
    saveProgress(filename, origin, absBlocks, placedSet);
    logW(`buildSchematic: ${e.message}`);
    bot.chat(`Lỗi khi xây: ${e.message}. Tiến trình đã lưu — gõ "xây resume" để tiếp tục.`);
  } finally {
    restorePlaceBlock();
    refreshMovements('default');
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ══════════════════════════════════════════════════════════════════
// ── BARITONE-INSPIRED FEATURES ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// 1. GOTO COORDS (#goto) ──────────────────────────────────────────
async function gotoCoords(x, y, z, who) {
  if (!bot || isBusy) return;
  isBusy = true; stopTask = false;
  const label = y !== null ? `${x},${y},${z}` : `${x},${z}`;
  bot._task = `đến ${label}`;
  bot.chat(`Đi đến (${label})...`);
  try {
    const goal = y !== null ? new GoalNear(x, y, z, 2) : new GoalXZ(x, z);
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_,rej) => setTimeout(rej, 120000)),
    ]);
    const p = bot.entity.position;
    bot.chat(`Đã đến! Pos: ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`);
  } catch(e) {
    bot.chat(`Không thể đến tọa độ đó: ${e.message||'timeout'}`);
  }
  isBusy = false; if (!isFollowing) startWander();
}

// 2. EXCAVATE (#excavate) ──────────────────────────────────────────
async function excavate(w, h, l, who) {
  if (!bot || isBusy) return;
  isBusy = true; stopTask = false;
  bot._task = `đào hầm ${w}×${h}×${l}`;
  const origin = bot.entity.position.floored();
  const hw = Math.floor(w / 2), hl = Math.floor(l / 2);
  // Collect targets bottom-up (prevents gravel/sand blocking)
  const targets = [];
  for (let dy = 0; dy < h; dy++)
    for (let dx = -hw; dx <= hw; dx++)
      for (let dz = -hl; dz <= hl; dz++) {
        const bx = origin.x+dx, by = origin.y+dy, bz = origin.z+dz;
        const blk = bot.blockAt(new Vec3(bx, by, bz));
        if (blk && blk.name !== 'air' && blk.diggable &&
            !['water','lava','bedrock'].includes(blk.name))
          targets.push({ x:bx, y:by, z:bz });
      }
  bot.chat(`Đào hầm ${w}×${h}×${l}: ${targets.length} block...`);
  let done = 0;
  for (const { x, y, z } of targets) {
    if (stopTask) break;
    const blk = bot.blockAt(new Vec3(x, y, z));
    if (!blk || blk.name === 'air') { done++; continue; }
    try {
      await Promise.race([bot.pathfinder.goto(new GoalNear(x,y,z,3)), new Promise((_,rej)=>setTimeout(rej,8000))]);
      await equipToolForBlock(blk);
      const fresh = bot.blockAt(new Vec3(x,y,z));
      if (fresh && fresh.diggable && fresh.name !== 'air') await smartDig(fresh, false);
      done++;
    } catch(_) {}
    if (done % 25 === 0 && targets.length) bot.chat(`${Math.round(done/targets.length*100)}% (${done}/${targets.length})`);
    await new Promise(r => setTimeout(r, 60));
  }
  bot.chat(`Đào hầm xong! ${done}/${targets.length} block.`);
  isBusy = false; if (!isFollowing) startWander();
}

// 3. FILL REGION (#fill) — lấp đầy vùng 3D bằng 1 loại block ─────
// Tương đương WorldEdit //set hoặc Baritone #fill
async function fillRegion(x1, y1, z1, x2, y2, z2, blockName, who) {
  if (!bot || isBusy) return;
  isBusy = true; stopTask = false;
  bot._task = `fill ${blockName}`;
  const bx1 = Math.min(x1,x2), bx2 = Math.max(x1,x2);
  const by1 = Math.min(y1,y2), by2 = Math.max(y1,y2);
  const bz1 = Math.min(z1,z2), bz2 = Math.max(z1,z2);
  const total = (bx2-bx1+1)*(by2-by1+1)*(bz2-bz1+1);
  if (total > 4000) { bot.chat(`Quá lớn! ${total} block (tối đa 4000). Thu nhỏ vùng lại.`); isBusy=false; return; }

  // Resolve alias
  const resolved = mcData?.blocksByName[blockName]?.name ?? blockName;
  bot.chat(`Fill ${resolved} vào vùng ${total} block...`);
  refreshMovements('build');

  let placed = 0, skipped = 0;
  try {
    for (let by = by1; by <= by2; by++) {        // bottom-up
      for (let bz = bz1; bz <= bz2; bz++) {
        for (let bx = bx1; bx <= bx2; bx++) {
          if (stopTask) break;
          const cur = bot.blockAt(new Vec3(bx, by, bz));
          if (cur?.name === resolved) { placed++; continue; }
          const item = bot.inventory.items().find(i => i.name === resolved);
          if (!item) { bot.chat(`Hết ${resolved}! Đã đặt ${placed}/${total}`); skipped += (by2-by+1)*(bz2-bz+1)*(bx2-bx+1); break; }
          // Rescan scaffold mỗi 30 block
          if ((placed + skipped) % 30 === 0) refreshMovements('build');
          try {
            await Promise.race([
              bot.pathfinder.goto(new GoalNear(bx, by, bz, 2)),
              new Promise((_,rej)=>setTimeout(rej,10000)),
            ]);
            if (stopTask) break;
            await tryPlaceBlock(bx, by, bz, item);
            placed++;
          } catch(e) { logW(`fill ${resolved}@${bx},${by},${bz}: ${e.message}`); skipped++; }
          if ((placed+skipped) % 20 === 0) bot.chat(`Fill ${Math.round((placed+skipped)/total*100)}% (${placed}/${total})`);
          await new Promise(r => setTimeout(r, 50));
        }
      }
    }
    bot.chat(`Fill xong! ${placed}/${total} block. Không đặt được: ${skipped}.`);
  } finally {
    refreshMovements('default');
    isBusy = false; if (!isFollowing) startWander();
  }
}

// 4. BUILD WALL (#wall) — xây tường từ điểm A đến điểm B ──────────
// Tọa độ tuyệt đối: x1 y1 z1 x2 y2 z2 [height] [blockname]
async function buildWall(x1, y1, z1, x2, y2, z2, wallH, blockName, who) {
  if (!bot || isBusy) return;
  isBusy = true; stopTask = false; bot._task = 'xây tường';
  const resolved = mcData?.blocksByName[blockName]?.name ?? blockName;
  // Tạo danh sách block theo đường thẳng (Bresenham 2D trên mặt phẳng XZ)
  const blocks = [];
  const dx = Math.abs(x2-x1), dz = Math.abs(z2-z1);
  const sx = x1<x2 ? 1 : -1, sz = z1<z2 ? 1 : -1;
  let err = dx - dz, cx = x1, cz = z1;
  while (true) {
    for (let dy = 0; dy < wallH; dy++) blocks.push({ x:cx, y:y1+dy, z:cz, blockName: resolved });
    if (cx===x2 && cz===z2) break;
    const e2 = 2*err;
    if (e2 > -dz) { err -= dz; cx += sx; }
    if (e2 < dx)  { err += dx; cz += sz; }
  }
  const wallBlueprintSet = new Set(blocks.map(b => `${b.x},${b.y},${b.z}`));
  const wallScaffoldLog  = new Set();
  const restoreWallPlace = wrapPlaceBlock(wallScaffoldLog);

  bot.chat(`Xây tường ${blocks.length} block (${resolved}) từ (${x1},${y1},${z1}) → (${x2},${y2},${z2})...`);
  refreshMovements('build');
  let built = 0, skip = 0;
  try {
    for (const { x, y, z, blockName: bn } of blocks) {
      if (stopTask) break;
      const cur = bot.blockAt(new Vec3(x, y, z));
      if (cur?.name === bn) { built++; continue; }
      const item = bot.inventory.items().find(i => i.name === bn);
      if (!item) { bot.chat(`Hết ${bn}! Đã xây ${built}/${blocks.length}`); break; }
      if ((built + skip) % 30 === 0) refreshMovements('build');
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(x, y, z, 2)),
          new Promise((_,rej)=>setTimeout(rej,12000)),
        ]);
        if (stopTask) break;
        await tryPlaceBlock(x, y, z, item);
        wallScaffoldLog.delete(`${x},${y},${z}`); // block thật → không xóa
        built++;
      } catch(e) { logW(`wall ${bn}@${x},${y},${z}: ${e.message}`); skip++; }
      if (built % 10 === 0 && blocks.length) bot.chat(`Tường ${Math.round(built/blocks.length*100)}% (${built}/${blocks.length})`);
      await new Promise(r => setTimeout(r, 60));
    }
    bot.chat(`Xây tường xong! ${built}/${blocks.length} block. Không đặt được: ${skip}.`);
    restoreWallPlace();
    await cleanupScaffold(wallBlueprintSet, wallScaffoldLog);
  } catch(e) {
    logW(`buildWall: ${e.message}`);
  } finally {
    restoreWallPlace();
    refreshMovements('default');
    isBusy = false; if (!isFollowing) startWander();
  }
}

// 5. SCAFFOLD GOTO — đi đến tọa độ với scaffold bật ──────────────
// Giống Baritone #goto nhưng bật tower + scaffold để vượt địa hình
// Có stuck detection: nếu không di chuyển >5s thì reset pathfinder + rescan scaffold
async function scaffoldGoto(x, y, z, who) {
  if (!bot || isBusy) return;
  isBusy = true; stopTask = false;
  bot._task = `scaffold đến ${x},${y ?? '?'},${z}`;
  bot.chat(`Scaffold đến (${x},${y ?? '?'},${z}) — bật chế độ Baritone...`);
  refreshMovements('baritone');

  const goal = y !== null && y !== undefined ? new GoalNear(x, y, z, 2) : new GoalXZ(x, z);
  const TIMEOUT_MS  = 180000; // 3 phút tổng
  const STUCK_MS    = 5000;   // 5 giây không di chuyển = bị kẹt

  let lastPos = bot.entity.position.clone();
  let lastMoveTime = Date.now();
  let attempts = 0;
  const MAX_RETRY = 3;

  // Stuck monitor: check mỗi 1 giây
  const stuckTimer = setInterval(() => {
    if (!bot || stopTask) { clearInterval(stuckTimer); return; }
    const cur = bot.entity.position;
    const moved = cur.distanceTo(lastPos);
    if (moved > 0.5) {
      lastPos = cur.clone();
      lastMoveTime = Date.now();
    } else if (Date.now() - lastMoveTime > STUCK_MS && attempts < MAX_RETRY) {
      attempts++;
      logW(`[Scaffold] Bị kẹt (${attempts}/${MAX_RETRY})! Rescan scaffold + replan...`);
      if (bot?.chat) bot.chat(`Bị kẹt, thử lại (${attempts})...`);
      // Rescan scaffold blocks từ túi hiện tại
      refreshMovements('baritone');
      // Reset pathfinder goal để force replan
      try { bot.pathfinder.setGoal(null); } catch(_) {}
      setTimeout(() => {
        if (!stopTask) {
          try { bot.pathfinder.goto(goal); } catch(_) {}
        }
      }, 500);
      lastMoveTime = Date.now(); // reset timer
    }
  }, 1000);

  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_,rej) => setTimeout(rej, TIMEOUT_MS, new Error('timeout 3 phút'))),
      new Promise((_,rej) => {
        const check = setInterval(() => { if (stopTask) { clearInterval(check); rej(new Error('dừng')); } }, 200);
      }),
    ]);
    const p = bot.entity.position;
    bot.chat(`✅ Đã đến! (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`);
  } catch(e) {
    if (e.message !== 'dừng')
      bot.chat(`Scaffold goto thất bại: ${e.message||'không tìm được đường'}`);
  } finally {
    clearInterval(stuckTimer);
    refreshMovements('default');
    isBusy = false; if (!isFollowing) startWander();
  }
}

// 6. VEINMINER (#veinminer) ────────────────────────────────────────
async function veinMine(blockArg, who) {
  if (!bot || isBusy) return;
  isBusy = true; stopTask = false;
  const mcData = mcDataLoader(bot.version);
  const ORE_ALIAS = {
    'kim cương':'diamond_ore','diamond':'diamond_ore',
    'sắt':'iron_ore','iron':'iron_ore','vàng':'gold_ore','gold':'gold_ore',
    'than':'coal_ore','coal':'coal_ore','đồng':'copper_ore','copper':'copper_ore',
    'đá đỏ':'redstone_ore','redstone':'redstone_ore',
    'lapis':'lapis_ore','ngọc lục bảo':'emerald_ore','emerald':'emerald_ore',
    'cổ':'ancient_debris','ancient debris':'ancient_debris','netherite':'ancient_debris',
  };
  const blockName = ORE_ALIAS[blockArg.toLowerCase()] || blockArg;
  bot._task = `đào mạch ${blockName}`;
  // Collect all IDs including deepslate variants
  const allIds = new Set();
  for (const cand of [blockName, 'deepslate_'+blockName, blockName.replace('_ore','')+'_ore', 'deepslate_'+blockName.replace('_ore','')+'_ore']) {
    const bid = mcData.blocksByName[cand]?.id;
    if (bid !== undefined) allIds.add(bid);
  }
  if (!allIds.size) { bot.chat(`Không biết block: ${blockName}`); isBusy=false; return; }
  const startBlock = bot.findBlock({ matching:[...allIds], maxDistance:64 });
  if (!startBlock) { bot.chat(`Không tìm thấy ${blockName} gần đây (r=64)`); isBusy=false; return; }
  // BFS find all connected same-type blocks
  const key = v => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;
  const visited = new Set([key(startBlock.position)]);
  const queue = [startBlock.position.clone()];
  const toMine = [];
  while (queue.length && toMine.length < 128) {
    const cur = queue.shift();
    const b = bot.blockAt(cur);
    if (!b || !allIds.has(b.type)) continue;
    toMine.push(cur.clone());
    for (const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nb = cur.offset(dx,dy,dz), k = key(nb);
      if (!visited.has(k)) { visited.add(k); queue.push(nb); }
    }
  }
  bot.chat(`Đào mạch ${blockName}: ${toMine.length} block...`);
  let done = 0;
  for (const pos of toMine) {
    if (stopTask) break;
    const blk = bot.blockAt(pos);
    if (!blk || !allIds.has(blk.type)) { done++; continue; }
    try {
      await Promise.race([bot.pathfinder.goto(new GoalNear(pos.x,pos.y,pos.z,3)), new Promise((_,rej)=>setTimeout(rej,10000))]);
      await equipToolForBlock(blk);
      const fresh = bot.blockAt(pos);
      if (fresh && allIds.has(fresh.type) && fresh.diggable) await smartDig(fresh, false);
      done++;
    } catch(_) {}
    await new Promise(r => setTimeout(r, 80));
  }
  bot.chat(`Đào mạch xong! ${done}/${toMine.length} block.`);
  isBusy = false; if (!isFollowing) startWander();
}

// 4. SURFACE (#surface) ────────────────────────────────────────────
async function goToSurface(who) {
  if (!bot || isBusy) return;
  isBusy = true; stopTask = false; bot._task = 'lên mặt đất';
  bot.chat('Đang đào lên mặt đất...');
  try {
    for (let iter = 0; iter < 350 && !stopTask; iter++) {
      const pos = bot.entity.position;
      const cy = Math.floor(pos.y), bx = Math.round(pos.x), bz = Math.round(pos.z);
      // Check if clear above (surface)
      const a1 = bot.blockAt(new Vec3(bx, cy+1, bz));
      const a2 = bot.blockAt(new Vec3(bx, cy+2, bz));
      if (a1?.name==='air' && a2?.name==='air') {
        let isSurface = true;
        for (let testY = cy+3; testY <= Math.min(cy+30, 320); testY++) {
          const tb = bot.blockAt(new Vec3(bx, testY, bz));
          if (tb && tb.name !== 'air') { isSurface = false; break; }
        }
        if (isSurface) break;
      }
      // Dig 2 blocks above
      for (const dy of [1,2]) {
        const blk = bot.blockAt(new Vec3(bx, cy+dy, bz));
        if (blk && blk.name !== 'air' && blk.diggable && !['water','lava','bedrock'].includes(blk.name))
          try { await equipToolForBlock(blk); await bot.dig(blk, true); } catch(_) {}
      }
      try {
        await Promise.race([bot.pathfinder.goto(new GoalNear(bx,cy+2,bz,1)), new Promise(r=>setTimeout(r,3000))]);
      } catch(_) {}
      if (Math.floor(bot.entity.position.y) <= cy) {
        try { bot.setControlState('jump',true); await new Promise(r=>setTimeout(r,300)); bot.setControlState('jump',false); } catch(_) {}
      }
      if (iter % 15 === 0) bot.chat(`Lên mặt đất... Y=${Math.round(bot.entity.position.y)}`);
      await new Promise(r => setTimeout(r, 100));
    }
    bot.chat(`Đã lên mặt đất! Y=${Math.round(bot.entity.position.y)}`);
  } catch(e) { bot.chat(`Lỗi: ${e.message}`); }
  isBusy = false; if (!isFollowing) startWander();
}

// 5. EXPLORE (#explore) ────────────────────────────────────────────
async function exploreArea(who) {
  if (!bot || isBusy) return;
  isBusy = true; stopTask = false; bot._task = 'khám phá';
  // Dùng 'follow' để pathfinder vượt qua địa hình (lá cây, cây, v.v.)
  refreshMovements('follow');
  bot.chat('Bắt đầu khám phá (xoắn ốc)...');
  const origin = bot.entity.position.clone();
  const STEP = 48;
  // Clockwise spiral: Right (+X), Down (+Z), Left (-X), Up (-Z)
  const DX = [1,0,-1,0], DZ = [0,1,0,-1];
  // Bắt đầu spiral từ bước 1 (bỏ qua vị trí gốc không cần di chuyển)
  let gx = DX[0], gz = DZ[0]; // bước đầu tiên: qua phải 1 ô
  let dir = 0, seg = 1, segCount = 1, turns = 0;
  // Xử lý turn ngay sau bước đầu
  if (segCount === seg) {
    segCount = 0; dir = (dir+1)%4; turns++;
    if (turns % 2 === 0) seg++;
  }
  try {
    for (let i = 0; i < 200 && !stopTask; i++) {
      const tx = Math.round(origin.x + gx*STEP), tz = Math.round(origin.z + gz*STEP);
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalXZ(tx, tz)),
          new Promise((_,rej) => setTimeout(rej, 20000)),
        ]);
      } catch(_) {}
      if (i % 4 === 0) bot.chat(`Khám phá (${tx}, ${tz}) [${i+1}/200]`);
      await new Promise(r => setTimeout(r, 200));
      // Advance spiral
      gx += DX[dir]; gz += DZ[dir]; segCount++;
      if (segCount === seg) {
        segCount = 0; dir = (dir+1)%4; turns++;
        if (turns % 2 === 0) seg++;
      }
    }
  } catch(_) {}
  bot.chat('Khám phá hoàn tất!');
  refreshMovements('default');
  isBusy = false; if (!isFollowing) startWander();
}

// ── AUTO FISH ─────────────────────────────────────────────────────
// Các loại item câu được (fishing loot table vanilla)
const FISH_LOOT_NAMES = new Set([
  'cod','salmon','tropical_fish','pufferfish',
  'lily_pad','saddle','name_tag','bow','fishing_rod','book',
  'string','ink_sac','bone','rotten_flesh','leather',
  'enchanted_book','nautilus_shell',
]);

async function startAutoFish(who) {
  if (isBusy) return;
  isBusy = true; stopTask = false; isFishing = true; bot._task = 'câu cá';
  let castCount = 0;
  let stopMsg = '';

  await botSay('Bắt đầu câu cá! (gõ "dừng câu" để dừng)');
  try {
    // ── BUG FIX #1+2: Tìm nước và pathfind MỘT LẦN khi bắt đầu ──────
    const water = bot.findBlock({ matching: b => b?.name === 'water', maxDistance: 16 });
    if (!water) {
      bot.chat('Không thấy nước gần đây (trong 16 block)! Hãy đứng cạnh ao/sông rồi thử lại.');
      return;
    }
    try {
      await bot.pathfinder.goto(new GoalNear(water.position.x, water.position.y, water.position.z, 2));
    } catch(_) {}
    // Nhìn về phía nước một lần
    await bot.lookAt(water.position.offset(0.5, 0.1, 0.5), true);

    while (!stopTask && isFishing) {
      // ── BUG FIX #7: Kiểm tra cần câu + cảnh báo độ bền ─────────────
      const rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
      if (!rod) {
        stopMsg = 'Không có cần câu trong túi!';
        bot.chat(stopMsg); break;
      }
      const durLeft = rod.durabilityUsed !== undefined ? (rod.maxDurability - rod.durabilityUsed) : null;
      if (durLeft !== null && durLeft <= 5) {
        bot.chat(`⚠️ Cần câu sắp hỏng (còn ${durLeft} lần dùng)! Đổi cần mới sớm.`);
      }

      // ── BUG FIX #8: Kiểm tra inventory đầy ─────────────────────────
      // bot.inventory.emptySlotCount() không tồn tại trong mineflayer — đếm thủ công
      const freeSlots = bot.inventory.slots.slice(9, 45).filter(s => !s).length;
      if (freeSlots === 0) {
        bot.chat('⚠️ Túi đồ đầy! Cá câu được sẽ rơi xuống đất. Hãy deposit đồ trước.');
      }

      // ── BUG FIX #4: equip + delay trước khi cast ────────────────────
      try { await bot.equip(rod, 'hand'); } catch(e) {
        logW('[Fish] equip rod: ' + e.message);
        await new Promise(r => setTimeout(r, 1000)); continue;
      }
      await new Promise(r => setTimeout(r, 250)); // chờ server confirm equip

      // Nhìn về phía nước trước mỗi lần quăng (không chỉ lần đầu)
      try { await bot.lookAt(water.position.offset(0.5, 0.1, 0.5), true); } catch(_) {}

      // Quăng cần
      try { bot.activateItem(); } catch(e) {
        logW('[Fish] cast: ' + e.message);
        await new Promise(r => setTimeout(r, 1200)); continue;
      }
      castCount++;
      logS(`[Fish] 🎣 Quăng #${castCount}...`);

      // ── BUG FIX #3: Detect cá cắn qua bobber entity (entityMoved) ───
      // Snapshot inventory trước khi kéo (để đếm item thực sự câu được)
      const invBefore = {};
      for (const it of bot.inventory.items()) {
        invBefore[it.name] = (invBefore[it.name] || 0) + it.count;
      }

      const bitten = await new Promise(resolve => {
        let bobber = null;
        let baseY  = null;
        let settled = false;
        let t_settle = null;
        let t_timeout = null;

        const cleanup = () => {
          bot.off('entitySpawn',  onSpawn);
          bot.off('entityMoved',  onMoved);
          bot.off('_fishStop',    onStop);
          if (t_settle)  clearTimeout(t_settle);
          if (t_timeout) clearTimeout(t_timeout);
        };

        // Bobber entity tên thay đổi theo phiên bản MC
        const isBobber = (e) =>
          e && e.name && (e.name.toLowerCase().includes('bobber') ||
                          e.name.toLowerCase().includes('fishinghook') ||
                          e.name.toLowerCase().includes('fishing_hook'));

        const onSpawn = (entity) => {
          if (!isBobber(entity)) return;
          bobber = entity;
          // Chờ bobber ổn định trong nước (~1.5s) rồi ghi baseY
          t_settle = setTimeout(() => {
            if (bobber) { baseY = bobber.position.y; settled = true; }
          }, 1500);
        };

        const onMoved = (entity) => {
          if (!bobber || entity !== bobber || !settled || baseY === null) return;
          // Khi cá cắn, bobber bị kéo xuống ~0.08 block
          if (entity.position.y < baseY - 0.07) {
            logS(`[Fish] 🐟 Cá cắn! (bobber Y ${baseY.toFixed(3)} → ${entity.position.y.toFixed(3)})`);
            cleanup(); resolve(true);
          }
        };

        const onStop = () => { cleanup(); resolve(false); };

        bot.on('entitySpawn', onSpawn);
        bot.on('entityMoved', onMoved);
        bot.once('_fishStop', onStop);

        // Fallback: nếu server không gửi entity hoặc bobber không dip sau 32s thì kéo
        t_timeout = setTimeout(() => {
          logS('[Fish] ⏱ Timeout 32s — kéo cần (không detect bobber)');
          cleanup(); resolve(true);
        }, 32000);
      });

      if (!isFishing || stopTask) break;

      // ── BUG FIX #6 (partial): Kéo cần rồi đếm loot thực sự ─────────
      try { bot.activateItem(); } catch(_) {}
      logS('[Fish] ↩️ Kéo cần!');
      await new Promise(r => setTimeout(r, 900)); // chờ item bay về

      // ── BUG FIX #1: Đếm item câu được bằng cách diff inventory ──────
      if (bitten) {
        let gotFish = false;
        for (const it of bot.inventory.items()) {
          if (!FISH_LOOT_NAMES.has(it.name)) continue;
          const prev = invBefore[it.name] || 0;
          if (it.count > prev) { gotFish = true; break; }
        }
        if (gotFish) { activityStats.fishCaught++; logActivity('Câu được cá/loot'); }
      }

      await autoEat();
      // Nghỉ ngắn rồi cast tiếp (tránh spam)
      await new Promise(r => setTimeout(r, 300));
    }

    // ── BUG FIX #6: Chat TRƯỚC khi finally chạy startWander ─────────
    if (stopMsg) {
      /* đã chat rồi */
    } else if (stopTask) {
      bot.chat(`⏸ Đã dừng câu cá. Tổng cast: ${castCount}, câu được: ${activityStats.fishCaught} lần.`);
    }
  } catch(e) {
    logW('[Fish] ' + e.message);
    bot.chat('Lỗi câu cá: ' + e.message);
  } finally {
    isFishing = false; isBusy = false;
    if (!isFollowing) startWander();
  }
}
function stopAutoFish() {
  isFishing = false; stopTask = true;
  try { if (bot) bot.emit('_fishStop'); } catch(_) {}
}

// ── BODYGUARD MODE ─────────────────────────────────────────────────
// Theo sát người được bảo vệ và tấn công mob thù gần người đó
function startBodyguard(targetName, who) {
  stopBodyguard();
  bodyguardTarget = targetName; isFollowing = true; stopTask = false;
  bot._task = `bảo vệ ${targetName}`;
  bot.chat(`Đang bảo vệ ${targetName}!`);
  logS(`[${who}] Bodyguard → ${targetName}`);
  refreshMovements();
  const followInt = setInterval(() => {
    if (!bot || !bodyguardTarget) return;
    const pEnt = bot.players[bodyguardTarget]?.entity;
    if (!pEnt) return;
    try { bot.pathfinder.setGoal(new GoalFollow(pEnt, 2), true); } catch(_) {}
  }, 800);
  bodyguardInterval = setInterval(async () => {
    if (!bot || !bodyguardTarget) return;
    try {
      const pEnt = bot.players[bodyguardTarget]?.entity;
      if (!pEnt) return;
      let nearest = null, minD = Infinity;
      for (const e of Object.values(bot.entities)) {
        if (!e || !e.position || e === bot.entity) continue;
        if (!HOSTILE_MOBS.has(e.name || e.mobType || '')) continue;
        const d = pEnt.position.distanceTo(e.position);
        if (d < 8 && d < minD) { minD = d; nearest = e; }
      }
      if (nearest) { await equipBestWeapon(); bot.pvp.attack(nearest); }
    } catch(_) {}
  }, 500);
  bot._bgFollow = followInt;
}
function stopBodyguard() {
  if (bodyguardInterval) { clearInterval(bodyguardInterval); bodyguardInterval = null; }
  if (bot?._bgFollow)    { clearInterval(bot._bgFollow);    bot._bgFollow = null; }
  bodyguardTarget = null; isFollowing = false;
  try { if (bot?.pvp) bot.pvp.stop(); } catch(_) {}
}

// ── AUTO TRADE ─────────────────────────────────────────────────────
// Chat: "đổi [A] lấy [B]" → chờ người kia ném B, nhặt xong rồi bot mới ném A
function handleTradeChat(user, msg) {
  // Kiểm tra quyền: chỉ allowedDropUsers mới được trade (trừ WebConsole)
  if (user !== '__WebConsole__' && CONFIG.allowedDropUsers.length > 0 && !CONFIG.allowedDropUsers.includes(user)) {
    bot.chat(`${user}: Bạn không có quyền trade!`);
    return false;
  }
  const txt = msg.toLowerCase();
  const m = txt.match(/(?:đổi|doi|trade)\s+(.+?)\s+(?:lấy|lay|for)\s+(.+)/);
  if (!m) return false;
  const give = m[1].trim().replace(/\s+/g, '_');
  const want = m[2].trim().replace(/\s+/g, '_');
  const giveItem = bot.inventory.items().find(i =>
    i.name.includes(give) || (i.displayName || '').toLowerCase().includes(give.replace(/_/g, ' '))
  );
  if (!giveItem) { bot.chat(`${user}: Tao không có ${give}!`); return true; }

  // Huỷ trade cũ nếu có
  if (pendingTrades.has(user)) {
    const old = pendingTrades.get(user);
    clearTimeout(old.timeout);
    if (old.onEntitySpawn) try { bot.off('entitySpawn', old.onEntitySpawn); } catch(_) {}
    pendingTrades.delete(user);
  }

  // Yêu cầu người kia ném trước
  bot.chat(`${user}: OK! Mày ném ${want.replace(/_/g,' ')} trước đi, tao sẽ ném ${giveItem.displayName} lại!`);

  // Lắng nghe item entity xuất hiện gần người chơi
  const onEntitySpawn = async (entity) => {
    if (entity.name !== 'item') return;
    const pEnt = bot.players[user]?.entity;
    if (!pEnt) return;
    if (entity.position.distanceTo(pEnt.position) > 6) return;

    // Dọn dẹp listener + timeout
    clearTimeout(tradeTimeout);
    try { bot.off('entitySpawn', onEntitySpawn); } catch(_) {}
    pendingTrades.delete(user);

    // Di chuyển đến nhặt item
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(entity.position.x, entity.position.y, entity.position.z, 1)),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    } catch(_) {}
    await new Promise(r => setTimeout(r, 600)); // chờ inventory cập nhật

    // Sau khi nhặt xong → ném đồ của bot lại cho người kia
    const ourItem = bot.inventory.items().find(i =>
      i.name.includes(give) || (i.displayName || '').toLowerCase().includes(give.replace(/_/g, ' '))
    );
    if (ourItem) {
      const pEnt2 = bot.players[user]?.entity;
      if (pEnt2) { try { bot.lookAt(pEnt2.position.offset(0, 1, 0), true); } catch(_) {} }
      await new Promise(r => setTimeout(r, 250));
      bot.tossStack(ourItem).catch(_ => {});
      bot.chat(`${user}: Đây ${ourItem.displayName}!`);
    } else {
      bot.chat(`${user}: Tao đã nhặt đồ của mày nhưng không còn ${give.replace(/_/g,' ')} để ném lại!`);
    }
  };

  bot.on('entitySpawn', onEntitySpawn);

  const tradeTimeout = setTimeout(() => {
    if (pendingTrades.has(user)) {
      pendingTrades.delete(user);
      try { bot.off('entitySpawn', onEntitySpawn); } catch(_) {}
      bot.chat(`${user}: Đợi 30 giây không thấy mày ném ${want.replace(/_/g,' ')}!`);
    }
  }, 30000);

  pendingTrades.set(user, { want, timeout: tradeTimeout, onEntitySpawn });
  return true;
}

// ── SORT CHEST ─────────────────────────────────────────────────────
// Lấy toàn bộ đồ trong rương, sắp theo nhóm (quặng → vật liệu → công cụ → vũ khí → đồ ăn → misc)
async function sortChest(who) {
  if (isBusy) return;
  isBusy = true; bot._task = 'sắp rương'; refreshMovements();
  await botSay('Đang sắp xếp rương...');
  const chestIds = [mcData.blocksByName.chest?.id, mcData.blocksByName.trapped_chest?.id, mcData.blocksByName.barrel?.id].filter(Boolean);
  const cb = bot.findBlock({ matching: chestIds, maxDistance: 32 });
  if (!cb) { bot.chat('Không tìm thấy rương nào!'); isBusy = false; if (!isFollowing) startWander(); return; }
  const catOf = name => {
    if (name.includes('_ore') || name === 'ancient_debris') return 0;
    if (['diamond','emerald','amethyst'].some(g => name.includes(g))) return 1;
    if (['iron_ingot','gold_ingot','copper_ingot','netherite_ingot','netherite_scrap','coal'].some(m => name === m)) return 2;
    if (['pickaxe','axe','shovel','hoe'].some(t => name.includes(t))) return 3;
    if (['sword','bow','crossbow','trident','mace'].some(w => name.includes(w))) return 4;
    if (['helmet','chestplate','leggings','boots','shield','elytra'].some(a => name.includes(a))) return 5;
    if (['arrow','spectral_arrow','tipped_arrow'].some(a => name.includes(a))) return 6;
    if (name.includes('potion') || name.includes('splash') || name.includes('lingering')) return 7;
    if (['bread','beef','pork','chicken','carrot','potato','apple','golden_apple','cod','salmon'].some(f => name.includes(f))) return 8;
    return 9;
  };
  try {
    await bot.pathfinder.goto(new GoalNear(cb.position.x, cb.position.y, cb.position.z, 3));
    await new Promise(r => setTimeout(r, 300));
    const chest = await bot.openChest(cb);
    // Lấy danh sách + sắp xếp; ghi nhớ số lượng từng loại lấy ra để không deposit thêm đồ riêng của bot
    const chestItemAmounts = new Map();
    for (const item of chest.containerItems()) {
      chestItemAmounts.set(item.name, (chestItemAmounts.get(item.name) || 0) + item.count);
    }
    const sorted = [...chest.containerItems()].sort((a, b) => {
      const ca = catOf(a.name), cb2 = catOf(b.name);
      return ca !== cb2 ? ca - cb2 : a.name.localeCompare(b.name);
    });
    // Rút hết ra — snapshot trước để tránh iterate array bị thay đổi bởi server update
    const chestSnapshot = [...chest.containerItems()];
    for (const item of chestSnapshot) {
      try { await chest.withdraw(item.type, null, item.count); await new Promise(r => setTimeout(r, 50)); } catch(_) {}
    }
    chest.close();
    await new Promise(r => setTimeout(r, 400));
    // Gửi lại theo thứ tự đã sắp — chỉ deposit đúng số lượng đã lấy ra khỏi rương
    const chest2 = await bot.openChest(cb);
    let n = 0;
    const depositTrack = new Map(chestItemAmounts);
    for (const sItem of sorted) {
      const remaining = depositTrack.get(sItem.name) || 0;
      if (remaining <= 0) continue;
      const inv = bot.inventory.items().find(i => i.name === sItem.name);
      if (!inv) continue;
      const depositCount = Math.min(inv.count, remaining);
      if (depositCount <= 0) continue;
      depositTrack.set(sItem.name, remaining - depositCount);
      try { await chest2.deposit(inv.type, null, depositCount); n++; await new Promise(r => setTimeout(r, 60)); } catch(_) {}
    }
    chest2.close();
    bot.chat(`Đã sắp xếp ${n} loại đồ theo nhóm!`);
  } catch(e) { logE(`sortChest: ${e.message}`); }
  finally { isBusy = false; if (!isFollowing) startWander(); }
}

// ── DEPOSIT ───────────────────────────────────────────────────────
// Thử đặt rương từ túi đồ lên mặt đất gần bot
async function tryPlaceChestFromInventory() {
  const chestItem = bot.inventory.items().find(i => i.name === 'chest');
  if (!chestItem) return null;
  const pos = bot.entity.position;
  // Quét xung quanh để tìm chỗ đặt
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx === 0 && dz === 0) continue;
      const groundPos = pos.offset(dx, -1, dz);
      const placePos  = pos.offset(dx,  0, dz);
      const headPos   = pos.offset(dx,  1, dz);
      try {
        const ground = bot.blockAt(groundPos);
        const place  = bot.blockAt(placePos);
        const head   = bot.blockAt(headPos);
        if (!ground || ground.name === 'air') continue;
        if (!place  || place.name  !== 'air') continue;
        if (!head   || head.name   !== 'air') continue;
        await bot.equip(chestItem, 'hand');
        // Dùng Promise.race với timeout dài hơn cho server Aternos lag
        try {
          await Promise.race([
            bot.placeBlock(ground, new Vec3(0, 1, 0)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('place timeout')), 12000)),
          ]);
        } catch(pe) {
          // Nếu timeout, vẫn kiểm tra xem block đã được đặt chưa
          logW(`[PlaceChest] ${pe.message} — kiểm tra lại...`);
        }
        await new Promise(r => setTimeout(r, 600));
        logS(`Đặt rương tại (${Math.round(pos.x+dx)},${Math.round(pos.y)},${Math.round(pos.z+dz)})`);
        // Tìm lại block vừa đặt
        const placed = bot.findBlock({
          matching: [mcData.blocksByName.chest?.id].filter(Boolean),
          maxDistance: 6,
        });
        if (placed) return placed;
      } catch(e) { logW(`Lỗi đặt rương: ${e.message}`); }
    }
  }
  return null;
}

const KEEP_ITEMS = new Set([
  // Công cụ & vũ khí
  'pickaxe','axe','shovel','sword','hoe','bow','crossbow','mace','trident',
  // Giáp
  'helmet','chestplate','leggings','boots','shield','elytra',
  // Utility quan trọng không được cất
  'totem_of_undying','ender_pearl','firework_rocket',
  'water_bucket','lava_bucket','milk_bucket',
  'arrow','spectral_arrow','tipped_arrow',
  'golden_apple','enchanted_golden_apple',
  // Giữ rương để có thể tự đặt khi cần
  'chest',
]);
function shouldKeep(name) { for (const k of KEEP_ITEMS) { if (name.includes(k)) return true; } return false; }

async function depositToChest(who) {
  if (isBusy && who !== '[Auto]') return;
  isBusy = true; bot._task = 'cất đồ'; refreshMovements();
  logS(`[${who}] Tìm rương...`);
  if (who !== '[Auto]') await botSay('Đang đi cất đồ vào rương');

  // Tìm rương/barrel trong bán kính 64
  let cb = bot.findBlock({
    matching: [mcData.blocksByName.chest?.id, mcData.blocksByName.trapped_chest?.id, mcData.blocksByName.barrel?.id].filter(Boolean),
    maxDistance: 64,
  });

  // Không thấy rương → thử đặt từ túi
  if (!cb) {
    logW('Không thấy rương trong 64m, thử đặt rương từ túi...');
    cb = await tryPlaceChestFromInventory();
    if (!cb) {
      const r = await getAI('Không có rương', 'Bot không tìm thấy hoặc không có rương để đặt. Cằn nhằn ngắn.');
      if (r) bot.chat(r);
      logW('Không có rương nào.');
      isBusy = false; if (!isFollowing) startWander(); return;
    }
  }

  // Thử từng rương gần nhất cho đến khi tới được
  const chestIds = [mcData.blocksByName.chest?.id, mcData.blocksByName.trapped_chest?.id, mcData.blocksByName.barrel?.id].filter(Boolean);
  // Dùng findBlocks (số nhiều) để tìm TẤT CẢ rương trong 64m (findBlock chỉ trả về 1 cái gần nhất)
  const allChestPositions = bot.findBlocks({ matching: chestIds, maxDistance: 64, count: 30 });
  const allChests = allChestPositions.map(pos => bot.blockAt(pos)).filter(Boolean);
  if (cb && !allChests.some(c => c.position.equals(cb.position))) allChests.unshift(cb);

  let reached = null;
  for (const candidate of allChests) {
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(candidate.position.x, candidate.position.y, candidate.position.z, 2)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('nav timeout')), 10000)),
      ]);
      reached = candidate; break;
    } catch(e) { logW(`Bỏ qua rương tại ${candidate.position} (${e.message})`); }
  }

  if (!reached) {
    // Vẫn không tới được → thử đặt rương mới từ túi
    logW('Không tới được rương nào, thử đặt rương từ túi...');
    reached = await tryPlaceChestFromInventory();
    if (!reached) {
      logW('Không có rương nào đặt được.');
      const r = await getAI('Không tới được rương', 'Bot không đến được rương. Cằn nhằn ngắn.');
      if (r) bot.chat(r);
      isBusy = false; if (!isFollowing) startWander(); return;
    }
    try {
      await bot.pathfinder.goto(new GoalNear(reached.position.x, reached.position.y, reached.position.z, 2));
    } catch(e) { logE(`Lỗi đến rương mới: ${e.message}`); isBusy = false; if (!isFollowing) startWander(); return; }
  }

  try {
    await new Promise(r => setTimeout(r, 300));
    const chest = await bot.openChest(reached);
    const items = bot.inventory.items().filter(i => !shouldKeep(i.name));
    if (!items.length) {
      bot.chat('Túi sạch rồi!'); chest.close();
      isBusy = false; if (!isFollowing) startWander(); return;
    }
    let count = 0; let chestFull = false;
    for (const item of items) {
      if (stopTask) break;
      try {
        await chest.deposit(item.type, null, item.count);
        count++; logS(`→ ${item.name} x${item.count}`);
        await new Promise(r => setTimeout(r, 180));
      } catch(e) {
        if (e.message && (e.message.includes('full') || e.message.includes('not enough'))) {
          chestFull = true; logW('Rương đầy!'); break;
        }
        logW(`Lỗi cất ${item.name}: ${e.message}`);
      }
    }
    chest.close();
    if (chestFull && count === 0) {
      bot.chat('⚠️ Rương đầy, không cất được gì!');
    } else {
      logS(`Cất xong ${count} loại đồ`);
      if (who !== '[Auto]') await botSay('Cất đồ xong rồi');
      else bot.chat(`Túi đầy, đã cất ${count} loại vào rương!`);
    }
  } catch(e) { logE(`Lỗi rương: ${e.message}`); }
  // [Auto] = được gọi từ giữa task đào → không startWander, để task tự tiếp tục
  finally { isBusy = false; if (!isFollowing && who !== '[Auto]') startWander(); }
}

// ── PVP CHALLENGE ─────────────────────────────────────────────────
const PVP_INTERVAL_MS = 30 * 60 * 1000; // 30 phút
const DEATH_KEYWORDS  = ['died','was slain','was killed','fell','drowned','burned','suffocated','starved','chết','bị giết','ngã'];

function cancelActiveDuel() {
  if (!activeDuel) return;
  clearTimeout(activeDuel.fightTimeout);
  if (activeDuel.trackInterval) clearInterval(activeDuel.trackInterval);
  if (activeDuel.deathHandler) { try { bot.removeListener('death', activeDuel.deathHandler); } catch(e){} }
  if (activeDuel.winHandler)   { try { bot.removeListener('entityDead', activeDuel.winHandler); } catch(e){} }
  try { if (bot?.pvp) bot.pvp.stop(); } catch(e){}
  try { if (bot?.pathfinder) bot.pathfinder.setGoal(null); } catch(e){}
  try { if (bot) { bot.setControlState('sprint', false); bot.setControlState('forward', false); } } catch(e){}
  // BUG FIX PVP-1: reset combo mutex khi duel kết thúc — nếu không reset,
  // isDoingSpecialCombo=true còn lại từ elytra/trident sẽ chặn mọi combo về sau
  isDoingSpecialCombo = false;
  activeDuel = null;
}

function getRandomPlayer() {
  if (!bot || !bot.players) return null;
  const others = Object.keys(bot.players).filter(n => n !== bot.username && bot.players[n]?.entity);
  if (!others.length) return null;
  return others[Math.floor(Math.random() * others.length)];
}

async function sendPvpChallenge() {
  if (!bot || !bot.entity || pendingDuel || activeDuel) return;
  const target = getRandomPlayer();
  if (!target) return;
  logS(`[PvP] Thách đấu → ${target}`);
  const msg = await getAI(
    `Thách ${target} đấu 1v1 PvP Minecraft`,
    `Bạn là bot Minecraft. Thách ${target} 1v1 PvP, yêu cầu gõ "có" để chấp nhận hoặc "không" để từ chối. Dưới 20 từ, tiếng Việt.`
  );
  bot.chat(msg || `@${target} mày có dám 1v1 với tao không? Gõ "có" hoặc "không"!`);
  pendingDuel = {
    player: target,
    timeout: setTimeout(async () => {
      if (!pendingDuel || pendingDuel.player !== target) return;
      pendingDuel = null;
      logS(`[PvP] ${target} không trả lời → sợ`);
      const r = await getAI(`${target} im lặng không dám đấu PvP`, `Bot Minecraft chê người sợ đấu, 1 câu ngắn tiếng Việt.`);
      bot.chat(r || `${target} bạn sợ à? Hèn vậy!`);
    }, 30000),
  };
}

// skipCountdown=true khi caller đã tự đếm rồi (tránh đếm 2 lần)
async function startDuel(playerName, skipCountdown = false) {
  cancelActiveDuel();
  logS(`[PvP] ${playerName} chấp nhận đấu!`);

  // Trang bị kiếm + khiên; cảnh báo nếu đang mặc elytra (dễ bị one-shot)
    const torsoSlot = bot.inventory.slots[6];
    if (torsoSlot && torsoSlot.name === 'elytra') {
      bot.chat('⚠ Đang mặc Elytra! Đổi giáp ngực để không bị one-shot...');
      await equipBestArmor(); // tự đổi nếu có giáp trong túi
    }
    await equipCombatLoadout();

  if (!skipCountdown) {
    const startMsg = await getAI(`${playerName} chấp nhận đấu PvP 1v1`, `Bot Minecraft tự cao, hứa thắng, 1 câu ngắn tiếng Việt.`);
    bot.chat(startMsg || `${playerName} dũng cảm đấy! Tao sẽ không thương tình!`);

    // Đếm ngược 3-2-1 trước khi bắt đầu (chạy tới vị trí địch + countdown)
    await new Promise(r => setTimeout(r, 800));
    bot.chat('3...');
    // Bắt đầu chạy tới địch trong lúc đếm
    const targetEntityEarly = bot.players[playerName]?.entity;
    if (targetEntityEarly) {
      try { bot.pathfinder.setGoal(new GoalNear(targetEntityEarly.position.x, targetEntityEarly.position.y, targetEntityEarly.position.z, 3), true); } catch(_){}
    }
    await new Promise(r => setTimeout(r, 1000));
    bot.chat('2...');
    await new Promise(r => setTimeout(r, 1000));
    bot.chat('1... ⚔️ Bắt đầu!');
    await new Promise(r => setTimeout(r, 300));
  } else {
    // Caller đã đếm + chat rồi, chỉ cần chạy tới địch
    const targetEntityEarly = bot.players[playerName]?.entity;
    if (targetEntityEarly) {
      try { bot.pathfinder.setGoal(new GoalNear(targetEntityEarly.position.x, targetEntityEarly.position.y, targetEntityEarly.position.z, 3), true); } catch(_){}
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Hàm lấy entity của đối thủ
  const getTarget = () => bot.players[playerName]?.entity || null;

  // Bắt đầu tấn công
  let pe = getTarget();
  if (pe) {
    try { bot.pvp.attack(pe); } catch(e) { logW('pvp.attack: ' + e.message); }
  }

  // Interval theo dõi + tái tấn công + counter elytra/mace + flee + water + pearl
  let shieldRaised = false;
  let lastWaterPlace   = 0;  // cooldown đặt nước (ms)
  let lastPearlThrow   = 0;  // cooldown pearl (ms)
  let lastBowShot      = 0;  // cooldown bắn cung (ms)
  let lastElyraDive    = 0;  // cooldown elytra+mace dive (ms) — 25s
  let lastTridentCombo = 0;  // cooldown trident+firework (ms) — 18s
  let isCombatFleeing = false; // flee state riêng cho duel
  let isTicking = false;   // guard chống interval chồng chéo

  const trackInterval = setInterval(async () => {
    if (!activeDuel) { clearInterval(trackInterval); return; }
    if (isTicking) return; // tick trước chưa xong, bỏ qua
    isTicking = true;
    try {
    const e = getTarget();
      if (!e) {
        // Địch biến mất khỏi entity list → thoát duel sau 5s
        if (!activeDuel._targetLostAt) activeDuel._targetLostAt = Date.now();
        if (Date.now() - activeDuel._targetLostAt > 5000) {
          cancelActiveDuel();
          try { bot.chat(`${playerName} đã biến mất, hủy duel!`); } catch(_){}
        }
        return;
      }
      if (activeDuel) activeDuel._targetLostAt = null; // reset khi thấy lại

      const myPos = bot.entity?.position;
    if (!myPos) return;
    const tPos      = e.position;
    const now       = Date.now();
    const heightDiff = tPos.y - myPos.y;
    const velY       = e.velocity?.y ?? 0;
    const hDist      = Math.sqrt((tPos.x-myPos.x)**2 + (tPos.z-myPos.z)**2);
    const dist3d     = myPos.distanceTo(tPos);
    const myHp       = bot.health ?? 20;

    // ══════════════════════════════════════════════════════════════
    // 1. YẾU MÁU (HP < 9 = 4.5 tim): CHẠY TRỐN + ĐẶT NƯỚC + ĂN
    // ══════════════════════════════════════════════════════════════
    if (myHp < 9) {
      if (!isCombatFleeing) {
        isCombatFleeing = true;
        try { bot.pvp.stop(); } catch(_){}
        logW(`[PvP] ⚠ HP thấp (${Math.round(myHp)}/20) → CHẠY TRỐN!`);
      }
      // Hướng chạy: ngược hướng địch
      const dx = myPos.x - tPos.x, dz = myPos.z - tPos.z;
      const len = Math.sqrt(dx*dx + dz*dz) || 1;
      const fleeX = myPos.x + dx/len * 22;
      const fleeZ = myPos.z + dz/len * 22;
      try { bot.pathfinder.setGoal(new GoalXZ(fleeX, fleeZ), true); } catch(_){}

      // Đặt xô nước mỗi 3s khi chạy trốn (làm chậm địch)
      if (now - lastWaterPlace > 3000) {
        const placed = await tryPlaceWaterBucket(tPos);
        if (placed) lastWaterPlace = now;
        else lastWaterPlace = now - 2500; // đặt thất bại → thử lại sau 500ms
      }

      // Ăn trong khi chạy trốn
      await autoEat();
      return;
    }

    // Đã hồi phục (HP >= 14): múc lại nước, trang bị, tiếp tục chiến
    if (isCombatFleeing && myHp >= 14) {
      isCombatFleeing = false;
      logS('[PvP] ✅ Đã hồi phục → múc nước + tiếp tục chiến!');
      await tryPickUpWater(); // múc lại water bucket nếu có
      try { await equipCombatLoadout(); } catch(_){}
    }
    if (isCombatFleeing) {
      // Vẫn đang flee, chờ hồi HP
      await autoEat();
      return;
    }

    // ══════════════════════════════════════════════════════════════
      // 1B. PHÁT HIỆN PROJECTILE (tên, cầu lửa) → giơ khiên
      // ══════════════════════════════════════════════════════════════
      {
        const myBB = bot.entity.position; // check entities flying toward bot
        const incomingProjectile = Object.values(bot.entities).find(ent => {
          if (!ent || !ent.position || !ent.velocity) return false;
          const isProjectile = ['arrow','spectral_arrow','snowball','egg','fireball','small_fireball'].includes(ent.name || '');
          if (!isProjectile) return false;
          const d = ent.position.distanceTo(myBB);
          if (d > 10) return false;
          // Kiểm tra projectile đang bay về hướng bot (dot product vận tốc với vector từ proj→bot < 0)
          const toBot = myBB.minus(ent.position).normalize();
          const velNorm = ent.velocity.clone().normalize();
          const dot = toBot.dot(velNorm);
          return dot > 0.6 && d < 6; // đang bay thẳng về phía bot, gần < 6m
        });
        if (incomingProjectile && !shieldRaised) {
          const shield2 = bot.inventory.slots.find(i => i && i.name === 'shield');
          if (shield2) {
            try { await bot.equip(shield2, 'off-hand'); bot.activateItem(false); shieldRaised = true; } catch(_){}
            setTimeout(() => {
              try { if (shieldRaised) { bot.deactivateItem(); shieldRaised = false; } } catch(_){}
            }, 600); // hạ khiên sau 600ms
          }
        }
      }

      // ══════════════════════════════════════════════════════════════
      // 2. PHÁT HIỆN MACE DIVE (địch từ cao lao xuống)
      // ══════════════════════════════════════════════════════════════
    const isMaceDive = heightDiff > 4 && velY < -0.25 && hDist < 5;
    if (isMaceDive) {
      logW(`[PvP] 💥 Mace dive! H=${Math.round(heightDiff)}m vy=${velY.toFixed(2)}`);
      const shield = bot.inventory.slots.find(i => i && i.name==='shield');
      if (shield) {
        try { await bot.equip(shield, 'off-hand'); bot.activateItem(false); shieldRaised = true; } catch(_){}
      }
      // Chạy vuông góc để tránh điểm tiếp đất
      const sideAngle = Math.atan2(myPos.x - tPos.x, myPos.z - tPos.z) + Math.PI / 2;
      try { bot.pathfinder.setGoal(new GoalXZ(myPos.x + Math.sin(sideAngle)*8, myPos.z + Math.cos(sideAngle)*8), true); } catch(_){}
      return;
    }

    // Hạ khiên sau khi nguy hiểm qua
    if (shieldRaised && heightDiff < 2) {
      try { bot.deactivateItem(); shieldRaised = false; await equipCombatLoadout(); } catch(_){}
    }

    // ══════════════════════════════════════════════════════════════
    // 3. ĐỊA ELYTRA BAY (cao + xa) → BẮN CUNG DỰ ĐOÁN HƯỚNG
    // ══════════════════════════════════════════════════════════════
    const isElytraFlying = heightDiff > 3 && hDist > 4;
    if (isElytraFlying) {
      if (now - lastBowShot > 1800) {
        const ranged = bot.inventory.items().find(i => i.name==='crossbow' || i.name==='bow');
        if (ranged) {
          // Dừng pvp trước khi bắn cung để tránh đánh thường bằng cung
          try { bot.pvp.stop(); } catch(_){}
          await shootBowWithLead(e, ranged);
          lastBowShot = now;
          return;
        }
      }
      return; // Không vũ khí tầm xa → chờ địch đáp
    }

    // ══════════════════════════════════════════════════════════════
    // 4A. ELYTRA + MACE — lao thẳng vào địch bằng pháo hoa
    //     Điều kiện: elytra + mace + pháo hoa trong túi,
    //     địch cách 6-28m, đứng trên đất, cooldown 25s,
    //     không có combo nào đang chạy (mutex)
    // ══════════════════════════════════════════════════════════════
    const hasElytra   = bot.inventory.items().some(i => i.name === 'elytra');
    const hasMace     = bot.inventory.items().some(i => i.name === 'mace');
    const hasFirework = bot.inventory.items().some(i => i.name === 'firework_rocket');
    if (!isDoingSpecialCombo && hasElytra && hasMace && hasFirework
        && dist3d >= 6 && dist3d <= 28
        && bot.entity.onGround && now - lastElyraDive > 25000) {
      logS(`[PvP] 🦅 Elytra+Mace+Pháo hoa (dist=${Math.round(dist3d)}m) → BAY VÀO!`);
      lastElyraDive = now;
      try { bot.pvp.stop(); } catch(_){}
      const diveOk = await elytraMaceDive(e);
      if (diveOk) return;
    }

    // ══════════════════════════════════════════════════════════════
    // 4B. TRIDENT + FIREWORK COMBO — gap close + ném giáo cực dính
    //     Điều kiện: elytra + trident + pháo hoa, địch > 8m,
    //     cooldown 18s, không có combo nào đang chạy (mutex)
    // ══════════════════════════════════════════════════════════════
    const hasTrident = bot.inventory.items().some(i => i.name === 'trident');
    if (!isDoingSpecialCombo && hasElytra && hasTrident && hasFirework && dist3d > 8
        && now - lastTridentCombo > 18000) {
      logS(`[PvP] 🚀 Trident+Firework (dist=${Math.round(dist3d)}m) → LAUNCH!`);
      lastTridentCombo = now;
      try { bot.pvp.stop(); } catch(_){}
      const comboOk = await tridentFireworkCombo(e);
      if (comboOk) return;
    }

    // ══════════════════════════════════════════════════════════════
    // 4C. ENDER PEARL: GAP CLOSE khi địch xa (> 12m, không chạy)
    // ══════════════════════════════════════════════════════════════
    if (dist3d > 12 && !shieldRaised && now - lastPearlThrow > 8000) {
      const threw = await throwEnderPearl(tPos);
      if (threw) { lastPearlThrow = now; return; }
    }

    // ══════════════════════════════════════════════════════════════
    // 5. TẦM XA (> 6m): BẮN CUNG VỚI DỰ ĐOÁN HƯỚNG
    //    → Dừng pvp trước khi bắn, tránh đánh thường bằng cung
    // ══════════════════════════════════════════════════════════════
    if (hDist > 6) {
      // Nếu pvp đang chạy với vũ khí là cung → dừng ngay
      try { if (bot.pvp.target) bot.pvp.stop(); } catch(_){}
      if (now - lastBowShot > 1800) {
        const ranged = bot.inventory.items().find(i => i.name==='crossbow' || i.name==='bow');
        if (ranged) {
          await shootBowWithLead(e, ranged);
          lastBowShot = now;
          return;
        }
      } else {
        // Trong cooldown cung: tiến lại gần địch để sẵn sàng cận chiến
        try { bot.pathfinder.setGoal(new GoalNear(tPos.x, tPos.y, tPos.z, 3), true); } catch(_){}
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 6. CẬN CHIẾN PRO (< 6m): kiếm + jump crit + w-tap + strafe
    // ══════════════════════════════════════════════════════════════
    // Đảm bảo cầm kiếm (không cầm cung)
    const heldItem = bot.heldItem;
    const holdingRanged = heldItem && (heldItem.name === 'bow' || heldItem.name === 'crossbow');
    if (holdingRanged || !bot.pvp.target || bot.pvp.target.id !== e.id) {
      await equipBestWeapon();
      try { bot.pvp.attack(e); } catch(err) {}
    }

    // ── JUMP CRITICAL HIT ─────────────────────────────────────────
    // Nhảy lên chém khi đang đứng yên trên đất, địch trong tầm đánh
    // Critical hit = hit khi đang rơi xuống (velY < 0) + không sprint
    const onGround = bot.entity.onGround;
    const myVelY   = bot.entity.velocity?.y ?? 0;
    const inMeleeRange = hDist < 3.5;
    const canJumpCrit  = onGround && inMeleeRange && now - (bot._lastJumpCrit || 0) > 600;
    if (canJumpCrit) {
      bot._lastJumpCrit = now;
      // W-tap: dừng sprint 1 tick để reset knockback, sau đó nhảy + đánh
      bot.setControlState('sprint', false);
      await new Promise(r => setTimeout(r, 50));
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      await new Promise(r => setTimeout(r, 100));
      bot.setControlState('jump', false);
      // Đợi lên đỉnh rồi rơi xuống (velY sẽ < 0) → crit window
      await new Promise(r => setTimeout(r, 180));
    }

    // ── SMART COMBO: HP địch < 6♥ → rush thẳng, skip strafe ─────────
    const isRushing = applySmartCombat(e);

    // ── STRAFING: xoay tròn quanh địch để tránh đòn ────────────────
    // Mỗi 1.2s đổi hướng chạy ngang (left/right) để khó bị hit
    // Bỏ qua khi đang rush (HP địch thấp)
    if (!isRushing) {
      const now2 = Date.now();
      if (!bot._strafeState) bot._strafeState = { dir: 'left', at: 0, angle: 0 };
      if (now2 - bot._strafeState.at > 900) {
        // Circle strafe: tính góc quanh địch, mỗi tick xoay thêm ~45°
        bot._strafeState.angle = (bot._strafeState.angle + 45) % 360;
        const rad = (bot._strafeState.angle * Math.PI) / 180;
        const RADIUS = 3.0; // bán kính circle strafe (block)
        const strafeX = e.position.x + Math.cos(rad) * RADIUS;
        const strafeZ = e.position.z + Math.sin(rad) * RADIUS;
        try { bot.pathfinder.setGoal(new GoalXZ(strafeX, strafeZ), true); } catch(_){}
        // Vẫn duy trì sprint để giữ tốc độ
        bot.setControlState('sprint', true);
        bot._strafeState.at = now2;
        // Reset left/right (pathfinder đang dẫn đường)
        bot.setControlState('left', false);
        bot.setControlState('right', false);
      }
      } // end !isRushing
    } catch(_) {} finally { isTicking = false; }
  }, 400);

  // Thua: bot chết
  const deathHandler = async () => {
    clearInterval(trackInterval);
    if (!activeDuel || activeDuel.player !== playerName) return;
    cancelActiveDuel();
    logS(`[PvP] Bot thua ${playerName}`);
    const r = await getAI(`Bot Minecraft vừa thua PvP với ${playerName}`, `Nhận thua, kêu ăn may, hứa trả thù, 1 câu tiếng Việt.`);
    bot.chat(r || `${playerName} gg! Lần sau tao sẽ khác, đợi đó!`);
  };
  bot.once('death', deathHandler);

  // Thắng: đối thủ chết — dùng entityDead event (chính xác hơn parse chat)
  const winHandler = (entity) => {
    if (!activeDuel || activeDuel.player !== playerName) return;
    if (entity.username !== playerName) return; // không phải đối thủ đang đấu
    cancelActiveDuel();
    logS(`[PvP] ${playerName} chết → THẮNG!`);
    getAI(`Bot Minecraft vừa thắng PvP, đối thủ ${playerName} chết`, `Trêu chọc đối thủ thua, 1 câu tiếng Việt.`)
      .then(r => { try { bot.chat(r || `${playerName} haha mày yếu thế! Đi luyện thêm đi!`); } catch(e){} });
  };
  bot.on('entityDead', winHandler);

  // Timeout 3 phút → hòa
  const fightTimeout = setTimeout(() => {
    if (!activeDuel || activeDuel.player !== playerName) return;
    cancelActiveDuel();
    logS(`[PvP] Hết 3 phút đấu với ${playerName} → hòa`);
    try { bot.chat(`${playerName} tạm thời hòa! Lần sau quyết liệt hơn!`); } catch(e){}
  }, 3 * 60 * 1000);

  activeDuel = { player: playerName, fightTimeout, trackInterval, deathHandler, winHandler };
  logS(`[PvP] Đang chiến đấu với ${playerName} ⚔️`);
}

function startPvpChallengeTimer() {
  if (pvpChallengeInterval) clearInterval(pvpChallengeInterval);
  pvpChallengeInterval = setInterval(sendPvpChallenge, PVP_INTERVAL_MS);
}

// ── SERVER PING (kiểm tra trạng thái trước khi kết nối) ──────────
const mc = require('minecraft-protocol');

function stopPingLoop() {
  if (pingLoopInterval) { clearInterval(pingLoopInterval); pingLoopInterval = null; }
}

function pingServerStatus() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ state: 'timeout' }), 6000);
    try {
      mc.ping({ host: CONFIG.host, port: CONFIG.port, closeTimeout: 6000 }, (err, res) => {
        clearTimeout(timer);
        if (err) {
          const code = err.code || '';
          // ECONNREFUSED / ENOTFOUND = server thực sự offline
          if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') resolve({ state: 'offline' });
          else resolve({ state: 'timeout' });
          return;
        }
        // Lấy text MOTD
        let desc = '';
        try {
          if (typeof res.description === 'string') desc = res.description;
          else if (res.description?.text) desc = res.description.text;
          else if (res.description?.extra) desc = res.description.extra.map(e => e.text||'').join('');
          else desc = JSON.stringify(res.description || '');
        } catch(_) {}
        const d = desc.toLowerCase();
        // Aternos "preparing / starting / waking"
        if (/starting|preparing|loading|waking|hibernat|please wait|đang khởi|đang tải/.test(d)) {
          resolve({ state: 'starting', desc, players: res.players });
        } else {
          resolve({ state: 'online', desc, players: res.players });
        }
      });
    } catch(e) { clearTimeout(timer); resolve({ state: 'timeout' }); }
  });
}

// Hàm chuyển trạng thái ping sang ping 30s (dùng lại khi phát hiện "starting")
function startSlowPingLoop() {
  stopPingLoop();
  logW(`[PING] Server đang khởi động — ping lại mỗi 30s...`);
  pingLoopInterval = setInterval(async () => {
    const r = await pingServerStatus();
    if (r.state === 'offline') {
      stopPingLoop(); isRejoining = false;
      logW(`[PING] Server offline → dừng tự kết nối`);
    } else if (r.state === 'online') {
      stopPingLoop();
      logJ(`[PING] ✅ Server ONLINE! ${r.players?.online??0}/${r.players?.max??0} người — kết nối ngay!`);
      isRejoining = false; createBot();
    } else {
      logS(`[PING] Vẫn đang khởi động... (${r.desc?.slice(0,60)||r.state})`);
    }
  }, 30000);
}

// Entry point: ping liên tục rồi quyết định kết nối hay không
async function waitForServerThenConnect() {
  stopPingLoop();
  logS(`[PING] Kiểm tra trạng thái server...`);
  const first = await pingServerStatus();

  if (first.state === 'offline') {
    logW(`[PING] Server offline → dừng tự kết nối. Start bot thủ công khi server bật.`);
    isRejoining = false; return;
  }
  if (first.state === 'online') {
    logJ(`[PING] ✅ Server ONLINE! ${first.players?.online??0}/${first.players?.max??0} người — kết nối ngay!`);
    isRejoining = false; createBot(); return;
  }
  if (first.state === 'starting') {
    startSlowPingLoop(); return;
  }

  // timeout → ping nhanh mỗi 2s (vô hạn) cho đến khi server phản hồi
  logS(`[PING] Server chưa phản hồi — ping mỗi 2s...`);
  pingLoopInterval = setInterval(async () => {
    const r = await pingServerStatus();
    if (r.state === 'offline') {
      stopPingLoop(); isRejoining = false;
      logW(`[PING] Server offline → dừng`);
    } else if (r.state === 'online') {
      stopPingLoop();
      logJ(`[PING] ✅ Server ONLINE! ${r.players?.online??0}/${r.players?.max??0} người — kết nối!`);
      isRejoining = false; createBot();
    } else if (r.state === 'starting') {
      stopPingLoop();
      startSlowPingLoop();
    }
    // state === 'timeout': tiếp tục ping 2s
  }, 2000);
}

// ── REJOIN ────────────────────────────────────────────────────────
function handleRejoin() {
  if (isRejoining) return; isRejoining = true;
  botOnline = false;
  if (spawnTimeout) { clearTimeout(spawnTimeout); spawnTimeout = null; }
  if (spawnWaitInterval) { clearInterval(spawnWaitInterval); spawnWaitInterval = null; }
  stopPingLoop();
  mcData = null;
  if (armorInterval) { clearInterval(armorInterval); armorInterval=null; }
  if (eatInterval)   { clearInterval(eatInterval);   eatInterval=null; }
  if (pvpChallengeInterval) { clearInterval(pvpChallengeInterval); pvpChallengeInterval=null; }
  if (invCheckInterval)    { clearInterval(invCheckInterval);    invCheckInterval=null; }
  if (statusBarInterval)   { clearInterval(statusBarInterval);   statusBarInterval=null; }
  if (huntInterval)        { clearInterval(huntInterval);        huntInterval=null; isHunting=false; }
  if (pendingDuel) { clearTimeout(pendingDuel.timeout); pendingDuel=null; }
  isDoingSpecialCombo = false; // reset PvP combo mutex khi disconnect
  cancelActiveDuel();
  stopAutoAttack(); stopAutoHunt(); resetState();
  try {
    if (bot) {
      bot.removeAllListeners();
      try { bot._client.end('disconnect.quitting'); } catch(e){}
      try { bot.end(); } catch(e){}
    }
  } catch(e){}
  bot = null;
  logW(`Mất kết nối — bắt đầu ping server để chờ sẵn sàng...`);
  // Chờ 1s rồi bắt đầu ping (tránh flood ngay sau disconnect)
  setTimeout(() => waitForServerThenConnect(), 1000);
}

// ── GEMINI API KEY PERSISTENCE ────────────────────────────────────
const GEMINI_KEY_FILE     = 'gemini_key.json';
const AI_DECISION_KEY_FILE = 'ai_decision_key.json';
function loadAIDecisionKeyFromFile() {
  try {
    if (fs.existsSync(AI_DECISION_KEY_FILE)) {
      const data = JSON.parse(fs.readFileSync(AI_DECISION_KEY_FILE, 'utf8'));
      if (data && data.key) return data.key;
    }
  } catch(e) {}
  return '';
}
function saveAIDecisionKeyToFile(key) {
  try { fs.writeFileSync(AI_DECISION_KEY_FILE, JSON.stringify({ key }), { encoding: 'utf8', mode: 0o600 }); } catch(e) {}
}
function loadGeminiKeyFromFile() {
  try {
    if (fs.existsSync(GEMINI_KEY_FILE)) {
      const data = JSON.parse(fs.readFileSync(GEMINI_KEY_FILE, 'utf8'));
      if (data && data.key) return data.key;
    }
  } catch(e) {}
  return '';
}
function saveGeminiKeyToFile(key) {
  try { fs.writeFileSync(GEMINI_KEY_FILE, JSON.stringify({ key }), { encoding: 'utf8', mode: 0o600 }); } catch(e) {}
}
// Nếu chưa có key từ env, thử load từ file đã lưu
if (!CONFIG.geminiApiKey) {
  CONFIG.geminiApiKey = loadGeminiKeyFromFile();
}
if (!CONFIG.aiDecisionKey) {
  CONFIG.aiDecisionKey = loadAIDecisionKeyFromFile();
}

// ── DISCORD WEBHOOK URL (module-level so config can update it) ─────────────────
const WEBHOOK_CONFIG_FILE = 'webhook.json';
function loadWebhookFromFile() {
  try {
    if (fs.existsSync(WEBHOOK_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(WEBHOOK_CONFIG_FILE, 'utf8'));
      if (data && data.url) return data.url;
    }
  } catch(e) {}
  return '';
}
function saveWebhookToFile(url) {
  try { fs.writeFileSync(WEBHOOK_CONFIG_FILE, JSON.stringify({ url }), { encoding: 'utf8', mode: 0o600 }); } catch(e) {}
}
let DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK || loadWebhookFromFile();
// Status dedup: chỉ emit khi có gì thực sự thay đổi
let _lastStatusHash = '';
// Periodic Discord status: gửi mỗi 30 phút
let _discordStatusInterval = null;
function startDiscordStatusInterval() {
  if (_discordStatusInterval) clearInterval(_discordStatusInterval);
  _discordStatusInterval = setInterval(() => {
    if (DISCORD_WEBHOOK_URL && botOnline) { try { sendDiscordStatus(); } catch(e) {} }
  }, 30 * 60 * 1000);
}

// ── DISCORD HELPER FUNCTIONS (module-level) ──────────────────────────────────

// Màu Discord chính thức theo loại sự kiện
const DISCORD_COLORS = {
  online:  0x57F287, // Discord Green
  success: 0x57F287,
  error:   0xED4245, // Discord Red
  warn:    0xFEE75C, // Discord Yellow
  info:    0x5865F2, // Discord Blurple
  death:   0xEB459E, // Discord Fuchsia
  pvp:     0xFEE75C,
  status:  0x5865F2,
  offline: 0x747F8D, // Discord Grey
};

// Tạo thanh tiến trình ASCII (10 ký tự)
function makeBar(val, max) {
  const pct = Math.max(0, Math.min(1, val / (max || 1)));
  const filled = Math.round(pct * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// Icon cho các item phổ biến trong Minecraft
const ITEM_ICONS = {
  'Diamond':'💎','Emerald':'💚','Gold Ingot':'🟡','Iron Ingot':'⬜',
  'Netherite Ingot':'🔳','Coal':'🪨','Log':'🪵','Wood':'🪵','Planks':'🪵',
  'Cobblestone':'🧱','Stone':'🧱','Sand':'🏜️','Dirt':'🟫','Gravel':'🪨',
  'Wheat':'🌾','Carrot':'🥕','Potato':'🥔','Sugar Cane':'🎋','Bamboo':'🎍',
  'Cactus':'🌵','Nether Wart':'🍄','Pumpkin':'🎃','Melon':'🍈',
  'Apple':'🍎','Bread':'🍞','Cooked Beef':'🥩','Rotten Flesh':'🧟',
  'Bone':'🦴','Arrow':'🏹','String':'🕸️','Gunpowder':'💥','Feather':'🪶',
  'Leather':'🟤','Beef':'🥩','Chicken':'🍗','Mutton':'🍖','Porkchop':'🥩',
  'Salmon':'🐟','Cod':'🐟','Tropical Fish':'🐠','Ink Sac':'🦑',
  'Potion':'🧪','Bucket':'🪣','Torch':'🔦','Chest':'📦',
  'Sword':'⚔️','Pickaxe':'⛏️','Axe':'🪓','Shovel':'🪚','Hoe':'🌱',
  'Shield':'🛡️','Bow':'🏹','Helmet':'⛑️','Chestplate':'🦺',
  'Leggings':'👖','Boots':'👢','Elytra':'🪂','Totem':'🗿',
  'Blaze Rod':'🔥','Ender Pearl':'💜','Eye of Ender':'👁️',
  'Obsidian':'⬛','Glass':'🪟','Book':'📖','Map':'🗺️','Compass':'🧭',
};
function getItemIcon(displayName) {
  const dn = (displayName || '').toLowerCase();
  for (const [key, icon] of Object.entries(ITEM_ICONS)) {
    if (dn.includes(key.toLowerCase())) return icon;
  }
  return '📦';
}

// Fields HP + Food dạng thanh tiến trình
function getVitalFields() {
  if (!bot || !botOnline) return [];
  try {
    const hp   = Math.round(bot.health ?? 0);
    const food = Math.round(bot.food ?? 0);
    const hpEmoji   = hp > 14 ? '❤️' : hp > 7 ? '🧡' : '💔';
    const foodEmoji = food > 14 ? '🍖' : food > 7 ? '🥩' : '🍂';
    return [{
      name: `${hpEmoji} HP  ·  ${foodEmoji} Đói`,
      value: `\`${makeBar(hp,20)}\` **${hp}**/20\n\`${makeBar(food,20)}\` **${food}**/20`,
      inline: true,
    }];
  } catch(e) { return []; }
}

// Fields vị trí + task hiện tại
function getStatusFields() {
  if (!bot || !botOnline) return [];
  const fields = [];
  try {
    const p = bot.entity?.position;
    if (p) fields.push({
      name: '📍 Vị trí',
      value: `\`${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}\``,
      inline: true,
    });
    const task = bot._task || 'idle';
    const taskIcon = { 'idle':'😴','wandering':'🚶','chặt gỗ':'🪓','đào đá':'⛏️',
      'đào quặng':'⛏️','strip mine':'⛏️','làm nông':'🌾','câu cá':'🎣',
      'ngủ':'💤','farm mía':'🎋','mob farm':'⚔️','tuần tra':'🗺️',
      'pha thuốc':'🧪','về nhà':'🏠','chiến đấu':'⚔️',
      'đào hầm':'⛏️','đào mạch':'💎','khám phá':'🗺️','lên mặt đất':'⬆️' }[task] || '⚙️';
    fields.push({ name: `${taskIcon} Task`, value: `\`${task}\``, inline: true });
  } catch(e) {}
  return fields;
}

// Kho đồ đẹp với icon
function getInventoryFields() {
  if (!bot || !botOnline) return [];
  try {
    const items = bot.inventory.items();
    if (!items.length) return [{ name: '🎒 Kho đồ', value: '`[ trống ]`', inline: false }];
    const grouped = {};
    for (const it of items) {
      const key = it.displayName || it.name;
      grouped[key] = (grouped[key] || 0) + it.count;
    }
    const sorted = Object.entries(grouped).sort((a,b) => b[1]-a[1]);
    const totalTypes = sorted.length;
    const totalCount = sorted.reduce((s,[,c]) => s+c, 0);
    const top = sorted.slice(0, 18);
    const lines = top.map(([name, cnt]) => `${getItemIcon(name)} **${name}** × ${cnt}`);
    if (sorted.length > 18) lines.push(`*... và ${sorted.length - 18} loại khác*`);
    // Tách chunk ≤1024 ký tự
    const chunks = [];
    let cur = '';
    for (const l of lines) {
      if ((cur + l + '\n').length > 1020) { chunks.push(cur.trim()); cur = ''; }
      cur += l + '\n';
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks.map((v, i) => ({
      name: i === 0 ? `🎒 Kho đồ — ${totalTypes} loại · ${totalCount} item` : '🎒 Kho đồ (tiếp)',
      value: v,
      inline: false,
    }));
  } catch(e) { return []; }
}

// ── Gửi alert embed lên Discord ──────────────────────────────────────────────
async function sendDiscordAlert(content, opts = {}) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const color = typeof opts.color === 'number'
      ? opts.color
      : (DISCORD_COLORS[opts.color] ?? DISCORD_COLORS.info);
    const avatarUrl = 'https://mc-heads.net/avatar/' + encodeURIComponent(CONFIG.username) + '/64';

    const fields = [
      ...getVitalFields(),
      ...getStatusFields(),
    ];
    if (opts.extraFields) fields.push(...opts.extraFields);

    const embed = {
      color,
      author: {
        name: opts.title || `3D2Y Bot — ${CONFIG.username}`,
        icon_url: avatarUrl,
      },
      description: content,
      fields,
      footer: {
        text: `🌐 ${CONFIG.host}:${CONFIG.port}  ·  3D2Y Bot`,
        icon_url: avatarUrl,
      },
      timestamp: new Date().toISOString(),
    };

    await fetchFn(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `${CONFIG.username} · 3D2Y`,
        avatar_url: avatarUrl,
        embeds: [embed],
      }),
    });
  } catch(e) { logW('[Discord] ' + e.message); }
}

// ── Gửi status embed tổng quan ────────────────────────────────────────────────
async function sendDiscordStatus() {
  if (!DISCORD_WEBHOOK_URL || !bot || !botOnline) return;
  try {
    const avatarUrl = 'https://mc-heads.net/avatar/' + encodeURIComponent(CONFIG.username) + '/64';
    const p   = bot.entity?.position;
    const pos = p ? `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}` : 'N/A';
    const up  = Math.round((Date.now() - activityStats.startTime) / 1000);
    const hh  = String(Math.floor(up/3600)).padStart(2,'0');
    const mm  = String(Math.floor((up%3600)/60)).padStart(2,'0');
    const ss  = String(up%60).padStart(2,'0');
    const hp   = Math.round(bot.health ?? 0);
    const food = Math.round(bot.food ?? 0);
    const hpEmoji   = hp > 14 ? '❤️' : hp > 7 ? '🧡' : '💔';
    const foodEmoji = food > 14 ? '🍖' : food > 7 ? '🥩' : '🍂';
    const task = bot._task || 'idle';
    const taskIcon = { 'idle':'😴','wandering':'🚶','chặt gỗ':'🪓','đào đá':'⛏️',
      'đào quặng':'⛏️','strip mine':'⛏️','làm nông':'🌾','câu cá':'🎣',
      'ngủ':'💤','mob farm':'⚔️','tuần tra':'🗺️','pha thuốc':'🧪',
      'về nhà':'🏠','chiến đấu':'⚔️',
      'đào hầm':'⛏️','đào mạch':'💎','khám phá':'🗺️','lên mặt đất':'⬆️' }[task] || '⚙️';
    // Kho đồ đầy đủ (tối đa 18 loại, chia chunk nếu quá dài)
    let invSummary = '`[ trống ]`';
    let invExtraFields = [];
    try {
      const items = bot.inventory.items();
      if (items.length) {
        const g = {};
        for (const it of items) { const k=it.displayName||it.name; g[k]=(g[k]||0)+it.count; }
        const sorted = Object.entries(g).sort((a,b)=>b[1]-a[1]);
        const top = sorted.slice(0, 18);
        const lines = top.map(([n,c])=>`${getItemIcon(n)} **${n}** ×${c}`);
        const rest = sorted.length - 18;
        if (rest > 0) lines.push(`*... và ${rest} loại khác*`);
        // Chia thành chunk ≤1024 ký tự cho Discord
        const chunks = [];
        let cur = '';
        for (const l of lines) {
          if ((cur + l + '\n').length > 1020) { chunks.push(cur.trim()); cur = ''; }
          cur += l + '\n';
        }
        if (cur.trim()) chunks.push(cur.trim());
        invSummary = chunks[0] || '`[ trống ]`';
        // Chunk 2+ sẽ thêm vào extraFields
        for (let i = 1; i < chunks.length; i++) {
          invExtraFields.push({ name: '🎒 Kho đồ (tiếp)', value: chunks[i], inline: false });
        }
      }
    } catch(e){}

    const embed = {
      color: DISCORD_COLORS.status,
      author: {
        name: `${CONFIG.username}  ·  🟢 Đang Online`,
        icon_url: avatarUrl,
      },
      title: '📊 Bot Status Report',
      description: `> 🌐 \`${CONFIG.host}:${CONFIG.port}\`  ·  ⏱️ Uptime **${hh}:${mm}:${ss}**`,
      fields: [
        {
          name: `${hpEmoji} HP  ·  ${foodEmoji} Food`,
          value: `\`${makeBar(hp,20)}\` ${hp}/20\n\`${makeBar(food,20)}\` ${food}/20`,
          inline: true,
        },
        {
          name: '📍 Vị trí',
          value: `\`${pos}\``,
          inline: true,
        },
        {
          name: `${taskIcon} Task`,
          value: `\`${task}\``,
          inline: true,
        },
        {
          name: '📈 Thống kê phiên',
          value: [
            `⛏️ Block đào: **${activityStats.blocksMinedTotal}**`,
            `🪵 Gỗ chặt: **${activityStats.woodChopped}**`,
            `🐟 Cá câu: **${activityStats.fishCaught}**`,
            `⚔️ Mob diệt: **${activityStats.mobsKilled}**`,
            `🌾 Cây thu: **${activityStats.cropHarvested||0}**`,
            `🧪 Thuốc pha: **${activityStats.potionsBrewed||0}**`,
          ].join('  ·  '),
          inline: false,
        },
        {
          name: '🎒 Kho đồ',
          value: invSummary,
          inline: false,
        },
        ...invExtraFields,
      ],
      thumbnail: { url: avatarUrl },
      footer: {
        text: `3D2Y Bot  ·  "status discord" để gửi lại  ·  Tự động mỗi 30 phút`,
        icon_url: avatarUrl,
      },
      timestamp: new Date().toISOString(),
    };

    await fetchFn(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `${CONFIG.username} · 3D2Y`,
        avatar_url: avatarUrl,
        embeds: [embed],
      }),
    });
  } catch(e) { logW('[Discord status] ' + e.message); }
}

// ── ACTIVITY STATS & LOG (module-level) ──────────────────────────────────────
const activityStats = {
  startTime: Date.now(),
  blocksMinedTotal: 0,
  woodChopped: 0,
  fishCaught: 0,
  mobsKilled: 0,
  itemsLooted: 0,
  potionsBrewed: 0,
  waypointsVisited: 0,
  returnedToBase: 0,
  cropHarvested: 0,
  specialCropHarvested: 0,
};
const activityLog = [];
function logActivity(event) {
  const entry = { time: Date.now(), text: event };
  activityLog.push(entry);
  if (activityLog.length > 500) activityLog.shift();
  if (typeof checkDiscordAlert === 'function') checkDiscordAlert(event);
}

// ── BOT INIT ──────────────────────────────────────────────────────
function createBot() {
  try {
    logS(`Đang kết nối → ${C.mint}${CONFIG.host}:${CONFIG.port}${C.reset} | user: ${C.green}${CONFIG.username}${C.reset} | version: ${CONFIG.version}`);
    bot = mineflayer.createBot({ host:CONFIG.host, port:CONFIG.port, username:CONFIG.username, version:CONFIG.version, auth:'offline', hideErrors: false });
    bot._task = 'connecting';
    bot.loadPlugin(pathfinder); bot.loadPlugin(collectBlock); bot.loadPlugin(pvp);

    // Xác nhận kết nối TCP + auth thành công (trước khi vào thế giới)
    bot._client.once('login', () => {
      logJ(`Xác thực thành công! Đang tải thế giới...`);
    });

    // Helper gọi 1 lần khi bất kỳ sự kiện nào xác nhận "đã vào thế giới"
    let worldEntryDone = false;
    function onWorldEntry(src) {
      if (worldEntryDone) return;
      worldEntryDone = true;
      clearTimeout(spawnTimeout);
      if (spawnWaitInterval) { clearInterval(spawnWaitInterval); spawnWaitInterval = null; }
      botOnline = true;
      _lastStatusHash = ''; // reset dedup → emit ngay lần đầu sau spawn
      logJ(`Bot đã vào thế giới (${src})!`);
      // Discord: thông báo bot online + bắt đầu gửi status định kỳ
      setTimeout(() => {
        if (DISCORD_WEBHOOK_URL) {
          sendDiscordAlert('✅ Bot đã kết nối và vào thế giới!', {
            color: 'success',
            title: `🟢 ${CONFIG.username} — ONLINE`,
            extraFields: [{ name: '🌐 Server', value: `${CONFIG.host}:${CONFIG.port}`, inline: true }],
          });
          setTimeout(() => sendDiscordStatus(), 3000);
        }
        startDiscordStatusInterval();
      }, 1500);
      if (!mcData) { mcData = mcDataLoader(bot.version); refreshMovements(); rejoinAttempts = 0; isStandingStill = false; startWander(); }
    }

    // Log 1 lần khi bắt đầu chờ, sau đó chỉ nhắc mỗi 60s (không spam)
    logS(`Đã kết nối TCP — đang chờ server gửi dữ liệu thế giới...`);
    let spawnWaitSecs = 0;
    if (spawnWaitInterval) clearInterval(spawnWaitInterval);
    spawnWaitInterval = setInterval(() => {
      if (botOnline) { clearInterval(spawnWaitInterval); spawnWaitInterval = null; return; }
      spawnWaitSecs += 60;
      logS(`Vẫn đang chờ spawn... (${spawnWaitSecs}s) — mạng Replit→Aternos có thể chậm hơn máy bạn`);
    }, 60000);

    // Timeout 8 phút — cho đủ thời gian khi mạng chậm
    spawnTimeout = setTimeout(() => {
      if (!botOnline) {
        if (spawnWaitInterval) { clearInterval(spawnWaitInterval); spawnWaitInterval = null; }
        logW('Chờ spawn quá 8 phút — thử rejoin...');
        handleRejoin();
      }
    }, 480000);

    // forcedMove: một số server (proxy/Aternos) gửi cái này thay vì spawn
    bot.on('forcedMove', () => {
      onWorldEntry('forcedMove');
      if (!mcData) { mcData=mcDataLoader(bot.version); refreshMovements(); rejoinAttempts=0; isStandingStill=false; startWander(); }
    });
    // chunkColumnLoad: chunk đầu tiên tải = chắc chắn đang trong thế giới
    bot.once('chunkColumnLoad', () => { onWorldEntry('chunk'); });
    // health: nhận HP = trong thế giới
    bot.once('health', () => { onWorldEntry('health'); });

    bot.once('spawn', () => {
      onWorldEntry('spawn');
      rejoinAttempts=0;
      if (armorInterval) clearInterval(armorInterval);
      armorInterval = setInterval(()=>equipBestArmor(), 12000);
      if (eatInterval) clearInterval(eatInterval);
      eatInterval = setInterval(()=>autoEat(), 2000);
      startAutoAttack();
      startAutoHunt();
      // ── Global jump assist — chạy cho MỌI movement task, không chỉ follow
      // Tự nhảy qua block 1 tầng và slab/địa hình dốc
      setTimeout(() => startJumpAssist(), 2000);
      startPvpChallengeTimer();
      if (statusBarInterval) clearInterval(statusBarInterval);
      statusBarInterval = setInterval(printStatusBar, 30000);
      if (invCheckInterval) clearInterval(invCheckInterval);
      invCheckInterval = setInterval(async () => {
        if (!bot || !mcData || isBusy || isFollowing || _autoReturning) return;
        if (isInventoryFull()) {
          _autoReturning = true;
          try {
            logS('🎒 Túi gần đầy! Tự động đi cất đồ...');
            await depositToChest('[Auto]');
          } finally { _autoReturning = false; }
        }
      }, 30000);
      bot.on('startedDigging', async (block) => { try { await equipToolForBlock(block); } catch(e){} });

      // ── WATER CLUTCH DETECTOR ─────────────────────────────────────────
      // Mỗi physicsTick (~50ms): theo dõi tốc độ rơi và kích clutch khi cần
      bot.on('physicsTick', () => {
        if (!bot?.entity || _waterClutchActive) return;
        const vel = bot.entity.velocity;
        const onGround = bot.entity.onGround;
        const pos = bot.entity.position;

        if (onGround) {
          // Chạm đất: reset theo dõi
          _clutchFallStartY = null;
          _clutchGroundY    = null;
          _waterClutchFalling = false;
          return;
        }

        // Chưa rơi đủ nhanh → chưa kích clutch
        if (!vel || vel.y > -0.3) {
          if (vel && vel.y >= 0) _clutchFallStartY = pos.y; // đang đi lên → ghi lại Y đỉnh
          return;
        }

        // Đang rơi: tính chiều cao rơi tới mặt đất
        if (_clutchFallStartY === null) _clutchFallStartY = pos.y;
        const fallSoFar = _clutchFallStartY - pos.y;
        if (fallSoFar < 4) return; // < 4 block: không cần clutch

        // Tìm mặt đất bên dưới (cache mỗi 5 tick để tiết kiệm)
        if (_clutchGroundY === null) {
          let gy = pos.y;
          for (let dy = 1; dy <= 60; dy++) {
            const b = bot.blockAt(pos.offset(0, -dy, 0));
            if (b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && b.boundingBox !== 'empty') {
              gy = pos.y - dy;
              break;
            }
          }
          _clutchGroundY = gy;
        }

        const distToGround = pos.y - _clutchGroundY;

        // Điều kiện kích clutch:
        // - Còn đủ xa (≥ 2 block) để nước kịp đặt nhưng đủ gần (≤ 7 block)
        // - Rơi tổng ≥ 5 block (đáng để clutch, bật trong MỌI context kể cả PvP)
        // - Có water_bucket trong túi
        const shouldClutch =
          distToGround >= 2 && distToGround <= 7 &&
          fallSoFar >= 5 &&
          bot.inventory.items().some(i => i.name === 'water_bucket');

        if (shouldClutch && !_waterClutchFalling) {
          _waterClutchFalling = true; // chỉ trigger 1 lần mỗi lần rơi
          waterClutch().catch(() => { _waterClutchActive = false; _waterClutchFalling = false; });
        }
      });
      bot.on('entityHurt', (entity) => {
        if (entity !== bot.entity || isBusy || isFollowing) return;
        const pos = bot.entity?.position; if (!pos) return;
        // Chỉ phản ứng với mob thù — KHÔNG chạy trốn khi người chơi đánh (attacker=null)
        let attacker = null, minD = Infinity;
        for (const e of Object.values(bot.entities)) {
          if (!e || e === bot.entity || !e.position) continue;
          if (!HOSTILE_MOBS.has(e.name || e.mobType || '')) continue;
          const d = pos.distanceTo(e.position);
          if (d < minD) { minD = d; attacker = e; }
        }
        if (attacker && minD < 20) {
          const dx = pos.x - attacker.position.x, dz = pos.z - attacker.position.z;
          const len = Math.sqrt(dx*dx + dz*dz) || 1;
          try { bot.pathfinder.setGoal(new GoalXZ(pos.x + dx/len*16, pos.z + dz/len*16)); } catch(e){}
        }
        // Không else → bị player đánh thì đứng yên, không hoảng loạn chạy đi
      });
      let ad=null; bot.inventory.on('updateSlot', ()=>{ clearTimeout(ad); ad=setTimeout(()=>equipBestArmor(),800); });
        // ── STATS & DISCORD HOOKS ─────────────────────────────────────────
        bot.on('diggingCompleted', () => { activityStats.blocksMinedTotal++; });
        bot.on('death', () => {
          logActivity('Bot chết!');
          sendDiscordAlert('💀 Bot đã chết!', {
            color: 'death',
            title: '💀 ' + CONFIG.username + ' — CHẾT',
            extraFields: getInventoryFields(),
          });
        });
        bot.on('playerCollect', (collector, itemDrop) => {
          if (collector === bot.entity) { activityStats.itemsLooted++; }
        });
        bot.on('chat', (user) => {
          if (user === bot.username) return;
          // Track fish caught via "added to inventory" pattern is handled in startAutoFish
        });
        // Đếm kill chính xác theo sự kiện mob chết (thay vì đếm lần attack)
        bot.on('entityDead', (entity) => {
          if (!entity) return;
          const ename = entity.name || entity.mobType || '';
          if (HOSTILE_MOBS.has(ename) || HUNTABLE_MOBS.has(ename)) {
            activityStats.mobsKilled++;
          }
        });
  
    });

    bot.on('chat', async (rawUser, msg) => {
      // Sanitize: bỏ <> bracket nếu server trả về "<PlayerName>" thay vì "PlayerName"
      const user = (rawUser || '').replace(/^<+|>+$/g, '').trim();
      if (!user || user === bot.username) return;
      logC(user, msg);
      const txt = msg.toLowerCase();

      // ── Phản hồi thách đấu PvP (bot thách người) ──
      if (pendingDuel && user === pendingDuel.player) {
        const accepted = ['có','co','yes','ok','oke','okay','chấp nhận','chap nhan','đồng ý','dong y','sure','yep'].some(k=>txt.includes(k));
        const denied   = ['không','khong','no','nope','từ chối','tu choi','thôi','thoi'].some(k=>txt.includes(k));
        if (accepted || denied) {
          clearTimeout(pendingDuel.timeout);
          const challenger = pendingDuel.player;
          pendingDuel = null;
          if (accepted) {
            startDuel(challenger);
          } else {
            logS(`[PvP] ${challenger} từ chối → sợ`);
            const r = await getAI(`${challenger} từ chối đấu PvP`, `Bot Minecraft chế giễu "bạn sợ à?", 1 câu tiếng Việt.`);
            bot.chat(r || `${challenger} bạn sợ à? Hèn vậy!`);
          }
          return;
        }
      }

      // ── Người thách đấu PvP bot ──
      const myName = CONFIG.username.toLowerCase();
      const isPvpChallenge = !activeDuel && !pendingDuel &&
        (txt.includes('pvp') || txt.includes('1v1') || txt.includes('duel') ||
         txt.includes('đấu') || txt.includes('thách') || txt.includes('tach')) &&
        (txt.includes(myName) || txt.includes('mày') || txt.includes('may') ||
         txt.includes('bot') || txt.includes('ban') || txt.includes('bạn'));
      if (isPvpChallenge) {
        await equipBestArmor(); // thử mặc giáp tốt nhất trước
        await new Promise(r => setTimeout(r, 500));
        const currentHp = bot.health ?? 0;
        const fullyReady = isFullyArmored() && currentHp >= 19; // đủ giáp VÀ máu đầy
        if (fullyReady) {
          // Chấp nhận — đếm ngược 3-2-1
          logS(`[PvP] ${user} thách đấu → chấp nhận (đủ giáp, HP=${Math.round(currentHp)}/20)`);
          const acceptMsg = await getAI(`${user} thách bot đấu PvP 1v1`, `Bot Minecraft chấp nhận đấu tự tin, 1 câu ngắn tiếng Việt.`);
          bot.chat(acceptMsg || `${user} được thôi! Đừng có hối hận!`);
          await new Promise(r => setTimeout(r, 800));
          bot.chat('3...');
          // Bắt đầu di chuyển về phía địch trong lúc đếm
          const targetEnt = bot.players[user]?.entity;
          if (targetEnt) {
            try { bot.pathfinder.setGoal(new GoalNear(targetEnt.position.x, targetEnt.position.y, targetEnt.position.z, 3), true); } catch(_){}
          }
          await new Promise(r => setTimeout(r, 1000));
          bot.chat('2...');
          await new Promise(r => setTimeout(r, 1000));
          bot.chat('1... ⚔️ Bắt đầu!');
          await new Promise(r => setTimeout(r, 300));
          // skipCountdown=true: tránh đếm 321 lần 2 bên trong startDuel
          startDuel(user, true);
        } else if (!isFullyArmored()) {
          // Từ chối — thiếu giáp
          const missing = getMissingArmorNames().join(', ');
          logS(`[PvP] ${user} thách đấu → từ chối (thiếu: ${missing})`);
          const denyMsg = await getAI(
            `${user} thách bot đấu PvP nhưng bot thiếu giáp: ${missing}`,
            `Bot Minecraft từ chối vì chưa đủ giáp, hứa sẽ đấu sau khi có giáp, 1 câu ngắn tiếng Việt.`
          );
          bot.chat(denyMsg || `Tao thiếu ${missing}! Chờ tao có đủ giáp rồi tính!`);
        } else {
          // Từ chối — máu chưa đầy
          logS(`[PvP] ${user} thách đấu → từ chối (HP=${Math.round(currentHp)}/20 chưa đầy)`);
          const denyMsg = await getAI(
            `${user} thách bot đấu PvP nhưng bot đang ${Math.round(currentHp)}/20 HP`,
            `Bot Minecraft từ chối vì máu chưa đầy, hứa đấu khi máu full, 1 câu ngắn tiếng Việt.`
          );
          bot.chat(denyMsg || `Máu tao chưa đầy (${Math.round(currentHp)}/20), đợi tao hồi xong rồi tính!`);
        }
        return;
      }

      const isCmd = ['dừng','stop','dung','halt','cancel','chop','deposit','store','sleep','boat','fish','fishing','sort','stripmine'].includes(txt)
        ||['chặt gỗ','chặt cây','đào đá','đào nhà','phá nhà','pha nha','dao nha','mặc giáp','cất đồ','cat do','theo',
           'làm nông','lam nong','thu hoạch','thu hoach','farm',
           'chop wood','chop tree','fell tree','cut wood','mine stone','mine cobble','mine ore','mine ores','ore mining',
           'demolish','destroy house','break house','harvest','farming','equip armor','wear armor','armor up','put on armor',
           'store items','chest store','go sleep','find bed','board boat','get in boat','stop fish','stop fishing',
           'tree farm','plant tree','cobble farm','cobblestone farm','stone farm','strip mine','sort chest','organize chest',
           'bodyguard ','protect ','guard ','follow ','attack ','hit ','drop ','give ',
           'trade ','đổi ','doi ','nhặt loot','nhat loot','loot','pickup',
           'mob farm','afk farm','farm mob','pha thuốc','pha thuoc','brew','brewing',
           'farm mía','farm mia','farm đặc biệt','farm nether wart','farm tre','special farm',
           'đặt nhà','dat nha','set base','về nhà','ve nha','go home',
           'farm set','set farm','dat farm','đặt farm',
           'đứng yên','dung yen','stand','stand still',
           'thêm wp','them wp','add waypoint','add wp','tuần tra','tuan tra','patrol',
           'thống kê','thong ke','stats',
           'đào hầm','dao ham','excavate',
           'đào mạch','dao mach','veinmine','vein mine',
           'lên mặt đất','len mat dat','surface','go surface',
           'khám phá','kham pha','explore',
           'fill ','lấp ','lap ',
           'xây tường','xay tuong','build wall','wall ',
           'scaffold goto','scaffold go','scaffold đến',
           'xây ','xay ','build schematic','build file ','schematic ',
           'xây list','xay list','build list','list schematic',
           'xây resume','xay resume','resume build','build resume',
           'đến ','goto ','go to '].some(k=>txt.includes(k)||txt.startsWith(k))
        ||(txt.startsWith('đào ')||txt.startsWith('dao ')||txt.startsWith('mine ')||txt.startsWith('dig ')||txt.startsWith('phá ')||txt.startsWith('pha '));
      if (isCmd) {
        // ── Guard: bot đang bận → chỉ cho dừng/stop đi qua, block lệnh khác ──
        const isStopCmd = ['dừng','stop','dung','halt','cancel'].includes(txt);
        if (isBusy && !isStopCmd) {
          bot.chat(`Đang ${bot._task || 'bận'}! Gõ "dừng" để dừng rồi ra lệnh mới.`);
          return;
        }
        // ── Manual override: AI nhường quyền 2 phút khi người dùng ra lệnh thủ công ──
        if (aiModeEnabled) setManualOverride(120000);
        resetState(); isBusy = true; await new Promise(r=>setTimeout(r,150)); isBusy = false; stopTask=false;
      }
      // ── STOP ──────────────────────────────────────────────────────────
      if (['dừng','stop','dung','halt','cancel'].includes(txt)) { bot._task='idle'; await botSay('Đã dừng'); setTimeout(() => { if (!isBusy && !isFollowing) startWander(); }, 650); }
      // ── AI MODE BẬT/TẮT ───────────────────────────────────────────────
      else if (txt==='bật ai'||txt==='bat ai'||txt==='ai on'||txt==='ai mode on'||txt==='enable ai'||txt==='ai bật'||txt==='ai bat') { startAIMode(); }
      else if (txt==='tắt ai'||txt==='tat ai'||txt==='ai off'||txt==='ai mode off'||txt==='disable ai'||txt==='ai tắt'||txt==='ai tat') { stopAIMode(); }
      else if (txt==='ai resume'||txt==='ai tiếp tục'||txt==='ai tiep tuc'||txt==='ai takeover') {
        _manualOverrideUntil = 0;
        await botSay(aiModeEnabled ? '🧠 AI tiếp quản ngay!' : 'AI đang tắt — gõ "ai on" để bật');
      }
      else if (txt==='ai pause'||txt==='ai tạm dừng'||txt==='ai tam dung'||txt==='ai hold') {
        setManualOverride(3600000); // 1 tiếng
        await botSay('⏸ AI tạm dừng 1 tiếng. Gõ "ai resume" để AI tiếp quản lại.');
      }
      else if (txt==='ai mode'||txt==='ai status'||txt==='ai?') {
        const overrideLeft = _manualOverrideUntil > Date.now() ? Math.round((_manualOverrideUntil - Date.now())/1000) : 0;
        bot.chat(`🧠 AI: ${aiModeEnabled ? '🟢 BẬT' : '🔴 TẮT'} | Stage: ${aiGameStage.toUpperCase()} | Key: ${CONFIG.aiDecisionKey ? '✅' : '❌ dùng chung'} | Override còn: ${overrideLeft}s | Lần cuối: ${aiLastDecision ? aiLastDecision.action + ' — ' + aiLastDecision.reason : 'chưa có'}`);
      }
      // ── ĐỨNG YÊN / STAND ──────────────────────────────────────────────
      else if (txt==='đứng yên'||txt==='dung yen'||txt==='stand'||txt==='stand still') { isStandingStill=true; bot._task='đứng yên'; try{bot.pathfinder.setGoal(null);}catch(_){} try{bot.clearControlStates();}catch(_){} await botSay('Đứng yên tại chỗ!'); }
      // ── CHẶT GỖ / CHOP WOOD ───────────────────────────────────────────
      // Dùng autoTreeFarm: leo cây đúng (canDig=true) + chặt từ gốc lên đỉnh
      else if (txt.includes('chặt gỗ')||txt.includes('chặt cây')||txt.includes('chop wood')||txt.includes('chop tree')||txt.includes('fell tree')||txt==='chop'||txt==='cut wood') { resetState(); setTimeout(()=>{stopTask=false; autoTreeFarm(user);},150); }
      // ── ĐÀO ĐÁ / MINE STONE ──────────────────────────────────────────
      else if (txt.includes('đào đá')||txt.includes('dao da')||txt.includes('mine stone')||txt.includes('mine cobble')||txt.includes('dig stone')) doTask('mine',user);
      // ── ĐÀO QUẶNG / MINE ORE ─────────────────────────────────────────
      else if (txt.includes('đào quặng')||txt.includes('dao quang')||txt.includes('khai thác')||txt.includes('mine ore')||txt.includes('mine ores')||txt.includes('ore mining')) {
        const ORE_ALIAS = {
          'kim cương':'diamond_ore','diamond':'diamond_ore',
          'sắt':'iron_ore','iron':'iron_ore',
          'vàng':'gold_ore','gold':'gold_ore',
          'than':'coal_ore','coal':'coal_ore',
          'đồng':'copper_ore','copper':'copper_ore',
          'đá đỏ':'redstone_ore','redstone':'redstone_ore',
          'lapis':'lapis_ore','ngọc lục bảo':'emerald_ore','emerald':'emerald_ore',
          'cổ':'ancient_debris','ancient':'ancient_debris','netherite':'ancient_debris',
        };
        let tgt = null;
        for (const [k,v] of Object.entries(ORE_ALIAS)) { if (txt.includes(k)) { tgt = v; break; } }
        resetState(); await new Promise(r=>setTimeout(r,150)); stopTask=false;
        mineOres(user, tgt);
      }
      // ── PHÁ NHÀ / DEMOLISH ────────────────────────────────────────────
      else if (txt.includes('đào nhà')||txt.includes('phá nhà')||txt.includes('pha nha')||txt.includes('dao nha')||txt.includes('demolish')||txt.includes('destroy house')||txt.includes('break house')) doTask('demolish',user);
      // ── MOB FARM (phải check TRƯỚC 'farm' generic) ───────────────────────
      else if (txt.includes('mob farm')||txt.includes('afk farm')||txt.includes('farm mob')||txt==='afk') { resetState(); setTimeout(()=>{stopTask=false;startMobFarmAFK(user);},150); }
      // ── FARM SET / ĐẶT VỊ TRÍ FARM ───────────────────────────────────────
      else if (txt==='farm set'||txt==='set farm'||txt==='dat farm'||txt==='đặt farm'||txt.startsWith('farm set ')) { setFarmOrigin(user); }
      // ── COBBLE FARM ────────────────────────────────────────────────────────
      else if (txt.startsWith('farm đá')||txt.startsWith('farm da')||txt.includes('cobble farm')||txt.includes('cobblestone farm')||txt.includes('stone farm')) { resetState(); setTimeout(()=>{stopTask=false;autoCobbleFarm(user);},150); }
      // ── TREE FARM ──────────────────────────────────────────────────────────
      else if (txt.startsWith('trồng cây')||txt.startsWith('trong cay')||txt.includes('tree farm')||txt.includes('plant tree')||txt.startsWith('plant sapling')) { resetState(); setTimeout(()=>{stopTask=false;autoTreeFarm(user);},150); }
      // ── FARM ĐẶC BIỆT (mía / nether wart / tre) ───────────────────────────
      else if (txt.includes('farm mía')||txt.includes('farm mia')||txt.includes('farm đặc biệt')||txt.includes('farm nether wart')||txt.includes('farm tre')||txt==='special farm') { resetState(); setTimeout(()=>{stopTask=false;doFarmSpecial(user);},150); }
      // ── LÀM NÔNG / FARM (generic — chỉ khi không khớp các loại farm trên) ─
      else if (txt.includes('làm nông')||txt.includes('thu hoạch')||txt.includes('lam nong')||txt.includes('thu hoach')||txt.includes('harvest')||txt.includes('farming')||(txt.includes('farm')&&!txt.includes('mob')&&!txt.includes('cobble')&&!txt.includes('tree')&&!txt.includes('mía')&&!txt.includes('mia')&&!txt.includes('đặc biệt')&&!txt.includes('nether')&&!txt.includes('farm tre'))) doFarm(user);
      // ── GỘP ĐỒ / COMBINE TOOLS ────────────────────────────────────────
        else if (txt.includes('gộp đồ')||txt.includes('gop do')||txt.includes('combine tools')||txt.includes('gộp dụng cụ')||txt==='combine'||txt==='gop') { resetState(); setTimeout(()=>{stopTask=false;autoCombineTools(user);},150); }
        // ── MẶC GIÁP / EQUIP ARMOR ────────────────────────────────────────
        else if (txt.includes('mặc giáp')||txt.includes('mac giap')||txt.includes('equip armor')||txt.includes('wear armor')||txt.includes('armor up')||txt.includes('put on armor')) { await botSay('Đang mặc giáp tốt nhất'); await equipBestArmor(); }
      // ── CẤT ĐỒ / DEPOSIT ──────────────────────────────────────────────
      else if (txt.includes('cất đồ')||txt.includes('cat do')||txt.includes('deposit')||txt.includes('store items')||txt.includes('chest store')||txt==='store') depositToChest(user);
      // ── THEO / FOLLOW ─────────────────────────────────────────────────
      else if (txt.startsWith('theo ')||txt.startsWith('follow ')) {
        const t = msg.trim().replace(/^(theo|follow)\s+/i,'').trim();
        if (t) startFollow(t);
        else startFollow(user);
      }
      else if (txt==='theo'||txt==='follow') startFollow(user);
      // ── VỨT ĐỒ / DROP ─────────────────────────────────────────────────
      else if (txt.startsWith('vứt ')||txt.startsWith('vut ')||txt.startsWith('drop ')) {
        if (CONFIG.allowedDropUsers.length > 0 && !CONFIG.allowedDropUsers.includes(user)) {
          bot.chat(`${user}, bạn không có quyền ra lệnh vứt đồ!`);
        } else {
          const q = msg.trim().replace(/^(vứt|vut|drop)\s+/i,'').trim();
          if (q) dropItem(q, user);
        }
      }
      // ── NGỦ / SLEEP ───────────────────────────────────────────────────
      else if (txt.includes('ngủ')||txt.includes('ngu di')||txt.includes('đi ngủ')||txt==='sleep'||txt.includes('go sleep')||txt.includes('find bed')) goSleep(user);
      // ── LÊN THUYỀN / BOARD BOAT ───────────────────────────────────────
      else if (txt.includes('lên thuyền')||txt.includes('len thuyen')||txt.includes('thuyền')||txt==='boat'||txt.includes('board boat')||txt.includes('get in boat')) boardBoat(user);
      // ── ĐÁNH NGƯỜI / ATTACK PLAYER ────────────────────────────────────
      else if (txt.startsWith('đánh ')||txt.startsWith('danh ')||txt.startsWith('tấn công ')||txt.startsWith('tan cong ')||txt.startsWith('attack ')||txt.startsWith('hit ')) {
        const target = msg.trim().split(/\s+/).slice(1).join(' ').trim();
        if (target) attackPlayer(target, user);
        else bot.chat('Đánh ai? / Who to attack? e.g. attack Steve');
      }
      // ── CHO TÔI / GIVE ────────────────────────────────────────────────
      else if (txt.startsWith('cho tôi ')||txt.startsWith('cho toi ')||txt.startsWith('give ')) {
        const q = msg.trim().replace(/^(cho tôi|cho toi|give)\s+/i,'').trim();
        if (q) { dropItem(q, user); }
        else bot.chat('Cho cái gì? / What to give? e.g. give stone');
      }
      // ── LÀM SÀN / PLATFORM ────────────────────────────────────────────
      else if (txt.startsWith('làm sàn')||txt.startsWith('lam san')||txt.startsWith('xây sàn')||txt.startsWith('xay san')||txt.startsWith('platform ')||txt.startsWith('build platform ')) {
        const rawParts = msg.trim().split(/\s+/);
        const skip = (txt.startsWith('platform')||txt.startsWith('build platform')) ? (txt.startsWith('build platform')?2:1) : 2;
        const args = rawParts.slice(skip);
        if (args.length >= 6) {
          const [sx1,sy,sz1,sx2,sz2,...blkP] = args;
          const bx1=parseInt(sx1),by=parseInt(sy),bz1=parseInt(sz1),bx2=parseInt(sx2),bz2=parseInt(sz2);
          const blk = blkP[0]||'stone';
          if (isNaN(bx1)||isNaN(by)||isNaN(bz1)||isNaN(bx2)||isNaN(bz2)) {
            bot.chat('Toạ độ không hợp lệ! Usage: platform x1 y z1 x2 z2 [block]');
          } else {
            resetState(); await new Promise(r=>setTimeout(r,150)); stopTask=false;
            buildPlatform(bx1,by,bz1,bx2,bz2,blk,user);
          }
        } else {
          bot.chat('Usage: platform x1 y z1 x2 z2 [block]  |  làm sàn x1 y z1 x2 z2 [block]');
        }
      }
      // ── ĐÀO BLOCK BẤT KỲ / MINE SPECIFIC BLOCK ──────────────────────
      else if (
        (txt.startsWith('đào ')||txt.startsWith('dao ')||txt.startsWith('mine ')||txt.startsWith('dig ')||txt.startsWith('phá ')||txt.startsWith('pha ')) &&
        !txt.includes('đào đá') && !txt.includes('dao da') && !txt.includes('đào quặng') && !txt.includes('đào nhà') &&
        !txt.includes('dao nha') && !txt.includes('phá nhà') && !txt.includes('pha nha') &&
        !txt.includes('mine stone') && !txt.includes('mine cobble') && !txt.includes('mine ore')
      ) {
        const blockArg = msg.trim().split(/\s+/).slice(1).join(' ').trim();
        if (blockArg) mineBlockType(blockArg, user);
        else bot.chat('Đào gì? / Mine what? e.g. mine oak_log, dig dirt, đào cobblestone');
      }
      // ── CÂU CÁ / FISH ─────────────────────────────────────────────────
      else if (txt.startsWith('câu cá')||txt.startsWith('cau ca')||txt==='fish'||txt.startsWith('auto fish')||txt==='fishing'||txt.startsWith('start fish')) { resetState(); setTimeout(()=>{stopTask=false;startAutoFish(user);},150); }
      // ── DỪNG CÂU / STOP FISHING ───────────────────────────────────────
      else if (txt.includes('dừng câu')||txt.includes('dung cau')||txt.includes('stop fish')||txt.includes('stop fishing')) stopAutoFish();
      // ── STRIP MINE ────────────────────────────────────────────────────
      // Usage: strip mine [y] [length] [branchLen]  e.g.: strip mine -58 80 16
      else if (txt.startsWith('strip mine')||txt.includes('đào strip')||txt.includes('dao strip')||txt==='stripmine') {
        const parts = msg.trim().split(/\s+/);
        const nums = parts.slice(txt.startsWith('strip mine')?2:2).map(Number).filter(v=>!isNaN(v));
        const opts = { y: nums[0] ?? -58, len: nums[1] ?? 64, branchLen: nums[2] ?? 16 };
        resetState(); setTimeout(()=>{stopTask=false;stripMine(user,opts);},150);
      }
      // ── ĐẼN TọA ĐỘ / GOTO COORDS (Baritone #goto) ─────────────
      else if (txt.startsWith('đến ')||txt.startsWith('den ')||txt.startsWith('goto ')||txt.startsWith('go to ')) {
        const nums = msg.trim().split(/\s+/).map(Number).filter(n=>!isNaN(n));
        if (nums.length >= 3) {
          resetState(); setTimeout(()=>{stopTask=false; gotoCoords(nums[0],nums[1],nums[2],user);},150);
        } else if (nums.length >= 2) {
          resetState(); setTimeout(()=>{stopTask=false; gotoCoords(nums[0],null,nums[1],user);},150);
        } else {
          bot.chat('Usage: đến X Y Z  hoặc  đến X Z  (2D)  |  goto X Y Z');
        }
      }
      // ── ĐÀO HẦM / EXCAVATE (Baritone #excavate) ──────────────
      else if (txt.startsWith('đào hầm')||txt.startsWith('dao ham')||txt.startsWith('excavate')) {
        const nums = msg.trim().split(/\s+/).map(Number).filter(n=>!isNaN(n)&&n>0);
        if (nums.length >= 3) {
          const [w,h,l] = nums;
          if (w<=20&&h<=10&&l<=20) { resetState(); setTimeout(()=>{stopTask=false; excavate(w,h,l,user);},150); }
          else bot.chat('Kích thước tối đa: W=20, H=10, L=20');
        } else if (nums.length === 1) {
          const s = nums[0];
          if (s<=20) { resetState(); setTimeout(()=>{stopTask=false; excavate(s,s,s,user);},150); }
          else bot.chat('Tối đa 20 block mỗi chiều. Ví dụ: đào hầm 5 3 7');
        } else {
          bot.chat('Usage: đào hầm W H L  |  excavate 5 3 7  |  đào hầm 5 (cube 5×5×5)');
        }
      }
      // ── ĐÀO MẠCH / VEINMINE (Baritone veinminer) ─────────────
      else if (txt.startsWith('đào mạch')||txt.startsWith('dao mach')||txt.startsWith('veinmine')||txt.startsWith('vein mine')) {
        const arg = msg.trim().replace(/^(đào mạch|dao mach|veinmine|vein mine)\s*/i,'').trim().toLowerCase();
        if (arg) { resetState(); setTimeout(()=>{stopTask=false; veinMine(arg,user);},150); }
        else bot.chat('Đào mạch quặng gì? Ví dụ: đào mạch diamond | veinmine iron');
      }
      // ── LÊN MẶT ĐẤT / SURFACE (Baritone #surface) ──────────────
      else if (txt==='lên mặt đất'||txt==='len mat dat'||txt==='surface'||txt==='go surface'||txt.includes('lên mặt đất')||txt.includes('len mat dat')) {
        resetState(); setTimeout(()=>{stopTask=false; goToSurface(user);},150);
      }
      // ── KHÁM PHÁ / EXPLORE (Baritone #explore) ────────────────
      else if (txt==='khám phá'||txt==='kham pha'||txt==='explore'||txt.startsWith('explore ')) {
        resetState(); setTimeout(()=>{stopTask=false; exploreArea(user);},150);
      }
      // ── XÂY LIST — liệt kê file schematic có sẵn ──────────────────
      else if (txt==='xây list'||txt==='xay list'||txt==='build list'||txt==='list schematic'||txt==='list schematics') {
        const files = listSchematics();
        if (!files.length) {
          bot.chat('Chưa có file schematic nào. Đặt .litematic/.schem/.txt vào thư mục schematics/');
        } else {
          bot.chat(`[Schematic] ${files.length} file: ${files.join(' | ')}`);
        }
      }
      // ── XÂY RESUME — tiếp tục xây dở ──────────────────────────────
      else if (txt==='xây resume'||txt==='xay resume'||txt==='resume build'||txt==='build resume'||txt==='resume') {
        resetState(); setTimeout(()=>{stopTask=false;resumeBuild(user);},150);
      }
      // ── XÂY SCHEMATIC / BUILD FILE ──────────────────────────────────
      // Hỗ trợ: .litematic (Litematica), .schem (WorldEdit/Sponge), .txt
      // Origin = vị trí bot đứng; tọa độ trong file là offset tương đối
      else if (
        txt.startsWith('xây ')||txt.startsWith('xay ')||
        txt.startsWith('xây file ')||txt.startsWith('xay file ')||
        txt.startsWith('build schematic')||txt.startsWith('build file ')||txt.startsWith('schematic ')
      ) {
        const words = msg.trim().split(/\s+/);
        const skip = (txt.startsWith('build file')||txt.startsWith('xây file')||txt.startsWith('xay file')) ? 2 : 1;
        const fn = words.slice(skip).join(' ').trim();
        if (fn) { resetState(); setTimeout(()=>{stopTask=false;buildSchematic(fn,user);},150); }
        else bot.chat('Usage: xây <file.litematic>  |  xây list (xem danh sách)  |  xây resume (tiếp tục)');
      }
      // ── FILL / LẤP ĐẦY VÙNG (Baritone-style) ──────────────────────
      // fill x1 y1 z1 x2 y2 z2 [block]   |  lấp x1 y1 z1 x2 y2 z2 [block]
      else if (txt.startsWith('fill ')||txt.startsWith('lấp ')||txt.startsWith('lap ')) {
        const parts = msg.trim().split(/\s+/);
        const nums = parts.slice(1).filter(p => !isNaN(Number(p))).map(Number);
        const blk  = parts.find((p,i) => i >= 7 && isNaN(Number(p))) || 'stone';
        if (nums.length >= 6) {
          const [x1,y1,z1,x2,y2,z2] = nums;
          resetState(); setTimeout(()=>{stopTask=false;fillRegion(x1,y1,z1,x2,y2,z2,blk,user);},150);
        } else {
          bot.chat('Usage: fill x1 y1 z1 x2 y2 z2 [block]  |  lấp 0 64 0 10 70 10 stone');
        }
      }
      // ── XÂY TƯỜNG / BUILD WALL ──────────────────────────────────────
      // wall x1 y1 z1 x2 y2 z2 [height] [block]
      else if (txt.startsWith('xây tường')||txt.startsWith('xay tuong')||txt.startsWith('build wall')||txt.startsWith('wall ')) {
        const parts = msg.trim().split(/\s+/);
        const skip  = (txt.startsWith('build wall')||txt.startsWith('xây tường')||txt.startsWith('xay tuong')) ? 2 : 1;
        const rest  = parts.slice(skip);
        const nums  = rest.filter(p => !isNaN(Number(p))).map(Number);
        const blk   = rest.find(p => isNaN(Number(p))) || 'cobblestone';
        if (nums.length >= 6) {
          const [x1,y1,z1,x2,y2,z2,h=4] = nums;
          resetState(); setTimeout(()=>{stopTask=false;buildWall(x1,y1,z1,x2,y2,z2,h,blk,user);},150);
        } else {
          bot.chat('Usage: wall x1 y1 z1 x2 y2 z2 [height] [block]  |  xây tường 0 64 0 20 64 0 4 cobblestone');
        }
      }
      // ── SCAFFOLD GOTO (Baritone-mode: bật tower + scaffold) ─────────
      // scaffold đến X Y Z  |  scaffold goto X Y Z  |  scaffold go X Y Z
      else if (txt.startsWith('scaffold đến')||txt.startsWith('scaffold den')||txt.startsWith('scaffold goto')||txt.startsWith('scaffold go')) {
        const nums = msg.trim().split(/\s+/).map(Number).filter(n=>!isNaN(n));
        if (nums.length >= 3) {
          resetState(); setTimeout(()=>{stopTask=false; scaffoldGoto(nums[0],nums[1],nums[2],user);},150);
        } else if (nums.length === 2) {
          resetState(); setTimeout(()=>{stopTask=false; scaffoldGoto(nums[0],null,nums[1],user);},150);
        } else {
          bot.chat('Usage: scaffold goto X Y Z  |  scaffold đến X Y Z');
        }
      }
      // ── BẢO VỆ / BODYGUARD ────────────────────────────────────────────
      else if (txt.startsWith('bảo vệ ')||txt.startsWith('bao ve ')||txt.startsWith('bodyguard ')||txt.startsWith('protect ')||txt.startsWith('guard ')) {
        const t = msg.trim().replace(/^(bảo vệ|bao ve|bodyguard|protect|guard)\s+/i,'').trim();
        if (t) { resetState(); setTimeout(()=>{stopTask=false;startBodyguard(t,user);},150); }
        else bot.chat('Bảo vệ ai? / Guard who? e.g. bodyguard Steve');
      }
      // ── SẮP RƯƠNG / SORT CHEST ────────────────────────────────────────
      else if (txt.includes('sắp rương')||txt.includes('sap ruong')||txt.includes('sort chest')||txt==='sort'||txt.includes('organize chest')) { resetState(); setTimeout(()=>{stopTask=false;sortChest(user);},150); }
      // ── ĐẶT NHÀ / SET BASE ───────────────────────────────────────────────────────
        else if (txt==='đặt nhà'||txt==='dat nha'||txt==='set base'||txt==='setbase') { setBase(user); }
        // ── VỀ NHÀ / GO HOME ────────────────────────────────────────────────────────
        else if (txt==='về nhà'||txt==='ve nha'||txt==='go home'||txt==='home') { resetState(); setTimeout(()=>{stopTask=false;goHome(user);},150); }
        // ── THÊM WAYPOINT ────────────────────────────────────────────────────────────
        else if (txt.startsWith('thêm wp')||txt.startsWith('them wp')||txt.startsWith('add waypoint')||txt.startsWith('add wp')) {
          const wname = msg.trim().split(/\s+/).slice(2).join(' ').trim();
          addWaypoint(wname);
        }
        // ── XEM WAYPOINTS ────────────────────────────────────────────────────────────
        else if (txt==='danh sách wp'||txt==='ds wp'||txt==='list wp'||txt==='waypoints') { listWaypoints(); }
        // ── XÓA WAYPOINT ────────────────────────────────────────────────────────────
        else if (txt.startsWith('xóa wp')||txt.startsWith('xoa wp')||txt.startsWith('remove wp')) {
          const wname = msg.trim().split(/\s+/).slice(2).join(' ').trim();
          if (wname) removeWaypoint(wname); else clearWaypoints();
        }
        // ── XÓA TẤT CẢ WAYPOINTS ────────────────────────────────────────────────────
        else if (txt==='xóa hết wp'||txt==='xoa het wp'||txt==='clear waypoints'||txt==='clear wp') { clearWaypoints(); }
        // ── TUẦN TRA / PATROL ────────────────────────────────────────────────────────
        else if (txt==='tuần tra'||txt==='tuan tra'||txt==='patrol'||txt.startsWith('patrol')) { resetState(); setTimeout(()=>{stopTask=false;startPatrol(user);},150); }
        // ── MOB FARM AFK ─────────────────────────────────────────────────────────────
        else if (txt.includes('mob farm')||txt.includes('afk farm')||txt.includes('farm mob')||txt==='afk') { resetState(); setTimeout(()=>{stopTask=false;startMobFarmAFK(user);},150); }
        // ── PHA THUỐC / BREW ─────────────────────────────────────────────────────────
        else if (txt.includes('pha thuốc')||txt.includes('pha thuoc')||txt==='brew'||txt==='brewing'||txt.includes('auto brew')) { resetState(); setTimeout(()=>{stopTask=false;autoBrewing(user);},150); }
        // ── FARM MÍA / FARM ĐẶC BIỆT ────────────────────────────────────────────────
        else if (txt.includes('farm mía')||txt.includes('farm mia')||txt.includes('farm đặc biệt')||txt.includes('farm nether wart')||txt.includes('farm tre')||txt==='special farm') { resetState(); setTimeout(()=>{stopTask=false;doFarmSpecial(user);},150); }
        // ── NHẶT LOOT ────────────────────────────────────────────────────────────────
        else if (txt==='nhặt loot'||txt==='nhat loot'||txt==='loot'||txt==='pickup') { autoLootNearby(16).then(()=>bot&&bot.chat('Đã nhặt loot xung quanh')); }
        // ── THỐNG KÊ / STATS ─────────────────────────────────────────────────────────
        else if (txt==='thống kê'||txt==='thong ke'||txt==='stats'||txt==='statistics') {
          const uptime = Math.round((Date.now() - activityStats.startTime) / 60000);
          bot.chat('📊 Stats: đào ' + activityStats.blocksMinedTotal + ' block, giết ' + activityStats.mobsKilled + ' mob, câu ' + activityStats.fishCaught + ' cá, pha ' + activityStats.potionsBrewed + ' thuốc, thời gian: ' + uptime + ' phút');
        }
        // ── HELP / LỆNH ───────────────────────────────────────────────────
      else if (['help','lenh','lệnh','commands','cmd','?','!help','danh sach lenh','danh sách lệnh'].includes(txt)) botSayCommands();
      // ── TRADE HANDLER ─────────────────────────────────────────────────
      else if (handleTradeChat(user, msg)) { /* trade handled */ }
      else if (shouldReply(user,msg)) await replyToChat(user,msg);
    });

    bot.on('kicked', (reason) => {
      clearTimeout(spawnTimeout);
      let r = typeof reason === 'string' ? reason : JSON.stringify(reason);
      // Thử parse JSON kick reason (dạng text component)
      try { const j=JSON.parse(r); r=j.text||j.translate||r; } catch(_){}
      // Thử parse thêm một lớp nữa (Aternos dùng nested JSON)
      try { const j2=JSON.parse(r); r=j2.text||j2.translate||r; } catch(_){}
      lastError = `Bị kick: ${r.slice(0,200)}`;

      const isAnotherLocation = r.includes('another location') || r.includes('logged in') || r.includes('multiplayer.disconnect.duplicate_login');
      const isOutdated  = r.includes('outdated') || r.includes('Outdated') || r.includes('version');
      const isWhitelist = r.includes('whitelist') || r.includes('not whitelisted');
      const isBanned    = r.includes('banned') || r.includes('Banned');

      // Aternos kick khi server đang khởi động — chờ lâu hơn, không đếm vào MAX_REJOIN
      const isStarting  = /starting|start up|not running|currently offline|restarting|hibernat|waking|please wait|đang khởi|đang tải|server is loading/i.test(r);

      if (isOutdated)        logW(`[KICK] Sai version! Server dùng version khác. Kiểm tra cấu hình.`);
      else if (isWhitelist)  logW(`[KICK] Bot không có trong whitelist server!`);
      else if (isBanned)     logW(`[KICK] Bot bị ban khỏi server!`);
      else if (isStarting)   logW(`[KICK] Aternos đang khởi động server... Chờ 60s rồi thử lại.`);
      else                   logW(`[KICK] ${r.slice(0,200)}`);
        sendDiscordAlert('Lý do: ' + r.slice(0,200), { color: 'error', title: '🔴 ' + CONFIG.username + ' — BỊ KICK', extraFields: getInventoryFields() });
        logActivity('Bị kick: ' + r.slice(0,200));

      if (isAnotherLocation) {
        lastError = 'Bị kick: đăng nhập từ nơi khác (duplicate login)';
        rejoinAttempts = Math.max(rejoinAttempts, 3);
        logW(lastError + ' — Rejoin sau vài giây...');
        handleRejoin(); return;
      } else if (isWhitelist || isBanned) {
        logE('Dừng tự rejoin vì whitelist/ban. Sửa config rồi restart bot.');
      } else if (isStarting) {
        // Server Aternos chưa sẵn sàng — không tính vào MAX_REJOIN, chờ 60s
        if (isRejoining) return;
        isRejoining = true; botOnline = false;
        if (spawnWaitInterval) { clearInterval(spawnWaitInterval); spawnWaitInterval = null; }
        try { bot.removeAllListeners(); try { bot._client.end('disconnect.quitting'); } catch(_){} try { bot.end(); } catch(_){} } catch(_){}
        bot = null;
        logW(`[KICK] Thử lại sau 60s (server đang tải, không tính vào giới hạn rejoin)...`);
        setTimeout(() => { isRejoining = false; createBot(); }, 60000);
      } else {
        handleRejoin();
      }
    });
    bot.on('error', (err) => {
      clearTimeout(spawnTimeout);
      if (err.code==='ECONNREFUSED')      lastError=`Lỗi kết nối: Server offline hoặc sai địa chỉ (${CONFIG.host}:${CONFIG.port})`;
      else if (err.code==='ECONNRESET')   lastError=`Lỗi mạng: Kết nối bị đứt (ECONNRESET)`;
      else if (err.code==='ETIMEDOUT')    lastError=`Timeout: Server không phản hồi (${CONFIG.host}:${CONFIG.port})`;
      else if (err.code==='ENOTFOUND')    lastError=`Lỗi DNS: Không tìm thấy host '${CONFIG.host}'`;
      else                                lastError=err.message;
      logE(lastError); handleRejoin();
    });
    bot.on('end', (reason) => { clearTimeout(spawnTimeout); botOnline = false; _lastStatusHash = ''; logW(`Mất kết nối (End${reason?' — '+reason:''}). Rejoin...`); handleRejoin(); });
  } catch(err) {
    lastError = `Lỗi tạo bot: ${err.message}`;
    logE(lastError);
    // Dọn tất cả interval giống handleRejoin để không bị rò rỉ
    if (armorInterval)        { clearInterval(armorInterval);        armorInterval=null; }
    if (eatInterval)          { clearInterval(eatInterval);          eatInterval=null; }
    if (pvpChallengeInterval) { clearInterval(pvpChallengeInterval); pvpChallengeInterval=null; }
    if (invCheckInterval)     { clearInterval(invCheckInterval);     invCheckInterval=null; }
    if (statusBarInterval)    { clearInterval(statusBarInterval);    statusBarInterval=null; }
    if (huntInterval)         { clearInterval(huntInterval);         huntInterval=null; isHunting=false; }
    bot = null;
    if (rejoinAttempts < MAX_REJOIN) {
      rejoinAttempts++;
      const delay = Math.min(REJOIN_DELAY * Math.pow(2, rejoinAttempts - 1), 45000);
      logW(`Lỗi khởi tạo. Thử lại [${rejoinAttempts}/${MAX_REJOIN}] sau ${(delay/1000).toFixed(0)}s...`);
      isRejoining = true;
      setTimeout(() => { isRejoining = false; createBot(); }, delay);
    } else {
      logE('Thất bại nhiều lần. Chờ 60s...'); rejoinAttempts = 0;
      isRejoining = true;
      setTimeout(() => { isRejoining = false; createBot(); }, 60000);
    }
  }
}

// ── DROP ITEM ─────────────────────────────────────────────────────
async function dropItem(query, who) {
  if (!bot || !mcData) return;
  const q = query.trim().toLowerCase();
  const items = bot.inventory.items();
  let targets;
  if (q === 'hết' || q === 'tất cả' || q === 'all') {
    targets = items.filter(i => !shouldKeep(i.name));
    if (!targets.length) { bot.chat('Túi trống rồi!'); return; }
  } else {
    // Map từ tiếng Việt thông dụng → tên MC
    const aliasMap = {
      'đá': ['cobblestone','stone','granite','diorite','andesite'],
      'gỗ': ['log','wood','planks'],
      'cát': ['sand'], 'sỏi': ['gravel'], 'đất': ['dirt','grass'],
      'than': ['coal'], 'sắt': ['iron'], 'vàng': ['gold'], 'kim cương': ['diamond'],
      'thức ăn': ['bread','apple','carrot','potato','beef','chicken','pork','mutton','rabbit','cod','salmon'],
      'mũi tên': ['arrow'], 'xương': ['bone'], 'lông': ['feather'],
      'đá đỏ': ['redstone'], 'ngọc lục bảo': ['emerald'], 'lapis': ['lapis'],
    };
    const mcNames = aliasMap[q] || [q.replace(/ /g,'_')];
    targets = items.filter(i => mcNames.some(n => i.name.includes(n)));
    if (!targets.length) { bot.chat(`Không có "${query}" trong túi`); return; }
  }
  let dropped = 0;
  for (const item of targets) {
    try { await bot.toss(item.type, null, item.count); dropped++; await new Promise(r => setTimeout(r, 120)); }
    catch(e) { logW(`Lỗi vứt ${item.name}: ${e.message}`); }
  }
  logS(`[${who}] Vứt ${dropped} loại đồ`);
  if (dropped) bot.chat(`Đã vứt ${dropped} loại ra ngoài`);
}

// ── SLEEP ─────────────────────────────────────────────────────────
async function goSleep(who) {
  if (!bot || !mcData) return;
  resetState(); await new Promise(r => setTimeout(r, 200));
  stopTask = false; isBusy = true; bot._task = 'ngủ'; refreshMovements();
  const BED_BLOCKS = Object.keys(mcData.blocksByName)
    .filter(n => n.endsWith('_bed'))
    .map(n => mcData.blocksByName[n].id);

  // Thử nhiều giường — lấy danh sách trong bán kính tăng dần
  // findBlocks (plural) lấy tất cả giường trong 64 block cùng lúc
  const beds = (bot.findBlocks({ matching: BED_BLOCKS, maxDistance: 64, count: 16 }) || [])
    .map(pos => bot.blockAt(pos))
    .filter(Boolean);
  if (!beds.length) {
    bot.chat('Không tìm thấy giường nào gần đây (trong 64 block)');
    isBusy = false; if (!isFollowing) startWander(); return;
  }

  let bed = null;
  for (const candidate of beds) {
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(candidate.position.x, candidate.position.y, candidate.position.z, 2)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('nav timeout')), 10000)),
      ]);
      bed = candidate; break;
    } catch(e) { logW(`Bỏ qua giường tại ${candidate.position} (${e.message})`); }
  }
  if (!bed) {
    bot.chat('Không đến được giường nào gần đây!');
    isBusy = false; if (!isFollowing) startWander(); return;
  }

  try {
    await new Promise(r => setTimeout(r, 400));
    // Thử sleep — trong MC cần phải là ban đêm hoặc thunderstorm
    await bot.sleep(bed);
    logS(`[${who}] Đang ngủ...`);
    bot.chat('Ngủ ngon 💤');
    // Chờ bot thực sự thức dậy (sự kiện 'wake') thay vì setTimeout cố định
    await new Promise((resolve) => {
      const onWake = () => resolve();
      bot.once('wake', onWake);
      // Fallback: tối đa 60s (đêm MC ≈7 phút, nhưng skip nếu không ngủ được lâu)
      setTimeout(async () => {
        bot.removeListener('wake', onWake);
        try { await bot.wake(); } catch(_){}
        resolve();
      }, 60000);
    });
    bot.chat('Dậy rồi! ☀️');
  } catch(e) {
    const msg = e.message || String(e);
    if (msg.includes('daytime') || msg.includes('not night')) {
      bot.chat('Chưa đến ban đêm, không ngủ được!');
    } else {
      bot.chat(`Không ngủ được: ${msg}`);
    }
    logW(`[Sleep] ${msg}`);
    try { await bot.wake(); } catch(_){}
  } finally {
    isBusy = false; if (!isFollowing) startWander();
  }
}

// ── ATTACK PLAYER ─────────────────────────────────────────────────
async function attackPlayer(playerName, who) {
  if (!bot || !mcData || !botOnline) return;
  const target = bot.players[playerName]?.entity;
  if (!target) {
    bot.chat(`Không tìm thấy ${playerName} gần đây`);
    return;
  }
  resetState(); await new Promise(r => setTimeout(r, 150));
  stopTask = false; isBusy = true; bot._task = `tấn công ${playerName}`; refreshMovements();
  bot.chat(`⚔️ Tấn công ${playerName}!`);
  try { bot.pvp.attack(target); } catch(e) { logW('pvp.attack: ' + e.message); }
  // Theo dõi — dừng khi bot bị stop hoặc target rời đi
  const trackAtk = setInterval(() => {
    if (stopTask || !bot || !botOnline) {
      clearInterval(trackAtk);
      try { bot?.pvp?.stop(); } catch(_){}
      isBusy = false; return;
    }
    const fresh = bot.players[playerName]?.entity;
    if (!fresh || !fresh.isValid) {
      clearInterval(trackAtk);
      try { bot.pvp.stop(); } catch(_){}
      isBusy = false;
      bot.chat(`${playerName} đã thoát khỏi tầm nhìn`);
      if (!isFollowing) startWander();
      return;
    }
    if (!bot.pvp.target) {
      try { bot.pvp.attack(fresh); } catch(_){}
    }
  }, 1000);
}

// ── BOARD BOAT ────────────────────────────────────────────────────
async function boardBoat(who) {
  if (!bot || !mcData) return;
  resetState(); await new Promise(r => setTimeout(r, 200));
  stopTask = false; isBusy = true; bot._task = 'lên thuyền'; refreshMovements();

  // Tìm thuyền gần nhất trong 64 block (oak_boat, spruce_boat, bamboo_raft, chest_boat, v.v.)
    const isBoatEntity = (e) => {
      if (!e || !e.position) return false;
      const n = (e.name || e.objectType || '').toLowerCase();
      // MC 1.21: bamboo_raft, oak_boat, spruce_boat, chest_boat, v.v.
      return n.includes('boat') || n.includes('raft') ||
        (e.type === 'object' && n === '') && false; // fallback tắt
    };
    const findBoat = () => {
      let nearest = null, nearDist = 64;
      for (const entity of Object.values(bot.entities)) {
        if (!isBoatEntity(entity)) continue;
        const d = bot.entity.position.distanceTo(entity.position);
        if (d < nearDist) { nearDist = d; nearest = entity; }
      }
      return nearest;
    };

  const boat0 = findBoat();
  if (!boat0) {
    bot.chat('Không tìm thấy thuyền nào gần đây (trong 64 block)');
    isBusy = false; return;
  }

  try {
      // Tiếp cận bờ nước gần thuyền — dùng Y của bot (không dùng Y nổi của thuyền)
      const approachY = Math.floor(bot.entity.position.y);
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(boat0.position.x, approachY, boat0.position.z, 2)),
          new Promise((_,rej) => setTimeout(() => rej(new Error('nav timeout')), 10000)),
        ]);
      } catch(_) {
        // Nếu fail: thử pathfind đến Y thuyền
        try { await bot.pathfinder.goto(new GoalNear(boat0.position.x, Math.floor(boat0.position.y), boat0.position.z, 2)); } catch(_2){}
      }
      await new Promise(r => setTimeout(r, 400));

      // Lấy lại entity sau khi đã di chuyển (thuyền có thể trôi)
      const boat = findBoat();
      if (!boat) throw new Error('Thuyền đã biến mất hoặc quá xa');

      // Nhìn vào giữa thuyền
      await bot.lookAt(boat.position.offset(0, (boat.height || 0.9) * 0.5, 0), true);
      await new Promise(r => setTimeout(r, 200));

      // Thử mount tối đa 5 lần với nhiều phương pháp
      let boarded = false;
      for (let attempt = 0; attempt < 5 && !boarded; attempt++) {
        // Phương pháp 1: bot.mount()
        try { await bot.mount(boat); await new Promise(r => setTimeout(r, 400)); if (bot.vehicle) { boarded = true; break; } } catch(_) {}

        // Phương pháp 2: activateEntity (right-click)
        try { bot.activateEntity(boat); await new Promise(r => setTimeout(r, 400)); if (bot.vehicle) { boarded = true; break; } } catch(_) {}

        // Tiến sát hơn nếu còn cách
        const fresh = findBoat();
        if (!fresh) break;
        const distToBoat = bot.entity.position.distanceTo(fresh.position);
        if (distToBoat > 1) {
          try { await bot.pathfinder.goto(new GoalNear(fresh.position.x, Math.floor(bot.entity.position.y), fresh.position.z, 1)); } catch(_){}
          await new Promise(r => setTimeout(r, 300));
          // Nhìn lại vào thuyền sau khi đến gần
          try { await bot.lookAt(fresh.position.offset(0, 0.5, 0), true); } catch(_){}
        }
      }

      if (boarded || bot.vehicle) {
        logS(`[${who}] Đã lên thuyền ✅`);
        bot.chat('Lên thuyền rồi! 🚤');
      } else {
        throw new Error('Không thể lên thuyền (đảm bảo thuyền thực sự gần bot < 3 block)');
      }
    } catch(e) {
      bot.chat(`Không lên được thuyền: ${e.message}`);
      logW(`[Boat] ${e.message}`);
  } finally {
    isBusy = false;
  }
}

// ── XÂY SÀN (PLATFORM) ────────────────────────────────────────────
async function buildPlatform(x1, y, z1, x2, z2, blockName, who) {
  if (!bot || !mcData) { try { bot?.chat('Bot chưa sẵn sàng'); } catch(_){} return; }
  if (isBusy) { bot.chat('Bot đang bận'); return; }

  const blockData = mcData.blocksByName[blockName];
  if (!blockData) { bot.chat(`Không biết block "${blockName}"`); return; }

  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
  const sizeX = maxX - minX + 1, sizeZ = maxZ - minZ + 1;
  const total = sizeX * sizeZ;

  if (total > 400) {
    bot.chat(`Sàn quá lớn (${total} block)! Tối đa 400 (ví dụ 20×20)`);
    return;
  }

  isBusy = true; stopTask = false; bot._task = 'xây sàn';
  bot.chat(`🏗 Xây sàn ${sizeX}×${sizeZ} (${total} block) bằng ${blockName} tại Y=${y}`);
  logS(`[${who}] Platform ${blockName} (${x1},${y},${z1})→(${x2},${y},${z2})`);

  let placed = 0, skipped = 0;

  try {
    outer:
    for (let x = minX; x <= maxX && !stopTask; x++) {
      for (let z = minZ; z <= maxZ && !stopTask; z++) {
        const pos = new Vec3(x, y, z);
        const existing = bot.blockAt(pos);

        // Bỏ qua nếu đã có block đặc tại vị trí đó
        if (existing && existing.type !== 0 && existing.name !== 'air' &&
            existing.name !== 'water' && existing.name !== 'lava') {
          skipped++; continue;
        }

        // Cần có block bên dưới để đặt lên
        const below = bot.blockAt(pos.offset(0, -1, 0));
        if (!below || below.boundingBox !== 'block') { skipped++; continue; }

        // Kiểm tra inventory còn block không
        const item = bot.inventory.items().find(i => i.name === blockName);
        if (!item) {
          bot.chat(`Hết ${blockName}! Đã đặt ${placed}/${total} block`);
          break outer;
        }

        try {
          await bot.pathfinder.goto(new GoalNear(x, y, z, 3));
          if (stopTask) break outer;
          // Re-tìm item sau khi di chuyển (slot có thể thay đổi)
          const freshItem = bot.inventory.items().find(i => i.name === blockName);
          if (!freshItem) { bot.chat(`Hết ${blockName}! Đã đặt ${placed}/${total} block`); break outer; }
          await bot.equip(freshItem, 'hand');
          // Đặt lên mặt trên của block bên dưới
          const belowFresh = bot.blockAt(pos.offset(0, -1, 0));
          if (belowFresh && belowFresh.boundingBox === 'block') {
            await bot.placeBlock(belowFresh, new Vec3(0, 1, 0));
            placed++;
            if (placed % 10 === 0) logS(`[Platform] ${placed}/${total}...`);
          } else { skipped++; }
        } catch(e) {
          logW(`[Platform] (${x},${y},${z}): ${e.message}`);
          skipped++;
        }
        await new Promise(r => setTimeout(r, 40));
      }
    }

    if (stopTask) {
      bot.chat(`⏹ Dừng. Đã đặt ${placed} block`);
    } else {
      bot.chat(`✅ Xây sàn xong! ${placed} đặt, ${skipped} bỏ qua`);
      logS(`[${who}] Platform hoàn thành: ${placed} đặt, ${skipped} bỏ qua`);
    }
  } catch(e) {
    logW(`[Platform] ${e.message}`);
    bot.chat(`Lỗi xây sàn: ${e.message}`);
  } finally {
    isBusy = false;
    bot._task = 'idle';
    if (!isFollowing) startWander();
  }
}

// ── AI CONTROL PANEL (mini HTTP server) ───────────────────────────
// Phục vụ giao diện web riêng tại cổng BOT_PANEL_PORT (mặc định 8090)
// Truy cập: http://localhost:8090
function startAIPanelServer() {
  const PANEL_PORT = parseInt(process.env.BOT_PANEL_PORT || '8090');

  function getStatus() {
    const hp   = bot?.health  != null ? Math.round(bot.health)  : null;
    const food = bot?.food    != null ? Math.round(bot.food)    : null;
    const pos  = bot?.entity?.position
      ? `${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)}`
      : null;
    const pauseSec = _manualOverrideUntil > Date.now() ? Math.round((_manualOverrideUntil - Date.now()) / 1000) : 0;
    return {
      aiEnabled:       aiModeEnabled,
      paused:          pauseSec > 0,
      pauseSec,
      stage:           aiGameStage,
      botOnline,
      hp, food, pos,
      totalDecisions:  aiMemory.totalDecisions || 0,
      lastAction:      aiLastDecision ? `${aiLastDecision.action} — ${aiLastDecision.reason}` : null,
      lastTime:        aiLastDecision ? Math.round((Date.now() - aiLastDecision.time) / 60000) : null,
      chatKey:         CONFIG.geminiApiKey ? CONFIG.geminiApiKey.slice(0,4) + '****...' : null,
      aiKey:           CONFIG.aiDecisionKey ? CONFIG.aiDecisionKey.slice(0,4) + '****...' : null,
    };
  }

  const PANEL_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>3D2Y AI Panel</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
  h1{font-size:1.3rem;color:#00e5ff;letter-spacing:2px;margin-bottom:4px;text-align:center}
  .sub{color:#555;font-size:0.75rem;margin-bottom:20px;text-align:center}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:18px;width:100%;max-width:440px;margin-bottom:16px}
  .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:0.85rem}
  .row:last-child{margin-bottom:0}
  .lbl{color:#777}
  .val{color:#fff;font-weight:600}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:0.75rem;font-weight:700}
  .on{background:#00c85333;color:#00e676;border:1px solid #00e67644}
  .off{background:#ff000022;color:#ff5252;border:1px solid #ff525244}
  .pause{background:#ff900022;color:#ffab40;border:1px solid #ffab4044}
  .btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%;max-width:440px;margin-bottom:16px}
  .btn{padding:14px;border:none;border-radius:10px;font-size:0.92rem;font-weight:700;cursor:pointer;letter-spacing:.5px;transition:filter .15s}
  .btn:hover{filter:brightness(1.15)}
  .btn:active{filter:brightness(.85)}
  .btn-on{background:#00897b;color:#fff}
  .btn-off{background:#b71c1c;color:#fff}
  .btn-pause{background:#e65100;color:#fff}
  .btn-resume{background:#1565c0;color:#fff}
  .btn-status{background:#263238;color:#80deea;border:1px solid #37474f;grid-column:span 2}
  .log{background:#111;border:1px solid #222;border-radius:8px;padding:12px;font-size:0.75rem;font-family:monospace;color:#aaa;white-space:pre-wrap;max-height:180px;overflow-y:auto;width:100%;max-width:440px;margin-bottom:8px}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 20px;border-radius:20px;font-size:0.8rem;opacity:0;transition:opacity .3s;pointer-events:none}
  .toast.show{opacity:1}
  .keys{font-size:0.72rem;color:#444;margin-top:4px}
  .dim{color:#555}
</style>
</head>
<body>
<h1>🧠 3D2Y AI PANEL</h1>
<div class="sub">Bảng điều khiển AI — tự động cập nhật mỗi 5s</div>

<div class="card" id="statusCard">
  <div class="row"><span class="lbl">Trạng thái AI</span><span class="badge off" id="aiBadge">TẮT</span></div>
  <div class="row"><span class="lbl">Bot online</span><span class="val" id="botOnline">—</span></div>
  <div class="row"><span class="lbl">Giai đoạn</span><span class="val" id="stage">—</span></div>
  <div class="row"><span class="lbl">HP / Food</span><span class="val" id="hpFood">—</span></div>
  <div class="row"><span class="lbl">Vị trí</span><span class="val dim" id="pos">—</span></div>
  <div class="row"><span class="lbl">Quyết định</span><span class="val" id="totalDec">—</span></div>
  <div class="row"><span class="lbl">Lần cuối</span><span class="val dim" id="lastAct">—</span></div>
  <div class="keys"><span id="chatKey">Chat key: —</span> &nbsp;|&nbsp; <span id="aiKey">AI key: —</span></div>
</div>

<div class="btns">
  <button class="btn btn-on"    onclick="cmd('ai on')">🟢 BẬT AI</button>
  <button class="btn btn-off"   onclick="cmd('ai off')">🔴 TẮT AI</button>
  <button class="btn btn-pause" onclick="cmd('ai pause')">⏸ Tạm dừng 1h</button>
  <button class="btn btn-resume"onclick="cmd('ai resume')">▶ Tiếp tục</button>
  <button class="btn btn-status"onclick="cmd('ai status')">📋 Xem AI Status chi tiết</button>
</div>

<div class="log" id="logBox">Nhấn nút để điều khiển AI...</div>
<div class="toast" id="toast"></div>

<script>
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2000);
}
function appendLog(msg){
  const b=document.getElementById('logBox');
  b.textContent+=new Date().toLocaleTimeString()+' '+msg+'\\n';
  b.scrollTop=b.scrollHeight;
}
async function cmd(c){
  try{
    const r=await fetch('/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({c})});
    const j=await r.json();
    if(j.ok){showToast('✅ '+c);appendLog('→ '+c+(j.msg?' | '+j.msg:''));}
    else appendLog('❌ '+c+': '+(j.msg||'lỗi'));
  }catch(e){appendLog('❌ Lỗi kết nối: '+e.message);}
}
async function refresh(){
  try{
    const r=await fetch('/status');
    const s=await r.json();
    const badge=document.getElementById('aiBadge');
    if(s.aiEnabled&&s.paused){badge.textContent='⏸ PAUSE';badge.className='badge pause';}
    else if(s.aiEnabled){badge.textContent='🟢 BẬT';badge.className='badge on';}
    else{badge.textContent='🔴 TẮT';badge.className='badge off';}
    document.getElementById('botOnline').textContent=s.botOnline?'✅ Online':'❌ Offline';
    document.getElementById('stage').textContent=(s.stage||'—').toUpperCase();
    document.getElementById('hpFood').textContent=s.hp!=null?s.hp+'/20  ❤  '+s.food+'/20  🍗':'—';
    document.getElementById('pos').textContent=s.pos||'—';
    document.getElementById('totalDec').textContent=s.totalDecisions!=null?s.totalDecisions+' lần':'—';
    document.getElementById('lastAct').textContent=s.lastAction?(s.lastTime+'ph: '+s.lastAction):'chưa có';
    document.getElementById('chatKey').textContent='Chat key: '+(s.chatKey||'❌ chưa set');
    document.getElementById('aiKey').textContent='AI key: '+(s.aiKey||'(dùng chat key)');
  }catch(_){}
}
refresh(); setInterval(refresh,5000);
</script>
</body></html>`;

  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (req.method === 'GET' && u === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PANEL_HTML);
    }
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type' });
      return res.end();
    }
    const CORS = { 'Access-Control-Allow-Origin':'*' };
    if (req.method === 'GET' && u === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      return res.end(JSON.stringify(getStatus()));
    }
    if (req.method === 'POST' && u === '/cmd') {
      let body = '';
      let bodyLen = 0;
      const MAX_BODY = 4096;
      req.on('data', d => { bodyLen += d.length; if (bodyLen <= MAX_BODY) body += d; });
      req.on('end', () => {
        if (bodyLen > MAX_BODY) { res.writeHead(413, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify({ ok: false, msg: 'Request body too large' })); return; }
        try {
          const { c } = JSON.parse(body);
          const txt = (c || '').trim().toLowerCase();
          let msg = '';
          if (txt === 'ai on' || txt === 'bật ai') {
            if (!bot || !botOnline) { msg = 'Bot chưa online'; }
            else if (aiModeEnabled) { msg = 'AI đã bật rồi'; }
            else { startAIMode(); msg = 'AI Mode đã bật'; }
          } else if (txt === 'ai off' || txt === 'tắt ai') {
            if (aiModeEnabled) { stopAIMode(); msg = 'AI Mode đã tắt'; }
            else { msg = 'AI đã tắt rồi'; }
          } else if (txt === 'ai pause') {
            _manualOverrideUntil = Date.now() + 3600000;
            msg = 'AI tạm dừng 1 tiếng';
          } else if (txt === 'ai resume') {
            _manualOverrideUntil = 0;
            msg = 'AI tiếp tục';
          } else if (txt === 'ai status') {
            const s = getStatus();
            msg = `${s.aiEnabled ? '🟢 BẬT' : '🔴 TẮT'} | Stage: ${s.stage} | HP:${s.hp} Food:${s.food} | ${s.totalDecisions} quyết định`;
          }
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ ok: true, msg }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ ok: false, msg: e.message }));
        }
      });
      return;
    }
    res.writeHead(404, CORS); res.end('Not found');
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') logW(`[PANEL] Cổng ${PANEL_PORT} đã dùng — panel không khởi động`);
    else logW(`[PANEL] Lỗi: ${e.message}`);
  });

  const panelHost = process.env.PANEL_BIND || '127.0.0.1';
  server.listen(PANEL_PORT, panelHost, () => {
    logS(`[PANEL] 🖥️  AI Control Panel: http://${panelHost}:${PANEL_PORT}  (nút bật/tắt ở góc phải web console)`);
  });
}

// CORS headers cho mini panel server — cho phép web console (cổng khác) gọi API
const _CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── KHỞI ĐỘNG ─────────────────────────────────────────────────────
printBanner();
logS('Tự đánh: BẬT | Tự ăn: BẬT | Tự mặc giáp: BẬT | Tự chọn tool: BẬT');
startAIPanelServer();
waitForServerThenConnect();

// ── WEB CONSOLE STDIN INTERFACE ────────────────────────────────────
// ── HELP: liệt kê tất cả lệnh trong game chat ─────────────────────────
function botSayCommands() {
  if (!bot || !botOnline) return;
  const lines = [
    '=== 3D2Y Bot Commands ===',
    '[Stop] dung / stop / halt / cancel',
    '[Chat go] chat go / chop / chop wood / fell tree / cut wood',
    '[Dao da] dao da / mine stone / mine cobble / dig stone',
    '[Dao quang] dao quang [loai] / mine ore [diamond/iron/gold/coal/copper/redstone/lapis/emerald/netherite]',
    '[Strip] strip mine / stripmine / dao strip',
    '[Pha nha] pha nha / demolish / destroy house / break house',
    '[Nong] lam nong / farm / harvest / farming',
    '[Cau ca] cau ca / fish  |  Dung: dung cau / stop fish',
    '[Cay] trong cay / tree farm / plant tree',
    '[Farm da] farm da / cobble farm / cobblestone farm',
    '[Follow] theo [ten] / follow [name]',
    '[Bodyguard] bao ve [ten] / bodyguard [name] / protect [name] / guard [name]',
    '[Attack] danh [ten] / attack [name] / hit [name]',
    '[Ngu] ngu / sleep / go sleep / find bed',
    '[Thuyen] len thuyen / boat / board boat / get in boat',
    '[Giap] mac giap / equip armor / wear armor / armor up',
    '[Cat do] cat do / deposit / store / store items',
    '[Sap ruong] sap ruong / sort chest / sort / organize chest',
    '[Drop] vut [item] / drop [item]  |  Give: cho toi [item] / give [item]',
    '[San] lam san x y z x2 z2 [block] / platform x y z x2 z2 [block]',
    '[Xay] xay <file.litematic> / xay <file.schem> / xay <file.txt>',
    '[Dao block] dao [block_name] / mine [block_name] / dig [block_name]',
    '--- Baritone Features ---',
    '[Goto] den X Y Z / goto X Y Z  |  2D: den X Z / goto X Z',
    '[Scaffold] scaffold goto X Y Z  (bật tower+scaffold giống Baritone)',
    '[Excavate] dao ham W H L / excavate W H L  (toi da 20x10x20)',
    '[Veinmine] dao mach [ore] / veinmine [ore]  e.g. dao mach diamond',
    '[Surface] len mat dat / surface  (dao len mat dat)',
    '[Explore] kham pha / explore  (kham pha xoan oc)',
    '[Fill] fill x1 y1 z1 x2 y2 z2 [block]  (lap day vung 3D)',
    '[Wall] xay tuong x1 y1 z1 x2 y2 z2 [h] [block]  (xay tuong)',
    '[Schematic] xay <file.litematic/.schem/.txt>  (xay tu file)',
  ];
  let i = 0;
  const send = () => {
    if (i >= lines.length) return;
    try { bot.chat(lines[i]); } catch(_) {}
    i++;
    setTimeout(send, 600);
  };
  send();
}


  // ══════════════════════════════════════════════════════════════════════════════
  //  TÍNH NĂNG MỚI — Auto Brewing, Mob Farm AFK, Special Crops, Auto Loot,
  //                  Patrol, Return to Base, Inventory Dashboard, Stats, Discord
  // ══════════════════════════════════════════════════════════════════════════════

  // Discord helpers are defined at module level below createBot()


  // activityStats, activityLog, logActivity moved to module level
  const DISCORD_ALERT_KEYWORDS = ['bị kick', 'chết', 'inventory đầy', 'hoàn thành', 'lỗi'];
  function checkDiscordAlert(event) {
    const low = event.toLowerCase();
    if (DISCORD_ALERT_KEYWORDS.some(k => low.includes(k))) {
      sendDiscordAlert(event, { color: 'warn', title: '⚠️ ' + CONFIG.username + ' — Cảnh báo' });
    }
  }

  // ── BASE POSITION ─────────────────────────────────────────────────────────────
  let basePosition = null;
  const BASE_FILE = 'base_position.json';
  function loadBase() {
    try { if (fs.existsSync(BASE_FILE)) { basePosition = JSON.parse(fs.readFileSync(BASE_FILE,'utf8')); logS('[Base] Nhà: (' + basePosition.x + ',' + basePosition.y + ',' + basePosition.z + ')'); } } catch(e) {}
  }
  function setBase(who) {
    if (!bot || !bot.entity) return;
    const p = bot.entity.position;
    basePosition = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    try { fs.writeFileSync(BASE_FILE, JSON.stringify(basePosition)); } catch(e) {}
    logS('[Base] Đặt nhà tại (' + basePosition.x + ',' + basePosition.y + ',' + basePosition.z + ')');
    if (bot) bot.chat('Đã đặt nhà tại (' + basePosition.x + ',' + basePosition.y + ',' + basePosition.z + ')');
    logActivity('Đặt vị trí nhà tại (' + basePosition.x + ',' + basePosition.y + ',' + basePosition.z + ')');
    sendDiscordAlert('Tại `(' + basePosition.x + ', ' + basePosition.y + ', ' + basePosition.z + ')`', { color: 'success', title: '🏠 Đặt nhà' });
  }
  async function goHome(who) {
    if (!basePosition) { if (bot) bot.chat('Chưa đặt nhà! Dùng "đặt nhà" / "set base".'); return; }
    const prevTask = bot ? bot._task : 'idle';
    if (bot) bot._task = 'về nhà';
    isBusy = true;
    logS('[' + (who||'auto') + '] Về nhà tại (' + basePosition.x + ',' + basePosition.y + ',' + basePosition.z + ')');
    if (bot) bot.chat('Đang về nhà...');
    refreshMovements(true);
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(basePosition.x, basePosition.y, basePosition.z, 3)),
        new Promise((_,rej) => setTimeout(() => rej(new Error('nav timeout')), 90000)),
      ]);
      if (bot) bot.chat('Đã về nhà!');
      logS('[Base] Đã về nhà');
      activityStats.returnedToBase++;
      logActivity('Về nhà thành công tại (' + basePosition.x + ',' + basePosition.y + ',' + basePosition.z + ')');
      sendDiscordAlert('Đã về nhà thành công!', { color: 'success', title: '🏠 Về nhà' });
    } catch(e) {
      logW('[Base] Không về được nhà: ' + e.message);
      if (bot) bot.chat('Không tìm được đường về nhà!');
    } finally {
      isBusy = false;
      if (bot) bot._task = prevTask === 'về nhà' ? 'idle' : prevTask;
      if (!isFollowing) startWander();
    }
  }
  loadBase();

  // ── AUTO LOOT NEARBY ──────────────────────────────────────────────────────────
  _autoLootNearbyFn = (r) => autoLootNearby(r);
  async function autoLootNearby(radius) {
    if (!bot || !botOnline || _autoLootBusy) return; // isBusy removed: loot works inside tasks too
    _autoLootBusy = true;
    try {
      const r = radius || 6;
      const items = [];
      for (const entity of Object.values(bot.entities)) {
        if (!entity || !entity.position || entity === bot.entity) continue;
        // Chỉ nhặt dropped item (entity.name === 'item')
        if (entity.name !== 'item') continue;
        const dist = bot.entity.position.distanceTo(entity.position);
        if (dist <= r && dist > 0.5) items.push(entity);
      }
      for (const item of items.slice(0, 8)) {
        if (stopTask) break; // dừng nếu task bị huỷ
        try {
          await Promise.race([
            bot.pathfinder.goto(new GoalNear(item.position.x, item.position.y, item.position.z, 1)),
            new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
          ]);
          activityStats.itemsLooted++;
        } catch(e) {}
      }
    } finally {
      _autoLootBusy = false;
    }
  }

  // ── WAYPOINT & PATROL ─────────────────────────────────────────────────────────
  let waypoints = [];
  let isPatrolling = false;
  const WAYPOINTS_FILE = 'waypoints.json';

  function loadWaypoints() {
    try { if (fs.existsSync(WAYPOINTS_FILE)) { waypoints = JSON.parse(fs.readFileSync(WAYPOINTS_FILE,'utf8')); logS('[Patrol] Tải ' + waypoints.length + ' waypoints'); } } catch(e) {}
  }
  function saveWaypoints() {
    try { fs.writeFileSync(WAYPOINTS_FILE, JSON.stringify(waypoints)); } catch(e) {}
  }
  function addWaypoint(name) {
    if (!bot || !bot.entity) { if (bot) bot.chat('Bot chưa online!'); return; }
    const p = bot.entity.position;
    const wp = { name: name || ('WP' + (waypoints.length + 1)), x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    waypoints.push(wp);
    saveWaypoints();
    logS('[Patrol] Thêm waypoint: ' + wp.name + ' (' + wp.x + ',' + wp.y + ',' + wp.z + ')');
    if (bot) bot.chat('Đã thêm waypoint: ' + wp.name + ' (' + wp.x + ',' + wp.y + ',' + wp.z + ')');
    logActivity('Thêm waypoint ' + wp.name);
  }
  function listWaypoints() {
    if (!waypoints.length) { if (bot) bot.chat('Chưa có waypoint nào.'); return; }
    bot.chat('Có ' + waypoints.length + ' waypoints: ' + waypoints.map(w => w.name).join(', '));
  }
  function removeWaypoint(name) {
    const before = waypoints.length;
    waypoints = waypoints.filter(w => w.name.toLowerCase() !== name.toLowerCase());
    saveWaypoints();
    if (bot) bot.chat(before !== waypoints.length ? 'Đã xóa waypoint: ' + name : 'Không tìm thấy waypoint: ' + name);
  }
  function clearWaypoints() {
    waypoints = [];
    saveWaypoints();
    if (bot) bot.chat('Đã xóa tất cả waypoints');
    logS('[Patrol] Xóa tất cả waypoints');
  }
  async function startPatrol(who) {
    if (!waypoints.length) { if (bot) bot.chat('Chưa có waypoint! Dùng "thêm wp" hoặc "add waypoint".'); return; }
    isPatrolling = true; isBusy = true; stopTask = false;
    if (bot) { bot._task = 'tuần tra'; bot.chat('Bắt đầu tuần tra ' + waypoints.length + ' điểm'); }
    logS('[' + who + '] Tuần tra ' + waypoints.length + ' waypoints');
    logActivity('Bắt đầu tuần tra ' + waypoints.length + ' waypoints');
    sendDiscordAlert('Bắt đầu tuần tra **' + waypoints.length + '** điểm', { color: 'info', title: '🗺️ Tuần tra', extraFields: getInventoryFields() });
    refreshMovements(true);
    let idx = 0;
    try {
    while (!stopTask && isPatrolling && waypoints.length > 0) {
      const wp = waypoints[idx % waypoints.length];
      logS('[Patrol] → ' + wp.name + ' (' + wp.x + ',' + wp.y + ',' + wp.z + ')');
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(wp.x, wp.y, wp.z, 3)),
          new Promise((_,rej) => setTimeout(() => rej(new Error('nav timeout')), 20000)),
        ]);
        if (bot) bot.chat('Đến: ' + wp.name);
        activityStats.waypointsVisited++;
        logActivity('Đến waypoint ' + wp.name);
        // Nhặt loot xung quanh tại mỗi điểm
        await autoLootNearby(8);
        await new Promise(r => setTimeout(r, 2000));
      } catch(e) { logW('[Patrol] Không đến được ' + wp.name + ': ' + e.message); await new Promise(r => setTimeout(r, 1000)); }
      idx++;
      await new Promise(r => setTimeout(r, 100));
    }
    } finally {
      isPatrolling = false; isBusy = false;
      if (bot) bot.chat('Đã dừng tuần tra');
      if (!isFollowing) startWander();
    }
  }
  function stopPatrol(silent = false) {
    if (!isPatrolling) return; // không đang tuần tra → bỏ qua
    isPatrolling = false; stopTask = true;
    logS('[Patrol] Dừng tuần tra');
    if (bot && !silent) bot.chat('Đã dừng tuần tra');
  }
  _stopPatrolFn = () => stopPatrol(true); // gọi từ resetState: silent=true
  loadWaypoints();

  // ── MOB FARM AFK ──────────────────────────────────────────────────────────────
  let mobFarmInterval = null;
  let isMobFarming = false;
  let mobFarmAntiAfkTick = 0;

  function startMobFarmAFK(who) {
    if (mobFarmInterval) { clearInterval(mobFarmInterval); mobFarmInterval = null; }
    isMobFarming = true; isBusy = true; stopTask = false;
    if (bot) { bot._task = 'mob farm AFK'; bot.chat('AFK tại mob farm. Gõ "dừng" để dừng.'); }
    logS('[' + who + '] Mob Farm AFK bắt đầu');
    logActivity('Bắt đầu Mob Farm AFK');
    sendDiscordAlert('Bắt đầu Mob Farm AFK', { color: 'info', title: '⚔️ Mob Farm', extraFields: getInventoryFields() });
    mobFarmAntiAfkTick = 0;
    mobFarmInterval = setInterval(async () => {
      if (!bot || !botOnline || stopTask) { clearInterval(mobFarmInterval); mobFarmInterval = null; isMobFarming = false; isBusy = false; return; }
      mobFarmAntiAfkTick++;
      // Anti-AFK: nhảy mỗi ~1 phút (30 ticks × 2s)
      if (mobFarmAntiAfkTick % 30 === 0) {
        try { bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 120)); bot.setControlState('jump', false); } catch(e) {}
        logS('[MobFarm] Anti-AFK jump');
      }
      // Tấn công mob trong 5m
      let nearest = null, minD = Infinity;
      for (const e of Object.values(bot.entities)) {
        if (!e || e === bot.entity || !e.position) continue;
        if (!HOSTILE_MOBS.has(e.name || e.mobType || '')) continue;
        const d = bot.entity.position.distanceTo(e.position);
        if (d < minD && d <= 5) { minD = d; nearest = e; }
      }
      if (nearest) {
        try { await equipBestWeapon(); bot.pvp.attack(nearest); } catch(e) {} // mobsKilled via entityDead
      }
      // Nhặt loot xung quanh 8m
      await autoLootNearby(8);
      // Auto ăn
      if (autoEatEnabled) await autoEat();
      // Trả về base nếu inventory đầy
      if (autoReturnEnabled && basePosition && isInventoryFull()) {
        logS('[MobFarm] Inventory đầy → về nhà');
        logActivity('Inventory đầy, về nhà cất đồ');
        sendDiscordAlert('Inventory đầy — đang về nhà cất đồ!', { color: 'warn', title: '🎒 Inventory Đầy', extraFields: getInventoryFields() });
        clearInterval(mobFarmInterval); mobFarmInterval = null;
        await goHome('auto');
        // Quay lại farm sau khi về
        if (!stopTask) startMobFarmAFK('auto');
      }
    }, 2000);
  }
  function stopMobFarmAFK(silent = false) {
    if (!isMobFarming && !mobFarmInterval) return; // không đang chạy → bỏ qua
    if (mobFarmInterval) { clearInterval(mobFarmInterval); mobFarmInterval = null; }
    isMobFarming = false; isBusy = false;
    logS('[MobFarm] Dừng');
    if (bot && !silent) bot.chat('Đã dừng Mob Farm AFK');
  }
  _stopMobFarmFn = () => stopMobFarmAFK(true); // gọi từ resetState: silent=true

  // ── AUTO RETURN TO BASE FLAGS ─────────────────────────────────────────────────
  let autoReturnEnabled = true;
  // Kiểm tra tự động về nhà mỗi 30s (cho các task khác, không chỉ mob farm)
  setInterval(async () => {
    if (!bot || !botOnline || !autoReturnEnabled || !basePosition || isBusy || isFollowing || isMobFarming || isPatrolling || isStandingStill || _autoReturning) return;
    if (isInventoryFull()) {
      _autoReturning = true;
      try {
        logS('[AutoReturn] Inventory đầy → về nhà');
        logActivity('Inventory đầy, tự động về nhà');
        sendDiscordAlert('🎒 **' + CONFIG.username + '** inventory đầy! Đang về nhà...');
        resetState();
        await new Promise(r => setTimeout(r, 200));
        stopTask = false;
        await goHome('auto');
      } finally { _autoReturning = false; }
    }
  }, 30000);

  // ── AUTO BREWING ──────────────────────────────────────────────────────────────
  const BREW_RECIPE_INGREDIENTS = [
    'nether_wart','sugar','rabbit_foot','glistering_melon_slice','spider_eye',
    'fermented_spider_eye','ghast_tear','golden_carrot','pufferfish','magma_cream',
    'phantom_membrane','turtle_helmet','dragon_breath','gunpowder','glowstone_dust',
    'redstone','golden_apple','enchanted_golden_apple',
  ];
  async function autoBrewing(who) {
    isBusy = true; stopTask = false;
    if (bot) { bot._task = 'pha thuốc'; bot.chat('Tìm Brewing Stand...'); }
    logS('[' + who + '] Auto Brewing bắt đầu');

    // Tìm brewing stand
    const brewBlock = bot.findBlock({ matching: b => b && b.name === 'brewing_stand', maxDistance: 32 });
    if (!brewBlock) { if (bot) bot.chat('Không có Brewing Stand trong 32m!'); isBusy = false; if (!isFollowing) startWander(); return; }

    // Di chuyển đến
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalNear(brewBlock.position.x, brewBlock.position.y, brewBlock.position.z, 2)),
        new Promise((_,rej) => setTimeout(() => rej(new Error('nav timeout')), 15000)),
      ]);
    } catch(e) { if (bot) bot.chat('Không đến được Brewing Stand!'); isBusy = false; return; }

    // Mở brewing stand
    let window;
    try { window = await bot.openBlock(brewBlock); }
    catch(e) { if (bot) bot.chat('Không mở được Brewing Stand: ' + e.message); isBusy = false; return; }

    try {
      const inv = bot.inventory.items();

      // Bỏ blaze powder vào slot nhiên liệu (slot 4)
      const fuel = inv.find(i => i.name === 'blaze_powder');
      if (fuel) {
        const fuelSlot = window.slots[4];
        if (!fuelSlot || fuelSlot.name !== 'blaze_powder') {
          try { await bot.moveSlotItem(fuel.slot, 4); await new Promise(r => setTimeout(r, 300)); } catch(e) {}
        }
      } else { if (bot) bot.chat('Cảnh báo: Không có Blaze Powder để làm nhiên liệu!'); }

      // Tìm nguyên liệu pha
      let ingredient = null;
      for (const name of BREW_RECIPE_INGREDIENTS) {
        const it = bot.inventory.items().find(i => i.name === name);
        if (it) { ingredient = it; break; }
      }
      if (!ingredient) { if (bot) bot.chat('Không có nguyên liệu pha thuốc!'); window.close(); isBusy = false; return; }

      // Bỏ nguyên liệu vào slot 3
      try { await bot.moveSlotItem(ingredient.slot, 3); await new Promise(r => setTimeout(r, 300)); } catch(e) {}

      // Bỏ water bottle / potion vào 3 slot (0,1,2)
      const bottles = bot.inventory.items().filter(i => i.name === 'potion' || i.name === 'water_bottle' || i.name === 'splash_potion' || i.name === 'lingering_potion');
      for (let s = 0; s < 3; s++) {
        if (!bottles[s]) break;
        try { await bot.moveSlotItem(bottles[s].slot, s); await new Promise(r => setTimeout(r, 200)); } catch(e) {}
      }

      if (bot) bot.chat('Đang pha ' + ingredient.name.replace(/_/g,' ') + '... (~20s)');
      logS('[Brewing] Pha ' + ingredient.name + '...');

      // Chờ pha xong (~20 giây)
      await new Promise(r => setTimeout(r, 21000));

      // Lấy potion ra
      let brewed = 0;
      for (let s = 0; s < 3; s++) {
        const slot = window.slots[s];
        if (slot && slot.name !== 'air' && slot.name !== 'water_bottle' && slot.name !== 'potion') {
          const emptySlot = bot.inventory.firstEmptyInventorySlot();
          if (emptySlot !== null) { try { await bot.moveSlotItem(s, emptySlot); brewed++; await new Promise(r => setTimeout(r, 200)); } catch(e) {} }
        }
      }

      activityStats.potionsBrewed += brewed;
      logActivity('Pha xong ' + brewed + ' thuốc (' + ingredient.name.replace(/_/g,' ') + ')');
      sendDiscordAlert('Pha xong **' + brewed + '** lọ `' + ingredient.name.replace(/_/g,' ') + '`', { color: 'success', title: '🧪 Hoàn thành pha thuốc', extraFields: getInventoryFields() });
      if (bot) bot.chat('Đã pha xong ' + brewed + ' thuốc!');
      logS('[Brewing] Xong: ' + brewed + ' thuốc');
    } finally {
      try { window.close(); } catch(e) {}
      isBusy = false;
      if (!isFollowing) startWander();
    }
  }

  // ── AUTO FARM ĐẶC BIỆT (Sugarcane, Nether Wart, Bamboo, Cactus) ───────────────
  const SPECIAL_CROPS = [
    { name: 'sugar_cane',   harvestName: 'sugar_cane',    keepBase: true,  maxHeight: 3, replant: false },
    { name: 'bamboo',       harvestName: 'bamboo',         keepBase: true,  maxHeight: 3, replant: false },
    { name: 'cactus',       harvestName: 'cactus',         keepBase: true,  maxHeight: 2, replant: false },
    { name: 'nether_wart',  harvestName: 'nether_wart',    keepBase: false, maxAge: 3,   replant: true, seed: 'nether_wart' },
  ];

  async function doFarmSpecial(who) {
    stopTask = false; isBusy = true;
    if (bot) { bot._task = 'farm đặc biệt'; bot.chat('Thu hoạch mía/tre/nether wart...'); }
    logS('[' + who + '] Farm đặc biệt bắt đầu');
    let harvested = 0;
    try {
    while (!stopTask) {
      let target = null;

      // Sugar cane / Bamboo / Cactus — đào block phía trên (index 1+), giữ lại base
      for (const sc of SPECIAL_CROPS) {
        if (!mcData) continue;
        const def = mcData.blocksByName[sc.name]; if (!def) continue;
        
        if (sc.keepBase) {
          // Tìm block loại này ở Y bất kỳ, nhưng block phía dưới cũng là cùng loại (tức là không phải base)
          const found = bot.findBlock({
            matching: b => {
              if (!b || b.type !== def.id) return false;
              const below = bot.blockAt(b.position.offset(0,-1,0));
              return below && below.type === def.id; // block này không phải base
            },
            maxDistance: 32,
          });
          if (found) { target = { block: found, kind: 'special', sc }; break; }
        } else if (sc.maxAge !== undefined) {
          // Nether wart: đợi đủ tuổi
          const found = bot.findBlock({
            matching: b => { try { return b && b.type === def.id && (b.getProperties?.()?.age ?? 0) >= sc.maxAge; } catch(_) { return false; } },
            maxDistance: 32,
          });
          if (found) { target = { block: found, kind: 'netherwart', sc }; break; }
        }
      }

      if (!target) { if (bot) bot.chat('Thu hoạch đặc biệt xong! +' + harvested + ' lượt'); logS('[FarmSpecial] Xong: ' + harvested); break; }

      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalLookAtBlock(target.block.position, bot.world)),
          new Promise((_,rej) => setTimeout(() => rej(new Error('nav timeout')), 10000)),
        ]);
        await bot.dig(target.block);
        harvested++;
        activityStats.specialCropHarvested++;

        // Nether wart: trồng lại nếu có
        if (target.kind === 'netherwart' && target.sc.replant) {
          const seedDef = mcData.itemsByName[target.sc.seed];
          if (seedDef) {
            const seed = bot.inventory.findInventoryItem(seedDef.id, null, false);
            if (seed) {
              try {
                await bot.equip(seed, 'hand');
                const soilPos = target.block.position.offset(0,-1,0);
                const soil = bot.blockAt(soilPos);
                if (soil && (soil.name === 'soul_sand' || soil.name === 'soul_soil')) {
                  await bot.placeBlock(soil, new Vec3(0,1,0));
                }
              } catch(e) {}
            }
          }
        }

        // Nhặt loot
        await new Promise(r => setTimeout(r, 300));
        await autoLootNearby(4);
      } catch(e) { logW('[FarmSpecial] ' + e.message); await new Promise(r => setTimeout(r, 500)); }
      await new Promise(r => setTimeout(r, 100));
    }
    } finally {
      logActivity('Farm đặc biệt: thu hoạch ' + harvested + ' lượt');
      isBusy = false;
      if (!isFollowing) startWander();
    }
  }

  process.stdin.resume();
process.stdin.setEncoding('utf8');
let _stdinBuf = '';
process.stdin.on('data', chunk => {
  _stdinBuf += chunk;
  let nl;
  while ((nl = _stdinBuf.indexOf('\n')) !== -1) {
    const line = _stdinBuf.slice(0, nl).trim();
    _stdinBuf = _stdinBuf.slice(nl + 1);
    if (!line) continue;
    try { handleWebCmd(JSON.parse(line)); } catch(e) {}
  }
});

function handleWebCmd(cmd) {
  if (cmd.type === 'chat') {
    if (bot && botOnline) try { bot.chat(String(cmd.msg||'').slice(0,256)); } catch(e){}
    return;
  }
  if (cmd.type === 'command') {
    const raw = String(cmd.msg||'');
    const txt = raw.toLowerCase().trim();
    // Config/AI commands không cần bot online — chỉ gameplay mới cần
    const _needsBotOnline = !txt.startsWith('set ai') && !txt.startsWith('set gemini') &&
      !txt.startsWith('set chat') && !txt.startsWith('set decision') && !txt.startsWith('add ai') &&
      !txt.startsWith('remove ai') && !txt.startsWith('clear ai') && !txt.startsWith('list ai') &&
      !txt.startsWith('set discord') && !txt.startsWith('discord') && !txt.startsWith('webhook') &&
      !['test ai','test gemini','check ai','test ai decision','check decision key',
        'check decision','ai status','ai mode','ai?','ai info','ai on','bật ai','bat ai',
        'ai mode on','enable ai','ai off','tắt ai','tat ai','ai mode off','disable ai',
        'ai pause','ai tạm dừng','ai tam dung','ai hold','ai resume','ai takeover',
        'status keys','key status','quota status','status quota','check keys','list keys',
        'ai keys','keys','list ai keys','key info','keys info','key?'].includes(txt);
    if (_needsBotOnline && (!bot || !botOnline)) {
      console.log('⚠️ Bot chưa kết nối — lệnh gameplay cần bot online. Config/AI/set key hoạt động khi bot offline.');
      return;
    }
    const user = '__WebConsole__';
    if (bot && botOnline) { resetState(); isBusy = true; }
    setTimeout(() => {
      if (bot && botOnline) { isBusy = false; stopTask = false; }
      // ── STOP ──────────────────────────────────────────────────────────
      if (['dừng','stop','dung','halt','cancel'].includes(txt)) { bot._task='idle'; setTimeout(() => { if (!isBusy && !isFollowing) startWander(); }, 650); }
      // ── ĐỨNG YÊN / STAND ──────────────────────────────────────────────
      else if (txt==='đứng yên'||txt==='dung yen'||txt==='stand'||txt==='stand still') { isStandingStill=true; bot._task='đứng yên'; try{bot.pathfinder.setGoal(null);}catch(_){} try{bot.clearControlStates();}catch(_){} if(bot)bot.chat('Đứng yên tại chỗ!'); }
      // ── CHẶT GỖ / CHOP WOOD ───────────────────────────────────────────
      // Dùng autoTreeFarm: leo cây đúng (canDig=true) + chặt từ gốc lên đỉnh
      else if (txt.includes('chặt gỗ')||txt.includes('chặt cây')||txt.includes('chop wood')||txt.includes('chop tree')||txt.includes('fell tree')||txt==='chop'||txt==='cut wood') { resetState(); setTimeout(()=>{stopTask=false; autoTreeFarm(user);},150); }
      // ── ĐÀO ĐÁ / MINE STONE ──────────────────────────────────────────
      else if (txt.includes('đào đá')||txt.includes('dao da')||txt.includes('mine stone')||txt.includes('mine cobble')||txt.includes('dig stone')) doTask('mine',user);
      // ── ĐÀO QUẶNG / MINE ORE ─────────────────────────────────────────
      else if (txt.includes('đào quặng')||txt.includes('khai thác')||txt.includes('mine ore')||txt.includes('mine ores')||txt.includes('ore mining')) {
        const ORE_ALIAS_WEB = {
          'kim cương':'diamond_ore','diamond':'diamond_ore',
          'sắt':'iron_ore','iron':'iron_ore',
          'vàng':'gold_ore','gold':'gold_ore',
          'than':'coal_ore','coal':'coal_ore',
          'đồng':'copper_ore','copper':'copper_ore',
          'đá đỏ':'redstone_ore','redstone':'redstone_ore',
          'lapis':'lapis_ore','ngọc lục bảo':'emerald_ore','emerald':'emerald_ore',
          'cổ':'ancient_debris','ancient':'ancient_debris','netherite':'ancient_debris',
        };
        let tgtWeb = null;
        for (const [k,v] of Object.entries(ORE_ALIAS_WEB)) { if (txt.includes(k)) { tgtWeb = v; break; } }
        mineOres(user, tgtWeb);
      }
      // ── PHÁ NHÀ / DEMOLISH ────────────────────────────────────────────
      else if (txt.includes('đào nhà')||txt.includes('phá nhà')||txt.includes('pha nha')||txt.includes('demolish')||txt.includes('destroy house')||txt.includes('break house')) doTask('demolish',user);
      // ── LÀM NÔNG / FARM ───────────────────────────────────────────────
      else if ((txt.includes('làm nông')||txt.includes('farm')||txt.includes('thu hoạch')||txt.includes('harvest')||txt.includes('farming'))&&!txt.includes('mob farm')&&!txt.includes('afk farm')&&!txt.includes('farm mob')&&!txt.includes('cobble farm')&&!txt.includes('cobblestone farm')&&!txt.includes('stone farm')&&!txt.includes('tree farm')&&!txt.includes('trồng cây')&&!txt.includes('trong cay')&&!txt.includes('farm đá')&&!txt.includes('farm da')&&!txt.includes('farm mía')&&!txt.includes('farm mia')&&!txt.includes('farm đặc biệt')&&!txt.includes('farm nether wart')&&!txt.includes('farm tre')) doFarm(user);
      // ── MẶC GIÁP / EQUIP ARMOR ────────────────────────────────────────
      else if (txt.includes('mặc giáp')||txt.includes('mac giap')||txt.includes('equip armor')||txt.includes('wear armor')||txt.includes('armor up')||txt.includes('put on armor')) equipBestArmor();
      // ── CẤT ĐỒ / DEPOSIT ──────────────────────────────────────────────
      else if (txt.includes('cất đồ')||txt.includes('cat do')||txt.includes('deposit')||txt.includes('store items')||txt.includes('chest store')||txt==='store') depositToChest(user);
      // ── THEO / FOLLOW ─────────────────────────────────────────────────
      else if (txt.startsWith('theo ')||txt.startsWith('follow ')) {
        const t=raw.trim().replace(/^(theo|follow)\s+/i,'').trim();
        if(t) { resetState(); setTimeout(()=>{ stopTask=false; startFollow(t); },150); }
      }
      // ── NGỦ / SLEEP ───────────────────────────────────────────────────
      else if (txt.includes('ngủ')||txt.includes('ngu di')||txt==='sleep'||txt.includes('go sleep')||txt.includes('go to sleep')||txt.includes('find bed')) goSleep(user);
      // ── LÊN THUYỀN / BOARD BOAT ───────────────────────────────────────
      else if (txt.includes('lên thuyền')||txt.includes('len thuyen')||txt.includes('thuyền')||txt==='boat'||txt.includes('board boat')||txt.includes('board ship')||txt.includes('get in boat')) boardBoat(user);
      // ── VỨT ĐỒ / DROP ─────────────────────────────────────────────────
      else if (txt.startsWith('vứt ')||txt.startsWith('vut ')||txt.startsWith('drop ')) {
        const q=raw.trim().replace(/^(vứt|vut|drop)\s+/i,'').trim();
        if(q) dropItem(q,user);
      }
      // ── ĐÁNH NGƯỜI / ATTACK PLAYER ────────────────────────────────────
      else if (txt.startsWith('đánh ')||txt.startsWith('danh ')||txt.startsWith('tấn công ')||txt.startsWith('attack ')||txt.startsWith('hit ')) {
        const t=raw.trim().split(/\s+/).slice(1).join(' ').trim();
        if(t) attackPlayer(t,user);
      }
      // ── LÀM SÀN / PLATFORM ────────────────────────────────────────────
      else if (txt.startsWith('platform ')||txt.startsWith('làm sàn ')||txt.startsWith('lam san ')||txt.startsWith('xây sàn ')||txt.startsWith('xay san ')||txt.startsWith('build platform ')) {
        const parts=raw.trim().split(/\s+/);
        const skip=/^(platform|build platform)/.test(txt)?1:2;
        const args=parts.slice(skip);
        if(args.length>=5){ const [sx1,sy,sz1,sx2,sz2,...blkP]=args; buildPlatform(parseInt(sx1),parseInt(sy),parseInt(sz1),parseInt(sx2),parseInt(sz2),blkP[0]||'stone',user); }
        else bot.chat('Usage: platform x1 y z1 x2 z2 [block]  or  làm sàn x1 y z1 x2 z2 [block]');
      }
      // ── CÂU CÁ / FISH ─────────────────────────────────────────────────
      else if (txt.startsWith('câu cá')||txt.startsWith('cau ca')||txt==='fish'||txt.startsWith('auto fish')||txt==='fishing'||txt.startsWith('start fish')) { resetState(); setTimeout(()=>{stopTask=false;startAutoFish(user);},150); }
      // ── DỪNG CÂU / STOP FISHING ───────────────────────────────────────
      else if (txt.includes('dừng câu')||txt.includes('dung cau')||txt.includes('stop fish')||txt.includes('stop fishing')) stopAutoFish();
      // ── TRỒNG CÂY / TREE FARM ─────────────────────────────────────────
      else if (txt.startsWith('trồng cây')||txt.startsWith('trong cay')||txt.includes('tree farm')||txt.includes('plant tree')||txt.startsWith('plant sapling')) { resetState(); setTimeout(()=>{stopTask=false;autoTreeFarm(user);},150); }
      // ── FARM ĐÁ / COBBLE FARM ─────────────────────────────────────────
      else if (txt.startsWith('farm đá')||txt.startsWith('farm da')||txt.includes('cobble farm')||txt.includes('cobblestone farm')||txt.includes('stone farm')) { resetState(); setTimeout(()=>{stopTask=false;autoCobbleFarm(user);},150); }
      // ── STRIP MINE ────────────────────────────────────────────────────
      // Usage: strip mine [y] [length] [branchLen]  e.g.: strip mine -58 80 16
      else if (txt.startsWith('strip mine')||txt.includes('đào strip')||txt.includes('dao strip')||txt==='stripmine') {
        const parts = raw.trim().split(/\s+/);
        const nums = parts.slice(2).map(Number).filter(v=>!isNaN(v));
        const opts = { y: nums[0] ?? -58, len: nums[1] ?? 64, branchLen: nums[2] ?? 16 };
        resetState(); setTimeout(()=>{stopTask=false;stripMine('WebConsole',opts);},150);
      }
      // ── XÂY LIST (web console) ─────────────────────────────────────────
      else if (txt==='xây list'||txt==='xay list'||txt==='build list'||txt==='list schematic'||txt==='list schematics') {
        const files=listSchematics();
        if(bot) bot.chat(files.length ? `[Schematic] ${files.length} file: ${files.join(' | ')}` : 'Chưa có file. Đặt .litematic/.schem/.txt vào thư mục schematics/');
      }
      // ── XÂY RESUME (web console) ───────────────────────────────────────
      else if (txt==='xây resume'||txt==='xay resume'||txt==='resume build'||txt==='build resume') {
        resetState(); setTimeout(()=>{stopTask=false;resumeBuild('WebConsole');},150);
      }
      // ── XÂY SCHEMATIC (web console v2) ─────────────────────────────────
      else if (txt.startsWith('xây ')||txt.startsWith('xay ')||txt.startsWith('xây file ')||txt.startsWith('xay file ')||txt.startsWith('build file ')||txt.startsWith('schematic ')||txt.startsWith('build schematic')) {
        const ww=raw.trim().split(/\s+/);
        const sk=(txt.startsWith('build file')||txt.startsWith('xây file')||txt.startsWith('xay file'))?2:1;
        const fn=ww.slice(sk).join(' ').trim();
        if(fn){resetState();setTimeout(()=>{stopTask=false;buildSchematic(fn,user);},150);}
        else if(bot) bot.chat('Usage: xây <file>  |  xây list  |  xây resume');
      }
      // ── BẢO VỆ / BODYGUARD ────────────────────────────────────────────
      else if (txt.startsWith('bảo vệ ')||txt.startsWith('bao ve ')||txt.startsWith('bodyguard ')||txt.startsWith('protect ')||txt.startsWith('guard ')) {
        const t=raw.trim().replace(/^(bảo vệ|bao ve|bodyguard|protect|guard)\s+/i,'').trim();
        if(t){resetState();setTimeout(()=>{stopTask=false;startBodyguard(t,user);},150);}
        else bot.chat('Usage: bodyguard <player>  or  bảo vệ <tên>');
      }
      // ── SẮP RƯƠNG / SORT CHEST ────────────────────────────────────────
      else if (txt.includes('sắp rương')||txt.includes('sap ruong')||txt.includes('sort chest')||txt==='sort'||txt.includes('organize chest')) { resetState(); setTimeout(()=>{stopTask=false;sortChest(user);},150); }
      // ── CHO TÔI / GIVE ────────────────────────────────────────────────
      else if (txt.startsWith('cho tôi ')||txt.startsWith('cho toi ')||txt.startsWith('give ')) {
        const q=raw.trim().replace(/^(cho tôi|cho toi|give)\s+/i,'').trim();
        if(q) dropItem(q,user);
        else bot.chat('Usage: give <item>  or  cho tôi <item>');
      }
      // ── ĐẶT NHÀ / SET BASE ─────────────────────────────────────────────
        else if (txt==='đặt nhà'||txt==='dat nha'||txt==='set base'||txt==='setbase') { setBase('WebConsole'); }
        // ── FARM SET / ĐẶT VỊ TRÍ FARM ────────────────────────────────────
        else if (txt==='farm set'||txt==='set farm'||txt==='dat farm'||txt==='đặt farm'||txt.startsWith('farm set ')) { setFarmOrigin('WebConsole'); }
        // ── VỀ NHÀ / GO HOME ─────────────────────────────────────────────
        else if (txt==='về nhà'||txt==='ve nha'||txt==='go home'||txt==='home') { resetState(); setTimeout(()=>{stopTask=false;goHome('WebConsole');},150); }
        // ── THÊM WAYPOINT ─────────────────────────────────────────────────
        else if (txt.startsWith('thêm wp')||txt.startsWith('them wp')||txt.startsWith('add waypoint')||txt.startsWith('add wp')) {
          const wname2=raw.trim().split(/\s+/).slice(2).join(' ').trim(); addWaypoint(wname2);
        }
        // ── XEM WAYPOINTS ─────────────────────────────────────────────────
        else if (txt==='danh sách wp'||txt==='ds wp'||txt==='list wp'||txt==='waypoints') { listWaypoints(); }
        // ── XÓA WAYPOINTS ─────────────────────────────────────────────────
        else if (txt.startsWith('xóa wp')||txt.startsWith('xoa wp')||txt.startsWith('remove wp')) {
          const wname3=raw.trim().split(/\s+/).slice(2).join(' ').trim(); if(wname3) removeWaypoint(wname3); else clearWaypoints();
        }
        else if (txt==='xóa hết wp'||txt==='xoa het wp'||txt==='clear waypoints'||txt==='clear wp') { clearWaypoints(); }
        // ── TUẦN TRA / PATROL ─────────────────────────────────────────────
        else if (txt==='tuần tra'||txt==='tuan tra'||txt==='patrol'||txt.startsWith('patrol')) { resetState(); setTimeout(()=>{stopTask=false;startPatrol('WebConsole');},150); }
        // ── MOB FARM AFK ──────────────────────────────────────────────────
        else if (txt.includes('mob farm')||txt.includes('afk farm')||txt.includes('farm mob')||txt==='afk') { resetState(); setTimeout(()=>{stopTask=false;startMobFarmAFK('WebConsole');},150); }
        // ── PHA THUỐC / BREW ──────────────────────────────────────────────
        else if (txt.includes('pha thuốc')||txt.includes('pha thuoc')||txt==='brew'||txt==='brewing'||txt.includes('auto brew')) { resetState(); setTimeout(()=>{stopTask=false;autoBrewing('WebConsole');},150); }
        // ── FARM ĐẶC BIỆT ─────────────────────────────────────────────────
        else if (txt.includes('farm mía')||txt.includes('farm mia')||txt.includes('farm đặc biệt')||txt.includes('farm nether wart')||txt.includes('farm tre')||txt==='special farm') { resetState(); setTimeout(()=>{stopTask=false;doFarmSpecial('WebConsole');},150); }
        // ── NHẶT LOOT ─────────────────────────────────────────────────────
        else if (txt==='nhặt loot'||txt==='nhat loot'||txt==='loot'||txt==='pickup') { autoLootNearby(16).then(()=>bot&&bot.chat('Đã nhặt loot')); }
        // ── THỐNG KÊ / STATS ──────────────────────────────────────────────
        else if (txt==='thống kê'||txt==='thong ke'||txt==='stats'||txt==='statistics') {
          const uptime2=Math.round((Date.now()-activityStats.startTime)/60000);
          if(bot) bot.chat('📊 Stats: đào '+activityStats.blocksMinedTotal+' block, giết '+activityStats.mobsKilled+' mob, câu '+activityStats.fishCaught+' cá, pha '+activityStats.potionsBrewed+' thuốc, '+uptime2+' phút');
        }
        // ── XÂY SCHEMATIC (web console) ─────────────────────────────────
        else if (txt.startsWith('xây ')||txt.startsWith('xay ')||txt.startsWith('build file ')||txt.startsWith('schematic ')||txt.startsWith('build schematic')) {
          const words2=raw.trim().split(/\s+/);
          const skip2=(txt.startsWith('build file')||txt.startsWith('xây file')||txt.startsWith('xay file')) ? 2 : 1;
          const fn2=words2.slice(skip2).join(' ').trim();
          if(fn2) { resetState(); setTimeout(()=>{stopTask=false;buildSchematic(fn2,'WebConsole');},150); }
          else if(bot) bot.chat('Usage: xây <file.litematic>  |  xây <file.schem>  |  xây <file.txt>');
        }
        // ── FILL (web console) ──────────────────────────────────────────
        else if (txt.startsWith('fill ')||txt.startsWith('lấp ')||txt.startsWith('lap ')) {
          const parts3=raw.trim().split(/\s+/);
          const nums3=parts3.slice(1).filter(p=>!isNaN(Number(p))).map(Number);
          const blk3=parts3.find((p,i)=>i>=7&&isNaN(Number(p)))||'stone';
          if(nums3.length>=6) { const[x1,y1,z1,x2,y2,z2]=nums3; resetState(); setTimeout(()=>{stopTask=false;fillRegion(x1,y1,z1,x2,y2,z2,blk3,'WebConsole');},150); }
          else if(bot) bot.chat('Usage: fill x1 y1 z1 x2 y2 z2 [block]');
        }
        // ── BUILD WALL (web console) ─────────────────────────────────────
        else if (txt.startsWith('wall ')||txt.startsWith('xây tường')||txt.startsWith('xay tuong')||txt.startsWith('build wall')) {
          const parts4=raw.trim().split(/\s+/);
          const skip4=(txt.startsWith('build wall')||txt.startsWith('xây tường')||txt.startsWith('xay tuong'))?2:1;
          const rest4=parts4.slice(skip4);
          const nums4=rest4.filter(p=>!isNaN(Number(p))).map(Number);
          const blk4=rest4.find(p=>isNaN(Number(p)))||'cobblestone';
          if(nums4.length>=6) { const[x1,y1,z1,x2,y2,z2,h=4]=nums4; resetState(); setTimeout(()=>{stopTask=false;buildWall(x1,y1,z1,x2,y2,z2,h,blk4,'WebConsole');},150); }
          else if(bot) bot.chat('Usage: wall x1 y1 z1 x2 y2 z2 [height] [block]');
        }
        // ── SCAFFOLD GOTO (web console) ──────────────────────────────────
        else if (txt.startsWith('scaffold ')) {
          const nums5=raw.trim().split(/\s+/).map(Number).filter(n=>!isNaN(n));
          if(nums5.length>=3) { resetState(); setTimeout(()=>{stopTask=false;scaffoldGoto(nums5[0],nums5[1],nums5[2],'WebConsole');},150); }
          else if(bot) bot.chat('Usage: scaffold goto X Y Z');
        }
        // ── TRADE / ĐỔI ──────────────────────────────────────────────────
        else if (txt.startsWith('trade ')||txt.startsWith('đổi ')||txt.startsWith('doi ')) { handleTradeChat('__WebConsole__', raw); }
        // ── DISCORD WEBHOOK ───────────────────────────────────────────────
        // Từ web console command box: "set discord https://discord.com/api/webhooks/..."
        else if (txt.startsWith('set discord ')||txt.startsWith('discord webhook ')||txt.startsWith('webhook ')) {
          const parts2 = raw.trim().split(/\s+/);
          const urlPart = txt.startsWith('set discord ') ? parts2[2] : parts2[txt.startsWith('webhook ') ? 1 : 2];
          if (urlPart && /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+/.test(urlPart)) {
            DISCORD_WEBHOOK_URL = urlPart;
            saveWebhookToFile(DISCORD_WEBHOOK_URL);
            logS('[Discord] Webhook URL cập nhật từ web console & lưu file');
            if (botOnline) { setTimeout(() => sendDiscordStatus(), 1000); startDiscordStatusInterval(); }
            console.log('✅ Discord webhook đã cập nhật & lưu file!');
          } else if (urlPart === 'clear'||urlPart === 'off') {
            DISCORD_WEBHOOK_URL = ''; saveWebhookToFile(''); logS('[Discord] Webhook đã xóa & file đã xóa');
          } else {
            logW('[Discord] URL không hợp lệ. Dùng: set discord https://discord.com/api/webhooks/...');
          }
        }
        // Gửi status embed lên Discord ngay lập tức
        else if (txt === 'status discord'||txt === 'discord status'||txt === 'discord ping') {
          sendDiscordStatus();
          console.log('📊 Đã gửi status embed lên Discord!');
        }
        // ── TEST / SET GEMINI AI KEY ──────────────────────────────────────
        // test ai — gọi thử Gemini chat key
        else if (txt === 'test ai'||txt === 'test gemini'||txt === 'check ai') {
          if (!CONFIG.geminiApiKey) {
            console.log('❌ Chưa có Gemini API key. Dùng: set ai [key]');
          } else {
            console.log('🔄 Đang test Gemini Chat API...');
            getAI('Nói "AI OK" bằng tiếng Việt', 'Chỉ trả lời "AI OK"').then(r => {
              if (r) {
                logS('[AI] Test chat key thành công: ' + r);
                console.log('✅ Gemini Chat key hoạt động! Phản hồi: ' + r);
              } else {
                logW('[AI] Test chat key thất bại');
                console.log('❌ Gemini Chat key lỗi — kiểm tra key hoặc quota');
              }
            }).catch(e => {
              console.log('❌ Lỗi: ' + e.message);
            });
          }
        }
        // test ai decision — gọi thử AI Decision key với mock context
        else if (txt === 'test ai decision'||txt === 'test decision'||txt === 'check decision key') {
          const decKey = CONFIG.aiDecisionKey || CONFIG.geminiApiKey;
          if (!decKey) {
            console.log('❌ Chưa có AI Decision key. Dùng: set ai decision [key]');
          } else {
            console.log(`🔄 Đang test AI Decision key (${CONFIG.aiDecisionKey ? 'riêng' : 'dùng chung chat key'})...`);
            const MODELS_TEST = ['gemini-3.1-flash-lite','gemini-2.5-flash-lite','gemini-3.5-flash','gemini-3.0-flash','gemini-2.5-flash','gemini-2.0-flash'];
            const mockCtx = '=== TEST ===\nHP:20/20 Food:20/20 Stage:stone\nMob thù: không có\nAction test: chop';
            const mockSys = 'Trả lời JSON: {"action":"chop","reason":"test","stage_tip":"test ok"}';
            let tested = false;
            (async () => {
              for (const model of MODELS_TEST) {
                try {
                  const res = await fetchFn(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${decKey}`,
                    { method:'POST', headers:{'Content-Type':'application/json'},
                      body: JSON.stringify({ system_instruction:{parts:[{text:mockSys}]}, contents:[{role:'user',parts:[{text:mockCtx}]}], generationConfig:{maxOutputTokens:60,temperature:0} }) }
                  );
                  if (res.status === 429) { continue; }
                  if (res.ok) {
                    const j = await res.json();
                    const txt2 = j?.candidates?.[0]?.content?.parts?.[0]?.text || '(không có text)';
                    logS(`[AI Decision Test] Model ${model}: ${txt2}`);
                    console.log(`✅ AI Decision key hoạt động! Model: ${model} | Phản hồi: ${txt2.slice(0,80)}`);
                    tested = true; break;
                  } else {
                    const j = await res.json().catch(()=>({}));
                    console.log(`❌ Model ${model} lỗi ${res.status}: ${j?.error?.message||'unknown'}`);
                    break;
                  }
                } catch(e) { continue; }
              }
              if (!tested) console.log('❌ Tất cả model đều thất bại — kiểm tra key hoặc quota');
            })();
          }
        }
        // ── STATUS KEYS — hiện trạng thái RPD + số lần dùng hôm nay ────────────
        else if (txt === 'status keys' || txt === 'key status' || txt === 'quota status' || txt === 'status quota' || txt === 'check keys') {
          const now = Date.now();
          const today = _getTodayUTC();
          const lines = [];
          lines.push('═══════════════════════════════════════════════════════');
          lines.push('📊 TRẠNG THÁI API KEY — RPD QUOTA & SỐ LẦN DÙNG HÔM NAY');
          lines.push(`📅 Ngày UTC: ${today}  |  Reset lúc 00:00 UTC`);
          lines.push('═══════════════════════════════════════════════════════');

          const chatKeys = [CONFIG.geminiApiKey, ...CONFIG.chatKeys].filter(Boolean);
          const decKeys  = CONFIG.aiDecisionKey
            ? [CONFIG.aiDecisionKey, ...CONFIG.decisionKeys].filter(Boolean)
            : [];

          if (chatKeys.length === 0) {
            lines.push('❌ Chưa set Gemini API key (set ai <key>)');
          } else {
            lines.push(`🗨️  CHAT KEY — dùng cho: trả lời chat in-game  (${chatKeys.length} key)`);
            for (const k of chatKeys) {
              const until = _keyRpdExhaustedUntil.get(k);
              const u = _getKeyUsage(k);
              const used = u.chat;
              const limit = _FREE_TIER_RPD.chat;
              const pct = Math.round(used/limit*100);
              const bar = '█'.repeat(Math.round(pct/10))+'░'.repeat(10-Math.round(pct/10));
              if (until && now < until) {
                const hoursLeft = Math.ceil((until - now) / 3600000);
                const resetAt = new Date(until).toISOString().slice(11,16)+' UTC';
                lines.push(`  🔴 ${k.slice(0,4)}...  ⛔ HẾT QUOTA — reset ${resetAt} (~${hoursLeft}h)  đã dùng: ${used}/${limit}`);
              } else {
                lines.push(`  🟢 ${k.slice(0,4)}...  [${bar}] ${used}/${limit} lần  (${pct}%)`);
              }
            }
          }

          if (decKeys.length > 0) {
            lines.push(`🧠 DECISION KEY — dùng cho: AI mode tự chọn hành động  (${decKeys.length} key):`);
            for (const k of decKeys) {
              const until = _keyRpdExhaustedUntil.get(k);
              const u = _getKeyUsage(k);
              const used = u.decision;
              const limit = _FREE_TIER_RPD.decision;
              const pct = Math.round(used/limit*100);
              const bar = '█'.repeat(Math.round(pct/10))+'░'.repeat(10-Math.round(pct/10));
              if (until && now < until) {
                const hoursLeft = Math.ceil((until - now) / 3600000);
                const resetAt = new Date(until).toISOString().slice(11,16)+' UTC';
                lines.push(`  🔴 ${k.slice(0,4)}...  ⛔ HẾT QUOTA — reset ${resetAt} (~${hoursLeft}h)  đã dùng: ${used}/${limit}`);
              } else {
                lines.push(`  🟢 ${k.slice(0,4)}...  [${bar}] ${used}/${limit} lần  (${pct}%)`);
              }
            }
          } else {
            lines.push('🧠 DECISION KEY: dùng chung chat key (set riêng: set ai decision <key>)');
          }

          lines.push('───────────────────────────────────────────────────────');
          const chatActive = chatKeys.filter(k => !(_keyRpdExhaustedUntil.get(k) && now < _keyRpdExhaustedUntil.get(k))).length;
          const decActive  = decKeys.length > 0
            ? decKeys.filter(k => !(_keyRpdExhaustedUntil.get(k) && now < _keyRpdExhaustedUntil.get(k))).length
            : chatActive;
          lines.push(`🟢 Chat active: ${chatActive}/${chatKeys.length} key  |  Decision active: ${decActive}/${Math.max(decKeys.length, chatKeys.length)} key`);
          lines.push('💡 Thêm key: add ai key <key>  |  add ai decision key <key>');
          lines.push('💡 Xem chi tiết: keys  |  key info');
          lines.push('═══════════════════════════════════════════════════════');

          for (const line of lines) {
            console.log(line);
          }
        }
        // ── AI MODE BẬT/TẮT (web console) ────────────────────────────
        else if (txt==='ai on'||txt==='bật ai'||txt==='bat ai'||txt==='ai mode on'||txt==='enable ai'||txt==='ai bật'||txt==='ai bat') {
          startAIMode();
          if (!bot || !botOnline) console.log('🧠 AI Mode đã BẬT! (Bot đang offline — AI sẽ tự động khi bot kết nối)');
          else console.log('🧠 AI Mode đã BẬT! Bot sẽ tự quyết định hành động.');
        }
        else if (txt==='ai off'||txt==='tắt ai'||txt==='tat ai'||txt==='ai mode off'||txt==='disable ai'||txt==='ai tắt'||txt==='ai tat') {
          stopAIMode();
          console.log('🔴 AI Mode đã TẮT!');
        }
        else if (txt==='ai resume'||txt==='ai tiếp tục'||txt==='ai tiep tuc'||txt==='ai takeover') {
          _manualOverrideUntil = 0;
          console.log(aiModeEnabled ? '🧠 AI tiếp quản ngay!' : '⚠️ AI đang tắt — gõ "ai on" để bật');
        }
        else if (txt==='ai pause'||txt==='ai tạm dừng'||txt==='ai tam dung'||txt==='ai hold') {
          _manualOverrideUntil = Date.now() + 3600000;
          console.log('⏸ AI tạm dừng 1 tiếng. Gõ "ai resume" để AI tiếp quản lại.');
        }
        // ai status / ai mode / ai? — xem trạng thái AI (web console)
        else if (txt==='ai mode'||txt==='ai status'||txt==='ai?'||txt==='ai info') {
          const overrideSec = _manualOverrideUntil > Date.now() ? Math.round((_manualOverrideUntil - Date.now())/1000) : 0;
          const chatKeyOk = CONFIG.geminiApiKey ? `✅ ${CONFIG.geminiApiKey.slice(0,4)}...` : '❌ chưa set (gõ: set ai <key>)';
          const decKeyOk  = CONFIG.aiDecisionKey ? `✅ ${CONFIG.aiDecisionKey.slice(0,4)}... (key riêng)` : '(dùng chung chat key)';
          const sinceMin  = aiLastDecision ? Math.round((Date.now()-aiLastDecision.time)/60000) : null;
          const lastDec   = aiLastDecision ? `${aiLastDecision.action} — ${aiLastDecision.reason?.slice(0,80)}` : 'chưa có';
          const hp   = bot?.health != null ? Math.round(bot.health) : '?';
          const food = bot?.food   != null ? Math.round(bot.food)   : '?';
          const pos  = bot?.entity?.position ? `${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}` : '?';
          const topAct = Object.entries(aiMemory.actionCounts||{}).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>`${k}:${v}`).join(' ') || 'chưa có';
          const out = [
            `┌── 🧠 AI STATUS ──────────────────────────────────`,
            `│ Trạng thái : ${aiModeEnabled ? '🟢 BẬT' : '🔴 TẮT'}${overrideSec > 0 ? `  ⏸ Pause còn ${overrideSec}s` : ''}`,
            `│ Stage      : ${aiGameStage.toUpperCase()}`,
            `│ Bot        : HP ${hp}/20  Food ${food}/20  Vị trí: ${pos}`,
            `│ Chat key   : ${chatKeyOk}`,
            `│ AI key     : ${decKeyOk}`,
            `│ Queue chờ  : chat=${_aiQueue.length} | ai=${_aiDecisionQueue.length}`,
            `│ Quyết định : ${aiMemory.totalDecisions||0} tổng | Hay làm: ${topAct}`,
            `│ Lần cuối   : ${sinceMin != null ? sinceMin+'ph trước' : 'chưa'} — ${lastDec}`,
            `│ Status log : mỗi 2 phút tự động`,
            `└──────────────────────────────────────────────────`,
          ].join('\n');
          console.log(out);
        }
        // set ai decision [key] — PHẢI kiểm tra TRƯỚC set ai để tránh bị bắt nhầm
        else if (txt.startsWith('set ai decision ')||txt.startsWith('set decision key ')) {
          const parts3 = raw.trim().split(/\s+/);
          const keyPart = parts3[parts3.length - 1];
          if (keyPart && (keyPart.startsWith('AIza') || keyPart.startsWith('AQ'))) {
            CONFIG.aiDecisionKey = keyPart;
            try { saveAIDecisionKeyToFile(keyPart); } catch(_) {}
            console.log(`✅ AI Decision key đã cập nhật! (${keyPart.slice(0,4)}...) Gõ "ai on" để bật AI Mode.`);
          } else if (keyPart === 'clear'||keyPart === 'off') {
            CONFIG.aiDecisionKey = '';
            try { saveAIDecisionKeyToFile(''); } catch(_) {}
            console.log('🗑 AI Decision key đã xóa. AI Mode sẽ dùng chung Gemini chat key.');
          } else {
            console.log(`❌ Key không hợp lệ! "${keyPart?.slice(0,10)}..." phải bắt đầu bằng AIza... Lấy tại: aistudio.google.com`);
          }
        }
        // set ai [key] / set ai chat [key] — cập nhật Gemini chat key (PHẢI đặt SAU set ai decision)
        else if (txt.startsWith('set ai chat ')||txt.startsWith('set chat key ')) {
          const partsC = raw.trim().split(/\s+/);
          const keyPart = partsC[partsC.length - 1];
          if (keyPart && (keyPart.startsWith('AIza') || keyPart.startsWith('AQ'))) {
            CONFIG.geminiApiKey = keyPart;
            try { saveGeminiKeyToFile(keyPart); } catch(_) {}
            console.log(`✅ Gemini chat key đã cập nhật! (${keyPart.slice(0,4)}...) Gõ "test ai" để kiểm tra.`);
          } else if (keyPart === 'clear'||keyPart === 'off') {
            CONFIG.geminiApiKey = '';
            try { saveGeminiKeyToFile(''); } catch(_) {}
            console.log('🗑 Gemini chat key đã xóa. Chat AI tắt.');
          } else {
            console.log(`❌ Key không hợp lệ! "${keyPart?.slice(0,10)}..." phải bắt đầu bằng AIza... Lấy tại: aistudio.google.com`);
          }
        }
        else if (txt.startsWith('set ai ')||txt.startsWith('set gemini ')) {
          const parts2 = raw.trim().split(/\s+/);
          const keyPart = parts2[2];
          if (keyPart && (keyPart.startsWith('AIza') || keyPart.startsWith('AQ'))) {
            CONFIG.geminiApiKey = keyPart;
            try { saveGeminiKeyToFile(keyPart); } catch(_) {}
            console.log(`✅ Gemini chat key đã cập nhật! (${keyPart.slice(0,4)}...) Gõ "test ai" để kiểm tra.`);
          } else if (keyPart === 'clear'||keyPart === 'off') {
            CONFIG.geminiApiKey = '';
            try { saveGeminiKeyToFile(''); } catch(_) {}
            console.log('🗑 Gemini chat key đã xóa. Chat AI tắt.');
          } else {
            console.log(`❌ Key không hợp lệ! "${keyPart?.slice(0,10)}..." phải bắt đầu bằng AIza... Lấy tại: aistudio.google.com`);
          }
        }
        // ── MULTI-KEY ROTATION ────────────────────────────────────────────
        // add ai key <key1> [key2] [key3]... — thêm 1 hoặc nhiều chat key cùng lúc
        else if (txt.startsWith('add ai key ')||txt.startsWith('add gemini key ')||txt.startsWith('add chat key ')) {
          const prefixLen = txt.startsWith('add ai key ') ? 'add ai key '.length
                          : txt.startsWith('add gemini key ') ? 'add gemini key '.length
                          : 'add chat key '.length;
          const candidates = raw.trim().slice(prefixLen).trim().split(/\s+/)
            .filter(k => k.startsWith('AIza') || k.startsWith('AQ'));
          if (candidates.length === 0) {
            console.log('❌ Không tìm thấy key hợp lệ! Key phải bắt đầu bằng AIza hoặc AQ');
            console.log('   Thêm 1 key  : add ai key AQ...');
            console.log('   Thêm nhiều  : add ai key AQ... AQ... AQ...');
          } else {
            const added = [];
            for (const k of candidates) {
              if (!CONFIG.chatKeys.includes(k) && k !== CONFIG.geminiApiKey) {
                CONFIG.chatKeys.push(k);
                added.push(k.slice(0,4) + '...');
              }
            }
            const total = [CONFIG.geminiApiKey, ...CONFIG.chatKeys].filter(Boolean).length;
            if (added.length > 0)
              console.log(`✅ Thêm ${added.length} chat key: ${added.join(' | ')} → Tổng pool: ${total} key (≈${total*500} RPD/ngày)`);
            else
              console.log('⚠️ Tất cả key đã có trong danh sách rồi.');
          }
        }
        // add ai decision key <key1> [key2]... — thêm 1 hoặc nhiều decision key cùng lúc
        else if (txt.startsWith('add ai decision key ')||txt.startsWith('add decision key ')) {
          const prefixLen2 = txt.startsWith('add ai decision key ') ? 'add ai decision key '.length : 'add decision key '.length;
          const candidates2 = raw.trim().slice(prefixLen2).trim().split(/\s+/)
            .filter(k => k.startsWith('AIza') || k.startsWith('AQ'));
          if (candidates2.length === 0) {
            console.log('❌ Không tìm thấy key hợp lệ! Key phải bắt đầu bằng AIza hoặc AQ');
          } else {
            const added2 = [];
            for (const k of candidates2) {
              if (!CONFIG.decisionKeys.includes(k) && k !== CONFIG.aiDecisionKey) {
                CONFIG.decisionKeys.push(k);
                added2.push(k.slice(0,4) + '...');
              }
            }
            const baseDecKey = CONFIG.aiDecisionKey || CONFIG.geminiApiKey;
            const total2 = [baseDecKey, ...CONFIG.decisionKeys].filter(Boolean).length;
            if (added2.length > 0)
              console.log(`✅ Thêm ${added2.length} decision key: ${added2.join(' | ')} → Tổng pool: ${total2} key (≈${total2*500} RPD/ngày)`);
            else
              console.log('⚠️ Tất cả key đã có trong danh sách rồi.');
          }
        }
        // list ai keys / key info — hiển thị tất cả keys + mục đích + số lần dùng hôm nay
        else if (txt==='list ai keys'||txt==='list keys'||txt==='ai keys'||txt==='keys'||txt==='key info'||txt==='keys info'||txt==='key status'||txt==='key?') {
          const _fmtKey = (k, role, label, isShared) => {
            if (!k) return `❌ chưa set`;
            const u = _getKeyUsage(k);
            const calls = role === 'chat' ? u.chat : u.decision;
            const limit = _FREE_TIER_RPD[role] || 1500;
            const pct = Math.round(calls / limit * 100);
            const exhausted = _isKeyRpdExhausted(k);
            const bar = (() => { const f = Math.round(pct/10); return '█'.repeat(f)+'░'.repeat(10-f); })();
            const statusIcon = exhausted ? '🔴' : calls > limit*0.8 ? '🟡' : '🟢';
            return `${statusIcon} ${k.slice(0,4)}... ${isShared?'(dùng chung)':''}  ${calls}/${limit} lần hôm nay  [${bar}] ${pct}%${exhausted?' ⛔ HẾT QUOTA':''}`;
          };
          const chatMainFmt  = _fmtKey(CONFIG.geminiApiKey, 'chat', 'chat');
          const decShared    = !CONFIG.aiDecisionKey || CONFIG.aiDecisionKey === CONFIG.geminiApiKey;
          const decMainFmt   = decShared
            ? `(dùng chung chat key — set bằng: set ai decision <key>)`
            : _fmtKey(CONFIG.aiDecisionKey, 'decision', 'decision');
          const chatExtraLines = CONFIG.chatKeys.map((k,i) => `│   [${i+2}] ${_fmtKey(k,'chat')}`);
          const decExtraLines  = CONFIG.decisionKeys.map((k,i) => `│   [${i+2}] ${_fmtKey(k,'decision')}`);
          const today = _getTodayUTC();
          const lines = [
            `┌── 🔑 THÔNG TIN API KEYS ─────────────────────────────────`,
            `│`,
            `│ 🗨️  CHAT KEY  (dùng cho: trả lời chat in-game, test ai)`,
            `│   [1] ${chatMainFmt}`,
            ...chatExtraLines,
            CONFIG.chatKeys.length === 0 ? `│       (chưa có key dự phòng — dùng: add ai key <key>)` : null,
            `│`,
            `│ 🧠 DECISION KEY  (dùng cho: AI mode tự chọn hành động)`,
            `│   [1] ${decMainFmt}`,
            ...decExtraLines,
            CONFIG.decisionKeys.length === 0 && !decShared ? `│       (chưa có key dự phòng — dùng: add ai decision key <key>)` : null,
            `│`,
            `│ 📅 Ngày hôm nay (UTC): ${today}  |  Giới hạn free tier: ~1500 lần/ngày`,
            `│ 💡 Thêm key dự phòng: add ai key <key>  |  add ai decision key <key>`,
            `│    Lấy key miễn phí:  aistudio.google.com/apikey`,
            `└──────────────────────────────────────────────────────────`,
          ].filter(l => l !== null).join('\n');
          console.log(lines);
        }
        // clear ai keys / remove ai keys — xóa tất cả extra chat keys
        else if (txt==='clear ai keys'||txt==='remove ai keys'||txt==='clear chat keys') {
          CONFIG.chatKeys = [];
          console.log('🗑 Đã xóa tất cả extra chat key. Chỉ còn key chính.');
        }
        // clear ai decision keys — xóa tất cả extra decision keys
        else if (txt==='clear ai decision keys'||txt==='remove ai decision keys'||txt==='clear decision keys') {
          CONFIG.decisionKeys = [];
          console.log('🗑 Đã xóa tất cả extra decision key. Chỉ còn key chính.');
        }
        // ── HELP / LỆNH ───────────────────────────────────────────────────
      else if (['help','lenh','lệnh','commands','cmd','?','!help','danh sach lenh','danh sách lệnh'].includes(txt)) botSayCommands();
      // ── fallback: gửi thẳng vào game chat ────────────────────────────
      else { if(bot) try { bot.chat(raw.slice(0,256)); } catch(e){} }
    }, 150);
    return;
  }
  if (cmd.type === 'disconnect') { if(bot) try{bot.end();}catch(e){} setTimeout(()=>process.exit(0),1000); return; }
  if (cmd.type === 'config') {
    if(cmd.host) CONFIG.host=cmd.host;
    if(cmd.port) CONFIG.port=parseInt(cmd.port)||CONFIG.port;
    if(cmd.username) CONFIG.username=cmd.username;
    if(cmd.version) CONFIG.version=cmd.version;
    try { fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify({host:CONFIG.host,port:CONFIG.port,username:CONFIG.username,version:CONFIG.version}), 'utf8'); } catch(_) {}
    if(typeof cmd.discordWebhook !== 'undefined') {
      DISCORD_WEBHOOK_URL = cmd.discordWebhook || '';
      saveWebhookToFile(DISCORD_WEBHOOK_URL);
      logS('[Discord] Webhook URL ' + (DISCORD_WEBHOOK_URL ? 'đã cập nhật & lưu file' : 'đã xóa'));
      if (DISCORD_WEBHOOK_URL && botOnline) {
        setTimeout(() => sendDiscordStatus(), 1000);
        startDiscordStatusInterval();
      }
    }
    if(typeof cmd.geminiApiKey !== 'undefined') {
      CONFIG.geminiApiKey = cmd.geminiApiKey || '';
      saveGeminiKeyToFile(CONFIG.geminiApiKey);
      logS('[AI] Gemini API key ' + (CONFIG.geminiApiKey ? 'đã cập nhật & lưu file' : 'đã xóa'));
    }
    if(typeof cmd.aiDecisionKey !== 'undefined') {
      CONFIG.aiDecisionKey = cmd.aiDecisionKey || '';
      saveAIDecisionKeyToFile(CONFIG.aiDecisionKey);
      logS('[AI MODE] AI Decision key ' + (CONFIG.aiDecisionKey ? 'đã cập nhật & lưu file' : 'đã xóa'));
    }
    return;
  }
  if (cmd.type === 'allowDrop') {
    const { action, username } = cmd;
    if (!username) return;
    if (action === 'add' && !CONFIG.allowedDropUsers.includes(username)) {
      CONFIG.allowedDropUsers.push(username);
    } else if (action === 'remove') {
      CONFIG.allowedDropUsers = CONFIG.allowedDropUsers.filter(u => u !== username);
    } else if (action === 'set' && Array.isArray(cmd.users)) {
      CONFIG.allowedDropUsers = cmd.users;
    }
    return;
  }
  if (cmd.type === 'status') {
    let pos=null, inventory=[], inventoryGrid=Array(36).fill(null), armor={helmet:null,chestplate:null,leggings:null,boots:null}, heldItem=null, offHand=null;
    try { if(bot?.entity?.position){const p=bot.entity.position;pos={x:Math.round(p.x),y:Math.round(p.y),z:Math.round(p.z)};} } catch(e){}
    try {
      if(bot && botOnline) {
        const sl = bot.inventory.slots;
        inventory = bot.inventory.items().map(i=>({name:i.name,displayName:i.displayName||i.name,count:i.count,slot:i.slot}));
        // Build 36-slot grid for inventory dashboard (slots 9..44)
        for (let s = 9; s <= 44; s++) {
          const it = sl[s];
          if (it) inventoryGrid[s-9] = {name:it.name,displayName:it.displayName||it.name,count:it.count,slot:s};
        }
        const ARMOR_SLOTS = {helmet:5,chestplate:6,leggings:7,boots:8};
        for(const [part,idx] of Object.entries(ARMOR_SLOTS)){
          const it=sl[idx]; if(it) armor[part]={name:it.name,displayName:it.displayName||it.name};
        }
        const h=bot.heldItem; if(h) heldItem={name:h.name,displayName:h.displayName||h.name,count:h.count};
        const oh=sl[45]; if(oh) offHand={name:oh.name,displayName:oh.displayName||oh.name,count:oh.count};
      }
    } catch(e){}

    const statusObj = {
      __STATUS__:true, online:!!botOnline, reconnecting:!!isRejoining,
      hp:Math.round((bot?.health??0)*10)/10, food:Math.round(bot?.food??0),
      task:bot?._task||(botOnline?'idle':'connecting'), pos, server:CONFIG.host, port:CONFIG.port,
      username:CONFIG.username, lastError, autoAttack:autoAttackEnabled, autoEat:autoEatEnabled,
      inventory, inventoryGrid, armor, heldItem, offHand, allowedDropUsers: CONFIG.allowedDropUsers,
      stats: { ...activityStats, uptime: Math.round((Date.now()-activityStats.startTime)/1000) },
      waypoints, basePosition, activityLog: activityLog.slice(-50),
      discordWebhook: !!DISCORD_WEBHOOK_URL, discordWebhookUrl: DISCORD_WEBHOOK_URL ? '***set***' : '',
      autoReturnEnabled, isPatrolling, isMobFarming,
      aiMode: aiModeEnabled, aiDecisionKey: !!CONFIG.aiDecisionKey,
      aiGameStage, aiLastDecision,
      aiDecisionLog: aiDecisionLog.slice(-30), // 30 quyết định gần nhất để client load lịch sử
      aiManualOverride: Date.now() < _manualOverrideUntil,
    };

    // ── Dedup: chỉ gửi khi có gì thay đổi thực sự ──────────────────
    // Loại uptime (tăng mỗi giây) và activityLog (append liên tục)
    // ra khỏi phép so sánh để tránh emit thừa
    const { stats: _s, activityLog: _al, ...cmpObj } = statusObj;
    const cmpStats = { ..._s }; delete cmpStats.uptime;
    const lastLogEntry = activityLog.length > 0 ? activityLog[activityLog.length-1]?.text : '';
    const hashStr = JSON.stringify({ ...cmpObj, cmpStats, lastLogEntry });

    if (hashStr === _lastStatusHash) return; // Không có gì thay đổi → bỏ qua
    _lastStatusHash = hashStr;

    process.stdout.write(JSON.stringify(statusObj)+'\n');
    return;
  }
  if (cmd.type === 'toggle') {
    if(cmd.feature==='autoAttack'){ autoAttackEnabled=!autoAttackEnabled; if(!autoAttackEnabled)stopAutoAttack(); else startAutoAttack(); }
    else if(cmd.feature==='autoEat'){ autoEatEnabled=!autoEatEnabled; }
    else if(cmd.feature==='aiMode'){ aiModeEnabled ? stopAIMode() : startAIMode(); }
    return;
  }
}
