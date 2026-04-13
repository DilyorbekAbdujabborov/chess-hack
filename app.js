/**
 * checkers.sifr.uz — AI Bot + Express Dashboard
 * YANGILANGAN: GPT-4o-mini + Iterative Deepening + Bug fixes
 *
 * O'rnatish:
 *   npm install express socket.io-client tough-cookie node-fetch openai dotenv
 *
 * Ishlatish:
 *   .env fayliga sozlamalarni yozing yoki environment o'zgaruvchilari
 *   node app.js
 */

require("dotenv").config();

const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const { io }     = require("socket.io-client");
const { CookieJar } = require("tough-cookie");
const FILE_DB = process.env.TMP || process.env.TEMP || "/tmp/db.json";

function loadDb() {
  try { return JSON.parse(fs.readFileSync(FILE_DB, "utf8")); }
  catch { return { games: [] }; }
}
function saveDb(data) {
  try { fs.writeFileSync(FILE_DB, JSON.stringify(data, null, 2)); } catch(e) {}
}

let _fetch;
async function getFetch() {
  if (!_fetch) { const m = await import("node-fetch"); _fetch = m.default; }
  return _fetch;
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CFG = {
  base:       "https://checkers.sifr.uz",
  cookie:     process.env.COOKIE     || "",
  initData:   process.env.INIT_DATA  || "",
  maxDepth:   parseInt(process.env.DEPTH || "12"),   // Maksimal chuqurlik
  timeLimitMs:parseInt(process.env.TIME_MS || "3500"), // 3.5 soniya
  tier:       parseInt(process.env.TIER  || "1"),
  port:       parseInt(process.env.PORT  || "3000"),
  moveDelay:  150,
  pingMs:     30_000,
  ua: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.177 Mobile Safari/537.36 Telegram-Android/12.6.3",

  // GitHub Models / GPT-4o-mini
  githubToken:   process.env.GITHUB_TOKEN || "",
  gptEnabled:    !!process.env.GITHUB_TOKEN,
  gptEndpoint:   "https://models.github.ai/inference",
  gptModel:      "openai/gpt-4o-mini",
};

// ─── JSON FILE DB ─────────────────────────────────────────────────────────────
async function connectDB() {
  log("✅ JSON file DB ishga tushdi");
}

async function createGameDocument(code, myPlayerNum) {
  if (!code) return;
  const db = loadDb();
  const gameIndex = db.games.findIndex(g => g.gameCode === code);
  const game = { gameCode: code, userId: state.userId, userName: state.name || "Bot", myPlayerNum, result: "ongoing", steps: [], startedAt: new Date().toISOString() };
  if (gameIndex >= 0) db.games[gameIndex] = game;
  else db.games.push(game);
  saveDb(db);
}

async function saveStep(code, step) {
  if (!code) return;
  const db = loadDb();
  const game = db.games.find(g => g.gameCode === code);
  if (game) { game.steps.push(step); saveDb(db); }
}

async function saveGameResult(code, result, eloChange) {
  if (!code) return;
  const db = loadDb();
  const game = db.games.find(g => g.gameCode === code);
  if (game) { game.result = result; game.eloChange = eloChange; game.endedAt = new Date().toISOString(); saveDb(db); }
  log(`💾 O'yin tugadi: ${code} (${result})`);
}

// ─── LOG ──────────────────────────────────────────────────────────────────────
const T   = () => new Date().toISOString();
let logFile;
const log = (m) => {
  const msg = `[${T()}] ${m}`;
  console.log(msg);
  try {
    if (!logFile) logFile = fs.createWriteStream(path.join(process.env.TMP || "/tmp", "req_log.txt"), { flags: "a" });
    logFile.write(msg + "\n");
  } catch(e) {}
};
const reqLog = (method, url, reqBody, resStatus, resBody) => {
  const entry = `[${T()}] --> ${method} ${url}\nreq: ${JSON.stringify(reqBody)}\n<-- ${resStatus}\nres: ${JSON.stringify(resBody)}\n---\n`;
  console.log(entry);
  try {
    if (!logFile) logFile = fs.createWriteStream(path.join(process.env.TMP || "/tmp", "req_log.txt"), { flags: "a" });
    logFile.write(entry);
  } catch(e) {}
};

// ─── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(type, data) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch(_) {} });
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  board: null, myP: null, curP: null, gameCode: null,
  myTimer: 0, oppTimer: 0, wins: 0, losses: 0,
  status: "Ulanmoqda...", lastMove: null, moves: [],
  thinking: false, connected: false, userId: null, pendingGame: null,
  inTournament: false, tournamentName: null, tournamentRound: 0,
  tournamentWins: 0, tournamentLosses: 0,
  currentDepth: 0, gptEnabled: CFG.gptEnabled,
};
function pushState() { broadcast("state", { state }); }

