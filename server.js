const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const COLORS = ['#e53935', '#1e88e5', '#fdd835', '#8e24aa', '#fb8c00', '#43a047'];
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Bank soal sementara (fase 1). Jawaban benar disimpan di server, urutan opsi diacak.
const QUESTIONS = [
  { q: 'Planet terdekat dengan Matahari adalah?', opts: ['Merkurius', 'Venus', 'Bumi', 'Mars'], a: 0 },
  { q: 'Ibu kota Indonesia adalah?', opts: ['Jakarta', 'Bandung', 'Surabaya', 'Medan'], a: 0 },
  { q: 'Bagian tumbuhan yang menyerap air adalah?', opts: ['Akar', 'Daun', 'Bunga', 'Buah'], a: 0 },
  { q: 'Lambang kimia air adalah?', opts: ['H2O', 'CO2', 'O2', 'NaCl'], a: 0 },
  { q: 'Sila ke-1 Pancasila berbunyi?', opts: ['Ketuhanan Yang Maha Esa', 'Persatuan Indonesia', 'Kemanusiaan yang adil dan beradab', 'Keadilan sosial'], a: 0 },
  { q: 'Bilangan prima terkecil adalah?', opts: ['2', '1', '3', '0'], a: 0 },
  { q: 'Satuan gaya dalam SI adalah?', opts: ['Newton', 'Joule', 'Watt', 'Pascal'], a: 0 },
  { q: 'Past tense dari go adalah?', opts: ['went', 'goed', 'gone', 'going'], a: 0 },
  { q: 'Mata uang Indonesia adalah?', opts: ['Rupiah', 'Ringgit', 'Yen', 'Dolar'], a: 0 },
  { q: 'Organ tubuh yang memompa darah adalah?', opts: ['Jantung', 'Paru-paru', 'Lambung', 'Ginjal'], a: 0 },
  { q: 'Benua tempat Indonesia berada adalah?', opts: ['Asia', 'Afrika', 'Eropa', 'Amerika'], a: 0 },
  { q: 'Proklamasi kemerdekaan Indonesia terjadi pada tahun?', opts: ['1945', '1950', '1942', '1948'], a: 0 }
];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

const rid = () => Math.random().toString(36).slice(2, 10);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CHARS[rnd(0, CHARS.length - 1)];
  } while (rooms.has(code));
  return code;
}

// Tangga (L) naik dan Creeper (S) turun, dibuat acak per room
function makeMap() {
  const used = new Set([1, 100]);
  const L = {};
  const S = {};
  const add = (obj, up) => {
    for (let t = 0; t < 300; t++) {
      const a = rnd(2, 98);
      const d = rnd(10, 45);
      const b = up ? a + d : a - d;
      if (b < 2 || b > 99 || used.has(a) || used.has(b)) continue;
      if (Math.floor((a - 1) / 10) === Math.floor((b - 1) / 10)) continue;
      used.add(a);
      used.add(b);
      obj[a] = b;
      return;
    }
  };
  for (let i = 0; i < 8; i++) {
    add(L, true);
    add(S, false);
  }
  return { L, S };
}

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};
const fail = (ws, text) => send(ws, { type: 'error', text });

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 60) room.log.shift();
}

// Setiap pemain hanya menerima state room, plus id dirinya sendiri (you)
function snapshot(room, pid) {
  return {
    type: 'state',
    you: pid,
    room: {
      code: room.code,
      host: room.host,
      phase: room.phase,
      turn: room.turn,
      winner: room.winner,
      map: room.map,
      quiz: room.quiz ? { pid: room.quiz.pid, q: room.quiz.q, opts: room.quiz.opts } : null,
      players: room.players.map((p) => ({ pid: p.pid, name: p.name, color: p.color, pos: p.pos })),
      log: room.log.slice(-25)
    }
  };
}

function broadcast(room) {
  room.players.forEach((p) => send(p.ws, snapshot(room, p.pid)));
}

function settle(room, p) {
  const { L, S } = room.map;
  if (L[p.pos]) {
    addLog(room, `🪜 ${p.name} naik tangga ke ${L[p.pos]}!`);
    p.pos = L[p.pos];
  } else if (S[p.pos]) {
    addLog(room, `💥 ${p.name} kena Creeper, turun ke ${S[p.pos]}!`);
    p.pos = S[p.pos];
  }
}

function checkWin(room, p) {
  if (p.pos === 100) {
    room.phase = 'over';
    room.winner = p.name;
    addLog(room, `🏆 ${p.name} MENANG!`);
    return true;
  }
  return false;
}

function askQuiz(room) {
  const base = QUESTIONS[rnd(0, QUESTIONS.length - 1)];
  const order = shuffle([0, 1, 2, 3].slice(0, base.opts.length));
  const pl = room.players[room.quizIdx];
  room.quiz = {
    pid: pl.pid,
    q: base.q,
    opts: order.map((i) => base.opts[i]),
    correct: order.indexOf(base.a)
  };
}

function startQuiz(room) {
  room.phase = 'quiz';
  room.quizIdx = 0;
  addLog(room, '📚 Kuis dimulai!');
  askQuiz(room);
}

