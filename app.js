require("dotenv").config();
const express = require("express");
const { io } = require("socket.io-client");
const { CookieJar } = require("tough-cookie");
const mongoose = require("mongoose");
const path = require("path");

// --- CONFIG ---
const CFG = {
    base: "https://checkers.sifr.uz",
    winnerCookie: process.env.WINNER_COOKIE,
    loserCookie: process.env.LOSER_COOKIE,
    isFarming: process.env.FARMING_MODE === "true",
    maxDepth: parseInt(process.env.DEPTH || "10"),
    timeLimitMs: parseInt(process.env.TIME_MS || "3000"),
    moveDelay: 1200, // Anti-cheat uchun sekinlashtirilgan
    ua: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.177 Mobile Safari/537.36 Telegram-Android/12.6.3",
};

// --- SHASHKA LOGIKASI (MINIMAX & UTILS) ---
const [EMPTY, P1, P2, P1K, P2K] = [0, 1, 2, 3, 4];
const isP1 = v => v === P1 || v === P1K;
const isP2 = v => v === P2 || v === P2K;
const isKg = v => v === P1K || v === P2K;
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

// --- EVALUATE & MINIMAX ---
function evaluate(b, myP) {
    let s = 0;
    for (let r=0; r<8; r++) for (let c=0; c<8; c++) {
        const v = b[r][c]; if (!v) continue;
        const mine = myP===1 ? isP1(v) : isP2(v);
        const val = isKg(v) ? 350 : 100;
        s += mine ? val : -val;
    }
    return s;
}

function minimax(b, d, alpha, beta, isMax, myP) {
    if (d === 0) return evaluate(b, myP);
    const forP = isMax ? myP : (myP===1?2:1);
    const mvs = allMvs(b, forP);
    if (!mvs.length) return isMax ? -10000 : 10000;
    if (isMax) {
        let best = -Infinity;
        for (const m of mvs) {
            best = Math.max(best, minimax(apply(b, m), d-1, alpha, beta, false, myP));
            alpha = Math.max(alpha, best);
            if (beta <= alpha) break;
        }
        return best;
    } else {
        let best = Infinity;
        for (const m of mvs) {
            best = Math.min(best, minimax(apply(b, m), d-1, alpha, beta, true, myP));
            beta = Math.min(beta, best);
            if (beta <= alpha) break;
        }
        return best;
    }
}

// --- BOT CLASS ---
class CheckerBot {
    constructor(cookie, name, role) {
        this.jar = new CookieJar();
        this.cookie = cookie;
        this.name = name;
        this.role = role;
        this.socket = null;
        this.state = { board: null, myP: null, gameCode: null, userId: null, thinking: false };
        this.loadCookies(cookie);
    }

    loadCookies(str) {
        str.split(";").forEach(p => this.jar.setCookieSync(p.trim(), CFG.base));
    }

    getCookieHeader() {
        return this.jar.getCookiesSync(CFG.base).map(c => c.cookieString()).join("; ");
    }

    log(m) { console.log(`[${new Date().toLocaleTimeString()}] [${this.name}] ${m}`); }

    connect() {
        this.socket = io(CFG.base, {
            extraHeaders: { cookie: this.getCookieHeader(), "user-agent": CFG.ua },
            transports: ["websocket"]
        });

        this.socket.on("connected", d => {
            this.state.userId = d.user_id;
            this.log(`Auth OK: ${d.user_id}`);
            if (this.role === "winner") this.searchGame();
        });

        this.socket.on("game_accepted", d => {
            this.state.gameCode = d.game_code;
            this.socket.emit("game/join_game", { game_code: d.game_code });
        });

        this.socket.on("game/game_state", d => {
            this.state.board = d.board;
            this.state.myP = d.player_num;
            this.state.gameCode = d.game_code;
            this.log(`Game started: ${d.game_code} (P${d.player_num})`);
            
            if (this.role === "winner" && CFG.isFarming) {
                // Loser ham shu o'yinga kirishi kerak
                global.loserBot.joinSpecificGame(d.game_code);
            }
            if (d.current_player === d.player_num) this.makeMove();
        });

        this.socket.on("game/move_made", d => {
            this.state.board = d.board;
            if (d.current_player === this.state.myP) this.makeMove();
        });

        this.socket.on("game/game_over", d => {
            this.log(`Game Over! Result: ${JSON.stringify(d.elo_changes || {})}`);
            this.state.board = null;
            this.state.gameCode = null;
            if (this.role === "winner") setTimeout(() => this.searchGame(), 5000);
        });
    }

    async searchGame() {
        this.log("Searching for game...");
        try {
            const fetch = (await import("node-fetch")).default;
            await fetch(`${CFG.base}/random_game?tier=1`, {
                headers: { cookie: this.getCookieHeader(), "user-agent": CFG.ua }
            });
        } catch(e) { this.log(`Search error: ${e.message}`); }
    }

    joinSpecificGame(code) {
        this.log(`Joining specific game: ${code}`);
        this.socket.emit("game/join_game", { game_code: code });
    }

    async makeMove() {
        if (this.state.thinking) return;
        this.state.thinking = true;
        await new Promise(r => setTimeout(r, CFG.moveDelay + Math.random()*500));

        const mvs = allMvs(this.state.board, this.state.myP);
        if (!mvs.length) { this.state.thinking = false; return; }

        let move;
        if (this.role === "winner") {
            // Eng yaxshi harakat
            let bestS = -Infinity;
            for (const m of mvs) {
                let s = minimax(apply(this.state.board, m), CFG.maxDepth, -Infinity, Infinity, false, this.state.myP);
                if (s > bestS) { bestS = s; move = m; }
            }
        } else {
            // Sacrifice (Winnerga tosh berish)
            move = mvs.find(m => {
                const nb = apply(this.state.board, m);
                const oppP = this.state.myP === 1 ? 2 : 1;
                return allMvs(nb, oppP).some(om => om._mid);
            }) || mvs[0];
        }

        if (move) {
            this.socket.emit("game/make_move", {
                game_code: this.state.gameCode,
                ...move
            });
            this.log(`Moved: (${move.from_row},${move.from_col}) to (${move.to_row},${move.to_col})`);
        }
        this.state.thinking = false;
    }
}

// --- START ---
const winnerBot = new CheckerBot(CFG.winnerCookie, "WINNER", "winner");
const loserBot  = new CheckerBot(CFG.loserCookie,  "LOSER",  "loser");
global.loserBot = loserBot; // Global ruxsat

winnerBot.connect();
setTimeout(() => loserBot.connect(), 3000);

const app = express();
app.get("/", (req, res) => res.send("Farming Bot is running..."));
app.listen(process.env.PORT || 3000);