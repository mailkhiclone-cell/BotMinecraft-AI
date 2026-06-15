# 3D2Y Bot Console

Bot Minecraft tự động với web console điều khiển từ xa.

---

## Cấu trúc file

```
Bot/
├── server.cjs    ← Web console + API server (chạy cái này)
└── bot.cjs       ← Bot Minecraft (tự động được server.cjs khởi động)
```

---

## Cài đặt & Chạy

### Bước 1 — Cài packages (chỉ cần 1 lần)

```bash
# Packages cho server
npm install express ws cors

# Packages cho bot
npm install mineflayer mineflayer-pathfinder mineflayer-collectblock mineflayer-pvp minecraft-data
```

### Bước 2 — Chạy

```bash
node server.cjs
```

### Bước 3 — Mở trình duyệt

```
http://localhost:3000          ← cùng máy
http://192.168.x.x:3000       ← máy khác trong mạng LAN
```

> IP của máy bạn sẽ hiện ra tự động trong terminal khi khởi động.

---

## Thay đổi cấu hình server Minecraft

### Cách 1 — Dùng web console (khuyến nghị)

Mở web console → kéo xuống phần **SERVER CONFIG** → điền vào:
- **Host** — địa chỉ server (ví dụ: `play.hypixel.net`)
- **Port** — cổng server (mặc định: `25565`)
- **Username** — tên bot
- **MC Version** — phiên bản Minecraft (ví dụ: `1.21.1`)

Nhấn **APPLY CONFIG** → nhấn **STOP** → nhấn **START** để bot kết nối lại.

---

### Cách 2 — Sửa trực tiếp trong `bot.cjs`

Mở `bot.cjs`, tìm đoạn này ở đầu file (khoảng dòng 32):

```javascript
const CONFIG = {
  host:       process.env.BOT_HOST      || 'Khanh-Khi.aternos.me',
  port:       parseInt(process.env.BOT_PORT  || '52717'),
  username:   process.env.BOT_USERNAME  || 'KhanhKhi',
  version:    process.env.BOT_VERSION   || '1.21.11',
  groqApiKey: process.env.GROQ_API_KEY  || 'sk-...',
};
```

Thay thẳng vào giá trị mặc định:

```javascript
const CONFIG = {
  host:       process.env.BOT_HOST      || 'play.yourserver.net',
  port:       parseInt(process.env.BOT_PORT  || '25565'),
  username:   process.env.BOT_USERNAME  || 'TenBotCuaBan',
  version:    process.env.BOT_VERSION   || '1.21.1',
  groqApiKey: process.env.GROQ_API_KEY  || '',   // bỏ trống nếu không dùng AI chat
};
```

---

### Cách 3 — Biến môi trường (khi chạy)

```bash
BOT_HOST=play.yourserver.net BOT_PORT=25565 BOT_USERNAME=MyBot node server.cjs
```

---

### Thay đổi port web console

Mặc định `server.cjs` chạy ở port `3000`. Để đổi:

```bash
PORT=8080 node server.cjs
```

Hoặc sửa dòng đầu `server.cjs`:

```javascript
const PORT = parseInt(process.env.PORT || '3000');
//                                         ^^^^^ đổi thành port bạn muốn
```

---

## Lệnh điều khiển bot qua chat Minecraft

Khi bạn đang chơi **cùng server** với bot, gõ các lệnh sau vào chat:

### Dừng

| Lệnh chat | Tác dụng |
|---|---|
| `dừng` | Dừng tất cả task đang làm |
| `stop` | Dừng tất cả task đang làm |

---

### Khai thác

| Lệnh chat | Tác dụng |
|---|---|
| `chặt gỗ` | Chặt cây gỗ gần nhất liên tục |
| `chặt cây` | Tương tự chặt gỗ |
| `đào đá` | Đào stone/cobblestone gần nhất |
| `đào quặng` | Đào tất cả quặng (ưu tiên: cổ đại → kim cương → vàng → …) |
| `đào quặng kim cương` | Chỉ đào quặng kim cương |
| `đào quặng sắt` | Chỉ đào quặng sắt |
| `đào quặng vàng` | Chỉ đào quặng vàng |
| `đào quặng than` | Chỉ đào quặng than |
| `đào quặng đồng` | Chỉ đào quặng đồng |
| `đào quặng đá đỏ` | Chỉ đào quặng redstone |
| `đào quặng lapis` | Chỉ đào quặng lapis |
| `đào quặng ngọc lục bảo` | Chỉ đào emerald |
| `đào quặng cổ` | Chỉ đào ancient debris |

**Đào bất kỳ loại block nào:**

```
đào [tên block]
```

Ví dụ:
```
đào đất
đào cát
đào gỗ
đào obsidian
đào oak_log
đào dirt
đào stone
```