function nextQuiz(room) {
  room.quizIdx++;
  if (room.quizIdx < room.players.length) {
    askQuiz(room);
  } else {
    room.quiz = null;
    room.phase = 'play';
    room.turn = 0;
    addLog(room, '🎲 Giliran bermain lagi!');
  }
}

function advanceTurn(room) {
  room.turn = (room.turn + 1) % room.players.length;
  if (room.turn === 0) startQuiz(room);
}

function doRoll(room, p) {
  if (room.phase !== 'play') return fail(p.ws, 'Belum waktunya mengocok dadu');
  if (room.players[room.turn].pid !== p.pid) return fail(p.ws, 'Bukan giliranmu');

  const d = rnd(1, 6);
  if (p.pos + d > 100) {
    addLog(room, `🎲 ${p.name} dapat ${d}, kelebihan dari 100. Tidak bergerak.`);
  } else {
    p.pos += d;
    addLog(room, `🎲 ${p.name} dapat ${d}, maju ke kotak ${p.pos}`);
    settle(room, p);
    if (checkWin(room, p)) return broadcast(room);
  }

  if (d === 6) {
    addLog(room, `🎲 ${p.name} dapat 6, kocok lagi!`);
    return broadcast(room);
  }
  advanceTurn(room);
  broadcast(room);
}

function doAnswer(room, p, choice) {
  if (room.phase !== 'quiz' || !room.quiz || room.quiz.pid !== p.pid) {
    return fail(p.ws, 'Bukan giliranmu menjawab');
  }
  if (room.quiz.correct === choice) {
    if (p.pos + 3 > 100) {
      addLog(room, `✅ ${p.name} benar, tapi kelebihan dari 100.`);
    } else {
      p.pos += 3;
      addLog(room, `✅ ${p.name} benar, maju 3 kotak!`);
      settle(room, p);
      if (checkWin(room, p)) return broadcast(room);
    }
  } else {
    p.pos = Math.max(0, p.pos - 2);
    addLog(room, `❌ ${p.name} salah, mundur 2 kotak.`);
  }
  nextQuiz(room);
  broadcast(room);
}

function join(room, ws, name) {
  const p = { pid: ws.pid, ws, name, color: COLORS[room.players.length % COLORS.length], pos: 0 };
  room.players.push(p);
  ws.room = room;
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  const idx = room.players.findIndex((p) => p.pid === ws.pid);
  if (idx < 0) return;
  const gone = room.players[idx];
  room.players.splice(idx, 1);
  ws.room = null;

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.host === gone.pid) room.host = room.players[0].pid;
  addLog(room, `🚪 ${gone.name} keluar`);

  if (room.phase === 'play' && room.turn >= room.players.length) room.turn = 0;
  if (room.phase === 'quiz') {
    if (idx < room.quizIdx) room.quizIdx--;
    if (room.quiz && room.quiz.pid === gone.pid) {
      if (room.quizIdx < room.players.length) askQuiz(room);
      else {
        room.quiz = null;
        room.phase = 'play';
        room.turn = 0;
      }
    }
  }
  broadcast(room);
}

wss.on('connection', (ws) => {
  ws.pid = rid();
  ws.room = null;
  send(ws, { type: 'hello', you: ws.pid });

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      return;
    }
    const name = String(m.name || '').trim().slice(0, 12) || 'Pemain';

    if (m.type === 'create') {
      if (ws.room) return fail(ws, 'Kamu sudah berada di room');
      const code = makeCode();
      const room = {
        code,
        host: ws.pid,
        players: [],
        phase: 'lobby',
        turn: 0,
        map: null,
        quiz: null,
        quizIdx: 0,
        winner: null,
        log: []
      };
      rooms.set(code, room);
      join(room, ws, name);
      addLog(room, `🏠 Room ${code} dibuat oleh ${name}`);
      return broadcast(room);
    }

    if (m.type === 'join') {
      if (ws.room) return fail(ws, 'Kamu sudah berada di room');
      const room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room) return fail(ws, 'Kode room tidak ditemukan');
      if (room.phase !== 'lobby') return fail(ws, 'Game di room ini sudah berjalan');
      if (room.players.length >= MAX_PLAYERS) return fail(ws, 'Room sudah penuh');
      join(room, ws, name);
      addLog(room, `👋 ${name} bergabung`);
      return broadcast(room);
    }

    const room = ws.room;
    if (!room) return fail(ws, 'Kamu belum masuk room');
    const p = room.players.find((x) => x.pid === ws.pid);
    if (!p) return;

    if (m.type === 'start') {
      if (room.host !== ws.pid) return fail(ws, 'Hanya host yang bisa memulai');
      if (room.phase !== 'lobby') return;
      room.map = makeMap();
      room.phase = 'play';
      room.turn = 0;
      addLog(room, '🎮 Game dimulai!');
      return broadcast(room);
    }
    if (m.type === 'roll') return doRoll(room, p);
    if (m.type === 'answer') return doAnswer(room, p, Number(m.choice));
  });

  ws.on('close', () => leave(ws));
});

server.listen(PORT, () => {
  console.log(`Ular Tangga Online berjalan di port ${PORT}`);
});
