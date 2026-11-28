#!/usr/bin/env bash
#
# ============================================================
#  Moonlight web-server - versao Linux
#  (equivalente Linux do start-web-server.cmd)
#
#  Uso:
#     ./start-web-server.sh            inicia o servidor em segundo plano
#     ./start-web-server.sh stop       para o servidor
#     ./start-web-server.sh restart    reinicia
#     ./start-web-server.sh status     mostra o status
#     ./start-web-server.sh logs       acompanha o log (tail -f)
#     ./start-web-server.sh install    instala/ativa o auto-inicio
#     ./start-web-server.sh uninstall  remove o auto-inicio
#
#  Assim como no Windows, na PRIMEIRA execucao o auto-inicio com o
#  sistema e configurado automaticamente (idempotente).
#
#  Requer o binario Linux do web-server ao lado deste script, com o
#  nome "web-server" e permissao de execucao:
#     chmod +x web-server
#
#  Logs (stdout + stderr): logs/web-server.log
# ============================================================
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$DIR/web-server"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/web-server.log"
PID_FILE="$LOG_DIR/web-server.pid"
UNIT_NAME="moonlight-web-server"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/${UNIT_NAME}.service"

# ---- Endereco de escuta ----
# 127.0.0.1:5022 = apenas localhost (o Cloudflare Tunnel conecta aqui).
# Para tambem aceitar acesso da rede local, troque por 0.0.0.0:5022
export BIND_ADDRESS="127.0.0.1:5022"

# ---- Nivel de log: error | warn | info | debug | trace ----
export LOG_LEVEL="info"

# ---- Liberar a maquina automaticamente (sem pedir codigo) ----
# O web-server envia o PIN de pareamento para a API do Sunshine abaixo.
export SUNSHINE_PIN_API_URL="https://pin.fusioncloud.online"
export SUNSHINE_PIN_API_USERNAME="Fusion"
export SUNSHINE_PIN_API_PASSWORD="Fusion"

# ---- PIN API secundaria: usada SOMENTE pelos host ids abaixo (Fusion 02) ----
# Para essas maquinas o PIN vai para esta API em vez da de cima.
export SUNSHINE_PIN_API_URL_2="https://pinos.grupofusioncloud.site"
export SUNSHINE_PIN_API_USERNAME_2="dz"
export SUNSHINE_PIN_API_PASSWORD_2="dz"
export SUNSHINE_PIN_API_HOST_IDS="2250422749"

log() { printf '%s\n' "$*"; }

