// ═══════════════════════════════════════════════════════════════════
//  3D2Y Bot Console — ALL-IN-ONE SERVER
//
//  Yêu cầu (cài 1 lần):
//    npm install express ws cors
//
//  Chạy:
//    node server.cjs
//
//  Mở trình duyệt:
//    http://localhost:3000          (cùng máy)
//    http://192.168.x.x:3000       (máy khác trong mạng LAN)
//
//  Bot file (phải ở cùng thư mục):
//    bot.cjs
// ═══════════════════════════════════════════════════════════════════
'use strict';

const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn }  = require('child_process');
const path       = require('path');
const EventEmitter = require('events');

const PORT = parseInt(process.env.PORT || '3000');
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ══════════════════════════════════════════════════════════════════════
//  BOT MANAGER
// ══════════════════════════════════════════════════════════════════════
class BotManager extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this._logs = [];
    this._status = {
      online: false, reconnecting: false,
      hp: 0, food: 0, task: 'stopped', pos: null,
      server: 'Khanh-Khi.aternos.me', port: 52717,
      username: 'KhanhKhi', lastError: '',
      autoAttack: true, autoEat: true, running: false,
      inventory: [],
      armor: { helmet: null, chestplate: null, leggings: null, boots: null },
      heldItem: null,
    };
    this.statusInterval = null;
  }

  get isRunning()     { return this._status.running; }
  get currentStatus() { return { ...this._status }; }
  get recentLogs()    { return this._logs.slice(-300); }

  start(config = {}) {
    if (this.proc) return;
    const botPath = path.resolve(__dirname, 'bot.cjs');
    const env = { ...process.env };
    if (config.host)     env.BOT_HOST     = config.host;
    if (config.port)     env.BOT_PORT     = String(config.port);
    if (config.username) env.BOT_USERNAME = config.username;
    if (config.version)  env.BOT_VERSION  = config.version;

    this.proc = spawn('node', [botPath], { env, cwd: __dirname, stdio: ['pipe','pipe','pipe'] });
    this._status.running = true;
    this._status.task = 'connecting';
    this.emit('status', this.currentStatus);

    const handle = (data) => {
      for (const rawLine of data.toString('utf8').split('\n')) {
        const line = rawLine.replace(ANSI_RE, '').trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.__STATUS__) {
            const { __STATUS__, ...s } = parsed;
            Object.assign(this._status, s);
            this.emit('status', this.currentStatus);
            continue;
          }
        } catch {}
        const entry = { time: Date.now(), text: line };
        this._logs.push(entry);
        if (this._logs.length > 1000) this._logs.shift();
        this.emit('log', entry);
      }
    };

    this.proc.stdout.on('data', handle);
    this.proc.stderr.on('data', handle);
    this.proc.on('exit', (code) => {
      const entry = { time: Date.now(), text: `[Manager] Bot process exited (code ${code ?? '?'})` };
      this._logs.push(entry);
      this.emit('log', entry);
      this.proc = null;
      Object.assign(this._status, { running: false, online: false, task: 'stopped' });
      this.emit('status', this.currentStatus);
      if (this.statusInterval) { clearInterval(this.statusInterval); this.statusInterval = null; }
    });

    this.statusInterval = setInterval(() => this._send({ type: 'status' }), 3000);
  }

  stop() {
    if (this.statusInterval) { clearInterval(this.statusInterval); this.statusInterval = null; }
    if (!this.proc) return;
    this._send({ type: 'disconnect' });
    setTimeout(() => {
      if (this.proc) { this.proc.kill('SIGTERM'); this.proc = null; }
      Object.assign(this._status, { running: false, online: false, task: 'stopped' });
      this.emit('status', this.currentStatus);
    }, 2500);
  }

  _send(cmd) {
    if (!this.proc?.stdin) return;
    try { this.proc.stdin.write(JSON.stringify(cmd) + '\n'); } catch {}
  }

  chat(msg)          { this._send({ type: 'chat', msg }); }
  command(msg)       { this._send({ type: 'command', msg }); }
  toggle(feature)    { this._send({ type: 'toggle', feature }); }
  updateConfig(cfg)  {
    this._send({ type: 'config', ...cfg });
    if (cfg.host)     this._status.server   = cfg.host;
    if (cfg.port)     this._status.port     = cfg.port;
    if (cfg.username) this._status.username = cfg.username;
  }
}

const bot = new BotManager();

// ══════════════════════════════════════════════════════════════════════
//  EXPRESS API
// ══════════════════════════════════════════════════════════════════════
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/bot/status', (_req, res) => res.json(bot.currentStatus));
app.get('/api/bot/logs',   (_req, res) => res.json({ logs: bot.recentLogs }));

app.post('/api/bot/start', (req, res) => {
  if (bot.isRunning) return res.json({ success: false, message: 'Already running' });
  bot.start(req.body ?? {});
  res.json({ success: true });
});

app.post('/api/bot/stop', (_req, res) => {
  if (!bot.isRunning) return res.json({ success: false, message: 'Not running' });
  bot.stop();
  res.json({ success: true });
});

app.post('/api/bot/command', (req, res) => {
  const { msg, type = 'command' } = req.body ?? {};
  if (!msg) return res.status(400).json({ error: 'msg required' });
  type === 'chat' ? bot.chat(String(msg)) : bot.command(String(msg));
  res.json({ success: true });
});

app.post('/api/bot/toggle', (req, res) => {
  const { feature } = req.body ?? {};
  if (!feature) return res.status(400).json({ error: 'feature required' });
  bot.toggle(String(feature));
  res.json({ success: true });
});

app.post('/api/bot/config', (req, res) => {
  bot.updateConfig(req.body ?? {});
  res.json({ success: true });
});

// Serve the UI
app.get('/', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(UI_HTML); });

// ══════════════════════════════════════════════════════════════════════
//  HTTP + WEBSOCKET SERVER
// ══════════════════════════════════════════════════════════════════════
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/api/ws' });

