#!/usr/bin/env bash
# =============================================================================
# Claude Agent — init.sh
# Setup completo su un sistema vuoto (macOS / Linux).
# Non richiede nulla preinstallato.
# =============================================================================
set -euo pipefail

# ── Colori ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()   { echo -e "${GREEN}✓${NC}  $*"; }
info()  { echo -e "${BLUE}→${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
error() { echo -e "${RED}✗  $*${NC}"; exit 1; }
step()  { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       Claude Agent — Init Setup      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

# ── 1. Bun ────────────────────────────────────────────────────────────────────
step "1/7  Bun runtime"

export BUN_INSTALL="${HOME}/.bun"
export PATH="${BUN_INSTALL}/bin:${PATH}"

if command -v bun &>/dev/null; then
  log "Bun già installato: $(bun --version)"
else
  info "Installazione Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="${BUN_INSTALL}/bin:${PATH}"
  log "Bun installato: $(bun --version)"
fi

# ── 2. Claude Code CLI ────────────────────────────────────────────────────────
step "2/7  Claude Code CLI"

if command -v claude &>/dev/null; then
  log "Claude Code già installato"
else
  info "Installazione @anthropic-ai/claude-code via bun..."
  bun install -g @anthropic-ai/claude-code
  # Make sure the bun global bin is in PATH
  export PATH="${BUN_INSTALL}/bin:${PATH}"
  command -v claude &>/dev/null || error "claude non trovato nel PATH dopo l'installazione"
  log "Claude Code installato"
fi

# ── 3. Token Claude ───────────────────────────────────────────────────────────
step "3/7  Autenticazione Claude"

# Funzione: estrae il token OAuth dai file di config di Claude Code
extract_claude_token() {
  local token=""
  # Possibili percorsi dove Claude Code salva le credenziali
  local candidates=(
    "$HOME/.claude/settings.json"
    "$HOME/.claude/.credentials.json"
    "$HOME/Library/Application Support/Claude/settings.json"
    "$HOME/.config/claude/settings.json"
  )
  for f in "${candidates[@]}"; do
    if [[ -f "$f" ]]; then
      # Usa python3 per il parsing JSON (disponibile su macOS e la maggior parte di Linux)
      if command -v python3 &>/dev/null; then
        token=$(python3 -c "
import json, sys
try:
    d = json.load(open('$f'))
    print(d.get('oauthToken') or d.get('oauth_token') or d.get('access_token') or '')
except: print('')
" 2>/dev/null) || true
      fi
      [[ -n "$token" ]] && break
    fi
  done
  echo "$token"
}

CLAUDE_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"

# Prova a leggere il token già salvato
if [[ -z "$CLAUDE_TOKEN" ]]; then
  CLAUDE_TOKEN=$(extract_claude_token)
fi

# Se non trovato, fai il login
if [[ -z "$CLAUDE_TOKEN" ]]; then
  info "Token non trovato — avvio login Claude Code."
  info "Si aprirà il browser per autenticarti con Anthropic."
  echo ""
  claude login || true
  echo ""
  CLAUDE_TOKEN=$(extract_claude_token)
fi

# Se ancora vuoto, chiedi manualmente
if [[ -z "$CLAUDE_TOKEN" ]]; then
  warn "Impossibile estrarre il token automaticamente."
  echo ""
  echo "  Dopo il login, trovalo con:"
  echo "    cat ~/.claude/settings.json | python3 -m json.tool"
  echo ""
  read -rp "  Incolla il CLAUDE_CODE_OAUTH_TOKEN: " CLAUDE_TOKEN
  echo ""
fi

[[ -z "$CLAUDE_TOKEN" ]] && error "Token Claude obbligatorio."
log "Token Claude configurato"

# ── 4. Token Telegram ─────────────────────────────────────────────────────────
step "4/7  Bot Telegram"

TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [[ -z "$TELEGRAM_TOKEN" ]]; then
  echo ""
  echo "  Crea un bot su Telegram → parla con @BotFather → /newbot"
  echo ""
  read -rp "  Incolla il TELEGRAM_BOT_TOKEN: " TELEGRAM_TOKEN
  echo ""
fi

[[ -z "$TELEGRAM_TOKEN" ]] && error "Token Telegram obbligatorio."
log "Token Telegram configurato"

# ── 5. Persona agente ─────────────────────────────────────────────────────────
step "5/7  Persona agente"

SYSTEM_PROMPT="${CLAUDE_AGENT_SYSTEM_PROMPT:-}"
if [[ -z "$SYSTEM_PROMPT" ]]; then
  echo ""
  echo "  Definisci il comportamento dell'agente."
  echo "  Lascia vuoto per il default di Claude (assistente generico)."
  echo ""
  echo "  Esempio: 'Sei un assistente esperto di scommesse sportive per EVBets.'"
  echo "  Esempio: 'Sei un assistente personale di nome Neo.'"
  echo ""
  read -rp "  System prompt (invio per saltare): " SYSTEM_PROMPT
  echo ""
fi

if [[ -n "$SYSTEM_PROMPT" ]]; then
  log "System prompt configurato"
else
  info "System prompt non impostato — verrà usato il default di Claude"
fi

# ── 6. Dipendenze progetto ────────────────────────────────────────────────────
step "6/7  Dipendenze"

cd "$SCRIPT_DIR"
info "bun install..."
bun install --frozen-lockfile 2>/dev/null || bun install
log "Dipendenze installate"

# ── 7. File di configurazione ─────────────────────────────────────────────────
step "7/7  Configurazione"

# .env
ENV_FILE="$SCRIPT_DIR/.env"
cat > "$ENV_FILE" <<EOF
# Claude Agent — Environment Variables
# Generato da init.sh il $(date)

# ── Required ──────────────────────────────────────────────────────────────────
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}
TELEGRAM_BOT_TOKEN=${TELEGRAM_TOKEN}

# ── Agent Persona ─────────────────────────────────────────────────────────────
CLAUDE_AGENT_SYSTEM_PROMPT=${SYSTEM_PROMPT}

# File persistenza sessioni Telegram (default: ~/.claude-agent/telegram-sessions.json)
# CLAUDE_TELEGRAM_SESSION_FILE=

# ── Optional ──────────────────────────────────────────────────────────────────
# CLAUDE_AGENT_TIMEOUT_MS=120000
# CLAUDE_AGENT_MAX_RETRIES=3
# CLAUDE_AGENT_RETRY_DELAY_MS=1000
# CLAUDE_AGENT_LOG_LEVEL=INFO
# CLAUDE_AGENT_SKIP_PERMISSIONS=0   # imposta "0" per disabilitare
EOF
log ".env creato"

# start.sh
START_SCRIPT="$SCRIPT_DIR/start.sh"
cat > "$START_SCRIPT" <<'STARTEOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BUN_INSTALL="${HOME}/.bun"
export PATH="${BUN_INSTALL}/bin:${PATH}"
cd "$SCRIPT_DIR"
exec bun run --env-file .env run.ts
STARTEOF
chmod +x "$START_SCRIPT"
log "start.sh creato"

# Directory log
mkdir -p "$HOME/.claude-agent"

# ── Auto-restart ──────────────────────────────────────────────────────────────

setup_launchd() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist="$plist_dir/com.claude-agent.telegram.plist"
  mkdir -p "$plist_dir"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-agent.telegram</string>
  <key>ProgramArguments</key>
  <array>
    <string>${SCRIPT_DIR}/start.sh</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.claude-agent/telegram.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.claude-agent/telegram.log</string>
  <key>WorkingDirectory</key>
  <string>${SCRIPT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BUN_INSTALL</key>
    <string>${HOME}/.bun</string>
    <key>PATH</key>
    <string>${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load -w "$plist"
  log "launchd service installato (si avvia automaticamente al login)"
  info "Log: $HOME/.claude-agent/telegram.log"
  info "Stop: launchctl unload $plist"
  info "Start: launchctl load $plist"
}

setup_systemd() {
  local svc_dir="$HOME/.config/systemd/user"
  local svc_file="$svc_dir/claude-agent-telegram.service"
  mkdir -p "$svc_dir"
  cat > "$svc_file" <<SYSTEMD
[Unit]
Description=Claude Agent Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${SCRIPT_DIR}/start.sh
Restart=always
RestartSec=5
StandardOutput=append:${HOME}/.claude-agent/telegram.log
StandardError=append:${HOME}/.claude-agent/telegram.log

[Install]
WantedBy=default.target
SYSTEMD
  systemctl --user daemon-reload
  systemctl --user enable --now claude-agent-telegram
  log "systemd user service installato (si avvia automaticamente al login)"
  info "Log:    journalctl --user -u claude-agent-telegram -f"
  info "Stop:   systemctl --user stop claude-agent-telegram"
  info "Start:  systemctl --user start claude-agent-telegram"
}

echo ""
read -rp "Configura auto-restart del bot in caso di crash/riavvio? [Y/n]: " AUTORESTART
AUTORESTART="${AUTORESTART:-Y}"

if [[ "$AUTORESTART" =~ ^[Yy]$ ]]; then
  OS="$(uname -s)"
  case "$OS" in
    Darwin) setup_launchd ;;
    Linux)
      if command -v systemctl &>/dev/null; then
        setup_systemd
      else
        warn "systemd non trovato — avvia manualmente con ./start.sh"
      fi ;;
    *) warn "OS non supportato per auto-restart — avvia manualmente con ./start.sh" ;;
  esac
else
  info "Auto-restart saltato."
fi

# ── Riepilogo finale ──────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║         ✅ Setup completato!         ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Avvio manuale:${NC}    ./start.sh"
echo -e "  ${BOLD}Sessioni:${NC}         ~/.claude-agent/telegram-sessions.json"
echo -e "  ${BOLD}Log:${NC}              ~/.claude-agent/telegram.log"
echo -e "  ${BOLD}Configurazione:${NC}   .env"
echo ""
if [[ -n "$SYSTEM_PROMPT" ]]; then
  echo -e "  ${BOLD}Persona agente:${NC}   ${SYSTEM_PROMPT:0:60}..."
fi
echo ""
