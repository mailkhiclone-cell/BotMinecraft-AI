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
//    BOT_HOST, BOT_PORT, BOT_USERNAME, BOT_VERSION, GROQ_API_KEY
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── GLOBAL ERROR GUARD (ngăn crash vì EPIPE / mất mạng) ───────────
process.on('uncaughtException', (err) => {
  lastError = `UncaughtException: ${err.code||''} ${err.message}`;
  console.error(`[GUARD] ${lastError}`);
  // Rejoin khi là lỗi kết nối và chưa đang rejoin
  if (!isRejoining && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED')) {
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
  groqApiKey: process.env.GROQ_API_KEY  || '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',
};
// ──────────────────────────────────────────────────────────────────

const Vec3         = require('vec3');
const mineflayer   = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalXZ, GoalLookAtBlock, GoalNear } = goals;
const collectBlock = require('mineflayer-collectblock').plugin;
const pvp          = require('mineflayer-pvp').plugin;
const mcDataLoader = require('minecraft-data');

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
let wanderInterval = null, armorInterval = null, eatInterval = null, autoAttackInterval = null;
let pvpChallengeInterval = null, invCheckInterval = null, statusBarInterval = null, huntInterval = null;
let pendingDuel = null;  // { player, timeout }
let activeDuel  = null;  // { player, fightTimeout, deathHandler }
let autoAttackEnabled = true, autoEatEnabled = true;
let isRejoining = false, rejoinAttempts = 0;
let botOnline = false; // true chỉ sau khi spawn, false khi end/kick/rejoin
let lastError = ''; // lý do mất kết nối gần nhất
const MAX_REJOIN = 10, REJOIN_DELAY = 5000;

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

// ── TERMINAL STATUS BAR (Termux) ──────────────────────────────────
function printStatusBar() {
  if (!bot || !bot.entity) return;
  const task = bot._task || '—';
  const hp   = bot.health != null ? Math.round(bot.health * 10) / 10 : '—';
  const food = bot.food   != null ? Math.round(bot.food)         : '—';
  let pos = '—';
  try { const p = bot.entity.position; pos = `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`; } catch(e){}
  const hpColor  = (hp < 6 ? C.red : hp < 12 ? C.orange : C.green);
  const fColor   = (food < 6 ? C.red : food < 12 ? C.orange : C.yellow);
  const line1 = `${C.cyan}┌─ ${C.bold}3D2Y Bot${C.reset}${C.cyan} ─────────────────────────────────────────────┐${C.reset}`;
  const line2 = `${C.cyan}│${C.reset} ${C.green}● online${C.reset}  ${C.gray}│${C.reset} ${C.white}${task.padEnd(18)}${C.reset} ${C.gray}│${C.reset} ${hpColor}❤ ${hp}/20${C.reset}  ${fColor}🍖 ${food}/20${C.reset}`;
  const line3 = `${C.cyan}│${C.reset} ${C.gray}📍 ${pos}${C.reset}`;
  const line4 = `${C.cyan}└──────────────────────────────────────────────────────────┘${C.reset}`;
  console.log(`\n${line1}\n${line2}\n${line3}\n${line4}`);
}

// ── ASCII BANNER ──────────────────────────────────────────────────
function printBanner() {
  console.log(`\x1b[38;5;81m
   ██████╗ ██████╗ ██████╗ ██╗   ██╗
   ╚════██╗██╔══██╗╚════██╗╚██╗ ██╔╝
    █████╔╝██║  ██║ █████╔╝ ╚████╔╝ 
    ╚═══██╗██║  ██║██╔═══╝   ╚██╔╝  
   ██████╔╝██████╔╝███████╗   ██║   
   ╚═════╝ ╚═════╝ ╚══════╝   ╚═╝   
\x1b[38;5;214m   ➔ 3D2Y Minecraft Bot\x1b[0m
`);
  console.log(`${C.cyan}  ┌──────────────────────────────────────────┐${C.reset}`);
  console.log(`${C.cyan}  │${C.reset}  ${C.bold}${C.white}Server ${C.reset}${C.gray}→${C.reset} ${C.mint}${CONFIG.host}:${CONFIG.port}${C.reset}`);
  console.log(`${C.cyan}  │${C.reset}  ${C.bold}${C.white}Bot    ${C.reset}${C.gray}→${C.reset} ${C.green}${CONFIG.username}${C.reset}  ${C.gray}(${CONFIG.version})${C.reset}`);
  console.log(`${C.cyan}  └──────────────────────────────────────────┘${C.reset}\n`);
}

// ── AI CHAT ───────────────────────────────────────────────────────
const chatHistory = [];
let lastReplyAt = 0;

function pushHistory(role, content) {
  chatHistory.push({ role, content });
  if (chatHistory.length > 20) chatHistory.shift();
}

function buildSys() {
  const task = bot?._task || 'offline';
  let pos = '';
  try { if (bot?.entity) { const p = bot.entity.position; pos = ` tại (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`; } } catch(e){}
  const hp = Math.round(bot?.health ?? 0), food = Math.round(bot?.food ?? 0);
  const held = bot?.heldItem ? bot.heldItem.name.replace(/_/g,' ') : 'tay trống';
  return `Bạn là ${CONFIG.username} — bot Minecraft thông minh, cá tính, hơi bướng bỉnh nhưng trung thành.
Đang: ${task}${pos}. HP: ${hp}/20, Food: ${food}/20, Cầm: ${held}. Server: ${CONFIG.host} (${CONFIG.version}).
Quy tắc: Trả lời tiếng Việt ngắn gọn (tối đa 20 từ). KHÔNG dùng ngoặc kép. Tự tin, hài hước, dựa trên trạng thái thực.`;
}

async function getAI(prompt, sys, useHist = false) {
  if (!CONFIG.groqApiKey) return null;
  try {
    const messages = [{ role: 'system', content: sys || buildSys() }];
    if (useHist) messages.push(...chatHistory.slice(-12));
    messages.push({ role: 'user', content: prompt });
    const res = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 120, temperature: 0.85, messages }),
    });
    const d = await res.json();
    return d?.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

async function botSay(p) {
  if (!bot) return;
  const r = await getAI(p, `Bạn là ${CONFIG.username} — bot Minecraft. Viết 1 câu dưới 12 từ, thể hiện đang làm việc đó, cá tính. Không dùng ngoặc kép.`);
  if (r) bot.chat(r);
}

async function replyToChat(user, msg) {
  if (Date.now() - lastReplyAt < 3000) return;
  lastReplyAt = Date.now();
  pushHistory('user', `${user}: ${msg}`);
  const r = await getAI(`${user} nói: "${msg}"`, null, true);
  if (r) { bot.chat(r); pushHistory('assistant', r); }
}

