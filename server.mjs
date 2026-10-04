// server.mjs — mantém o Render acordado e roda o bot em background
import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

let botProcess = null;
let botStatus = 'idle';
let botLogs = [];
let startedAt = null;

const APROVADOS_FILE = 'aprovados.txt';
const MAX_LOG_LINES = 500;

function pushLog(line) {
  const ts = new Date().toISOString();
  botLogs.push(`[${ts}] ${line}`);
  if (botLogs.length > MAX_LOG_LINES) botLogs.shift();
  console.log(line);
}

function iniciarBot() {
  if (botProcess) {
    pushLog('⚠️ Bot já está rodando.');
    return;
  }
  botStatus = 'running';
  startedAt = new Date().toISOString();
  pushLog('🚀 Iniciando chk.mjs...');

  botProcess = spawn('node', ['chk.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, HEADLESS: 'true', WORKERS: '1', MAX_RETRIES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  botProcess.stdout.on('data', (d) =>
    d.toString().split('\n').forEach((l) => l && pushLog(`[out] ${l}`))
  );
  botProcess.stderr.on('data', (d) =>
    d.toString().split('\n').forEach((l) => l && pushLog(`[err] ${l}`))
  );

  botProcess.on('exit', (code, signal) => {
    pushLog(`🏁 Bot finalizado. code=${code} signal=${signal}`);
    botStatus = code === 0 ? 'finished' : 'crashed';
    botProcess = null;
  });
}

app.get('/', (req, res) => {
  res.json({
    status: botStatus,
    startedAt,
    aprovadosCount: contarAprovados(),
    uptime: process.uptime(),
  });
});

app.get('/start', (req, res) => {
  if (botStatus === 'running') return res.status(409).json({ error: 'já rodando' });
  iniciarBot();
  res.json({ ok: true, status: botStatus });
});

app.get('/logs', (req, res) => {
  res.type('text/plain').send(botLogs.join('\n') || '(sem logs ainda)');
});

app.get('/aprovados', (req, res) => {
  try {
    const content = fs.existsSync(APROVADOS_FILE)
      ? fs.readFileSync(APROVADOS_FILE, 'utf-8')
      : '';
    res.type('text/plain').send(content || '(nenhum aprovado ainda)');
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/parar', (req, res) => {
  if (botProcess) {
    botProcess.kill('SIGTERM');
    pushLog('🛑 SIGTERM enviado ao bot.');
    res.json({ ok: true });
  } else {
    res.status(409).json({ error: 'bot não está rodando' });
  }
});

function contarAprovados() {
  try {
    if (!fs.existsSync(APROVADOS_FILE)) return 0;
    return fs
      .readFileSync(APROVADOS_FILE, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('#')).length;
  } catch {
    return 0;
  }
}

iniciarBot();

setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  fetch(url).catch(() => {});
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  pushLog(`🌐 Servidor ouvindo em :${PORT}`);
});