# 3D2Y Bot Console — v5.2.1

Bot Minecraft tự động với web console. Truy cập giao diện qua preview pane của Replit.

---

## Chạy trên Replit

Server được quản lý tự động bởi workflow **"artifacts/minecraft-bot: Minecraft Bot Server"**.  
Chỉ cần nhấn **Start** trên workflow hoặc vào preview — không cần chạy lệnh thủ công.

Cấu hình bot (host/port/username) nằm tại `server/bot_config.json`.

---

## Chạy thủ công (ngoài Replit)

```bash
npm install
PORT=8080 SERVE_STATIC=true node server/dist/index.mjs
```

Với key Gemini (khuyến nghị):
```bash
PORT=8080 SERVE_STATIC=true \
  GEMINI_API_KEY=<chat_key> \
  AI_DECISION_KEY=<decision_key> \
  node server/dist/index.mjs
```

Hoặc dùng script tự động (cài deps + Cloudflare tunnel):
```bash
chmod +x start.sh && ./start.sh
```

---

## Cấu trúc thư mục

```
artifacts/minecraft-bot/
├── bot.cjs                  ← Bot Minecraft (source chính)
├── server/dist/index.mjs    ← Web server
├── bot-console/dist/public/ ← Frontend web console
├── schematics/              ← Đặt file .litematic/.schem vào đây
├── ai_memory.json           ← Bộ nhớ AI (tự tạo)
├── ai_decision_key.json     ← AI Decision key đã lưu (tự tạo)
├── gemini_key.json          ← Chat key đã lưu (tự tạo)
├── server/bot_config.json   ← Cấu hình host/port/username bot
├── package.json
├── start.sh
└── README.md
```

---

## Bug fixes đã áp dụng (v5.2.1-replit)

Các lỗi crash sau đã được vá trong `bot.cjs`:

| # | Hàm | Lỗi | Fix |
|---|-----|-----|-----|
| 1 | `startAIMode()` | Crash khi `bot._task` là null | Thêm null-guard trước khi xóa interval |
| 2 | `stopAIMode()` | Crash khi `bot._task` là null | Thêm null-guard |
| 3 | `buildAIContext()` | Crash khi sort hostiles lúc `bot.entity` chưa tồn tại | Dùng `bot.entity?.position` |
| 4 | `heuristicFallbackDecision()` | Crash khi `bot.entity` là null | Thêm null-guard |
| 5 | `executeAIDecision` (retreat) | Crash khi `bot.entity` là null | Thêm null-guard |
| 6 | `_emergencyInterval` | Crash khi `bot.entity` chưa có | Thêm `&& bot.entity` guard |
| 7 | `ai on` (web console) | Silent fail khi bot offline | Hiện thông báo rõ ràng |

---

## Ghi chú về output lệnh

| Loại output | Nghĩa |
|-------------|-------|
| ✅ **Web console** | Hiện thẳng trong khung log trên web |
| 💬 **Game chat** | Bot nói trong game — hiện trong chat box web |
| 🤖 **AI chat** | Bot nói bằng AI (cần chat key) — trong game chat |
| 🔇 **Im lặng** | Task chạy ngầm, không thông báo ngay |

> **Lưu ý:** Lệnh gameplay cần bot đang **online** (đã kết nối server Minecraft).
> Lệnh config/AI/key hoạt động ngay cả khi bot **offline**.

---

## 🔑 Quản lý API Key
> Hoạt động khi bot offline. Output: **Web console**.

| Lệnh | Tác dụng |
|------|----------|
| `set ai <key>` | Cài Gemini **chat** key (dùng cho: trả lời chat in-game, test ai) |
| `set gemini <key>` | Alias của `set ai` |
| `set ai chat <key>` | Alias của `set ai` |
| `set chat key <key>` | Alias của `set ai` |
| `set ai <clear\|off>` | Xóa chat key |
| `set ai decision <key>` | Cài **decision** key riêng (dùng cho: AI mode tự chọn hành động) |
| `set decision key <key>` | Alias của `set ai decision` |
| `set ai decision <clear\|off>` | Xóa decision key (AI mode dùng chung chat key) |
| `test ai` / `check ai` / `test gemini` | Kiểm tra chat key — in kết quả ra web console |
| `test ai decision` / `check decision key` | Kiểm tra decision key — in kết quả ra web console |
| `add ai key <key1> [key2] [key3]...` | Thêm **1 hoặc nhiều** chat key cùng lúc — tự xoay vòng đều qua tất cả key |
| `add gemini key <key1> [key2]...` | Alias của `add ai key` |
| `add chat key <key1> [key2]...` | Alias của `add ai key` |
| `add ai decision key <key1> [key2]...` | Thêm **1 hoặc nhiều** decision key cùng lúc |
| `add decision key <key1> [key2]...` | Alias của `add ai decision key` |
| `keys` / `key info` / `list ai keys` / `ai keys` / `list keys` / `key?` / `keys info` | Xem tất cả key + mục đích + số lần dùng hôm nay + progress bar |
| `status keys` / `quota status` / `check keys` / `status quota` | Xem trạng thái RPD quota + số lần gọi API hôm nay |
| `clear ai keys` / `remove ai keys` / `clear chat keys` | Xóa tất cả chat key dự phòng (giữ key chính) |
| `clear ai decision keys` / `remove ai decision keys` | Xóa tất cả decision key dự phòng |