// ─── GPT-4o-mini INTEGRATION ──────────────────────────────────────────────────
// GPT o'yin strategiyasiga maslahat beradi - minimax bilan birga ishlaydi
async function askGPTForStrategy(board, myP, mvs) {
  if (!CFG.gptEnabled || !CFG.githubToken) return null;
  try {
    const fetch = await getFetch();
    // Board holatini matn ko'rinishida tayyorla
    const boardStr = board.map((row, r) =>
      row.map((v, c) => {
        if (v === 0) return ".";
        if (v === 1) return "o"; // P1
        if (v === 2) return "x"; // P2
        if (v === 3) return "O"; // P1 King
        if (v === 4) return "X"; // P2 King
        return ".";
      }).join("")
    ).join("\n");

    const mvsStr = mvs.slice(0, 8).map(m =>
      `(${m.from_row},${m.from_col})→(${m.to_row},${m.to_col})${m._mid ? " [YUTISH]" : ""}`
    ).join(", ");

    const prompt = `Shashka o'yinida men ${myP === 1 ? "o/O (pastga harakatlanadi)" : "x/X (tepaga harakatlanadi)"} o'ynayapman.
Taxtachi holati (8x8):
${boardStr}

Mavjud harakatlar: ${mvsStr}

Qaysi harakat STRATEGIK jihatdan eng kuchli? Faqat harakat koordinatalarini JSON formatda qaytaring:
{"from_row": N, "from_col": N, "to_row": N, "to_col": N, "reason": "qisqa sabab"}`;

    const res = await fetch(`${CFG.gptEndpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CFG.githubToken}`,
      },
      body: JSON.stringify({
        model: CFG.gptModel,
        max_tokens: 150,
        messages: [
          { role: "system", content: "Siz shashka o'yinida ekspertsiz. Faqat JSON formatda javob bering." },
          { role: "user", content: prompt }
        ],
      }),
      signal: AbortSignal.timeout(4000), // 4 soniya timeout
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    // JSON parse
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    // Mavjud harakatlar ichida shu bor ekanligini tekshir
    const found = mvs.find(m =>
      m.from_row === parsed.from_row && m.from_col === parsed.from_col &&
      m.to_row === parsed.to_row && m.to_col === parsed.to_col
    );
    if (found) {
      log(`🤖 GPT tavsiyasi: (${parsed.from_row},${parsed.from_col})→(${parsed.to_row},${parsed.to_col}) — ${parsed.reason || ""}`);
      return found;
    }
    return null;
  } catch(e) {
    log(`⚠️ GPT xato: ${e.message}`);
    return null;
  }
}

// ─── MINIMAX ENGINE ───────────────────────────────────────────────────────────
const [EMPTY, P1, P2, P1K, P2K] = [0, 1, 2, 3, 4];
const isP1  = v => v === P1  || v === P1K;
const isP2  = v => v === P2  || v === P2K;
const isKg  = v => v === P1K || v === P2K;
const clone = b => b.map(r => [...r]);

const DIRS4 = [[-1,-1],[-1,1],[1,-1],[1,1]];

function moveDirs(v, p) {
  if (isKg(v)) return DIRS4;
  return p === 1 ? [[1,-1],[1,1]] : [[-1,-1],[-1,1]];
}

function caps(b, r, c, p) {
  const v = b[r][c], res = [];
  for (const [dr, dc] of moveDirs(v, p)) {
    const mr = r+dr, mc = c+dc, lr = r+2*dr, lc = c+2*dc;
    if (lr<0||lr>7||lc<0||lc>7) continue;
    const mid = b[mr][mc];
    const opp = p===1 ? isP2(mid) : isP1(mid);
    if (opp && b[lr][lc] === EMPTY)
      res.push({ from_row:r, from_col:c, to_row:lr, to_col:lc, capture_path:[[r,c],[lr,lc]], _mid:[mr,mc] });
  }
  return res;
}

function simps(b, r, c, p) {
  const v = b[r][c], res = [];
  for (const [dr, dc] of moveDirs(v, p)) {
    const nr = r+dr, nc = c+dc;
    if (nr>=0&&nr<=7&&nc>=0&&nc<=7&&b[nr][nc]===EMPTY)
      res.push({ from_row:r, from_col:c, to_row:nr, to_col:nc, capture_path:null });
  }
  return res;
}

function allMvs(b, p) {
  const c = [], s = [];
  for (let r=0; r<8; r++) for (let col=0; col<8; col++) {
    const mine = p===1 ? isP1(b[r][col]) : isP2(b[r][col]);
    if (!mine) continue;
    c.push(...caps(b, r, col, p));
    s.push(...simps(b, r, col, p));
  }
  return c.length ? c : s;
}

function apply(b, m) {
  const nb = clone(b);
  const v = nb[m.from_row][m.from_col];
  nb[m.to_row][m.to_col] = v;
  nb[m.from_row][m.from_col] = EMPTY;
  if (m._mid) nb[m._mid[0]][m._mid[1]] = EMPTY;
  if (v===P1 && m.to_row===7) nb[m.to_row][m.to_col] = P1K;
  if (v===P2 && m.to_row===0) nb[m.to_row][m.to_col] = P2K;
  return nb;
}