const broadcast = (data) => {
  const msg = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
};

bot.on('log',    (entry)  => broadcast({ type: 'log', ...entry }));
bot.on('status', (status) => broadcast({ type: 'status', ...status }));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', logs: bot.recentLogs, status: bot.currentStatus }));
  ws.on('error', () => {});
  ws.on('close', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) nets.push(iface.address);
    }
  }

  const C = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    cyan:   '\x1b[38;5;81m',
    orange: '\x1b[38;5;214m',
    green:  '\x1b[38;5;82m',
    gray:   '\x1b[38;5;240m',
    white:  '\x1b[38;5;255m',
    blue:   '\x1b[38;5;117m',
    yellow: '\x1b[38;5;226m',
  };

  const line = (color, text) => console.log(color + text + C.reset);

  console.log('');
  line(C.cyan, `   ██████╗ ██████╗ ██████╗ ██╗   ██╗`);
  line(C.cyan, `   ╚════██╗██╔══██╗╚════██╗╚██╗ ██╔╝`);
  line(C.cyan, `    █████╔╝██║  ██║ █████╔╝ ╚████╔╝ `);
  line(C.cyan, `    ╚═══██╗██║  ██║██╔═══╝   ╚██╔╝  `);
  line(C.cyan, `   ██████╔╝██████╔╝███████╗   ██║   `);
  line(C.cyan, `   ╚═════╝ ╚═════╝ ╚══════╝   ╚═╝   `);
  console.log('');
  line(C.orange, `   Bot Console  ${C.dim}v1.0  —  node ${process.version}${C.reset}`);
  console.log('');
  line(C.gray,  `   ┌─────────────────────────────────────`);
  line(C.gray,  `   │`);
  line(C.gray,  `   │  ${C.white}${C.bold}Local   ${C.reset}${C.blue}  http://localhost:${PORT}${C.reset}`);
  for (const ip of nets) {
    line(C.gray, `   │  ${C.white}${C.bold}Network ${C.reset}${C.green}  http://${ip}:${PORT}${C.reset}`);
  }
  line(C.gray,  `   │`);
  line(C.gray,  `   │  ${C.yellow}Bot file:  ${C.reset}${C.white}bot.cjs${C.reset}`);
  line(C.gray,  `   │  ${C.yellow}API:       ${C.reset}${C.white}/api/*${C.reset}`);
  line(C.gray,  `   │  ${C.yellow}WebSocket: ${C.reset}${C.white}/api/ws${C.reset}`);
  line(C.gray,  `   │`);
  line(C.gray,  `   └─────────────────────────────────────`);
  console.log('');
  line(C.green, `   ✓ Server ready — open the URL above in your browser`);
  console.log('');
});