Hỗ trợ cả tên tiếng Việt lẫn tên Minecraft (dùng `_` hoặc dấu cách đều được).

---

### Xây dựng & Thu hoạch

| Lệnh chat | Tác dụng |
|---|---|
| `làm nông` | Thu hoạch lúa/cà rốt/khoai/củ cải chín, tự trồng lại |
| `thu hoạch` | Tương tự làm nông |
| `phá nhà` | Phá các block xây dựng xung quanh (không phá đá tự nhiên) |
| `đào nhà` | Tương tự phá nhà |

**Làm sàn (đặt block theo vùng toạ độ):**

```
làm sàn x1 y z1 x2 z2 [loại block]
```

Ví dụ:
```
làm sàn 100 64 200 120 220 stone
làm sàn 0 70 0 10 10 oak_planks
```

---

### Vật phẩm & Túi đồ

| Lệnh chat | Tác dụng |
|---|---|
| `mặc giáp` | Tự mặc bộ giáp tốt nhất trong túi |
| `cất đồ` | Tìm rương gần nhất và cất toàn bộ đồ (giữ lại vũ khí/giáp/công cụ) |
| `vứt [item]` | Vứt item ra đất — ví dụ: `vứt đất`, `vứt all`, `vứt stone` |
| `cho tôi [item]` | Bot vứt item ra đất gần bạn |

Ví dụ:
```
vứt all
vứt gỗ
vứt dirt
cho tôi oak_log
cho tôi stone
```

---

### Di chuyển & Theo dõi

| Lệnh chat | Tác dụng |
|---|---|
| `theo` | Bot theo sát bạn (người đã gõ lệnh) |
| `dừng` | Dừng theo, đứng yên / lang thang |
| `ngủ` | Tìm giường gần nhất và ngủ |
| `đi ngủ` | Tương tự ngủ |
| `lên thuyền` | Leo lên thuyền gần nhất |
| `thuyền` | Tương tự lên thuyền |

---

### Chiến đấu

| Lệnh chat | Tác dụng |
|---|---|
| `đánh [tên]` | Tấn công người chơi theo tên |
| `tấn công [tên]` | Tương tự đánh |
| `attack [tên]` | Tương tự đánh (tiếng Anh) |

Ví dụ:
```
đánh Steve
tấn công Alex
attack PlayerName
```

**PvP thách đấu:**

Nếu bạn gõ bất kỳ tin nhắn nào có chứa từ `pvp`, `1v1`, `đấu`, `thách` và đề cập đến bot — bot sẽ tự động phản hồi:
- Nếu đủ giáp → **chấp nhận đấu** (đếm 1…2…3)
- Nếu thiếu giáp → **từ chối**, nói rõ thiếu gì

Trả lời thách đấu của bot:
```
có        ← chấp nhận đấu
không     ← từ chối
```

---

### Trò chuyện AI

Bot có tích hợp **AI Groq (LLaMA 3.3)** — tự động phản hồi khi:
- Bạn nhắc đến tên bot trong tin nhắn
- Bạn đặt câu hỏi (có dấu `?`)
- Bạn chào (`hi`, `hello`, `chào`, …)

Để tắt AI chat: xóa `groqApiKey` trong `CONFIG` của `bot.cjs`.

---

## Tính năng tự động (không cần lệnh)

| Tính năng | Mô tả | Bật/Tắt |
|---|---|---|
| **Auto Attack** | Tự tấn công mob thù trong vòng 16m | Nút toggle trong web console |
| **Auto Eat** | Tự ăn khi đói < 16/20 hoặc máu < 8/20 | Nút toggle trong web console |
| **Auto Hunt** | Săn động vật khi đói và không có đồ ăn | Tự động |
| **Auto Armor** | Tự mặc giáp tốt nhất mỗi 12 giây | Tự động |
| **Auto Deposit** | Tự cất đồ khi túi gần đầy (≤2 ô trống) | Tự động |
| **Auto Rejoin** | Tự kết nối lại khi mất mạng (tối đa 10 lần) | Tự động |
| **PvP Challenge** | Thách đấu người chơi ngẫu nhiên mỗi 30 phút | Tự động |

---

## Ghi chú

- Bot chạy chế độ **offline** (`auth: 'offline'`) — chỉ vào được server không có premium (cracked server)
- Bot **không phá đá tự nhiên** (cobblestone, stone, dirt, v.v.) khi dùng lệnh `phá nhà`
- Khi cất đồ, bot **giữ lại** tất cả vũ khí, giáp, công cụ (chỉ cất nguyên liệu thô)
- Bot tự mặc **khiên vào tay trái** cùng với giáp nếu có trong túi
