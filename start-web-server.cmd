@echo off
setlocal

REM ============================================================
REM  Moonlight web-server - iniciar em SEGUNDO PLANO (sem janela)
REM  Basta dar duplo clique neste arquivo.
REM
REM  O servidor roda oculto, sem janela de CMD.
REM  Todas as logs (stdout + stderr) ficam em:
REM      logs\web-server.log
REM
REM  Na PRIMEIRA execucao este script se registra para abrir
REM  automaticamente junto com o Windows (ao fazer login).
REM  Para DESATIVAR o auto-inicio:  start-web-server.cmd uninstall
REM
REM  Para PARAR o servidor, use no PowerShell:
REM      Get-Process web-server -ErrorAction SilentlyContinue | Stop-Process -Force
REM ============================================================

REM --- Desinstalar o auto-inicio:  start-web-server.cmd uninstall ---
if /i "%~1"=="uninstall" (
    reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "MoonlightWebServer" /f >nul 2>&1
    if errorlevel 1 (echo Auto-inicio nao estava configurado.) else (echo Auto-inicio com o Windows removido.)
    exit /b 0
)

REM --- Auto-inicio com o Windows (registra na 1a execucao; idempotente) ---
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "MoonlightWebServer" >nul 2>&1
if errorlevel 1 (
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "MoonlightWebServer" /t REG_SZ /d "\"%~f0\"" /f >nul 2>&1
    if errorlevel 1 (echo [AVISO] Nao foi possivel ativar o auto-inicio com o Windows.) else (echo [OK] Auto-inicio com o Windows ativado.)
)

REM --- Primeira execucao: reabre este script escondido e fecha a janela visivel ---
if /i not "%~1"=="hidden" (
    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -ArgumentList 'hidden' -WindowStyle Hidden"
    exit /b 0
)

REM Vai para a pasta deste script (onde fica web-server.exe e a pasta server/)
cd /d "%~dp0"

REM ---- Endereco de escuta ----
REM 127.0.0.1:5022 = apenas localhost (o Cloudflare Tunnel conecta aqui).
REM Para tambem aceitar acesso da rede local, troque por 0.0.0.0:5022
set "BIND_ADDRESS=127.0.0.1:5022"

REM ---- Nivel de log: error | warn | info | debug | trace ----
set "LOG_LEVEL=info"

REM ---- Liberar a maquina automaticamente (sem pedir codigo) ----
REM O web-server envia o PIN de pareamento para a API do Sunshine abaixo.
set "SUNSHINE_PIN_API_URL=https://pin.fusioncloud.online"
set "SUNSHINE_PIN_API_USERNAME=Fusion"
set "SUNSHINE_PIN_API_PASSWORD=Fusion"

REM ---- PIN API secundaria: usada SOMENTE pelos host ids abaixo (Fusion 02) ----
REM Para essas maquinas o PIN vai para esta API em vez da de cima.
set "SUNSHINE_PIN_API_URL_2=https://pinos.grupofusioncloud.site"
set "SUNSHINE_PIN_API_USERNAME_2=dz"
set "SUNSHINE_PIN_API_PASSWORD_2=dz"
set "SUNSHINE_PIN_API_HOST_IDS=2250422749"

if not exist "logs" mkdir "logs"

REM ---- Roda o servidor em segundo plano com stdout + stderr no mesmo arquivo ----
"%~dp0web-server.exe" >> "%~dp0logs\web-server.log" 2>&1

exit /b 0