> **Format key được chấp nhận:** `AIza...` (format cũ) và `AQ...` (format mới).
> Lấy key miễn phí tại [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
>
> **Multi-key rotation:** Khi key bị 429 (hết quota), bot tự chuyển sang key dự phòng.
> Thêm key: `add ai key AQ...key2`
> Hoặc qua env: `GEMINI_CHAT_KEYS=key2,key3` / `GEMINI_DECISION_KEYS=key2,key3`

---

## 🧠 AI Mode
> Cần bot **online**. Output: **Web console** (từ web console); **Game chat** (từ in-game).

| Lệnh | Tác dụng |
|------|----------|
| `ai on` / `bật ai` / `bat ai` / `ai mode on` / `enable ai` | Bật AI mode — bot tự quyết định hành động |
| `ai off` / `tắt ai` / `tat ai` / `ai mode off` / `disable ai` | Tắt AI mode |
| `ai pause` / `ai tạm dừng` / `ai hold` | Tạm dừng AI 1 tiếng (bạn chơi thủ công) |
| `ai resume` / `ai takeover` | Cho AI tiếp quản lại ngay |
| `ai status` / `ai mode` / `ai?` / `ai info` | Xem trạng thái AI đầy đủ trong **web console** |

**Lệnh `ai status` cho biết:**
- Trạng thái bật/tắt, stage game hiện tại
- HP / Food / Vị trí bot
- Chat key và Decision key (đang dùng key nào)
- Queue chờ API, tổng số quyết định đã ra
- Hành động cuối cùng và lý do

> AI tự broadcast status vào web console mỗi 2 phút khi đang bật.

### Giai đoạn game (AI tự phát hiện)

| Stage | Điều kiện | Mục tiêu AI |
|-------|-----------|-------------|
| `early` | Mới bắt đầu | Chặt gỗ |
| `wood` | Có gỗ | Đào đá, craft công cụ |
| `stone` | Có công cụ đá | Tìm sắt |
| `iron` | Có đồ sắt | Tìm kim cương |
| `diamond` | Có kim cương | Vào Nether |
| `nether` | Trong Nether | Tìm Blaze Rod + Ender Pearl |
| `pre_end` | Có Eye of Ender | Tìm Stronghold |
| `end_done` | Đã phá dragon | Tìm Elytra |

---

## 📡 Discord Webhook
> Output: **Web console**.

| Lệnh | Tác dụng |
|------|----------|
| `set discord <url>` | Cài Discord webhook URL (phải bắt đầu bằng `https://`) — in xác nhận ra web console |
| `discord webhook <url>` | Alias của `set discord` |
| `webhook <url>` | Alias của `set discord` |
| `set discord <clear\|off>` | Xóa webhook (không in gì ra console) |
| `status discord` / `discord status` / `discord ping` | Gửi status embed lên Discord ngay, in xác nhận ra web console |

> **Lưu ý:** URL không hợp lệ → lỗi chỉ xuất hiện trong **server log** (terminal), không hiện trên web console.

---

## 🛑 Điều khiển chung
> Cần bot online. Dùng được từ **web console** và **game chat**.

| Lệnh | Output | Tác dụng |
|------|--------|----------|
| `dừng` / `stop` / `halt` / `cancel` | 💬 Game chat | Dừng task đang chạy |
| `đứng yên` / `stand` / `stand still` | 💬 Game chat | Bot đứng im, dừng di chuyển |

---

## 🪓 Thu hoạch tài nguyên
> Cần bot online. Dùng được từ **web console** và **game chat**.
> Output: 🤖 AI chat (cần chat key) hoặc 🔇 im lặng.

| Lệnh | Tác dụng |
|------|----------|
| `chặt gỗ` / `chặt cây` / `chop wood` / `chop tree` / `chop` | Chặt cây tự động |
| `đào đá` / `mine stone` / `mine cobble` | Đào đá/cobblestone |
| `đào quặng [loại]` / `mine ore [type]` | Đào quặng theo loại |
| `câu cá` / `fish` / `auto fish` | Câu cá tự động |
| `dừng câu` / `stop fishing` | Dừng câu cá |
| `làm nông` / `thu hoạch` / `harvest` / `farming` | Thu hoạch nông trại |
| `trồng cây` / `tree farm` / `plant tree` | Trồng cây tự động |
| `farm đá` / `cobble farm` / `cobblestone farm` | Farm cobblestone |
| `farm mía` / `special farm` / `farm nether wart` / `farm tre` | Farm mía, nether wart, tre |
| `strip mine [y] [length] [branchLen]` | Đào hầm ngang tìm quặng — default: y=-58, length=64, branch=16 |

**Loại quặng hợp lệ cho `đào quặng`:**
`diamond` / `iron` / `gold` / `coal` / `copper` / `redstone` / `lapis` / `emerald` / `netherite`

---

## 🚶 Di chuyển
> ⚠️ **Chỉ dùng được từ in-game chat** (không dùng được từ web console).

| Lệnh | Tác dụng |
|------|----------|
| `đến X Y Z` / `goto X Y Z` / `go to X Y Z` | Đi đến tọa độ (hoặc `đến X Z` nếu không cần Y) |
| `scaffold đến X Y Z` / `scaffold goto X Y Z` | Đi + bắc giàn giáo nếu cần |
| `lên mặt đất` / `surface` | Lên mặt đất |
| `khám phá` / `explore` | Khám phá vùng mới |
| `theo [tên]` / `follow [name]` | Theo một người chơi (hoặc `theo` để theo người ra lệnh) |

> Web console có lệnh `scaffold X Y Z` riêng (chỉ cần số, không cần gõ "goto").

---

## ⚔️ Chiến đấu
> Cần bot online. Dùng được từ **web console** và **game chat**.

| Lệnh | Output | Tác dụng |
|------|--------|----------|
| `đánh [tên]` / `attack [name]` | 🔇 Im lặng | Tấn công người chơi/mob |
| `bảo vệ [tên]` / `bodyguard [name]` / `guard [name]` / `protect [name]` | 🔇 Im lặng | Bảo vệ người chơi |
| `mob farm` / `afk farm` / `farm mob` | 🔇 Im lặng | AFK tại mob farm |

---

## 📦 Quản lý đồ
> Cần bot online.

| Lệnh | Từ đâu | Output | Tác dụng |
|------|--------|--------|----------|
| `cất đồ` / `deposit` / `store` | Web + game | 🔇 Im lặng | Cất đồ vào rương gần nhất |
| `sắp rương` / `sort chest` / `sort` | Web + game | 🔇 Im lặng | Sắp xếp đồ trong rương |
| `mặc giáp` / `equip armor` / `armor up` | Web + game | 💬 Game chat | Mặc giáp tốt nhất |
| `gộp đồ` / `combine tools` / `combine` | **Game chat only** | 🤖 AI chat | Gộp dụng cụ bằng đe |
| `vứt [item]` / `drop [item]` | Web + game | 🔇 Im lặng | Vứt item khỏi túi |
| `cho tôi [item]` / `give [item]` | Web + game | 🔇 Im lặng | Bot đưa item cho bạn |
| `nhặt loot` / `loot` / `pickup` | Web + game | 💬 Game chat | Nhặt item trong vòng 16 block |

---

## 🏗️ Xây dựng
> Cần bot online. Dùng được từ **web console** và **game chat** (trừ ghi chú riêng).

| Lệnh | Output | Tác dụng |
|------|--------|----------|
| `xây <file.litematic>` / `xây <file.schem>` / `build <file>` | 🔇 Im lặng | Xây từ file schematic (đặt file vào `schematics/`) |
| `xây list` / `build list` | 💬 Game chat | Liệt kê file schematic có sẵn |
| `xây resume` / `build resume` / `resume build` | 🔇 Im lặng | Tiếp tục xây dở |
| `fill x1 y1 z1 x2 y2 z2 [block]` / `lấp ...` | 🔇 Im lặng | Lấp đầy vùng 3D (default block: stone) |
| `wall x1 y1 z1 x2 y2 z2 [height] [block]` / `xây tường ...` | 🔇 Im lặng | Xây tường A→B (default: h=4, block=cobblestone) |
| `làm sàn x1 y z1 x2 z2 [block]` / `platform x1 y z1 x2 z2 [block]` | 🔇 Im lặng | Làm sàn phẳng (default: stone) |
| `scaffold X Y Z` | 🔇 Im lặng | **Web console:** đi + bắc giàn giáo đến tọa độ |
| `đào hầm W H L` / `excavate W H L` | **Game chat only** 🔇 | Đào hầm kích thước W×H×L (tối đa 20×10×20) |
| `đào mạch [quặng]` / `veinmine [ore]` / `vein mine [ore]` | **Game chat only** 🔇 | Đào toàn bộ mạch quặng đang đứng gần |

---

## 🗺️ Waypoint & Tuần tra
> Cần bot online. Dùng được từ **web console** và **game chat**.
> Output: 💬 **Game chat**.

| Lệnh | Tác dụng |
|------|----------|
| `đặt nhà` / `set base` | Đặt điểm nhà tại vị trí hiện tại |
| `về nhà` / `go home` | Về điểm nhà đã đặt |
| `farm set` / `set farm` | Đặt điểm gốc mob farm tại vị trí hiện tại |
| `thêm wp [tên]` / `add waypoint [name]` / `add wp [name]` | Thêm waypoint tại vị trí hiện tại |
| `danh sách wp` / `list wp` / `ds wp` / `waypoints` | Xem danh sách waypoint |
| `xóa wp [tên]` / `remove wp [name]` | Xóa một waypoint |
| `xóa hết wp` / `clear waypoints` / `clear wp` | Xóa tất cả waypoint |
| `tuần tra` / `patrol` | Tuần tra theo thứ tự waypoint |

---

## 🧪 Khác
> Cần bot online. Dùng được từ **web console** và **game chat**.

| Lệnh | Output | Tác dụng |
|------|--------|----------|
| `pha thuốc` / `brew` / `auto brew` | 🔇 Im lặng | Pha chế thuốc tự động |
| `ngủ` / `đi ngủ` / `sleep` / `find bed` | 🔇 Im lặng | Tìm giường và ngủ |
| `lên thuyền` / `boat` / `board boat` | 🔇 Im lặng | Lên thuyền gần nhất |
| `thống kê` / `stats` | 💬 Game chat | Xem thống kê (block đào, mob giết, cá câu...) |
| `đào nhà` / `phá nhà` / `demolish` | 🔇 Im lặng | Đào phá công trình gần nhất |
| `trade [item]` / `đổi [item]` | 💬 Game chat | Giao dịch với villager gần nhất |
| `help` / `lệnh` / `commands` / `?` | 💬 Game chat | Xem danh sách lệnh rút gọn |

---

## Items không bao giờ bị cất (KEEP_ITEMS)

```
Công cụ & vũ khí : pickaxe, axe, shovel, sword, hoe, bow, crossbow, mace, trident
Giáp             : helmet, chestplate, leggings, boots, shield, elytra
Utility          : totem_of_undying, ender_pearl, firework_rocket
                   water_bucket, lava_bucket, milk_bucket
                   arrow, spectral_arrow, tipped_arrow
                   golden_apple, enchanted_golden_apple
Dự phòng         : chest
```

---

## Movement Engine

| Mode | Dùng khi | canDig | Tower | Scaffold | maxDrop |
|------|----------|--------|-------|----------|---------|
| `default` | Wander, farm thường | ❌ | ❌ | ❌ | 4 |
| `follow` | Theo người | ✅ | ❌ | ❌ | 5 |
| `baritone` | scaffold goto | ✅ | ✅ | ✅ | 10 |
| `build` | Xây schematic/fill/wall | ❌ | ✅ | ❌ | 4 |

---

## Lưu ý khi dùng schematic

1. `.litematic` — xuất từ mod **Litematica** (Minecraft Java)
2. `.schem` — xuất từ **WorldEdit** (Sponge Schematic v2/v3)
3. **Origin** = vị trí bot đang đứng khi ra lệnh xây
4. Bot cần có đủ block trong túi
5. Gõ `dừng` để dừng bất cứ lúc nào

---

## Biến môi trường

| Biến | Mô tả |
|------|-------|
| `PORT` | Cổng web server (default: 8080) |
| `SERVE_STATIC` | Set `true` để serve frontend từ server |
| `GEMINI_API_KEY` | Chat key mặc định khi khởi động |
| `AI_DECISION_KEY` | Decision key riêng khi khởi động |
| `GEMINI_CHAT_KEYS` | Nhiều chat key dự phòng, cách nhau dấu phẩy |
| `GEMINI_DECISION_KEYS` | Nhiều decision key dự phòng |
| `BOT_HOST` | Server Minecraft (thay thế bot_config.json) |
| `BOT_PORT` | Port server Minecraft |
| `BOT_USERNAME` | Tên bot Minecraft |
| `BOT_VERSION` | Version Minecraft (vd: 1.21.4) |