function shouldReply(user, msg) {
  if (user === bot.username) return false;
  const t = msg.toLowerCase();
  if (t.includes(CONFIG.username.toLowerCase())) return true;
  if (t.includes('?') && msg.length < 80) return true;
  if (/^(hi|hello|hey|chào|alo|xin chào)/.test(t) && msg.length < 30) return true;
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

// ── GIÁP ──────────────────────────────────────────────────────────
const ARMOR_SLOTS = [
  { dest: 'head',  p: ['netherite_helmet','diamond_helmet','iron_helmet','chainmail_helmet','gold_helmet','leather_helmet'] },
  { dest: 'torso', p: ['netherite_chestplate','diamond_chestplate','iron_chestplate','chainmail_chestplate','gold_chestplate','leather_chestplate'] },
  { dest: 'legs',  p: ['netherite_leggings','diamond_leggings','iron_leggings','chainmail_leggings','gold_leggings','leather_leggings'] },
  { dest: 'feet',  p: ['netherite_boots','diamond_boots','iron_boots','chainmail_boots','gold_boots','leather_boots'] },
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
  'chorus_fruit','rotten_flesh',
];

async function autoEat() {
  if (!bot || !autoEatEnabled || isEating || !mcData) return;
  const foodVal = bot.food   ?? 20;
  const hp      = bot.health ?? 20;
  // Ăn khi đói (< 16) hoặc máu yếu (< 8 = 4 trái tim) và có đồ ăn
  if (foodVal >= 16 && hp >= 8) return;
  let food = null;
  for (const n of FOOD_LIST) { const info = mcData.itemsByName[n]; if (!info) continue; const f = bot.inventory.findInventoryItem(info.id, null, false); if (f) { food = f; break; } }
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
    isBusy = true; bot._task = 'săn động vật';
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
        if (!await new Promise(async res => { await autoEat(); res(true); })) {
          await tryEatRaw();
        }
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
function refreshMovements(forFollow = false) {
  if (!bot || !mcData) return;
  const mov = new Movements(bot, mcData);
  mov.allowSprinting = true;
  mov.canDig = forFollow;        // cho phép đào block cản khi đi theo
  mov.allow1by1towers = false;
  mov.scaffoldingBlocks = [];
  mov.maxDropDown = forFollow ? 5 : 4;
  mov.allowParkour = true;
  mov.allowSwim = true;
  try { mov.canJump = true; } catch(e){}
  bot.pathfinder.setMovements(mov);
}

// Kiểm tra túi có gần đầy không (còn ≤2 ô trống trong 36 slot)
function isInventoryFull() {
  let empty = 0;
  for (let i = 9; i < 45; i++) { if (!bot.inventory.slots[i]) empty++; }
  return empty <= 2;
}

const TOOL_PRI = ['netherite','diamond','iron','stone','wooden','golden'];
async function equipToolForBlock(block) {
  if (!mcData || !block) return;
  const bd = mcData.blocks[block.type]; if (!bd) return;
  const name = bd.name||'', mat = bd.material||'';
  let tt = null;
  if (mat.includes('rock')||mat.includes('stone')||name.includes('stone')||name.includes('ore')||name.includes('cobblestone')||name.includes('deepslate')||name.includes('obsidian')||name.includes('brick')||name.includes('terracotta')||name.includes('concrete')||name.includes('glass')||name.includes('nether')||name.includes('basalt')||name.includes('prismarine')||name.includes('purpur')||name.includes('quartz')||name.includes('end_stone')) tt='pickaxe';
  else if (name.endsWith('_log')||name.endsWith('_wood')||name.includes('planks')||name.includes('chest')||name.includes('_slab')||name.includes('_stairs')||name.includes('_fence')||name.includes('_door')||name.includes('_trapdoor')||name.includes('barrel')||name.includes('bookshelf')||name.includes('crafting_table')||name.includes('jukebox')||name.includes('note_block')||name.includes('_sign')||name.includes('bamboo')) tt='axe';
  else if (name.includes('dirt')||name.includes('grass')||name.includes('sand')||name.includes('gravel')||name.includes('soul')||name.includes('clay')||name.includes('mud')) tt='shovel';
  if (!tt) return;
  for (const m of TOOL_PRI) { const tool = bot.inventory.slots.find(i => i && i.name===`${m}_${tt}`); if (tool) { try { await bot.equip(tool,'hand'); return; } catch(e){} } }
}

function resetState() {
  stopTask = true; isFollowing = false; isBusy = false;
  if (wanderInterval) { clearInterval(wanderInterval); wanderInterval = null; }
  try { bot.clearControlStates(); } catch(e){}
  try { bot.pathfinder.setGoal(null); } catch(e){}
}

// ── WANDER ────────────────────────────────────────────────────────
function startWander() {
  if (wanderInterval || isBusy || isFollowing) return;
  bot._task = 'wandering';
  wanderInterval = setInterval(() => {
    if (!bot || isBusy || isFollowing || !bot.entity?.position) return;
    try { if (bot.pathfinder.isMoving()) return; } catch(e) { return; }
    refreshMovements();
    const pos = bot.entity.position;
    const target = bot.findBlock({ matching: b => { if (!b?.position) return false; const s=b.name==='grass_block'||b.name==='dirt'||b.name==='stone'; const u1=bot.blockAt(b.position.offset(0,1,0)); const u2=bot.blockAt(b.position.offset(0,2,0)); return s&&u1?.name==='air'&&u2?.name==='air'; }, maxDistance: 12 });
    if (target) { try { bot.pathfinder.setGoal(new GoalXZ(target.position.x, target.position.z)); } catch(e){} }
    else { const rx=pos.x+(Math.random()-.5)*16, rz=pos.z+(Math.random()-.5)*16; try { bot.pathfinder.setGoal(new GoalXZ(rx,rz)); } catch(e){} }
  }, 3000);
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

function startAutoAttack() {
  if (autoAttackInterval) return;
  autoAttackInterval = setInterval(async () => {
    if (!bot || !autoAttackEnabled || !bot.entity?.position) return;
    try {
      if (bot.pvp.target) return;
      let nearest = null, minD = Infinity;
      for (const e of Object.values(bot.entities)) {
        if (!e || e===bot.entity || !e.position) continue;
        if (e.type!=='mob' && e.type!=='hostile') continue;
        if (!HOSTILE_MOBS.has(e.name||e.mobType||'')) continue;
        const d = bot.entity.position.distanceTo(e.position);
        if (d < minD) { minD = d; nearest = e; }
      }
      if (nearest && minD <= 16) {
        await equipBestWeapon();
        bot.pvp.attack(nearest);
        logS(`⚔ ${nearest.name||nearest.mobType} (${Math.round(minD)}m)`);
      }
    } catch(e){}
  }, 500);
}
function stopAutoAttack() { if (autoAttackInterval) { clearInterval(autoAttackInterval); autoAttackInterval = null; } try { if (bot?.pvp) bot.pvp.stop(); } catch(e){} }

// ── FOLLOW ────────────────────────────────────────────────────────
async function tryUnstuck(targetEntity) {
  if (!bot?.entity || bot._task === 'idle') return;
  try {
    // Nhìn về phía người chơi trước
    if (targetEntity?.position) {
      try { await bot.lookAt(targetEntity.position.offset(0, 1.6, 0), true); } catch(e){}
    }

    const pos = bot.entity.position;
    const yaw = bot.entity.yaw;
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);

    // Đào block cản ở chân (y+0), thân (y+1), đầu (y+2) phía trước
    for (const dy of [0, 1, 2]) {
      const bx = Math.floor(pos.x + dx * 0.9 + 0.5);
      const by = Math.floor(pos.y + dy);
      const bz = Math.floor(pos.z + dz * 0.9 + 0.5);
      try {
        const blk = bot.blockAt(new Vec3(bx, by, bz));
        if (blk && blk.name !== 'air' && blk.name !== 'water' && blk.name !== 'lava' && blk.diggable) {
          await equipToolForBlock(blk);
          await bot.dig(blk, true);
          logS(`[Follow] Đào ${blk.name} tại dy=${dy}`);
        }
      } catch(e) {}
    }

    // Sprint + nhảy — giữ jump 500ms để đảm bảo nhảy đủ cao (1.25 block)
    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
    for (let i = 0; i < 6; i++) {
      bot.setControlState('jump', true);
      await new Promise(r => setTimeout(r, 500)); // giữ lâu hơn để nhảy đủ cao
      bot.setControlState('jump', false);
      await new Promise(r => setTimeout(r, 80));
    }
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
    await new Promise(r => setTimeout(r, 300));

    // Nếu vẫn kẹt: thử pathfind sang bên cạnh rồi về phía player
    if (targetEntity?.position) {
      const tp = targetEntity.position;
      const side = new GoalXZ(
        tp.x + (Math.random() > 0.5 ? 3 : -3),
        tp.z + (Math.random() > 0.5 ? 3 : -3)
      );
      try { bot.pathfinder.setGoal(side, true); } catch(e){}
      await new Promise(r => setTimeout(r, 800));
    }

    refreshMovements(true);
  } catch(e) {
    try { bot.setControlState('forward', false); bot.setControlState('sprint', false); bot.setControlState('jump', false); } catch(_){}
  }
}

async function startFollow(user) {
  isFollowing = true; isBusy = true; bot._task = `theo ${user}`;
  refreshMovements(true);
  try {
    const player = bot.players[user];
    if (!player?.entity) {
      await botSay('Không tìm thấy người để theo');
      isFollowing = false; isBusy = false; startWander(); return;
    }
    await botSay('Đang theo bạn');
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);

    // ── Stuck detection ──────────────────────────────────────────
    let lastPos = bot.entity?.position?.clone?.() || null;
    let stuckTicks = 0;
    const STUCK_THRESHOLD = 2;  // × 2s = 4s không di chuyển → unstuck
    const STUCK_MIN_DIST = 0.5;
    const FOLLOW_DIST = 2;

    const stuckTimer = setInterval(async () => {
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
            logW(`[Follow] Bị kẹt! Thử nhảy qua...`);
            try { bot.pathfinder.setGoal(null); } catch(e){}
            await tryUnstuck(player.entity);
            if (isFollowing && !stopTask && player.entity) {
              refreshMovements(true);
              try { bot.pathfinder.setGoal(new GoalFollow(player.entity, FOLLOW_DIST), true); } catch(e){}
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
  'dirt','grass_block','gravel','sand','sandstone','gravel','netherrack','bedrock',
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
  isBusy = true;
  bot._task = type==='chop' ? 'chặt gỗ' : type==='demolish' ? 'đào nhà' : 'đào đá';
  refreshMovements();
  let blockFilter;
  if (type==='chop') {
    blockFilter = Object.values(mcData.blocksByName).filter(b=>b.name?.endsWith('_log')).map(b=>b.id);
    await botSay('Bắt đầu chặt gỗ');
  } else if (type==='demolish') {
    blockFilter = getHouseBlockFilter();
    await botSay('Bắt đầu phá nhà');
  } else {
    blockFilter = Object.values(mcData.blocksByName).filter(b => {
      const n = b.name || '';
      return n==='stone'||n==='cobblestone'||n==='mossy_cobblestone'||
             n.includes('deepslate')&&!n.includes('ore')||
             n.includes('ore')||n==='coal_ore'||n==='iron_ore'||
             n==='gold_ore'||n==='diamond_ore'||n==='emerald_ore'||
             n==='lapis_ore'||n==='redstone_ore';
    }).map(b=>b.id);
    await botSay('Bắt đầu đào đá');
  }
  logS(`[${who}] ${bot._task}`);
  await digContinuous(blockFilter, bot._task, who);
  isBusy = false; if (!isFollowing) startWander();
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
  const base = name.replace('deepslate_','').replace('nether_gold_ore','nether_gold_ore');
  return ORE_NAMES[base] || ORE_NAMES[name] || name.replace(/_/g,' ');
}

async function mineOres(who, targetOre) {
  isBusy = true;
  bot._task = targetOre ? `đào ${oreDisplayName(targetOre)}` : 'đào quặng';
  refreshMovements();

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

  await digContinuous(oreIds, `đào ${label}`, who);
  isBusy = false; if (!isFollowing) startWander();
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
    const block = bot.findBlock({
      matching: b => b && b.position && blockIds.includes(b.type) && !skipped.has(b.position.toString()),
      maxDistance: 32,
    });

    if (!block) {
      notFoundStreak++;
      // Sau 2 lần không tìm thấy: xóa skipped để thử lại các block cũ
      if (notFoundStreak === 2) skipped.clear();
      // Sau 4 lần vẫn không có: di chuyển khám phá
      if (notFoundStreak >= 4) {
        const pos = bot.entity.position;
        const angle = Math.random() * Math.PI * 2;
        const dist = 16 + Math.random() * 16;
        const tx = pos.x + Math.cos(angle) * dist;
        const tz = pos.z + Math.sin(angle) * dist;
        logS(`[${label}] Không tìm thấy block, di chuyển khám phá...`);
        try {
          await Promise.race([
            bot.pathfinder.goto(new GoalXZ(tx, tz)),
            new Promise(r => setTimeout(r, 5000)),
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

      if (stopTask) break;

      // Lấy lại block (có thể đã bị phá bởi người khác trong lúc di chuyển)
      const fresh = bot.blockAt(p);
      if (!fresh || !blockIds.includes(fresh.type)) continue;

      // Đào — forceLook=true để bot quay nhìn vào block trước khi đào
      await bot.dig(fresh, true);
      await new Promise(r => setTimeout(r, 60));

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

  isBusy = true;
  const displayName = key.replace(/_/g, ' ');
  bot._task = `đào ${displayName}`;
  refreshMovements();
  await botSay(`Bắt đầu đào ${displayName}!`);
  logS(`[${who}] Đào "${displayName}" (${blockIds.length} loại, liên tục đến khi dừng)`);

  await digContinuous(blockIds, displayName, who);
  isBusy = false; if (!isFollowing) startWander();
}

// ── FARMING ───────────────────────────────────────────────────────
const FARM_CROPS = [
  { name: 'wheat',     maxAge: 7, seed: 'wheat_seeds'    },
  { name: 'carrots',   maxAge: 7, seed: 'carrot'         },
  { name: 'potatoes',  maxAge: 7, seed: 'potato'         },
  { name: 'beetroots', maxAge: 3, seed: 'beetroot_seeds' },
];
const FARM_FRUITS = ['melon','pumpkin'];

async function doFarm(who) {
  isBusy = true; bot._task = 'làm nông'; refreshMovements();
  await botSay('Bắt đầu thu hoạch nông trại');
  logS(`[${who}] farming`);
  let harvested = 0, replanted = 0;

  while (!stopTask) {
    let target = null;

    // Tìm cây chín
    for (const crop of FARM_CROPS) {
      const def = mcData.blocksByName[crop.name];
      if (!def) continue;
      const found = bot.findBlock({
        matching: b => b && b.type === def.id && (b.getProperties().age ?? 0) >= crop.maxAge,
        maxDistance: 48,
      });
      if (found) { target = { block: found, kind: 'crop', crop }; break; }
    }

    // Tìm dưa/bí
    if (!target) {
      for (const fname of FARM_FRUITS) {
        const def = mcData.blocksByName[fname];
        if (!def) continue;
        const found = bot.findBlock({ matching: def.id, maxDistance: 48 });
        if (found) { target = { block: found, kind: 'fruit' }; break; }
      }
    }

    if (!target) {
      await botSay(`Thu hoạch xong! +${harvested} lượt, trồng lại ${replanted}`);
      logS(`Farm xong: thu ${harvested}, trồng ${replanted}`);
      break;
    }

    try {
      await bot.pathfinder.goto(new GoalNear(
        target.block.position.x, target.block.position.y, target.block.position.z, 2));

      if (target.kind === 'crop') {
        const farmlandPos = target.block.position.offset(0, -1, 0);
        const cropPos    = target.block.position.clone();
        await bot.dig(target.block); harvested++;
        await new Promise(r => setTimeout(r, 250));

        // Trồng lại nếu có hạt giống
        const seedName = target.crop.seed;
        const seedItem = bot.inventory.items().find(i => i.name === seedName);
        if (seedItem) {
          try {
            await bot.equip(seedItem, 'hand');
            const farmland = bot.blockAt(farmlandPos);
            if (farmland && farmland.name === 'farmland') {
              await bot.placeBlock(farmland, new Vec3(0, 1, 0));
              replanted++;
            }
          } catch(e) { logW(`Không trồng lại được: ${e.message}`); }
        }
      } else {
        await bot.dig(target.block); harvested++;
      }
    } catch(e) {
      logW(`Lỗi farm: ${e.message}`);
      await new Promise(r => setTimeout(r, 400));
    }

    await new Promise(r => setTimeout(r, 120));
  }

  isBusy = false; if (!isFollowing) startWander();
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
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        logS(`Đặt rương tại (${Math.round(pos.x+dx)},${Math.round(pos.y)},${Math.round(pos.z+dz)})`);
        await new Promise(r => setTimeout(r, 400));
        // Tìm lại block vừa đặt
        const placed = bot.findBlock({
          matching: [mcData.blocksByName.chest?.id].filter(Boolean),
          maxDistance: 6,
        });
        return placed;
      } catch(e) { logW(`Lỗi đặt rương: ${e.message}`); }
    }
  }
  return null;
}

const KEEP_ITEMS = new Set(['pickaxe','axe','shovel','sword','hoe','bow','crossbow','shield',
  'helmet','chestplate','leggings','boots','trident','elytra','chest']);
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

  try {
    await bot.pathfinder.goto(new GoalNear(cb.position.x, cb.position.y, cb.position.z, 2));
    await new Promise(r => setTimeout(r, 300));
    const chest = await bot.openChest(cb);
    const items = bot.inventory.items().filter(i => !shouldKeep(i.name));
    if (!items.length) {
      bot.chat('Túi sạch rồi!'); chest.close();
      isBusy = false; if (!isFollowing) startWander(); return;
    }
    let count = 0;
    for (const item of items) {
      if (stopTask) break;
      try { await chest.deposit(item.type, null, item.count); count++; logS(`→ ${item.name} x${item.count}`); await new Promise(r => setTimeout(r, 180)); }
      catch(e) { logW(`Lỗi cất ${item.name}`); }
    }
    chest.close();
    logS(`Cất xong ${count} loại đồ`);
    if (who !== '[Auto]') await botSay('Cất đồ xong rồi');
    else bot.chat(`Túi đầy, đã cất ${count} loại vào rương!`);
  } catch(e) { logE(`Lỗi rương: ${e.message}`); }
  finally { isBusy = false; if (!isFollowing) startWander(); }
}

// ── PVP CHALLENGE ─────────────────────────────────────────────────
const PVP_INTERVAL_MS = 30 * 60 * 1000; // 30 phút
const DEATH_KEYWORDS  = ['died','was slain','was killed','fell','drowned','burned','suffocated','starved','chết','bị giết','ngã'];

function cancelActiveDuel() {
  if (!activeDuel) return;
  clearTimeout(activeDuel.fightTimeout);
  if (activeDuel.trackInterval) clearInterval(activeDuel.trackInterval);
  if (activeDuel.deathHandler) { try { bot.removeListener('death', activeDuel.deathHandler); } catch(e){} }
  if (activeDuel.msgHandler)   { try { bot.removeListener('message', activeDuel.msgHandler); } catch(e){} }
  try { if (bot?.pvp) bot.pvp.stop(); } catch(e){}
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
    `Bạn là bot Minecraft cá tính. Thách ${target} 1v1 PvP, yêu cầu gõ "có" để chấp nhận hoặc "không" để từ chối. Dưới 20 từ, tiếng Việt.`
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

async function startDuel(playerName) {
  cancelActiveDuel();
  logS(`[PvP] ${playerName} chấp nhận đấu!`);

  // Trang bị kiếm + khiên
  await equipCombatLoadout();

  const startMsg = await getAI(`${playerName} chấp nhận đấu PvP 1v1`, `Bot Minecraft cá tính, hứa thắng, 1 câu ngắn tiếng Việt.`);
  bot.chat(startMsg || `${playerName} dũng cảm đấy! Tao sẽ không thương tình!`);

  // Hàm lấy entity của đối thủ
  const getTarget = () => bot.players[playerName]?.entity || null;

  // Bắt đầu tấn công ngay
  let pe = getTarget();
  if (pe) {
    try { bot.pvp.attack(pe); } catch(e) { logW('pvp.attack: ' + e.message); }
  }

  // Interval theo dõi + tái tấn công + counter elytra/mace
  let shieldRaised = false;
  const trackInterval = setInterval(async () => {
    if (!activeDuel) { clearInterval(trackInterval); return; }
    const e = getTarget();
    if (!e) return;

    const myPos = bot.entity?.position;
    if (!myPos) return;
    const tPos = e.position;
    const heightDiff = tPos.y - myPos.y;             // > 0 = địch đang ở trên mình
    const velY      = e.velocity?.y ?? 0;             // < 0 = đang lao xuống
    const hDist     = Math.sqrt((tPos.x-myPos.x)**2 + (tPos.z-myPos.z)**2);

    // ── Phát hiện Mace dive (địch từ cao lao xuống gần mình) ───────
    const isMaceDive = heightDiff > 4 && velY < -0.25 && hDist < 5;
    if (isMaceDive) {
      logW(`[PvP] Mace dive phát hiện! H=${Math.round(heightDiff)}m vy=${velY.toFixed(2)}`);
      // 1. Giơ khiên
      const shield = bot.inventory.slots.find(i => i && i.name==='shield');
      if (shield) {
        try { await bot.equip(shield, 'off-hand'); bot.activateItem(false); shieldRaised = true; } catch(_){}
      }
      // 2. Chạy vuông góc để tránh điểm tiếp đất
      const sideAngle = Math.atan2(myPos.x - tPos.x, myPos.z - tPos.z) + Math.PI / 2;
      try { bot.pathfinder.setGoal(new GoalXZ(myPos.x + Math.sin(sideAngle)*7, myPos.z + Math.cos(sideAngle)*7), true); } catch(_){}
      return; // Không melee lúc này
    }

    // Hạ khiên sau khi nguy hiểm qua
    if (shieldRaised && heightDiff < 2) {
      try { bot.deactivateItem(); shieldRaised = false; await equipCombatLoadout(); } catch(_){}
    }

    // ── Phát hiện địch bay Elytra (cao + xa) → dùng cung ────────────
    const isElytraFlying = heightDiff > 3 && hDist > 4;
    if (isElytraFlying) {
      const ranged = bot.inventory.items().find(i => i.name==='crossbow' || i.name==='bow');
      if (ranged) {
        try {
          await bot.equip(ranged, 'hand');
          await bot.lookAt(tPos.offset(0, e.height*0.5, 0));
          if (ranged.name === 'crossbow') {
            bot.activateItem();
            await new Promise(r => setTimeout(r, 1200));
            bot.deactivateItem(); // bắn nỏ
          } else {
            bot.activateItem();   // kéo cung
            await new Promise(r => setTimeout(r, 900));
            bot.deactivateItem(); // thả để bắn
          }
        } catch(_){}
        return;
      }
      // Không có vũ khí tầm xa → đợi địch đáp xuống
      return;
    }

    // ── Cận chiến bình thường ────────────────────────────────────────
    try {
      if (!bot.pvp.target || bot.pvp.target.id !== e.id) {
        await equipBestWeapon();
        bot.pvp.attack(e);
      }
    } catch(err) {}
  }, 400);

  // Thua: bot chết
  const deathHandler = async () => {
    clearInterval(trackInterval);
    if (!activeDuel || activeDuel.player !== playerName) return;
    cancelActiveDuel();
    logS(`[PvP] Bot thua ${playerName}`);
    const r = await getAI(`Bot Minecraft vừa thua PvP với ${playerName}`, `Nhận thua cá tính, hứa trả thù, 1 câu tiếng Việt.`);
    bot.chat(r || `${playerName} gg! Lần sau tao sẽ khác, đợi đó!`);
  };
  bot.once('death', deathHandler);

  // Thắng: đối thủ chết (phát hiện qua system message)
  const msgHandler = (jsonMsg) => {
    if (!activeDuel || activeDuel.player !== playerName) return;
    const text = jsonMsg.toString();
    const isDead = DEATH_KEYWORDS.some(k => text.toLowerCase().includes(k));
    if (isDead && text.includes(playerName)) {
      cancelActiveDuel(); // dọn dẹp trackInterval + pvp.stop bên trong
      logS(`[PvP] ${playerName} chết → THẮNG!`);
      getAI(`Bot Minecraft vừa thắng PvP, đối thủ ${playerName} chết`, `Trêu chọc đối thủ thua, 1 câu tiếng Việt cá tính.`)
        .then(r => { try { bot.chat(r || `${playerName} haha mày yếu thế! Đi luyện thêm đi!`); } catch(e){} });
    }
  };
  bot.on('message', msgHandler);

  // Timeout 3 phút → hòa
  const fightTimeout = setTimeout(() => {
    if (!activeDuel || activeDuel.player !== playerName) return;
    cancelActiveDuel();
    logS(`[PvP] Hết 3 phút đấu với ${playerName} → hòa`);
    try { bot.chat(`${playerName} tạm thời hòa! Lần sau quyết liệt hơn!`); } catch(e){}
  }, 3 * 60 * 1000);

  activeDuel = { player: playerName, fightTimeout, trackInterval, deathHandler, msgHandler };
  logS(`[PvP] Đang chiến đấu với ${playerName} ⚔️`);
}

function startPvpChallengeTimer() {
  if (pvpChallengeInterval) clearInterval(pvpChallengeInterval);
  pvpChallengeInterval = setInterval(sendPvpChallenge, PVP_INTERVAL_MS);
}

// ── REJOIN ────────────────────────────────────────────────────────
function handleRejoin() {
  if (isRejoining) return; isRejoining = true;
  botOnline = false; // ← bot không còn online khi đang rejoin
  mcData = null;
  if (armorInterval) { clearInterval(armorInterval); armorInterval=null; }
  if (eatInterval)   { clearInterval(eatInterval);   eatInterval=null; }
  if (pvpChallengeInterval) { clearInterval(pvpChallengeInterval); pvpChallengeInterval=null; }
  if (invCheckInterval)    { clearInterval(invCheckInterval);    invCheckInterval=null; }
  if (statusBarInterval)   { clearInterval(statusBarInterval);   statusBarInterval=null; }
  if (huntInterval)        { clearInterval(huntInterval);        huntInterval=null; isHunting=false; }
  if (pendingDuel) { clearTimeout(pendingDuel.timeout); pendingDuel=null; }
  cancelActiveDuel();
  stopAutoAttack(); stopAutoHunt(); resetState();
  try {
    if (bot) {
      bot.removeAllListeners();
      // Đóng hẳn socket TCP cũ để server không giữ session → tránh "logged in from another location"
      try { bot._client.end('disconnect.quitting'); } catch(e){}
      try { bot.end(); } catch(e){}
    }
  } catch(e){}
  bot = null;
  if (rejoinAttempts < MAX_REJOIN) {
    rejoinAttempts++;
    logW(`Mất kết nối. Thử lại [${rejoinAttempts}/${MAX_REJOIN}] sau ${REJOIN_DELAY/1000}s...`);
    setTimeout(()=>{ isRejoining=false; createBot(); }, REJOIN_DELAY);
  } else {
    logE('Thất bại 10 lần. Chờ 60s...'); rejoinAttempts=0;
    setTimeout(()=>{ isRejoining=false; createBot(); }, 60000);
  }
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

    // Timeout cảnh báo nếu spawn không về sau 40s
    const spawnTimeout = setTimeout(() => {
      if (!botOnline) {
        logW('Chờ spawn quá 40s — server có thể đang tải hoặc cần whitelist. Thử rejoin...');
        handleRejoin();
      }
    }, 40000);

    // forcedMove: một số server (proxy/Aternos) gửi cái này thay vì spawn
    bot.on('forcedMove', () => {
      if (!botOnline) { clearTimeout(spawnTimeout); botOnline = true; logJ('Bot đã vào thế giới (forcedMove)!'); }
      if (!mcData) { mcData=mcDataLoader(bot.version); refreshMovements(); rejoinAttempts=0; startWander(); }
    });
    // health: nếu nhận HP thì chắc chắn đang trong thế giới
    bot.once('health', () => {
      if (!botOnline) { clearTimeout(spawnTimeout); botOnline = true; logJ('Bot đã vào thế giới (health)!'); }
    });

    bot.once('spawn', () => {
      clearTimeout(spawnTimeout);
      botOnline = true; // ← đánh dấu bot đã vào thế giới
      rejoinAttempts=0; logJ('Bot đã vào thế giới!');
      if (!mcData) { mcData=mcDataLoader(bot.version); refreshMovements(); startWander(); }
      if (armorInterval) clearInterval(armorInterval);
      armorInterval = setInterval(()=>equipBestArmor(), 12000);
      if (eatInterval) clearInterval(eatInterval);
      eatInterval = setInterval(()=>autoEat(), 2000);
      startAutoAttack();
      startAutoHunt();
      startPvpChallengeTimer();
      if (statusBarInterval) clearInterval(statusBarInterval);
      statusBarInterval = setInterval(printStatusBar, 30000);
      if (invCheckInterval) clearInterval(invCheckInterval);
      invCheckInterval = setInterval(async () => {
        if (!bot || !mcData || isBusy || isFollowing) return;
        if (isInventoryFull()) {
          logS('🎒 Túi gần đầy! Tự động đi cất đồ...');
          await depositToChest('[Auto]');
        }
      }, 30000);
      bot.on('startedDigging', async (block) => { try { await equipToolForBlock(block); } catch(e){} });
      bot.on('entityHurt', (entity) => {
        if (entity !== bot.entity || isBusy || isFollowing) return;
        const pos = bot.entity?.position; if (!pos) return;
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
        } else {
          const rx = pos.x + (Math.random()-.5)*20, rz = pos.z + (Math.random()-.5)*20;
          try { bot.pathfinder.setGoal(new GoalXZ(rx, rz)); } catch(e){}
        }
      });
      let ad=null; bot.inventory.on('updateSlot', ()=>{ clearTimeout(ad); ad=setTimeout(()=>equipBestArmor(),800); });
    });

    bot.on('chat', async (user, msg) => {
      if (user===bot.username) return;
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
        if (isFullyArmored()) {
          // Chấp nhận — đếm ngược 1-2-3
          logS(`[PvP] ${user} thách đấu → chấp nhận (đủ giáp)`);
          const acceptMsg = await getAI(`${user} thách bot đấu PvP 1v1`, `Bot Minecraft chấp nhận đấu tự tin, 1 câu ngắn tiếng Việt.`);
          bot.chat(acceptMsg || `${user} được thôi! Đừng có hối hận!`);
          await new Promise(r => setTimeout(r, 1200));
          bot.chat('1...');
          await new Promise(r => setTimeout(r, 1000));
          bot.chat('2...');
          await new Promise(r => setTimeout(r, 1000));
          bot.chat('3! Bắt đầu! ⚔️');
          await new Promise(r => setTimeout(r, 300));
          startDuel(user);
        } else {
          // Từ chối — thiếu giáp
          const missing = getMissingArmorNames().join(', ');
          logS(`[PvP] ${user} thách đấu → từ chối (thiếu: ${missing})`);
          const denyMsg = await getAI(
            `${user} thách bot đấu PvP nhưng bot thiếu giáp: ${missing}`,
            `Bot Minecraft từ chối vì chưa đủ giáp, hứa sẽ đấu sau khi có giáp, 1 câu ngắn tiếng Việt, cá tính.`
          );
          bot.chat(denyMsg || `Tao thiếu ${missing}! Chờ tao có đủ giáp rồi tính!`);
        }
        return;
      }

      const isCmd = ['dừng','stop','dung'].includes(txt)
        ||['chặt gỗ','chặt cây','đào đá','đào nhà','phá nhà','pha nha','dao nha','mặc giáp','cất đồ','cat do','theo'].some(k=>txt.includes(k))
        ||(txt.startsWith('đào ')||txt.startsWith('dao ')||txt.startsWith('mine ')||txt.startsWith('phá ')||txt.startsWith('pha '));
      if (isCmd) { resetState(); await new Promise(r=>setTimeout(r,150)); stopTask=false; }
      if (['dừng','stop','dung'].includes(txt)) { bot._task='idle'; await botSay('Đã dừng'); startWander(); }
      else if (txt.includes('chặt gỗ')||txt.includes('chặt cây')) doTask('chop',user);
      else if (txt.includes('đào đá')) doTask('mine',user);
      else if (txt.includes('đào quặng')||txt.includes('dao quang')||txt.includes('khai thác')||txt.includes('mine ore')) {
        const ORE_ALIAS = {
          'kim cương':'diamond_ore','diamond':'diamond_ore',
          'sắt':'iron_ore','iron':'iron_ore',
          'vàng':'gold_ore','gold':'gold_ore',
          'than':'coal_ore','coal':'coal_ore',
          'đồng':'copper_ore','copper':'copper_ore',
          'đá đỏ':'redstone_ore','redstone':'redstone_ore',
          'lapis':'lapis_ore','ngọc lục bảo':'emerald_ore','emerald':'emerald_ore',
          'cổ':'ancient_debris','ancient':'ancient_debris',
        };
        let tgt = null;
        for (const [k,v] of Object.entries(ORE_ALIAS)) { if (txt.includes(k)) { tgt = v; break; } }
        resetState(); await new Promise(r=>setTimeout(r,150)); stopTask=false;
        mineOres(user, tgt);
      }
      else if (txt.includes('đào nhà')||txt.includes('phá nhà')||txt.includes('pha nha')||txt.includes('dao nha')) doTask('demolish',user);
      else if (txt.includes('làm nông')||txt.includes('thu hoạch')||txt.includes('farm')||txt.includes('lam nong')||txt.includes('thu hoach')) doFarm(user);
      else if (txt.includes('mặc giáp')) { await botSay('Đang mặc giáp tốt nhất'); await equipBestArmor(); }
      else if (txt.includes('cất đồ')||txt.includes('cat do')) depositToChest(user);
      else if (txt.includes('theo')) startFollow(user);
      else if (txt.startsWith('vứt ') || txt.startsWith('vut ')) {
        const q = txt.replace(/^(vứt|vut)\s+/,'').trim();
        dropItem(q, user);
      }
      else if (txt.includes('ngủ')||txt.includes('ngu di')||txt.includes('đi ngủ')) goSleep(user);
      else if (txt.includes('lên thuyền')||txt.includes('len thuyen')||txt.includes('thuyền')) boardBoat(user);
      // Tấn công người chơi: "đánh [tên]", "tấn công [tên]", "attack [tên]"
      else if (txt.startsWith('đánh ')||txt.startsWith('danh ')||txt.startsWith('tấn công ')||txt.startsWith('tan cong ')||txt.startsWith('attack ')) {
        const target = msg.trim().split(/\s+/).slice(1).join(' ').trim();
        if (target) attackPlayer(target, user);
        else bot.chat('Đánh ai? Ví dụ: đánh Steve');
      }
      // Drop theo yêu cầu: "cho tôi [item]", "cho [tôi/tên] [item]", "give [item]"
      else if (txt.startsWith('cho tôi ')||txt.startsWith('cho toi ')||txt.startsWith('give ')) {
        const q = txt.replace(/^(cho tôi|cho toi|give)\s+/,'').trim();
        if (q) { dropItem(q, user); }
        else bot.chat('Cho cái gì? Ví dụ: cho tôi stone');
      }
      else if (
        txt.startsWith('làm sàn')||txt.startsWith('lam san')||txt.startsWith('xây sàn')||txt.startsWith('xay san')||txt.startsWith('platform ')
      ) {
        // "làm sàn x1 y z1 x2 z2 blockname"
        const rawParts = msg.trim().split(/\s+/);
        const skip = (txt.startsWith('làm sàn')||txt.startsWith('lam san')||txt.startsWith('xây sàn')||txt.startsWith('xay san')) ? 2 : 1;
        const args = rawParts.slice(skip);
        if (args.length >= 6) {
          const [sx1,sy,sz1,sx2,sz2,...blkP] = args;
          const bx1=parseInt(sx1),by=parseInt(sy),bz1=parseInt(sz1),bx2=parseInt(sx2),bz2=parseInt(sz2);
          const blk = blkP[0]||'stone';
          if (isNaN(bx1)||isNaN(by)||isNaN(bz1)||isNaN(bx2)||isNaN(bz2)) {
            bot.chat('Toạ độ không hợp lệ! Dùng: làm sàn x1 y z1 x2 z2 blockname');
          } else {
            resetState(); await new Promise(r=>setTimeout(r,150)); stopTask=false;
            buildPlatform(bx1,by,bz1,bx2,bz2,blk,user);
          }
        } else {
          bot.chat('Dùng: làm sàn x1 y z1 x2 z2 blockname\nVí dụ: làm sàn 100 64 200 120 220 stone');
        }
      }
      else if (
        (txt.startsWith('đào ')||txt.startsWith('dao ')||txt.startsWith('mine ')||txt.startsWith('phá ')||txt.startsWith('pha ')) &&
        !txt.includes('đào đá') && !txt.includes('đào quặng') && !txt.includes('đào nhà') &&
        !txt.includes('dao nha') && !txt.includes('phá nhà') && !txt.includes('pha nha')
      ) {
        // Đào bất kỳ block nào theo tên: "đào oak_log", "đào cobblestone", "đào dirt", v.v.
        const blockArg = msg.trim().split(/\s+/).slice(1).join(' ').trim();
        if (blockArg) mineBlockType(blockArg, user);
        else bot.chat('Đào gì? Ví dụ: đào cobblestone, đào oak_log, đào dirt');
      }
      else if (shouldReply(user,msg)) await replyToChat(user,msg);
    });

    bot.on('kicked', (reason) => {
      clearTimeout(spawnTimeout);
      let r = typeof reason === 'string' ? reason : JSON.stringify(reason);
      // Thử parse JSON kick reason (dạng text component)
      try { const j=JSON.parse(r); r=j.text||j.translate||r; } catch(_){}
      lastError = `Bị kick: ${r.slice(0,200)}`;
      const isAnotherLocation = r.includes('another location') || r.includes('logged in') || r.includes('multiplayer.disconnect.duplicate_login');
      const isOutdated = r.includes('outdated') || r.includes('Outdated') || r.includes('version');
      const isWhitelist = r.includes('whitelist') || r.includes('not whitelisted');
      const isBanned   = r.includes('banned') || r.includes('Banned');
      if (isOutdated)        logW(`[KICK] Sai version! Server dùng version khác. Kiểm tra cấu hình.`);
      else if (isWhitelist)  logW(`[KICK] Bot không có trong whitelist server!`);
      else if (isBanned)     logW(`[KICK] Bot bị ban khỏi server!`);
      else                   logW(`[KICK] ${r.slice(0,200)}`);
      if (isAnotherLocation) {
        lastError = 'Bị kick: đăng nhập từ nơi khác (duplicate login)';
        logW(lastError + ' — Chờ 10s rồi rejoin...');
        if (isRejoining) return; isRejoining = true;
        botOnline = false;
        try { bot.removeAllListeners(); try { bot._client.end(); } catch(e){} bot.end(); } catch(e){}
        bot = null;
        setTimeout(() => { isRejoining = false; createBot(); }, 10000);
      } else if (isWhitelist || isBanned) {
        logE('Dừng tự rejoin vì whitelist/ban. Sửa config rồi restart bot.');
        // Không rejoin tự động khi bị ban/whitelist
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
    bot.on('end', (reason) => { clearTimeout(spawnTimeout); botOnline = false; logW(`Mất kết nối (End${reason?' — '+reason:''}). Rejoin...`); handleRejoin(); });
  } catch(err) {
    lastError = `Lỗi tạo bot: ${err.message}`;
    logE(lastError);
    rejoinAttempts++;
    isRejoining = true; // giữ "connecting" thay vì "offline"
    const delay = rejoinAttempts >= MAX_REJOIN ? 60000 : REJOIN_DELAY;
    if (rejoinAttempts >= MAX_REJOIN) { logE('Thất bại nhiều lần. Chờ 60s...'); rejoinAttempts = 0; }
    setTimeout(() => { isRejoining = false; createBot(); }, delay);
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
  isBusy = true; bot._task = 'ngủ'; refreshMovements();
  const BED_BLOCKS = Object.keys(mcData.blocksByName)
    .filter(n => n.endsWith('_bed'))
    .map(n => mcData.blocksByName[n].id);
  const bed = bot.findBlock({ matching: BED_BLOCKS, maxDistance: 64 });
  if (!bed) {
    bot.chat('Không tìm thấy giường nào gần đây (trong 64 block)');
    isBusy = false; if (!isFollowing) startWander(); return;
  }
  try {
    await bot.pathfinder.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
    await new Promise(r => setTimeout(r, 400));
    // Thử sleep — trong MC cần phải là ban đêm hoặc thunderstorm
    await bot.sleep(bed);
    logS(`[${who}] Đang ngủ...`);
    bot.chat('Ngủ ngon 💤');
    // Chờ bot thực sự thức dậy (sự kiện 'wake') thay vì setTimeout cố định
    await new Promise((resolve) => {
      const onWake = () => resolve();
      bot.once('wake', onWake);
      // Fallback: tối đa 15s rồi wake thủ công
      setTimeout(async () => {
        bot.removeListener('wake', onWake);
        try { await bot.wake(); } catch(_){}
        resolve();
      }, 15000);
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
  isBusy = true; bot._task = 'lên thuyền'; refreshMovements();

  // Tìm thuyền gần nhất trong 64 block (hỗ trợ mọi loại: oak_boat, spruce_boat, chest_boat…)
  const findBoat = () => {
    let nearest = null, nearDist = 64;
    for (const entity of Object.values(bot.entities)) {
      if (!entity.name?.includes('boat')) continue;
      if (!entity.position) continue;
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
    // Tiếp cận — thuyền thường nổi trên nước nên dùng GoalNear
    await bot.pathfinder.goto(new GoalNear(boat0.position.x, boat0.position.y, boat0.position.z, 2));
    await new Promise(r => setTimeout(r, 400));

    // Lấy lại entity sau khi đã di chuyển
    const boat = findBoat();
    if (!boat) throw new Error('Thuyền đã biến mất');

    // Nhìn vào giữa thuyền
    await bot.lookAt(boat.position.offset(0, (boat.height || 0.9) * 0.5, 0));
    await new Promise(r => setTimeout(r, 150));

    // Thử mount tối đa 3 lần; mỗi lần thất bại tiến sát hơn
    let boarded = false;
    for (let attempt = 0; attempt < 3 && !boarded; attempt++) {
      try { await bot.mount(boat); } catch(_) {}
      await new Promise(r => setTimeout(r, 350));
      if (bot.vehicle) { boarded = true; break; }

      // Fallback: activateEntity
      try { bot.activateEntity(boat); } catch(_) {}
      await new Promise(r => setTimeout(r, 350));
      if (bot.vehicle) { boarded = true; break; }

      // Tiến sát thêm rồi thử lại
      const fresh = findBoat();
      if (fresh) {
        try { await bot.pathfinder.goto(new GoalNear(fresh.position.x, fresh.position.y, fresh.position.z, 1)); } catch(_){}
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (boarded || bot.vehicle) {
      logS(`[${who}] Đã lên thuyền ✅`);
      bot.chat('Lên thuyền rồi! 🚤');
    } else {
      throw new Error('Không thể lên thuyền sau 3 lần thử');
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
          await bot.equip(item, 'hand');
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
  }
}

// ── KHỞI ĐỘNG ─────────────────────────────────────────────────────
printBanner();
logS('Tự đánh: BẬT | Tự ăn: BẬT | Tự mặc giáp: BẬT | Tự chọn tool: BẬT');
createBot();

// ── WEB CONSOLE STDIN INTERFACE ────────────────────────────────────
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
    if (!bot || !botOnline) return;
    const user = '__WebConsole__';
    resetState();
    setTimeout(() => {
      stopTask = false;
      if (['dừng','stop','dung'].includes(txt)) { bot._task='idle'; startWander(); }
      else if (txt.includes('chặt gỗ')||txt.includes('chặt cây')) doTask('chop',user);
      else if (txt.includes('đào đá')) doTask('mine',user);
      else if (txt.includes('đào quặng')||txt.includes('khai thác')||txt.includes('mine ore')) mineOres(user,null);
      else if (txt.includes('đào nhà')||txt.includes('phá nhà')||txt.includes('pha nha')) doTask('demolish',user);
      else if (txt.includes('làm nông')||txt.includes('farm')||txt.includes('thu hoạch')) doFarm(user);
      else if (txt.includes('mặc giáp')) equipBestArmor();
      else if (txt.includes('cất đồ')||txt.includes('cat do')) depositToChest(user);
      else if (txt.startsWith('theo ')) { const t=raw.trim().replace(/^theo\s+/i,'').trim(); if(t) startFollow(t); }
      else if (txt.includes('ngủ')||txt.includes('ngu di')) goSleep(user);
      else if (txt.includes('lên thuyền')||txt.includes('len thuyen')||txt.includes('thuyền')) boardBoat(user);
      else if (txt.startsWith('vứt ')||txt.startsWith('vut ')) { const q=raw.trim().replace(/^(vứt|vut)\s+/i,'').trim(); if(q) dropItem(q,user); }
      else if (txt.startsWith('platform ')||txt.startsWith('làm sàn ')||txt.startsWith('xây sàn ')) {
        const parts=raw.trim().split(/\s+/); const skip=parts[0].toLowerCase()==='platform'?1:2;
        const args=parts.slice(skip);
        if(args.length>=5){ const [sx1,sy,sz1,sx2,sz2,...blkP]=args; buildPlatform(parseInt(sx1),parseInt(sy),parseInt(sz1),parseInt(sx2),parseInt(sz2),blkP[0]||'stone',user); }
      }
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
    return;
  }
  if (cmd.type === 'status') {
    let pos=null, inventory=[], armor={helmet:null,chestplate:null,leggings:null,boots:null}, heldItem=null;
    try { if(bot?.entity?.position){const p=bot.entity.position;pos={x:Math.round(p.x),y:Math.round(p.y),z:Math.round(p.z)};} } catch(e){}
    try {
      if(bot && botOnline) {
        inventory = bot.inventory.items().map(i=>({name:i.name,displayName:i.displayName||i.name,count:i.count}));
        const sl = bot.inventory.slots;
        const ARMOR_SLOTS = {helmet:5,chestplate:6,leggings:7,boots:8};
        for(const [part,idx] of Object.entries(ARMOR_SLOTS)){
          const it=sl[idx]; if(it) armor[part]={name:it.name,displayName:it.displayName||it.name};
        }
        const h=bot.heldItem; if(h) heldItem={name:h.name,displayName:h.displayName||h.name,count:h.count};
      }
    } catch(e){}
    process.stdout.write(JSON.stringify({
      __STATUS__:true, online:!!botOnline, reconnecting:!!isRejoining,
      hp:Math.round((bot?.health??0)*10)/10, food:Math.round(bot?.food??0),
      task:bot?._task||'offline', pos, server:CONFIG.host, port:CONFIG.port,
      username:CONFIG.username, lastError, autoAttack:autoAttackEnabled, autoEat:autoEatEnabled,
      inventory, armor, heldItem,
    })+'\n');
    return;
  }
  if (cmd.type === 'toggle') {
    if(cmd.feature==='autoAttack'){ autoAttackEnabled=!autoAttackEnabled; if(!autoAttackEnabled)stopAutoAttack(); else startAutoAttack(); }
    else if(cmd.feature==='autoEat'){ autoEatEnabled=!autoEatEnabled; }
    return;
  }
}