// Tosh xavf ostida ekanligini tekshirish
function isUnderAttack(b, r, c, myP) {
  const oppP = myP===1 ? 2 : 1;
  for (const [dr, dc] of DIRS4) {
    const ar = r-dr, ac = c-dc;
    if (ar<0||ar>7||ac<0||ac>7) continue;
    const adj = b[ar][ac];
    const isOpp = oppP===1 ? isP1(adj) : isP2(adj);
    if (!isOpp) continue;
    const oppDirs = moveDirs(adj, oppP);
    const canMove = oppDirs.some(([od,oc]) => od===dr && oc===dc);
    if (!canMove) continue;
    const lr = r+dr, lc = c+dc;
    if (lr>=0&&lr<=7&&lc>=0&&lc<=7&&b[lr][lc]===EMPTY) return true;
  }
  return false;
}

// Raqib toshiga ega bo'lish imkoniyati bor ekanligini tekshir (men uta olamanmi?)
function canCapture(b, r, c, myP) {
  return caps(b, r, c, myP).length > 0;
}

// KUCHLI EVALUATE funksiyasi
function evaluate(b, myP) {
  const oppP = myP===1 ? 2 : 1;
  let myPc = 0, oppPc = 0, myKg = 0, oppKg = 0;
  let s = 0;
  let myBackRow = 0, oppBackRow = 0;

  for (let r=0; r<8; r++) for (let c=0; c<8; c++) {
    const v = b[r][c];
    if (!v) continue;
    const mine = myP===1 ? isP1(v) : isP2(v);

    if (mine) {
      if (isKg(v)) {
        myKg++; myPc++;
        s += 350;
        // King markazda kuchliroq
        const cr = Math.abs(r-3.5), cc = Math.abs(c-3.5);
        s += (3.5-cr)*10 + (3.5-cc)*10;
        // King hujumda
        if (canCapture(b, r, c, myP)) s += 80;
      } else {
        myPc++;
        s += 100;
        const progress = myP===1 ? (7-r) : r;
        s += progress * 14; // oldinga yurish muhim
        // Xavf ostidami?
        if (isUnderAttack(b, r, c, myP)) s -= 90;
        // Chekkada himoyalanish
        if (c===0||c===7) s += 18;
        // Orqa safni qo'riqlash
        const backRow = myP===1 ? 0 : 7;
        if (r===backRow) { s += 25; myBackRow++; }
        // King promotion imkoni
        const kingRow = myP===1 ? 7 : 0;
        if (Math.abs(r - kingRow) <= 1) s += 30;
      }
    } else {
      if (isKg(v)) {
        oppKg++; oppPc++;
        s -= 350;
        const cr = Math.abs(r-3.5), cc = Math.abs(c-3.5);
        s -= (3.5-cr)*10 + (3.5-cc)*10;
        if (canCapture(b, r, c, oppP)) s -= 80;
      } else {
        oppPc++;
        s -= 100;
        const progress = oppP===1 ? r : (7-r);
        s -= progress * 14;
        if (isUnderAttack(b, r, c, oppP)) s += 75; // raqib xavf ostida = yaxshi
        if (c===0||c===7) s -= 18;
        const backRow = oppP===1 ? 0 : 7;
        if (r===backRow) { s -= 25; oppBackRow++; }
        const kingRow = oppP===1 ? 7 : 0;
        if (Math.abs(r - kingRow) <= 1) s -= 30;
      }
    }
  }

  if (myPc===0)  return -100000;
  if (oppPc===0) return  100000;

  // Tosh soni farqi - ENG muhim mezon
  s += (myPc - oppPc) * 250;
  // King soni farqi
  s += (myKg - oppKg) * 200;

  // Mobility
  const myMvs  = allMvs(b, myP);
  const oppMvs = allMvs(b, oppP);
  s += myMvs.length  * 6;
  s -= oppMvs.length * 6;

  // Raqib capture qila oladi - KATTA XAVF
  const oppCaptures = oppMvs.filter(m => m._mid);
  s -= oppCaptures.length * 150;

  // Men capture qila olaman - BONUS
  const myCaptures = myMvs.filter(m => m._mid);
  s += myCaptures.length * 120;

  // Endgame: toshlar kam bo'lsa king juda kuchli
  const totalPieces = myPc + oppPc;
  if (totalPieces <= 6) {
    // King vs Piece - king yaxshiroq
    s += (myKg - oppKg) * 400;
    // Raqibni burchakka qisib qo'y
    for (let r=0; r<8; r++) for (let c=0; c<8; c++) {
      const v = b[r][c];
      const isOppP = oppP===1 ? isP1(v) : isP2(v);
      if (isOppP) {
        // Burchakka yaqin = yomon raqib uchun
        const cornerDist = Math.min(r, 7-r, c, 7-c);
        s += (3 - cornerDist) * 15; // burchakda = biz uchun yaxshi
      }
    }
  }

  return s;
}

