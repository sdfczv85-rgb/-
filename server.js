
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const players = {};
const worldFile = path.join(__dirname, "world.json");

let blocks = [];

try {
  if (fs.existsSync(worldFile)) {
    blocks = JSON.parse(fs.readFileSync(worldFile, "utf8"));
    if (!Array.isArray(blocks)) blocks = [];
  }
} catch (error) {
  console.error("월드 불러오기 실패:", error);
}

function saveWorld() {
  try {
    fs.writeFileSync(worldFile, JSON.stringify(blocks));
    return true;
  } catch (error) {
    console.error("월드 저장 실패:", error);
    return false;
  }
}

function cleanName(name) {
  return String(name || "플레이어")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 16) || "플레이어";
}

function limited(socket, action, delay = 200) {
  const now = Date.now();
  socket.cooldowns ??= {};

  if (now - (socket.cooldowns[action] || 0) < delay) {
    return false;
  }

  socket.cooldowns[action] = now;
  return true;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({
    online: true,
    players: Object.keys(players).length
  });
});

io.on("connection", socket => {
  const player = {
    id: socket.id,
    name: "플레이어",
    x: 0,
    y: 0,
    z: 0,
    health: 100,
    color: "#" + Math.floor(Math.random() * 16777215)
      .toString(16).padStart(6, "0")
  };

  players[socket.id] = player;

  socket.emit("world:init", {
    id: socket.id,
    players: Object.values(players),
    blocks
  });

  socket.broadcast.emit("player:join", player);

  socket.on("player:name", name => {
    player.name = cleanName(name);
    io.emit("player:update", player);
  });

  socket.on("players:request", () => {
    socket.emit("players:list", Object.values(players));
  });

  socket.on("player:move", pos => {
    if (!pos || !limited(socket, "move", 35)) return;

    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);

    if (![x, y, z].every(Number.isFinite)) return;

    player.x = Math.max(-48, Math.min(48, x));
    player.y = Math.max(0, Math.min(40, y));
    player.z = Math.max(-48, Math.min(48, z));

    socket.broadcast.emit("player:move", {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z
    });
  });

  socket.on("block:place", data => {
    if (!data || !limited(socket, "place", 100)) return;
    if (blocks.length >= 700) return;

    const x = Math.round(Number(data.x));
    const y = Math.round(Number(data.y));
    const z = Math.round(Number(data.z));
    const color = String(data.color || "#42a5f5");

    if (![x, y, z].every(Number.isFinite)) return;
    if (Math.abs(x) > 48 || Math.abs(z) > 48) return;
    if (y < 0 || y > 24) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;

    const block = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2),
      x, y, z, color
    };

    blocks.push(block);
    saveWorld();
    io.emit("block:placed", block);
  });

  socket.on("block:remove", id => {
    if (!limited(socket, "remove", 100)) return;

    const index = blocks.findIndex(block => block.id === id);
    if (index < 0) return;

    blocks.splice(index, 1);
    saveWorld();
    io.emit("block:removed", id);
  });

  socket.on("world:save", () => {
    socket.emit(saveWorld() ? "world:saved" : "world:saveError");
  });

  socket.on("chat:send", text => {
    if (!limited(socket, "chat", 250)) return;

    const message = String(text || "")
      .replace(/[<>]/g, "")
      .trim()
      .slice(0, 160);

    if (message) {
      io.emit("chat:message", {
        name: player.name,
        text: message
      });
    }
  });

  socket.on("pvp:attack", data => {
    if (!limited(socket, "attack", 500)) return;

    const weapons = {
      wood:   { damage: 10, range: 4 },
      sword:  { damage: 22, range: 4.5 },
      laser:  { damage: 16, range: 12 },
      hammer: { damage: 30, range: 4.5 }
    };

    const weapon = weapons[data?.weapon] ? data.weapon : "wood";
    const settings = weapons[weapon];

    let target = null;
    let nearest = settings.range;

    for (const other of Object.values(players)) {
      if (other.id === player.id || other.health <= 0) continue;

      const distance = Math.hypot(
        player.x - other.x,
        player.z - other.z
      );

      if (distance < nearest) {
        nearest = distance;
        target = other;
      }
    }

    if (!target) {
      socket.emit("pvp:miss");
      return;
    }

    target.health = Math.max(0, target.health - settings.damage);

    io.emit("pvp:health", {
      id: target.id,
      health: target.health
    });

    io.emit("pvp:hit", {
      attacker: player.id,
      attackerName: player.name,
      target: target.id,
      name: target.name,
      damage: settings.damage,
      weapon
    });

    if (target.health <= 0) {
      setTimeout(() => {
        if (!players[target.id]) return;

        target.health = 100;

        io.emit("pvp:health", {
          id: target.id,
          health: 100
        });

        io.to(target.id).emit("pvp:respawned");
      }, 2500);
    }
  });

  socket.on("pvp:respawn", () => {
    player.health = 100;

    io.emit("pvp:health", {
      id: player.id,
      health: 100
    });
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("player:leave", socket.id);
    io.emit("players:list", Object.values(players));
  });
});

server.listen(PORT, () => {
  console.log("BlockWorld Mega 실행 중: " + PORT);
});
