const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const players = {};
const worldFile = path.join(__dirname, "world.json");
let blocks = [];
try { if (fs.existsSync(worldFile)) { const saved = JSON.parse(fs.readFileSync(worldFile, "utf8")); if (Array.isArray(saved)) blocks = saved.slice(0, 500); } } catch (e) { console.error("월드 저장 파일을 읽지 못했습니다:", e.message); }
const MAX_BLOCKS = 500;
const attackCooldown = new Map();
function saveWorld() { try { fs.writeFileSync(worldFile, JSON.stringify(blocks, null, 2), "utf8"); return true; } catch (e) { console.error("월드 저장 실패:", e.message); return false; } }

app.use(express.static("public"));

function safeName(value) {
  return String(value || "플레이어")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 16) || "플레이어";
}

io.on("connection", (socket) => {
  players[socket.id] = {
    id: socket.id,
    name: "플레이어",
    x: Math.random() * 6 - 3,
    y: 1,
    z: Math.random() * 6 - 3,
    health: 100,
    color: ["#ff6b6b", "#ffd166", "#06d6a0", "#4dabf7", "#c77dff"][Math.floor(Math.random() * 5)]
  };

  socket.emit("world:init", {
    id: socket.id,
    players: Object.values(players),
    blocks
  });
  socket.broadcast.emit("player:join", players[socket.id]);
  socket.on("players:request", () => socket.emit("players:list", Object.values(players)));

  socket.on("player:name", (name) => {
    if (!players[socket.id]) return;
    players[socket.id].name = safeName(name);
    io.emit("player:update", players[socket.id]);
  });

  // 클라이언트가 보내는 위치를 제한해 잘못된 값이 서버 상태를 망치지 않게 함.
  socket.on("player:move", (pos) => {
    const p = players[socket.id];
    if (!p || !pos) return;
    const x = Number(pos.x), z = Number(pos.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    p.x = Math.max(-48, Math.min(48, x));
    p.z = Math.max(-48, Math.min(48, z));
    p.y = Number.isFinite(Number(pos.y)) ? Math.max(0, Math.min(30, Number(pos.y))) : 1;
    socket.broadcast.emit("player:move", { id: socket.id, x: p.x, y: p.y, z: p.z });
  });

  socket.on("block:place", (data) => {
    if (!data || blocks.length >= MAX_BLOCKS) return;
    const x = Math.round(Number(data.x));
    const y = Math.round(Number(data.y));
    const z = Math.round(Number(data.z));
    const color = String(data.color || "#42a5f5");
    if (![x, y, z].every(Number.isFinite)) return;
    if (Math.abs(x) > 48 || y < 0 || y > 20 || Math.abs(z) > 48) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    const block = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, x, y, z, color };
    blocks.push(block);
    saveWorld();
    io.emit("block:placed", block);
  });

  socket.on("block:remove", (id) => {
    const index = blocks.findIndex((b) => b.id === id);
    if (index < 0) return;
    const [removed] = blocks.splice(index, 1);
    saveWorld();
    io.emit("block:removed", removed.id);
  });

  socket.on("world:save", () => { if (saveWorld()) socket.emit("world:saved"); else socket.emit("world:saveError"); });

  socket.on("pvp:attack", () => {
    const attacker = players[socket.id];
    if (!attacker) return;
    const now = Date.now(), last = attackCooldown.get(socket.id) || 0;
    if (now - last < 650) return;
    attackCooldown.set(socket.id, now);
    let target = null, best = 3.5;
    for (const p of Object.values(players)) {
      if (p.id === attacker.id || p.health <= 0) continue;
      const dx = p.x - attacker.x, dz = p.z - attacker.z;
      const dist = Math.hypot(dx, dz);
      if (dist < best) { best = dist; target = p; }
    }
    if (!target) { socket.emit("pvp:hit", { attacker: socket.id, target: null, name: "아무도 없음" }); return; }
    target.health = Math.max(0, target.health - 25);
    io.emit("pvp:hit", { attacker: attacker.id, target: target.id, name: target.name, attackerName: attacker.name });
    io.emit("pvp:health", { id: target.id, name: target.name, health: target.health });
    if (target.health <= 0) setTimeout(() => { if (players[target.id]) { players[target.id].health = 100; io.emit("pvp:health", { id: target.id, name: target.name, health: 100 }); } }, 2500);
  });
  socket.on("pvp:respawn", () => { const p = players[socket.id]; if (p) { p.health = 100; io.emit("pvp:health", { id: p.id, name: p.name, health: 100 }); } });

  socket.on("chat:send", (message) => {
    const p = players[socket.id];
    if (!p) return;
    const text = String(message || "").trim().slice(0, 160);
    if (!text) return;
    io.emit("chat:message", {
      name: p.name,
      text: text.replace(/[<>]/g, "")
    });
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    attackCooldown.delete(socket.id);
    io.emit("player:leave", socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`BlockWorld Online 실행 중: http://localhost:${PORT}`);
});