// Quiescence search
function quiesce(b, alpha, beta, myP, depth) {
  const stand = evaluate(b, myP);
  if (depth <= 0) return stand;
  if (stand >= beta)  return beta;
  if (stand > alpha)  alpha = stand;

  const mvs = allMvs(b, myP);
  const capMvs = mvs.filter(m => m._mid);
  if (!capMvs.length) return stand;

  for (const m of capMvs) {
    const nb = apply(b, m);
    const score = -quiesce(nb, -beta, -alpha, myP===1?2:1, depth-1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

// Move ordering: kuchli harakatlar avval
function orderMoves(mvs, b, myP) {
  return mvs.map(m => {
    let score = 0;
    if (m._mid) {
      score += 1500;
      const nb = apply(b, m);
      const further = allMvs(nb, myP).filter(x => x._mid).length;
      score += further * 600;
      // Qimmat toshni yutsa bonus
      const capturedV = b[m._mid[0]][m._mid[1]];
      if (isKg(capturedV)) score += 500;
    }
    // King promotion
    const v = b[m.from_row][m.from_col];
    if (!isKg(v)) {
      if (myP===1 && m.to_row===7) score += 900;
      if (myP===2 && m.to_row===0) score += 900;
    }
    // Xavf ostidagi toshni olib chiqish
    if (isUnderAttack(b, m.from_row, m.from_col, myP)) score += 200;
    return { m, score };
  }).sort((a, b) => b.score - a.score).map(x => x.m);
}

// Minimax + Alpha-Beta + vaqt nazorati
let searchStart = 0;
let searchAborted = false;

function minimax(b, d, alpha, beta, isMax, myP) {
  // Vaqt limitini tekshir
  if (Date.now() - searchStart > CFG.timeLimitMs - 200) {
    searchAborted = true;
    return 0;
  }

  const forP = isMax ? myP : (myP===1?2:1);
  let mvs = allMvs(b, forP);

  if (!mvs.length) return isMax ? -100000 : 100000;

  if (d === 0) {
    return isMax
      ? quiesce(b, alpha, beta, myP, 6)
      : quiesce(b, alpha, beta, myP===1?2:1, 6);
  }

  mvs = orderMoves(mvs, b, forP);

  if (isMax) {
    let best = -Infinity;
    for (const m of mvs) {
      if (searchAborted) break;
      best = Math.max(best, minimax(apply(b, m), d-1, alpha, beta, false, myP));
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of mvs) {
      if (searchAborted) break;
      best = Math.min(best, minimax(apply(b, m), d-1, alpha, beta, true, myP));
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

// ITERATIVE DEEPENING: vaqt tugaguncha chuqurroq qidiradi
function getBest(b, myP, forcedMvs) {
  const mvs = forcedMvs || allMvs(b, myP);
  if (!mvs.length) return null;
  if (mvs.length === 1) return mvs[0];

  // Agar yutish harakati bo'lsa — eng ko'p yutadigan tanlash
  const captures = mvs.filter(m => m._mid);
  if (captures.length === 1) return captures[0];

  const ordered = orderMoves(mvs, b, myP);
  let bestMove = ordered[0];
  let bestScore = -Infinity;

  searchStart = Date.now();

  for (let depth = 1; depth <= CFG.maxDepth; depth++) {
    searchAborted = false;
    let iterBestMove = null;
    let iterBestScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;

    for (const m of ordered) {
      if (searchAborted) break;
      const nb = apply(b, m);
      const score = minimax(nb, depth-1, alpha, beta, false, myP);
      if (score > iterBestScore) {
        iterBestScore = score;
        iterBestMove = m;
      }
      alpha = Math.max(alpha, iterBestScore);
    }

    if (!searchAborted && iterBestMove) {
      bestMove = iterBestMove;
      bestScore = iterBestScore;
      state.currentDepth = depth;
      log(`  Depth ${depth}: (${bestMove.from_row},${bestMove.from_col})→(${bestMove.to_row},${bestMove.to_col}) score=${bestScore}`);

      // Yutish topildi — davom etish shart emas
      if (bestScore >= 90000) break;
    }

    // Vaqt tugadi
    if (Date.now() - searchStart > CFG.timeLimitMs - 300) break;
  }

  const elapsed = Date.now() - searchStart;
  log(`🎯 Depth ${state.currentDepth} ichida ${elapsed}ms, score=${bestScore}`);
  return bestMove;
}

// ─── COOKIE / AUTH ────────────────────────────────────────────────────────────
const jar = new CookieJar();
function loadCookies(str) {
  if (!str) return;
  str.split(";").forEach(p => { const s = p.trim(); if (s) jar.setCookieSync(s, CFG.base); });
}
function cookieHeader() {
  return jar.getCookiesSync(CFG.base).map(c => c.cookieString()).join("; ");
}

async function apiFetch(p, opts = {}) {
  const fetch = await getFetch();
  const ch = cookieHeader();
  const url = CFG.base + p;
  const res = await fetch(url, {
    ...opts,
    headers: {
      accept: "*/*",
      "accept-language": "en-GB,en;q=0.9",
      origin: CFG.base,
      referer: CFG.base + "/find_game",
      "user-agent": CFG.ua,
      "x-requested-with": "org.telegram.messenger",
      ...(ch ? { cookie: ch } : {}),
      ...(opts.headers || {}),
    },
    redirect: "manual",
  });
  const sc = res.headers.raw?.()?.["set-cookie"] || [];
  sc.forEach(c => jar.setCookieSync(c, CFG.base));
  let body = null;
  if (!["POST","PUT","PATCH"].includes(opts.method)) {
    body = await res.clone().json().catch(() => null);
  }
  reqLog(opts.method || "GET", url, opts.body || null, res.status, body);
  return res;
}

async function auth() {
  if (CFG.cookie) { loadCookies(CFG.cookie); }
  else if (CFG.initData) {
    await apiFetch(`/?tgWebAppData=${encodeURIComponent(CFG.initData)}`).catch(() => {});
    await apiFetch("/find_game", { headers: { "x-telegram-init-data": CFG.initData } }).catch(() => {});
  } else {
    console.error("COOKIE yoki INIT_DATA kerak!"); process.exit(1);
  }
  try {
    const res = await apiFetch("/check_active_game");
    if (res.status === 200) {
      const d = await res.json();
      if (d.has_active_game && d.game_code) {
        log(`✅ Active game: ${d.game_code}`);
        state.pendingGame = d.game_code;
      }
      return true;
    }
    log(`❌ Session xato (${res.status})`); return false;
  } catch(e) { log(`❌ checkSession: ${e.message}`); return false; }
}

// ─── GAME ─────────────────────────────────────────────────────────────────────
let socket;
let thinking = false;
let thinkingSince = null; // ← TUZATILDI: global scope da

const isMyTurn = () => state.curP === state.myP;

async function doMove() {
  if (!state.board || !isMyTurn() || thinking || !state.gameCode) return;
  thinking = true;
  state.thinking = true;
  thinkingSince = Date.now();
  state.status = "AI o'ylamoqda...";
  pushState();

  const t0 = Date.now();
  let mvs = allMvs(state.board, state.myP);

  // Xavfli harakatlarni filter qilish - to'g'ridan-to'g'ri capture qilinadigan harakatlarni olib tashlash
  mvs = mvs.filter(m => {
    if (m._mid) return true; // capture harakatlari yaxshi
    const nb = apply(clone(state.board), m);
    const oppP = state.myP === 1 ? 2 : 1;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (state.myP === 1 ? isP1(nb[r][c]) : isP2(nb[r][c])) {
          if (isUnderAttack(nb, r, c, state.myP)) return false;
        }
      }
    }
    return true;
  });

  if (mvs.length === 0) mvs = allMvs(state.board, state.myP);

  // Minimax dan eng yaxshi harakatni top
  const bestMove = getBest(state.board, state.myP, mvs);
  let mv = bestMove;

  // GPT-4o-mini dan tavsiya so'ra (agar token bo'lsa)
  if (CFG.gptEnabled && mvs.length > 1 && mvs.length <= 12) {
    const gptMove = await askGPTForStrategy(state.board, state.myP, mvs);
      if (gptMove && gptMove !== bestMove) {
      const gptScore = evaluate(apply(clone(state.board), gptMove), state.myP);
      const bestScore = evaluate(apply(clone(state.board), bestMove), state.myP);
      if (gptScore >= bestScore - 50) {
        mv = gptMove; // GPT harakati yaxshi yoki minimaxga yaqin
      }
    }
  }

  const ms = Date.now() - t0;

  if (!mv) {
    thinking = false; state.thinking = false; thinkingSince = null;
    state.status = "Harakat yo'q — yutqazdim!"; pushState(); return;
  }

  log(`✅ Harakat (${ms}ms, depth=${state.currentDepth}): (${mv.from_row},${mv.from_col})→(${mv.to_row},${mv.to_col})${mv._mid ? " [YUTDI]" : ""}`);
  state.status = `Harakat: (${mv.from_row},${mv.from_col})→(${mv.to_row},${mv.to_col})${mv._mid ? " [YUTDI]" : ""} (depth=${state.currentDepth}, ${ms}ms)`;

  await new Promise(r => setTimeout(r, CFG.moveDelay + Math.random()*200));

  socket.emit("game/make_move", {
    game_code:    state.gameCode,
    from_row:     mv.from_row,
    from_col:     mv.from_col,
    to_row:       mv.to_row,
    to_col:       mv.to_col,
    capture_path: mv.capture_path,
  });

  thinking = false; state.thinking = false; thinkingSince = null;
  pushState();
}

async function findGame() {
  if (state.gameCode || state.board) return;
  state.status = "O'yin qidirilmoqda..."; pushState();
  log("🔍 O'yin qidirilmoqda...");
  try {
    const res = await apiFetch(`/random_game?tier=${CFG.tier}`);
    const d = await res.json();
    if (d.error && d.error.includes("faol o'yinda")) {
      const fetch = await getFetch();
      const gameRes = await fetch(CFG.base + "/find_game", {
        method: "GET",
        headers: { accept: "text/html", referer: CFG.base + "/", "user-agent": CFG.ua, cookie: cookieHeader(), "x-telegram-init-data": CFG.initData },
        redirect: "manual",
      });
      const location = gameRes.headers.get("location");
      if (location) {
        const match = location.match(/\/game\/([^?]+)/);
        if (match) {
          state.gameCode = match[1];
          log(`🔗 Joining active game: ${match[1]}`);
          socket.emit("game/join_game", { game_code: match[1] });
        }
      }
    } else {
      log(`Server: ${d.message || JSON.stringify(d)}`);
      if (!state.gameCode) {
        setTimeout(() => {
          if (!state.gameCode && !state.board) { log("⏰ Timeout - qayta izlash..."); findGame(); }
        }, 25000);
      }
    }
  } catch(e) { log(`findGame: ${e.message}`); }
}

async function ping() {
  const ref = state.gameCode ? `/game/${state.gameCode}` : "/find_game";
  try { await apiFetch("/online_ping", { method: "POST", headers: { referer: CFG.base+ref } }); } catch(_) {}
}

// ─── SOCKET ───────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io(CFG.base, {
    extraHeaders: {
      cookie: cookieHeader(), origin: CFG.base, referer: CFG.base+"/find_game",
      "user-agent": CFG.ua, "x-requested-with": "org.telegram.messenger",
    },
    reconnection: true, reconnectionDelay: 2000, reconnectionDelayMax: 10000,
    reconnectionAttempts: 20, transports: ["websocket","polling"],
  });

  socket.on("connect", () => {
    state.connected = true; state.status = "Socket ulandi";
    log("✅ Socket ulandi: " + socket.id); pushState();
  });

  socket.on("connected", d => {
    state.userId = d.user_id;
    state.status = `Auth OK — user_id: ${d.user_id}`;
    log("✅ Auth OK: " + d.user_id); pushState();
    if (state.pendingGame) {
      const gameCode = state.pendingGame;
      state.pendingGame = null;
      state.gameCode = gameCode;
      log(`🔗 Joining existing game: ${gameCode}`);
      setTimeout(() => socket.emit("game/join_game", { game_code: gameCode }), 800);
    } else {
      checkAndJoinActiveGame().then(hasActive => {
        if (!hasActive) setTimeout(findGame, 1000);
      });
    }
  });

  async function checkAndJoinActiveGame() {
    try {
      const res = await apiFetch("/check_active_game");
      const d = await res.json();
      if (d.has_active_game && d.game_code) {
        state.gameCode = d.game_code;
        log(`✅ Active game found: ${d.game_code}`);
        setTimeout(() => socket.emit("game/join_game", { game_code: d.game_code }), 500);
        return true;
      }
      return false;
    } catch(e) { log(`checkAndJoinActiveGame: ${e.message}`); return false; }
  }

  socket.on("disconnect", r => {
    state.connected = false; state.status = `Uzildi: ${r}`;
    state.gameCode = null; state.board = null;
    log("⚠️ Uzildi: " + r); pushState();
  });

  socket.on("game_accepted", d => {
    state.gameCode = d.game_code; state.status = `O'yin topildi: ${d.game_code}`;
    state.moves = []; state.lastMove = null;
    log("✅ O'yin: " + d.game_code); pushState();
    setTimeout(() => socket.emit("game/join_game", { game_code: state.gameCode }), 600);
  });

  socket.on("game_request", async d => {
    log(`📨 Taklif: ${d.from_user_name} (${d.from_user_rating})`);
    broadcast("invite", { name: d.from_user_name, rating: d.from_user_rating });
    if (!state.gameCode) {
      try { await apiFetch(`/accept_game_request/${d.invitation_id}`); } catch(_) {}
    }
  });

  socket.on("game/game_state", d => {
    state.gameCode = d.game_code || state.gameCode || null;
    state.board = d.board; state.curP = d.current_player; state.myP = d.player_num;
    state.myTimer = Math.round(d.user_timer); state.oppTimer = Math.round(d.opponent_timer);
    state.moves = []; state.lastMove = null; state.currentDepth = 0;
    state.status = `O'yin boshlandi — men player${state.myP}`;
    log(`✅ O'yin holati — myP=${state.myP} curP=${state.curP} gameCode=${state.gameCode}`);
    pushState();
    createGameDocument(state.gameCode, state.myP);
    if (isMyTurn()) doMove();
  });

  socket.on("game/move_made", d => {
    state.board = d.board; state.curP = d.current_player;
    state.myTimer  = d[`player${state.myP}_timer`]          ? Math.round(d[`player${state.myP}_timer`])          : state.myTimer;
    state.oppTimer = d[`player${state.myP===1?2:1}_timer`]  ? Math.round(d[`player${state.myP===1?2:1}_timer`])  : state.oppTimer;
    const isMe = state.userId && d.player_id === String(state.userId);
    const side = isMe ? "bot" : "opp";
    const step = {
      n: state.moves.length + 1, side,
      from: [d.from_row, d.from_col], to: [d.to_row, d.to_col],
      cap: !!d._mid || !!d.capture_path,
      board: d.board.map(r => [...r]),
    };
    state.moves.push(step);
    state.lastMove = { from_row: d.from_row, from_col: d.from_col, to_row: d.to_row, to_col: d.to_col, cap: !!d._mid||!!d.capture_path };
    state.status = `${side==="bot"?"Bot":"Raqib"}: (${d.from_row},${d.from_col})→(${d.to_row},${d.to_col})`;
    log(`${side==="bot"?"🤖":"👤"} Harakat: (${d.from_row},${d.from_col})→(${d.to_row},${d.to_col})`);
    pushState();
    if (state.gameCode) saveStep(state.gameCode, step);
    if (isMyTurn()) doMove();
  });

  // ── TUZATILDI: iWon mantiqiy to'g'rilandi ──────────────────────────────────
  socket.on("game/game_over", d => {
    // Ko'p usulda g'alaba aniqlash
    let iWon = false;

    // 1. ELO o'zgarishi ijobiy bo'lsa — yutdik
    if (d.elo_changes && state.userId) {
      const myElo = d.elo_changes[state.userId] || d.elo_changes[String(state.userId)] || 0;
      if (myElo > 0) iWon = true;
    }

    // 2. winner field
    if (d.winner && state.userId) {
      if (d.winner === state.userId || d.winner === String(state.userId)) iWon = true;
      if (d.winner === state.myP || d.winner === `player${state.myP}`) iWon = true;
    }

    // 3. Raqib taslim bo'lsa
    if (d.surrender && state.userId) {
      const surrenderedBy = d.surrendered_by || d.surrender_player_id;
      if (surrenderedBy && surrenderedBy !== state.userId && surrenderedBy !== String(state.userId)) {
        iWon = true;
      }
    }

    // 4. Xabar matni bo'yicha
    if (d.surrender_message) {
      const msg = d.surrender_message.toLowerCase();
      if (msg.includes("siz yutdingiz") || msg.includes("you won") || msg.includes("победили")) iWon = true;
      if (msg.includes("siz yutqazdingiz") || msg.includes("you lost") || msg.includes("проиграли")) iWon = false;
    }

    const myEloChange = d.elo_changes ? (d.elo_changes[state.userId] || d.elo_changes[String(state.userId)] || 0) : 0;
    const result = iWon ? "win" : "loss";

    if (iWon) { state.wins++;   state.status = `🏆 YUTDIM! W:${state.wins} L:${state.losses}`; }
    else       { state.losses++; state.status = `😞 Yutqazdim. W:${state.wins} L:${state.losses}`; }
    if (d.elo_changes) state.status += ` ELO:${JSON.stringify(d.elo_changes)}`;
    log(state.status);

    saveGameResult(state.gameCode, result, myEloChange);
    thinking = false; state.thinking = false; thinkingSince = null;
    state.gameCode = null; state.board = null; state.myP = null; state.curP = null;
    pushState();
    setTimeout(findGame, 4000);
  });

  socket.on("game/players_online_status", d => {
    if (d.opponent_online === false) { state.status = "Raqib offlayn!"; pushState(); }
  });

  socket.on("tournament/game_request", d => {
    log(`🏆 Turnir taklifi: ${d.from_user_name}`);
    broadcast("tournament_invite", { name: d.from_user_name, rating: d.from_user_rating, round: state.tournamentRound });
  });

  socket.on("tournament/status", d => {
    state.inTournament = true;
    state.tournamentName = d.tournament_name || state.tournamentName;
    state.tournamentRound = d.round || 0;
    state.tournamentWins = d.my_wins || 0;
    state.tournamentLosses = d.my_losses || 0;
    state.status = `🏆 Turnir: ${state.tournamentName} | Round ${state.tournamentRound} | W:${state.tournamentWins} L:${state.tournamentLosses}`;
    pushState();
  });

  socket.on("tournament/next_round", d => {
    state.tournamentRound = d.round || state.tournamentRound + 1;
    state.tournamentWins = d.my_wins || state.tournamentWins;
    state.tournamentLosses = d.my_losses || state.tournamentLosses;
    state.status = `🏆 Keyingi round ${state.tournamentRound} boshlanmoqda...`;
    pushState();
  });

  socket.on("tournament/ended", d => {
    state.inTournament = false;
    state.status = `🏆 Turnir tugadi! Natija: W:${state.tournamentWins} L:${state.tournamentLosses}`;
    pushState();
    setTimeout(findGame, 5000);
  });

  socket.on("connect_error", e => { log("❌ " + e.message); });
}

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type:"state", state })}\n\n`);
  req.on("close", () => sseClients.delete(res));
});

app.get("/api/state",    (req, res) => res.json(state));
app.post("/api/find",    async (req, res) => { await findGame(); res.json({ ok: true }); });
app.post("/api/surrender", (req, res) => {
  if (state.gameCode && socket) {
    socket.emit("game/surrender", { game_code: state.gameCode, player_id: state.userId });
    res.json({ ok: true });
  } else res.json({ ok: false, msg: "O'yin yo'q" });
});
app.post("/api/leave", (req, res) => {
  if (state.gameCode && socket) {
    socket.emit("game/leave_no_rating", { game_code: state.gameCode, player_id: state.userId });
    state.gameCode = null; state.board = null; state.myP = null; state.curP = null;
    state.status = "O'yindan chiqildi"; pushState();
    res.json({ ok: true });
  } else res.json({ ok: false, msg: "O'yin yo'q" });
});
app.post("/api/join", async (req, res) => {
  const { gameCode } = req.body;
  if (!gameCode) return res.json({ ok: false, msg: "Game code kerak" });
  if (state.gameCode) return res.json({ ok: false, msg: "Allaqachon o'yinda" });
  if (socket?.connected) {
    state.gameCode = gameCode;
    socket.emit("game/join_game", { game_code: gameCode });
    state.status = `O'yinga qo'shilindi: ${gameCode}`; pushState();
    res.json({ ok: true, gameCode });
  } else res.json({ ok: false, msg: "Socket ulanmagan" });
});
app.post("/api/depth", (req, res) => {
  const d = parseInt(req.body.depth);
  if (d>=1 && d<=15) { CFG.maxDepth = d; res.json({ ok: true, depth: d }); }
  else res.json({ ok: false });
});
app.post("/api/time", (req, res) => {
  const t = parseInt(req.body.timeMs);
  if (t>=500 && t<=8000) { CFG.timeLimitMs = t; res.json({ ok: true, timeMs: t }); }
  else res.json({ ok: false });
});
app.get("/api/history", async (req, res) => {
  try {
    const db = loadDb();
    const limit = parseInt(req.query.limit) || 50;
    const games = db.games.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
    res.json({ ok: true, games });
  } catch(e) { res.status(500).json({ ok: false, msg: e.message }); }
});
app.get("/api/profile", async (req, res) => {
  try {
    const fetch = await getFetch();
    const r = await fetch(CFG.base + "/profil", {
      headers: { accept: "text/html", "user-agent": CFG.ua, cookie: cookieHeader() },
    });
    const html = await r.text();
    const get = (re, idx=1) => { const m = html.match(re); return m ? m[idx] : null; };
    const name   = get(/id="heroNameText"[^>]*>([^<]+)</, 1) || "—";
    const rating = parseInt(get(/Reyting[\s\S]*?class="stat-value">(\d+)/, 1) || "0");
    const wins   = parseInt(get(/G'alaba[\s\S]*?class="stat-value">(\d+)/, 1) || "0");
    const losses = parseInt(get(/Mag'lubiyat[\s\S]*?class="stat-value">(\d+)/, 1) || "0");
    const gems   = parseInt(get(/Olmos[\s\S]*?class="stat-value">(\d+)/, 1) || "0");
    const refs   = parseInt(get(/Taklif[\s\S]*?class="stat-value">(\d+)/, 1) || "0");
    res.json({ name, wins, losses, rating, gems, refs, total: wins+losses });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── START ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(60));
  console.log(`  checkers.sifr.uz Bot  |  maxDepth=${CFG.maxDepth}  timeLimit=${CFG.timeLimitMs}ms`);
  console.log(`  GPT-4o-mini: ${CFG.gptEnabled ? "✅ YOQILGAN" : "❌ O'chirilgan (GITHUB_TOKEN yo'q)"}`);
  console.log("═".repeat(60));

  await connectDB();
  const ok = await auth();
  if (!ok) { console.error("Auth muvaffaqiyatsiz."); process.exit(1); }

  connectSocket();
  setInterval(ping, CFG.pingMs);

  // Watchdog: stuckdan qutqarish — TUZATILDI (thinkingSince global)
  setInterval(() => {
    if (!state.board || !state.gameCode) return;
    if (thinking && thinkingSince && Date.now() - thinkingSince > 12000) {
      log("⚠️ Thinking timeout — qayta urinish");
      thinking = false;
      state.thinking = false;
      thinkingSince = null;
    }
    if (state.board && isMyTurn() && !thinking) {
      log("⚠️ Navbat siqildi — qayta urinish...");
      doMove();
    }
  }, 8000);

  app.listen(CFG.port, () => {
    console.log(`\n🌐 Dashboard: http://localhost:${CFG.port}\n`);
  });
}

main().catch(e => { console.error(e.stack); process.exit(1); });

module.exports = app;