// ══════════════════════════════════════════════════════════════════════
//  WEB UI  (React 18 + Tailwind CDN + Babel standalone)
// ══════════════════════════════════════════════════════════════════════
const UI_HTML = /* html */`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>3D2Y Bot Console</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<style>
  :root {
    --term-bg:#0a0c10; --term-surface:#0d1117; --term-border:#21262d;
    --term-cyan:#58d6f5; --term-green:#3fb950; --term-red:#f85149;
    --term-orange:#e3a84b; --term-purple:#a78bfa; --term-yellow:#e3c63d;
    --term-gray:#586069; --term-white:#c9d1d9; --term-blue:#79c0ff;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--term-bg);color:var(--term-white);font-family:monospace;overflow:hidden;height:100vh}
  #root{height:100vh;overflow:hidden}
  .term-scroll{scrollbar-width:thin;scrollbar-color:#30363d transparent}
  .term-scroll::-webkit-scrollbar{width:6px}
  .term-scroll::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
  .log-sys{color:var(--term-cyan)}
  .log-join{color:var(--term-green)}
  .log-chat{color:var(--term-purple)}
  .log-warn{color:var(--term-orange)}
  .log-err{color:var(--term-red)}
  .log-default{color:var(--term-white)}
  @keyframes pulse-green{0%,100%{box-shadow:0 0 0 0 rgba(63,185,80,.4)}50%{box-shadow:0 0 0 6px rgba(63,185,80,0)}}
  .led-online{animation:pulse-green 2s ease-in-out infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .animate-spin{animation:spin 1s linear infinite}
  @keyframes blink2{0%,100%{opacity:1}50%{opacity:0}}
  .animate-pulse{animation:blink2 2s ease-in-out infinite}
  button:disabled{opacity:.4;cursor:not-allowed}
  input{outline:none}
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useRef, useCallback } = React;

const MC = "https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.1/assets/minecraft/textures";
const mcItemUrl  = n => MC+"/item/"+n+".png";
const mcBlockUrl = n => MC+"/block/"+n+".png";

function McItemImage({ name, size=24, style={} }) {
  const [src, setSrc] = useState(() => mcItemUrl(name));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setSrc(mcItemUrl(name)); setAttempt(0); }, [name]);
  const onError = () => {
    if (attempt===0) { setSrc(mcBlockUrl(name)); setAttempt(1); }
    else if (attempt===1) { setSrc(mcBlockUrl(name+"_top")); setAttempt(2); }
    else setAttempt(3);
  };
  if (attempt>=3) return <div style={{width:size,height:size,background:"#2d333b",borderRadius:2,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*.45,color:"#586069",flexShrink:0,...style}}>{name[0]?.toUpperCase()}</div>;
  return <img src={src} onError={onError} alt={name} draggable={false} style={{width:size,height:size,imageRendering:"pixelated",flexShrink:0,...style}}/>;
}

function classifyLog(t) {
  const l = t.toLowerCase();
  if (l.includes("[sys")||l.includes("│")) return "log-sys";
  if (l.includes("[join")) return "log-join";
  if (l.includes("[chat")) return "log-chat";
  if (l.includes("[warn")||l.includes("[manager]")) return "log-warn";
  if (l.includes("[err")||l.includes("lỗi")) return "log-err";
  return "log-default";
}
const fmt = ts => new Date(ts).toLocaleTimeString("vi-VN",{hour12:false});

function tierColor(name) {
  const t = (name||"").split("_")[0];
  return {diamond:"#58d6f5",netherite:"#ab8cd5",iron:"#a8b5c4",gold:"#f0c040",chainmail:"#8fa880",leather:"#b57a42"}[t] ?? "#c9d1d9";
}

function Bar({ value, max=20, color, item }) {
  const pct = Math.min(100,(value/max)*100);
  return <div style={{display:"flex",alignItems:"center",gap:6}}>
    <McItemImage name={item} size={14}/>
    <div style={{width:56,height:6,background:"#21262d",borderRadius:9999,overflow:"hidden"}}>
      <div style={{height:"100%",borderRadius:9999,transition:"width .5s",width:pct+"%",backgroundColor:color}}/>
    </div>
    <span style={{fontSize:11,fontFamily:"monospace",color}}>{Math.round(value*10)/10}/{max}</span>
  </div>;
}

function Toggle({ label, value, onToggle, disabled }) {
  return <button onClick={onToggle} disabled={disabled} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",padding:"6px 8px",borderRadius:4,fontSize:11,fontFamily:"monospace",background:"#161b22",border:"1px solid var(--term-border)",color:value?"var(--term-green)":"var(--term-gray)",cursor:"pointer"}}>
    <span>{label}</span>
    <span style={{padding:"0 4px",borderRadius:3,fontSize:10,fontWeight:"bold",background:value?"#0d4a1f":"#2d333b"}}>{value?"ON":"OFF"}</span>
  </button>;
}

function SHead({ label }) {
  return <div style={{fontSize:10,fontFamily:"monospace",fontWeight:"bold",letterSpacing:2,color:"var(--term-gray)",marginBottom:8}}>{label}</div>;
}

function Ico({ name, size=18 }) {
  return <McItemImage name={name} size={size}/>;
}

function QBtn({ label, cmd, item, disabled, onCmd }) {
  const [hover, setHover] = useState(false);
  return <button onClick={()=>onCmd(cmd)} disabled={disabled}
    onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
    style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",borderRadius:4,fontSize:11,fontFamily:"monospace",width:"100%",cursor:"pointer",background:hover?"#1f2937":"#161b22",color:"var(--term-blue)",border:"1px solid var(--term-border)"}}>
    <Ico name={item} size={18}/><span>{label}</span>
  </button>;
}

const ALL_CMDS = [
  {group:"Tasks", item:"crafting_table", items:[
    {cmd:"chặt gỗ",desc:"Chặt cây gỗ gần nhất liên tục"},
    {cmd:"đào đá",desc:"Đào cobblestone/stone gần nhất"},
    {cmd:"đào quặng",desc:"Đào quặng iron (mặc định)"},
    {cmd:"làm nông",desc:"Thu hoạch + trồng lại cây nông nghiệp"},
    {cmd:"phá nhà",desc:"Phá các block xung quanh"},
    {cmd:"cất đồ",desc:"Tìm rương và cất toàn bộ đồ"},
    {cmd:"mặc giáp",desc:"Tự mặc bộ giáp tốt nhất trong túi"},
    {cmd:"ngủ",desc:"Tìm giường gần nhất và ngủ"},
    {cmd:"lên thuyền",desc:"Leo lên thuyền gần nhất"},
  ]},
  {group:"Di chuyển", item:"compass", items:[
    {cmd:"theo [tên]",desc:"Theo sát người chơi"},
    {cmd:"dừng / stop",desc:"Dừng tất cả task"},
  ]},
  {group:"Chiến đấu", item:"diamond_sword", items:[
    {cmd:"đánh [tên]",desc:"Tấn công người chơi theo tên"},
  ]},
];

function HelpModal({ onClose }) {
  return <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",padding:16,background:"rgba(0,0,0,.85)"}}>
    <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:480,borderRadius:8,overflow:"hidden",background:"var(--term-surface)",border:"1px solid var(--term-border)",maxHeight:"80vh",display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderBottom:"1px solid var(--term-border)",background:"#161b22"}}>
        <span style={{fontFamily:"monospace",fontWeight:"bold",fontSize:13,color:"var(--term-cyan)",display:"flex",alignItems:"center",gap:6}}><McItemImage name="book" size={16}/>ALL COMMANDS</span>
        <button onClick={onClose} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#ccc",lineHeight:1}}>✕</button>
      </div>
      <div className="term-scroll" style={{overflowY:"auto",padding:16,display:"flex",flexDirection:"column",gap:16}}>
        {ALL_CMDS.map(g=><div key={g.group}>
          <div style={{fontSize:12,fontWeight:"bold",marginBottom:8,color:"var(--term-orange)",display:"flex",alignItems:"center",gap:6}}><McItemImage name={g.item} size={14}/>{g.group}</div>
          {g.items.map(i=><div key={i.cmd} style={{display:"flex",gap:12,fontSize:11,fontFamily:"monospace",marginBottom:4}}>
            <span style={{flexShrink:0,width:180,color:"var(--term-cyan)"}}>{i.cmd}</span>
            <span style={{color:"var(--term-gray)"}}>{i.desc}</span>
          </div>)}
        </div>)}
      </div>
    </div>
  </div>;
}

const SLOT=36, COLS=9;
function InventoryGrid({ items }) {
  const [open,setOpen]=useState(true);
  const rows=Math.max(2,Math.ceil(items.length/COLS));
  const total=Math.min(rows*COLS,36);
  return <section style={{borderBottom:"1px solid var(--term-border)"}}>
    <button onClick={()=>setOpen(v=>!v)} style={{width:"100%",padding:"8px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"none",border:"none",cursor:"pointer"}}>
      <span style={{fontSize:10,fontFamily:"monospace",fontWeight:"bold",letterSpacing:2,color:"var(--term-gray)"}}>INVENTORY</span>
      <span style={{fontSize:10,fontFamily:"monospace",color:items.length>=27?"var(--term-red)":"var(--term-gray)"}}>{items.length}/36 {open?"▲":"▼"}</span>
    </button>
    {open&&<div style={{padding:"0 12px 12px"}}>
      <div className="term-scroll" style={{display:"grid",gridTemplateColumns:"repeat("+COLS+","+SLOT+"px)",gap:2,maxHeight:SLOT*4+6,overflowY:"auto"}}>
        {Array.from({length:total}).map((_,idx)=>{
          const item=items[idx];
          return <div key={idx} style={{width:SLOT,height:SLOT,background:item?"#1a2233":"#141c2b",border:"1px solid "+(item?"#3a4a6b":"#1e2a3b"),borderRadius:2,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}} title={item?item.displayName+" ×"+item.count:""}>
            {item&&<><McItemImage name={item.name} size={SLOT-8}/>
            {item.count>1&&<span style={{position:"absolute",bottom:0,right:2,fontSize:10,fontWeight:"bold",color:"#fff",textShadow:"1px 1px 0 #000,-1px -1px 0 #000"}}>{item.count}</span>}</>}
          </div>;
        })}
      </div>
      {items.length===0&&<div style={{fontSize:11,fontFamily:"monospace",textAlign:"center",padding:"4px 0",color:"var(--term-gray)"}}>Túi trống</div>}
    </div>}
  </section>;
}

const ARMOR_DEF={helmet:"leather_helmet",chestplate:"leather_chestplate",leggings:"leather_leggings",boots:"leather_boots"};
const ARMOR_LBL={helmet:"Mũ",chestplate:"Áo",leggings:"Quần",boots:"Giày"};
function EquipPanel({ armor, held }) {
  const [open,setOpen]=useState(true);
  return <section style={{borderBottom:"1px solid var(--term-border)"}}>
    <button onClick={()=>setOpen(v=>!v)} style={{width:"100%",padding:"8px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"none",border:"none",cursor:"pointer"}}>
      <span style={{fontSize:10,fontFamily:"monospace",fontWeight:"bold",letterSpacing:2,color:"var(--term-gray)"}}>TRANG BỊ</span>
      <span style={{fontSize:10,color:"var(--term-gray)"}}>{open?"▲":"▼"}</span>
    </button>
    {open&&<div style={{padding:"0 12px 12px",display:"flex",flexDirection:"column",gap:6}}>
      {["helmet","chestplate","leggings","boots"].map(part=>{
        const piece=armor[part];
        return <div key={part} style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:30,height:30,background:piece?"#1a2233":"#141c2b",border:"1px solid "+(piece?"#3a4a6b":"#1e2a3b"),borderRadius:4,display:"flex",alignItems:"center",justifyContent:"center",opacity:piece?1:.3}}>
            <McItemImage name={piece?.name??ARMOR_DEF[part]} size={22}/>
          </div>
          <div style={{display:"flex",flexDirection:"column"}}>
            <span style={{fontSize:10,fontFamily:"monospace",color:"var(--term-gray)"}}>{ARMOR_LBL[part]}</span>
            <span style={{fontSize:11,fontFamily:"monospace",color:piece?tierColor(piece.name):"#2d333b"}}>{piece?.displayName??"—"}</span>
          </div>
        </div>;
      })}
      <div style={{display:"flex",alignItems:"center",gap:8,paddingTop:4,borderTop:"1px solid #21262d"}}>
        <div style={{width:30,height:30,background:held?"#1a2233":"#141c2b",border:"1px solid "+(held?"#3a4a6b":"#1e2a3b"),borderRadius:4,display:"flex",alignItems:"center",justifyContent:"center",opacity:held?1:.3}}>
          {held?<McItemImage name={held.name} size={22}/>:<div style={{width:22,height:22,background:"#2d333b",borderRadius:2}}/>}
        </div>
        <div style={{display:"flex",flexDirection:"column"}}>
          <span style={{fontSize:10,fontFamily:"monospace",color:"var(--term-gray)"}}>Tay phải</span>
          <span style={{fontSize:11,fontFamily:"monospace",color:held?"var(--term-yellow)":"#2d333b"}}>{held?held.displayName+" ×"+held.count:"—"}</span>
        </div>
      </div>
    </div>}
  </section>;
}

function DropPanel({ onCmd, disabled }) {
  const [item,setItem]=useState("");
  const drop=()=>{ if(item.trim()){onCmd("vứt "+item.trim());setItem("");} };
  return <section style={{padding:12,borderBottom:"1px solid var(--term-border)"}}>
    <SHead label="VỨT ĐỒ"/>
    <div style={{display:"flex",gap:4}}>
      <input value={item} onChange={e=>setItem(e.target.value)} onKeyDown={e=>e.key==="Enter"&&drop()} placeholder="gỗ / đá / all …" disabled={disabled}
        style={{flex:1,padding:"4px 8px",borderRadius:4,fontSize:11,fontFamily:"monospace",background:"#161b22",color:"var(--term-white)",border:"1px solid var(--term-border)"}}/>
      <button onClick={drop} disabled={disabled||!item.trim()} style={{display:"flex",alignItems:"center",gap:4,padding:"4px 8px",borderRadius:4,fontSize:11,fontFamily:"monospace",fontWeight:"bold",background:"#b91c1c",color:"#fff",border:"none",cursor:"pointer"}}>
        <McItemImage name="barrier" size={14}/> Vứt
      </button>
    </div>
    <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>
      {[{q:"all",i:"barrier"},{q:"gỗ",i:"oak_log"},{q:"đá",i:"cobblestone"},{q:"cát",i:"sand"},{q:"đất",i:"dirt"}].map(({q,i})=>(
        <button key={q} disabled={disabled} onClick={()=>onCmd("vứt "+q)} style={{display:"flex",alignItems:"center",gap:4,padding:"2px 6px",borderRadius:3,fontSize:10,fontFamily:"monospace",background:"#2d333b",color:"var(--term-gray)",border:"none",cursor:"pointer"}}>
          <McItemImage name={i} size={12}/>{q}
        </button>
      ))}
    </div>
  </section>;
}

function FollowInput({ onFollow, disabled }) {
  const [name,setName]=useState("");
  const go=()=>{ if(name.trim()){onFollow(name.trim());setName("");} };
  return <div style={{display:"flex",gap:4}}>
    <input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="Player name..." disabled={disabled}
      style={{flex:1,padding:"4px 8px",borderRadius:4,fontSize:11,fontFamily:"monospace",background:"#161b22",color:"var(--term-white)",border:"1px solid var(--term-border)"}}/>
    <button onClick={go} disabled={disabled||!name.trim()} style={{padding:"4px 8px",borderRadius:4,fontSize:12,fontFamily:"monospace",fontWeight:"bold",background:"#1a7f37",color:"#fff",border:"none",cursor:"pointer"}}>→</button>
  </div>;
}

// ── MAIN APP ─────────────────────────────────────────────────────────
const DEFAULT_STATUS = {
  running:false,online:false,reconnecting:false,
  hp:0,food:0,task:"stopped",pos:null,
  server:"Khanh-Khi.aternos.me",port:52717,username:"KhanhKhi",
  lastError:"",autoAttack:true,autoEat:true,
  inventory:[],armor:{helmet:null,chestplate:null,leggings:null,boots:null},heldItem:null,
};

function App() {
  const [logs,setLogs]=useState([]);
  const [status,setStatus]=useState(DEFAULT_STATUS);
  const [wsState,setWsState]=useState("connecting");
  const [input,setInput]=useState("");
  const [inputMode,setInputMode]=useState("command");
  const [config,setConfig]=useState({host:"Khanh-Khi.aternos.me",port:"52717",username:"KhanhKhi",version:"1.21.11"});
  const [showConfig,setShowConfig]=useState(false);
  const [showHelp,setShowHelp]=useState(false);
  const [autoScroll,setAutoScroll]=useState(true);
  const [mobileTab,setMobileTab]=useState("console");
  const [repeatMode,setRepeatMode]=useState(false);
  const [repeatActive,setRepeatActive]=useState(false);
  const [repeatCmd,setRepeatCmd]=useState("");
  const [repeatTick,setRepeatTick]=useState(0);

  const logsEnd=useRef(null);
  const logsBox=useRef(null);
  const wsRef=useRef(null);
  const reTimer=useRef(null);
  const retryCount=useRef(0);
  const repeatRef=useRef(null);
  const tickRef=useRef(null);

  const connectWs=useCallback(()=>{
    const s=wsRef.current?.readyState;
    if(s===WebSocket.OPEN||s===WebSocket.CONNECTING) return;
    const proto=location.protocol==="https:"?"wss:":"ws:";
    const ws=new WebSocket(proto+"//"+location.host+"/api/ws");
    wsRef.current=ws;
    setWsState("connecting");
    ws.onopen=()=>{ setWsState("open"); retryCount.current=0; };
    ws.onmessage=e=>{
      try{
        const msg=JSON.parse(e.data);
        if(msg.type==="init"){setLogs(msg.logs??[]);if(msg.status)setStatus(s=>({...s,...msg.status}));}
        else if(msg.type==="log") setLogs(p=>[...p.slice(-999),{time:msg.time,text:msg.text}]);
        else if(msg.type==="status") setStatus(s=>({...s,...msg}));
      }catch{}
    };
    ws.onclose=()=>{
      setWsState("closed");
      const delay=Math.min(1000*Math.pow(2,retryCount.current),30000);
      retryCount.current++;
      reTimer.current=setTimeout(connectWs,delay);
    };
    ws.onerror=()=>{ try{ws.close();}catch{} };
  },[]);

  useEffect(()=>{
    connectWs();
    return ()=>{ if(reTimer.current) clearTimeout(reTimer.current); wsRef.current?.close(); };
  },[connectWs]);

  useEffect(()=>{
    if(autoScroll && logsBox.current){
      logsBox.current.scrollTop = logsBox.current.scrollHeight;
    }
  },[logs,autoScroll]);

  const onScroll=()=>{
    const el=logsBox.current;
    if(el) setAutoScroll(el.scrollHeight-el.scrollTop-el.clientHeight<40);
  };

  const api=async(path,body)=>{
    try{ await fetch("/api"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined}); }catch{}
  };
  const startBot=()=>api("/bot/start",{host:config.host,port:parseInt(config.port)||25565,username:config.username,version:config.version});
  const stopBot=()=>api("/bot/stop");
  const toggle=f=>api("/bot/toggle",{feature:f});

  const REPEAT_INTERVAL=5000;

  const stopRepeat=useCallback(()=>{
    if(repeatRef.current){ clearInterval(repeatRef.current); repeatRef.current=null; }
    if(tickRef.current){ clearInterval(tickRef.current); tickRef.current=null; }
    setRepeatActive(false); setRepeatTick(0); setRepeatCmd("");
  },[]);

  const startRepeat=useCallback((msg,mode)=>{
    stopRepeat();
    setRepeatCmd(msg); setRepeatActive(true); setRepeatTick(REPEAT_INTERVAL/1000);
    repeatRef.current=setInterval(()=>{
      api("/bot/command",{msg,type:mode});
      setRepeatTick(REPEAT_INTERVAL/1000);
    },REPEAT_INTERVAL);
    tickRef.current=setInterval(()=>{
      setRepeatTick(t=>t>0?t-1:0);
    },1000);
  },[stopRepeat]);

  const quickCmd=useCallback((msg)=>{
    api("/bot/command",{msg,type:"command"});
    const isStop=["dừng","stop","dung"].includes(msg.trim().toLowerCase());
    if(isStop){ stopRepeat(); return; }
    if(repeatMode) startRepeat(msg,"command");
  },[repeatMode,startRepeat,stopRepeat]);

  const sendInput=()=>{
    const msg=input.trim(); if(!msg) return;
    api("/bot/command",{msg,type:inputMode});
    setInput("");
    const isStop=["dừng","stop","dung"].includes(msg.toLowerCase());
    if(isStop){ stopRepeat(); return; }
    if(repeatMode) startRepeat(msg,inputMode);
  };

  useEffect(()=>{
    if(!status.online) stopRepeat();
  },[status.online,stopRepeat]);

  const hpColor=status.hp<6?"#f85149":status.hp<12?"#e3a84b":"#3fb950";
  const foodColor=status.food<6?"#f85149":status.food<12?"#e3a84b":"#e3c63d";
  const dotClass=status.online?"bg-green-500 led-online":(status.reconnecting||status.running)?"bg-yellow-500 animate-pulse":"bg-red-600";
  const statusLabel=status.online?"ONLINE":status.reconnecting?"RECONNECTING":status.running?"CONNECTING":"OFFLINE";
  const statusColor=status.online?"var(--term-green)":(status.reconnecting||status.running)?"var(--term-orange)":"var(--term-red)";

  const dotStyle={width:8,height:8,borderRadius:"50%",display:"inline-block",
    background:status.online?"#3fb950":(status.reconnecting||status.running)?"#e3a84b":"#f85149",
    ...(status.online?{animation:"pulse-green 2s ease-in-out infinite"}:
       (status.reconnecting||status.running)?{animation:"blink2 2s ease-in-out infinite"}:{})};
  const wsDot={width:6,height:6,borderRadius:"50%",display:"inline-block",
    background:wsState==="open"?"#3fb950":wsState==="connecting"?"#e3a84b":"#f85149",
    ...(wsState!=="open"?{animation:"blink2 2s ease-in-out infinite"}:{})};

  const RightPanel=()=><div className="term-scroll" style={{background:"var(--term-surface)",overflowY:"auto",height:"100%",display:"flex",flexDirection:"column"}}>
    {/* Bot Control */}
    <section style={{padding:12,borderBottom:"1px solid var(--term-border)"}}>
      <SHead label="BOT CONTROL"/>
      <div style={{display:"flex",gap:6}}>
        <button onClick={startBot} disabled={status.running} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"6px 0",borderRadius:4,fontSize:11,fontFamily:"monospace",fontWeight:"bold",background:"#238636",color:"#fff",border:"none",cursor:"pointer"}}>
          <McItemImage name="lime_wool" size={16}/> START
        </button>
        <button onClick={stopBot} disabled={!status.running} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"6px 0",borderRadius:4,fontSize:11,fontFamily:"monospace",fontWeight:"bold",background:"#da3633",color:"#fff",border:"none",cursor:"pointer"}}>
          <McItemImage name="red_wool" size={16}/> STOP
        </button>
      </div>
    </section>
    {/* Quick Tasks */}
    <section style={{padding:12,borderBottom:"1px solid var(--term-border)"}}>
      <SHead label="QUICK TASKS"/>
      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        {[
          {label:"Chặt gỗ",cmd:"chặt gỗ",item:"iron_axe"},
          {label:"Đào đá",cmd:"đào đá",item:"stone_pickaxe"},
          {label:"Đào quặng",cmd:"đào quặng",item:"diamond_ore"},
          {label:"Làm nông",cmd:"làm nông",item:"wheat"},
          {label:"Phá nhà",cmd:"phá nhà",item:"tnt"},
          {label:"Cất đồ vào rương",cmd:"cất đồ",item:"chest"},
          {label:"Mặc giáp tốt nhất",cmd:"mặc giáp",item:"iron_chestplate"},
          {label:"Lên thuyền",cmd:"lên thuyền",item:"oak_boat"},
          {label:"Đi ngủ",cmd:"ngủ",item:"red_bed"},
        ].map(({label,cmd,item})=><QBtn key={cmd} label={label} cmd={cmd} item={item} disabled={!status.online} onCmd={quickCmd}/>)}
      </div>
    </section>
    {/* Follow / Stop */}
    <section style={{padding:12,borderBottom:"1px solid var(--term-border)"}}>
      <SHead label="FOLLOW / STOP"/>
      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        <FollowInput onFollow={n=>quickCmd("theo "+n)} disabled={!status.online}/>
        <button onClick={()=>quickCmd("dừng")} disabled={!status.online} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"6px 0",borderRadius:4,fontSize:11,fontFamily:"monospace",fontWeight:"bold",background:"#b91c1c",color:"#fff",border:"none",cursor:"pointer",width:"100%"}}>
          <McItemImage name="barrier" size={16}/> DỪNG TẤT CẢ
        </button>
      </div>
    </section>
    <EquipPanel armor={status.armor} held={status.heldItem}/>
    <InventoryGrid items={status.inventory}/>
    <DropPanel onCmd={quickCmd} disabled={!status.online}/>
    {/* Auto Features */}
    <section style={{padding:12,borderBottom:"1px solid var(--term-border)"}}>
      <SHead label="AUTO FEATURES"/>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        <Toggle label="Auto Attack" value={status.autoAttack} onToggle={()=>toggle("autoAttack")} disabled={!status.running}/>
        <Toggle label="Auto Eat" value={status.autoEat} onToggle={()=>toggle("autoEat")} disabled={!status.running}/>
      </div>
    </section>
    {/* Server Config */}
    <section style={{padding:12}}>
      <button onClick={()=>setShowConfig(v=>!v)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",background:"none",border:"none",cursor:"pointer",marginBottom:8}}>
        <span style={{fontSize:10,fontFamily:"monospace",fontWeight:"bold",letterSpacing:2,color:"var(--term-gray)"}}>SERVER CONFIG</span>
        <span style={{fontSize:10,color:"var(--term-gray)"}}>{showConfig?"▲":"▼"}</span>
      </button>
      {showConfig&&<div style={{display:"flex",flexDirection:"column",gap:6}}>
        {[{k:"host",l:"Host",p:"server.example.com"},{k:"port",l:"Port",p:"25565"},{k:"username",l:"Username",p:"BotName"},{k:"version",l:"MC Version",p:"1.21.1"}].map(({k,l,p})=>(
          <div key={k}>
            <div style={{fontSize:10,color:"var(--term-gray)",marginBottom:2}}>{l}</div>
            <input value={config[k]} onChange={e=>setConfig(c=>({...c,[k]:e.target.value}))} placeholder={p}
              style={{width:"100%",padding:"4px 8px",borderRadius:4,fontSize:11,fontFamily:"monospace",background:"#161b22",color:"var(--term-white)",border:"1px solid var(--term-border)"}}/>
          </div>
        ))}
        <button onClick={()=>api("/bot/config",{host:config.host,port:parseInt(config.port)||25565,username:config.username,version:config.version})}
          style={{padding:"6px 0",borderRadius:4,fontSize:11,fontFamily:"monospace",fontWeight:"bold",background:"#1f6feb",color:"#fff",border:"none",cursor:"pointer",marginTop:4}}>APPLY CONFIG</button>
      </div>}
      {status.lastError&&<div style={{marginTop:8,padding:8,borderRadius:4,fontSize:10,fontFamily:"monospace",wordBreak:"break-all",background:"#3d0b09",color:"var(--term-red)",border:"1px solid #5a1918"}}>{status.lastError}</div>}
      <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:2,fontSize:10,fontFamily:"monospace",color:"var(--term-gray)"}}>
        <div style={{display:"flex",justifyContent:"space-between"}}><span>Server</span><span style={{color:"var(--term-cyan)"}}>{status.server}:{status.port}</span></div>
        <div style={{display:"flex",justifyContent:"space-between"}}><span>User</span><span style={{color:"var(--term-green)"}}>{status.username}</span></div>
      </div>
    </section>
  </div>;

  const ConsolePanel=()=><div style={{display:"flex",flexDirection:"column",flex:1,minWidth:0,minHeight:0}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 12px",borderBottom:"1px solid var(--term-border)",background:"#0d1117",flexShrink:0}}>
      <span style={{fontSize:11,fontFamily:"monospace",color:"var(--term-gray)"}}>CONSOLE — {logs.length} lines</span>
      <div style={{display:"flex",gap:8}}>
        <button onClick={()=>setAutoScroll(v=>!v)} style={{padding:"2px 8px",borderRadius:3,fontSize:11,fontFamily:"monospace",background:autoScroll?"rgba(31,111,235,.2)":"#21262d",color:autoScroll?"#79c0ff":"#586069",border:"none",cursor:"pointer"}}>{autoScroll?"AUTO ✓":"AUTO"}</button>
        <button onClick={()=>setLogs([])} style={{padding:"2px 8px",borderRadius:3,fontSize:11,fontFamily:"monospace",background:"#21262d",color:"#586069",border:"none",cursor:"pointer"}}>CLEAR</button>
      </div>
    </div>
    <div ref={logsBox} onScroll={onScroll} className="term-scroll" style={{flex:1,overflowY:"auto",padding:12,fontFamily:"monospace",fontSize:11,lineHeight:1.6,background:"var(--term-bg)"}}>
      {logs.length===0
        ?<div style={{textAlign:"center",marginTop:40,color:"var(--term-gray)"}}>
            <McItemImage name="grass_block" size={48} style={{margin:"0 auto 8px",display:"block"}}/>
            Nhấn <span style={{color:"var(--term-green)",display:"inline-flex",alignItems:"center",gap:4,verticalAlign:"middle"}}><McItemImage name="lime_wool" size={14}/> START</span> để khởi động bot
          </div>
        :logs.map((log,i)=><div key={i} className={classifyLog(log.text)} style={{display:"flex",gap:8,padding:"1px 4px",borderRadius:2}}>
            <span style={{flexShrink:0,fontSize:10,opacity:.4,marginTop:1}}>{fmt(log.time)}</span>
            <span style={{wordBreak:"break-all",whiteSpace:"pre-wrap"}}>{log.text}</span>
          </div>)}
      <div ref={logsEnd}/>
    </div>
    {/* Repeat active banner */}
    {repeatActive&&<div style={{flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 12px",background:"rgba(227,168,75,.12)",borderTop:"1px solid rgba(227,168,75,.3)"}}>
      <span style={{fontSize:11,fontFamily:"monospace",color:"var(--term-orange)",display:"flex",alignItems:"center",gap:5}}>
        <McItemImage name="clock" size={13}/> Lặp: <span style={{color:"var(--term-yellow)"}}>{repeatCmd}</span>
        <span style={{color:"var(--term-gray)",marginLeft:4}}>— gửi lại sau {repeatTick}s</span>
      </span>
      <button onClick={stopRepeat} style={{display:"flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:3,fontSize:10,fontFamily:"monospace",background:"#b91c1c",color:"#fff",border:"none",cursor:"pointer"}}><McItemImage name="barrier" size={12}/> Dừng</button>
    </div>}
    {/* Input bar */}
    <div style={{flexShrink:0,display:"flex",alignItems:"center",gap:6,padding:"8px 12px",borderTop:"1px solid var(--term-border)",background:"var(--term-surface)"}}>
      <div style={{display:"flex",borderRadius:4,overflow:"hidden",border:"1px solid var(--term-border)",flexShrink:0}}>
        <button onClick={()=>setInputMode("command")} style={{padding:"4px 8px",fontSize:11,fontFamily:"monospace",background:inputMode==="command"?"#1f6feb":"transparent",color:inputMode==="command"?"#fff":"#586069",border:"none",cursor:"pointer"}}>CMD</button>
        <button onClick={()=>setInputMode("chat")}    style={{padding:"4px 8px",fontSize:11,fontFamily:"monospace",background:inputMode==="chat"?"#8957e5":"transparent",color:inputMode==="chat"?"#fff":"#586069",border:"none",cursor:"pointer"}}>CHAT</button>
      </div>
      <button onClick={()=>{ setRepeatMode(v=>!v); if(repeatActive) stopRepeat(); }}
        title="Lặp lại lệnh mỗi 5 giây"
        style={{padding:"4px 8px",borderRadius:4,fontSize:13,fontFamily:"monospace",fontWeight:"bold",flexShrink:0,
          background:repeatMode?"rgba(227,168,75,.25)":"#21262d",
          color:repeatMode?"var(--term-orange)":"#586069",
          border:"1px solid "+(repeatMode?"rgba(227,168,75,.5)":"var(--term-border)"),cursor:"pointer"}}><McItemImage name="clock" size={16}/></button>
      <span style={{fontSize:14,fontFamily:"monospace",color:inputMode==="command"?"var(--term-cyan)":"var(--term-purple)",flexShrink:0}}>{inputMode==="command"?"►":"#"}</span>
      <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendInput()}
        placeholder={repeatMode?"lệnh sẽ lặp mỗi 5s — nhấn Enter để bắt đầu":inputMode==="command"?"chặt gỗ / đào đá / theo [name] / dừng …":"Gửi chat đến Minecraft…"}
        style={{flex:1,background:"transparent",border:"none",fontSize:13,fontFamily:"monospace",color:"var(--term-white)",minWidth:0}}/>
      <button onClick={sendInput} disabled={!input.trim()} style={{padding:"4px 10px",borderRadius:4,fontSize:11,fontFamily:"monospace",fontWeight:"bold",flexShrink:0,background:inputMode==="command"?"#1f6feb":"#8957e5",color:"#fff",border:"none",cursor:"pointer"}}>SEND</button>
    </div>
  </div>;

  return <>
    {showHelp&&<HelpModal onClose={()=>setShowHelp(false)}/>}
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"var(--term-bg)",color:"var(--term-white)"}}>
      {/* Header */}
      <header style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",borderBottom:"1px solid var(--term-border)",background:"var(--term-surface)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:13,fontWeight:"bold",letterSpacing:3,fontFamily:"monospace",color:"var(--term-cyan)"}}>3D2Y</span>
          <span style={{fontSize:11,color:"#30363d"}}>BOT CONSOLE</span>
          <button onClick={()=>setShowHelp(true)} style={{width:20,height:20,borderRadius:"50%",fontSize:10,fontWeight:"bold",fontFamily:"monospace",display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(31,111,235,.2)",color:"var(--term-blue)",border:"1px solid rgba(31,111,235,.33)",cursor:"pointer"}}>i</button>
        </div>
        <div style={{width:1,height:16,background:"#21262d"}}/>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={dotStyle}/>
          <span style={{fontSize:11,fontFamily:"monospace",fontWeight:"bold",color:statusColor}}>{statusLabel}</span>
        </div>
        {status.running&&<>
          <div style={{width:1,height:16,background:"#21262d"}}/>
          <Bar value={status.hp} color={hpColor} item="golden_apple"/>
          <Bar value={status.food} color={foodColor} item="cooked_beef"/>
        </>}
        {status.online&&status.pos&&<span style={{fontSize:11,fontFamily:"monospace",color:"var(--term-gray)",display:"flex",alignItems:"center",gap:3}}><McItemImage name="compass" size={13}/>{status.pos.x},{status.pos.y},{status.pos.z}</span>}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:4}}>
          <span style={wsDot}/>
          <span style={{fontSize:10,color:"#30363d",fontFamily:"monospace"}}>WS</span>
        </div>
      </header>

      {/* Desktop (≥768px) */}
      <div style={{display:"flex",flex:1,minHeight:0}} className="hidden md:flex">
        <div style={{display:"flex",flexDirection:"column",flex:1,minWidth:0,minHeight:0,borderRight:"1px solid var(--term-border)"}}>
          {ConsolePanel()}
        </div>
        <div style={{width:240,flexShrink:0,minHeight:0}}>{RightPanel()}</div>
      </div>

      {/* Mobile (<768px) */}
      <div style={{display:"flex",flexDirection:"column",flex:1,minHeight:0}} className="flex md:hidden">
        <div style={{flexShrink:0,display:"flex",borderBottom:"1px solid var(--term-border)",background:"var(--term-surface)"}}>
          <button onClick={()=>setMobileTab("console")} style={{flex:1,padding:"8px 0",fontSize:11,fontFamily:"monospace",fontWeight:"bold",background:"none",border:"none",borderBottom:mobileTab==="console"?"2px solid var(--term-cyan)":"2px solid transparent",color:mobileTab==="console"?"var(--term-cyan)":"var(--term-gray)",cursor:"pointer"}}>📟 CONSOLE</button>
          <button onClick={()=>setMobileTab("control")} style={{flex:1,padding:"8px 0",fontSize:11,fontFamily:"monospace",fontWeight:"bold",background:"none",border:"none",borderBottom:mobileTab==="control"?"2px solid var(--term-green)":"2px solid transparent",color:mobileTab==="control"?"var(--term-green)":"var(--term-gray)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <span style={{...dotStyle,width:6,height:6}}/>CONTROL
          </button>
        </div>
        <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column"}}>
          {mobileTab==="console"?ConsolePanel():RightPanel()}
        </div>
      </div>
    </div>
  </>;
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App/>);
</script>
</body>
</html>`;
