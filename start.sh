#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  3D2Y Bot — start.sh
# ═══════════════════════════════════════════════════════════════════

# ── COLORS ──────────────────────────────────────────────────────────
G1='\033[38;5;51m'
G2='\033[38;5;81m'
G3='\033[38;5;75m'
G4='\033[38;5;69m'
G5='\033[38;5;63m'
G6='\033[38;5;57m'
ORG='\033[38;5;214m'
GRN='\033[38;5;82m'
RED='\033[38;5;196m'
YLW='\033[38;5;226m'
GRY='\033[38;5;240m'
WHT='\033[38;5;255m'
MNT='\033[38;5;156m'
BLU='\033[38;5;117m'
CYN='\033[38;5;81m'
BOLD='\033[1m'
DIM='\033[2m'
RST='\033[0m'

# ── HELPER: print a row in the info box ─────────────────────────────
row() {
  local label="$1"
  local value="$2"
  local color="${3:-$MNT}"
  printf "${CYN}  ║${RST}  ${BOLD}${WHT}%-10s${RST}${GRY} → ${RST}${color}%s${RST}\n" "$label" "$value"
}

step() {
  printf "\n${CYN}  ┌─ ${BOLD}${WHT}%s${RST}\n" "$1"
}

ok()   { printf "${CYN}  │${RST}  ${GRN}✔${RST}  %s\n" "$1"; }
info() { printf "${CYN}  │${RST}  ${BLU}→${RST}  %s\n" "$1"; }
warn() { printf "${CYN}  │${RST}  ${YLW}!${RST}  %s\n" "$1"; }
fail() { printf "${CYN}  │${RST}  ${RED}✘${RST}  %s\n" "$1"; }
rule() { printf "${CYN}  └──────────────────────────────────────────${RST}\n"; }

# ── CLEAR & BANNER ───────────────────────────────────────────────────
clear
printf "\n"
printf "${G1}   ██████╗ ██████╗ ██████╗ ██╗   ██╗${RST}\n"
printf "${G2}   ╚════██╗██╔══██╗╚════██╗╚██╗ ██╔╝${RST}\n"
printf "${G3}    █████╔╝██║  ██║ █████╔╝ ╚████╔╝ ${RST}\n"
printf "${G4}    ╚═══██╗██║  ██║██╔═══╝   ╚██╔╝  ${RST}\n"
printf "${G5}   ██████╔╝██████╔╝███████╗   ██║   ${RST}\n"
printf "${G6}   ╚═════╝ ╚═════╝ ╚══════╝   ╚═╝   ${RST}\n"
printf "${ORG}         Minecraft Bot Engine  ${GRY}v1.0${RST}\n"
printf "\n"
printf "${CYN}  ╔════════════════════════════════════════════╗${RST}\n"
row "NODE"    "$(node --version 2>/dev/null || echo 'not found')" "$BLU"
row "PLATFORM" "$(uname -s) $(uname -m)"                         "$G3"
row "DIR"     "$(pwd)"                                            "$GRY"
row "TIME"    "$(date '+%d/%m/%Y  %H:%M:%S')"                    "$GRY"
printf "${CYN}  ╚════════════════════════════════════════════╝${RST}\n"
printf "\n"

# ── STEP 1: npm install ──────────────────────────────────────────────
step "STEP 1 — Installing dependencies"
if npm install; then
  ok "node_modules installed"
else
  fail "npm install thất bại!"
  warn "Lỗi thường gặp:"
  warn "  • Node.js quá cũ  → cần Node.js v18+ (dùng: node --version)"
  warn "  • Thiếu internet  → kiểm tra kết nối mạng"
  warn "  • Thiếu quyền ghi → thử chạy lại với quyền cao hơn"
  warn "  • Termux           → chạy: pkg install python build-essential"
  if [ -d node_modules ] && [ -f node_modules/mineflayer/package.json ]; then
    warn "node_modules cũ vẫn còn → tiếp tục với bản cũ..."
  else
    fail "Không có node_modules — dừng lại. Hãy sửa lỗi npm install trước."
    exit 1
  fi
fi
rule

# ── STEP 2: cloudflared ──────────────────────────────────────────────
step "STEP 2 — Cloudflare Tunnel"
if [ -f ./cloudflared ]; then
  ok "cloudflared already present"
else
  info "Downloading cloudflared (linux-amd64)..."
  if curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared 2>/dev/null && chmod +x cloudflared; then
    ok "cloudflared downloaded"
  else
    fail "Download failed — remote access will be unavailable"
  fi
fi

if [ -f ./cloudflared ]; then
  info "Starting tunnel → http://localhost:8080 ..."
  ./cloudflared tunnel --url http://localhost:8080 > cloudflared.log 2>&1 &
  CFDPID=$!
  info "Waiting for tunnel URL..."
  TUNNEL_URL=""
  for i in $(seq 1 20); do
    sleep 1
    TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' cloudflared.log 2>/dev/null | head -1)
    [ -n "$TUNNEL_URL" ] && break
  done
  if [ -n "$TUNNEL_URL" ]; then
    printf "${CYN}  │${RST}  ${GRN}✔${RST}  Tunnel: ${BOLD}${MNT}%s${RST}\n" "$TUNNEL_URL"
  else
    warn "Tunnel URL not detected (check cloudflared.log)"
  fi
fi
rule

# ── STEP 3: Start server ─────────────────────────────────────────────
step "STEP 3 — Starting 3D2Y Server"
info "PORT=8080  SERVE_STATIC=true  NODE_ENV=production"
info "Entry: server/dist/index.mjs"
rule

printf "\n${CYN}  ══════════════════ SERVER OUTPUT ═════════════════${RST}\n\n"

PORT=8080 SERVE_STATIC=true NODE_ENV=production node server/dist/index.mjs