usage() {
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

# ------------------------------------------------------------------ helpers

have_systemd() {
    command -v systemctl >/dev/null 2>&1 || return 1
    systemctl --user show-environment >/dev/null 2>&1
}

check_binary() {
    if [ ! -f "$BIN" ]; then
        log "[ERRO] Binario nao encontrado: $BIN"
        log "       Coloque o binario Linux do web-server aqui e rode: chmod +x \"$BIN\""
        exit 1
    fi
    if [ ! -x "$BIN" ]; then
        log "[ERRO] Sem permissao de execucao: $BIN"
        log "       Rode: chmod +x \"$BIN\""
        exit 1
    fi
}

# --------------------------------------------------------- auto-inicio

install_autostart() {
    mkdir -p "$LOG_DIR"

    if have_systemd; then
        mkdir -p "$UNIT_DIR"
        cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Moonlight Web Server
After=network-online.target

[Service]
Type=simple
WorkingDirectory="$DIR"
Environment=BIND_ADDRESS=$BIND_ADDRESS
Environment=LOG_LEVEL=$LOG_LEVEL
Environment=SUNSHINE_PIN_API_URL=$SUNSHINE_PIN_API_URL
Environment=SUNSHINE_PIN_API_USERNAME=$SUNSHINE_PIN_API_USERNAME
Environment=SUNSHINE_PIN_API_PASSWORD=$SUNSHINE_PIN_API_PASSWORD
Environment=SUNSHINE_PIN_API_URL_2=$SUNSHINE_PIN_API_URL_2
Environment=SUNSHINE_PIN_API_USERNAME_2=$SUNSHINE_PIN_API_USERNAME_2
Environment=SUNSHINE_PIN_API_PASSWORD_2=$SUNSHINE_PIN_API_PASSWORD_2
Environment=SUNSHINE_PIN_API_HOST_IDS=$SUNSHINE_PIN_API_HOST_IDS
ExecStart="$BIN"
Restart=on-failure
RestartSec=3
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload >/dev/null 2>&1
        systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1
        log "[OK] Auto-inicio configurado via systemd --user:"
        log "     $UNIT_FILE"
        log "     Para iniciar tambem sem login, rode: loginctl enable-linger $USER"
        return 0
    fi

    # Fallback sem systemd: entrada @reboot no crontab
    if command -v crontab >/dev/null 2>&1; then
        local_line="@reboot \"$DIR/start-web-server.sh\" start"
        if (crontab -l 2>/dev/null || true) | grep -Fq "$DIR/start-web-server.sh"; then
            log "[i] Auto-inicio (crontab @reboot) ja configurado."
        else
            (crontab -l 2>/dev/null || true; printf '%s\n' "$local_line") | crontab -
            log "[OK] Auto-inicio configurado via crontab (@reboot)."
        fi
        return 0
    fi

    log "[AVISO] systemd/crontab indisponiveis; auto-inicio nao configurado."
}

uninstall_autostart() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1
        systemctl --user disable "$UNIT_NAME" >/dev/null 2>&1
        rm -f "$UNIT_FILE"
        systemctl --user daemon-reload >/dev/null 2>&1
    fi

    if command -v crontab >/dev/null 2>&1; then
        crontab -l 2>/dev/null | grep -Fv "$DIR/start-web-server.sh" | crontab - 2>/dev/null
    fi

    log "[OK] Auto-inicio removido."
}

# ------------------------------------------------------------ comandos

cmd_start() {
    check_binary
    mkdir -p "$LOG_DIR"

    if have_systemd; then
        # Configura/ativa o auto-inicio na primeira execucao (idempotente)
        if ! systemctl --user is-enabled --quiet "$UNIT_NAME" 2>/dev/null; then
            install_autostart
        fi
        if systemctl --user is-active --quiet "$UNIT_NAME"; then
            log "[i] O servidor ja esta rodando."
            return 0
        fi
        systemctl --user start "$UNIT_NAME"
        log "[OK] web-server iniciado (systemd --user). Log: $LOG_FILE"
        return 0
    fi

    # Fallback: processo em segundo plano com nohup
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        log "[i] O servidor ja esta rodando (PID $(cat "$PID_FILE"))."
        return 0
    fi
    nohup "$BIN" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    log "[OK] web-server iniciado (PID $(cat "$PID_FILE")). Log: $LOG_FILE"
}

cmd_stop() {
    if [ -f "$UNIT_FILE" ] && command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1
    fi

    if [ -f "$PID_FILE" ]; then
        pid="$(cat "$PID_FILE")"
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
            sleep 1
            kill -9 "$pid" 2>/dev/null
        fi
        rm -f "$PID_FILE"
    fi

    pkill -f "$BIN" 2>/dev/null
    log "[OK] web-server parado."
}

cmd_status() {
    if [ -f "$UNIT_FILE" ] && command -v systemctl >/dev/null 2>&1; then
        systemctl --user status "$UNIT_NAME" --no-pager
        return
    fi
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        log "Rodando (PID $(cat "$PID_FILE"))."
    else
        log "Parado."
    fi
}

cmd_logs() {
    mkdir -p "$LOG_DIR"
    touch "$LOG_FILE"
    tail -n 100 -f "$LOG_FILE"
}

# ---------------------------------------------------------------- main

case "${1:-start}" in
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_stop; cmd_start ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    install)   install_autostart ;;
    uninstall) uninstall_autostart ;;
    -h|--help|help) usage ;;
    *)
        log "Comando invalido: $1"
        log ""
        usage
        exit 1
        ;;
esac
