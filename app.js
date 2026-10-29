(() => {
  "use strict";

  const CFG = window.APP_CONFIG;
  const GOAL = CFG.route.totalKm;
  const FIREBASE_VERSION = "10.12.2";

  const TYPES = {
    run:   { label: "RUN",   icon: "🏃", verb: "ran" },
    cycle: { label: "CYCLE", icon: "🚴", verb: "cycled" },
    swim:  { label: "SWIM",  icon: "🏊", verb: "swam" },
    golf:  { label: "GOLF WIN", icon: "⛳", verb: "won at Golf with Friends", flat: true },
  };

  const TITLES = [
    [1, "NOOB"], [5, "ROOKIE"], [10, "GRINDER"], [20, "VETERAN"],
    [35, "ELITE"], [50, "LEGEND"], [70, "MYTHIC"], [100, "DEMIGOD"],
  ];

  const BADGES = [
    { id: "first",  label: "FIRST BLOOD", tip: "Logged a first activity",      test: s => s.acts.length > 0 },
    { id: "tri",    label: "TRIATHLETE",  tip: "Done all three classes",       test: s => s.raw.run > 0 && s.raw.cycle > 0 && s.raw.swim > 0 },
    { id: "mara",   label: "MARATHONER",  tip: "Single run of 42.2 km+",       test: s => s.acts.some(a => a.type === "run" && a.km >= 42.195) },
    { id: "cent",   label: "CENTURION",   tip: "Single ride of 100 km+",       test: s => s.acts.some(a => a.type === "cycle" && a.km >= 100) },
    { id: "fish",   label: "AQUAMAN",     tip: "10 km swum in total",          test: s => s.raw.swim >= 10 },
    { id: "scot",   label: "OVER THE WALL", tip: "Reached Scotland",           test: s => s.pts >= 820 },
    { id: "lap",    label: "NEW GAME+",   tip: "Finished the whole route",     test: s => s.pts >= GOAL },
    { id: "bet",    label: "HUSTLER",     tip: "Won a challenge",              test: s => s.betWins > 0 },
    { id: "roll",   label: "HIGH ROLLER", tip: "Staked 10 km+ on a challenge", test: s => s.bigBet },
    { id: "golf",   label: "CLUBHOUSE",   tip: "Won 5 games of Golf with Friends", test: s => s.raw.golf >= 5 },
  ];

  // No stake cap: losses can push a total below zero, and that's debt.

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const mult = t => CFG.multipliers[t] ?? 1;
  // golf is a flat bonus per win (stored as km: 1); everything else is distance x multiplier
  const GOLF_WIN = CFG.golfWin ?? 1;
  const points = a => TYPES[a.type]?.flat ? GOLF_WIN : a.km * mult(a.type);
  const rate = t => TYPES[t].flat ? GOLF_WIN : mult(t);
  const typeRate = t => TYPES[t].flat ? `+${GOLF_WIN} KM` : `×${mult(t)}`;
  // A bet's stake is in real km of its exercise (or wins, for golf), scaled like an activity.
  // Bets from before exercise types were added have no type and count at face value.
  const betValue = c => c.stake * (TYPES[c.type] ? rate(c.type) : 1);
  const stakeText = c => TYPES[c.type]
    ? `${TYPES[c.type].flat ? `${c.stake} WIN${c.stake === 1 ? "" : "S"}` : fmt(c.stake)} ${TYPES[c.type].icon}`
    : fmt(c.stake);
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const safeImg = src => typeof src === "string" && src.startsWith("data:image/") ? src : null;

  const state = {
    view: ["home", "side", "map"].includes(ls.get("gbg-view")) ? ls.get("gbg-view") : "home",
    tab: ["log", "bets", "feed"].includes(ls.get("gbg-tab")) ? ls.get("gbg-tab") : "log",
    players: {},      // overrides from store
    teams: {},
    activities: [],
    challenges: [],
    members: {},      // uid -> { playerId }
    claims: {},       // playerId -> { uid }
    user: null,       // signed-in Google account
    ready: false,
    claimDismissed: false,
    follow: ls.get("gbg-follow", null), // whose player the map camera follows
    pbType: ls.get("gbg-pb", "run"),    // which sport the PB board shows
    feedLimit: 30,                      // how many feed items to show ("SHOW MORE" adds more)
    timeEdit: null,                     // { id, value } while someone is adding a time to an old activity
    store: null,
  };

  // ---------- access (RBAC) ----------
  // viewer: anyone (read-only) · player: signed in and owns one player slot · admin: uid listed in config.admins.
  // Local mode has no accounts, so everyone gets admin. The UI only hides what you can't do;
  // firestore.rules is what actually enforces it.
  const access = {
    get local() { return state.store?.mode === "local"; },
    get admin() { return this.local || (!!state.user && (CFG.admins || []).includes(state.user.uid)); },
    get me() { return (state.user && state.members[state.user.uid]?.playerId) || null; },
    get member() { return this.local || !!this.me; },
    owns(playerId) { return this.admin || this.me === playerId; },
  };

  // ---------- personal bests ----------
  // "31", "30:12" or "1:02:45" -> seconds (a bare number is minutes); null if it doesn't parse
  function parseTime(str) {
    const s = String(str || "").trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60) || null;
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!m || +m[3] > 59 || (m[1] && +m[2] > 59)) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) || null;
  }
  const fmtTime = secs => {
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = Math.round(secs % 60);
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const milestoneFor = (type, km) => (CFG.milestones?.[type] || []).find(m => km >= m.km * 0.98 && km <= m.km * 1.05);

  // best time per player per milestone: { [playerId]: { [label]: { secs, date } } }
  function personalBests(type) {
    const best = {};
    state.activities.forEach(a => {
      if (a.type !== type || !(a.secs > 0)) return;
      const m = milestoneFor(type, a.km);
      if (!m) return;
      const mine = best[a.playerId] = best[a.playerId] || {};
      if (!mine[m.label] || a.secs < mine[m.label].secs) mine[m.label] = { secs: a.secs, date: a.date };
    });
    return best;
  }

  const fmt = (km, dp = 1) => `${km.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })} KM`;

  // ---------- stores ----------
  function localStore() {
    const KEY = "gbg-data-v1";
    const data = ls.get(KEY, { players: {}, activities: [] });
    data.teams = data.teams || {};
    data.challenges = data.challenges || [];
    const listeners = [];
    const snap = () => ({ players: data.players, teams: data.teams, activities: [...data.activities], challenges: [...data.challenges] });
    const emit = () => { ls.set(KEY, data); listeners.forEach(f => f(snap())); };
    return {
      mode: "local",
      subscribe(f) { listeners.push(f); f(snap()); },
      onAuth(f) { f(null); },
      async savePlayer(id, p) { data.players[id] = { ...data.players[id], ...p }; emit(); },
      async saveTeam(id, t) { data.teams[id] = { ...data.teams[id], ...t }; emit(); },
      async addActivity(a) { data.activities.push({ ...a, id: uid() }); emit(); },
      async deleteActivity(id) { data.activities = data.activities.filter(a => a.id !== id); emit(); },
      async setActivityTime(id, secs) {
        data.activities = data.activities.map(a => {
          if (a.id !== id) return a;
          const { secs: _, ...rest } = a;
          return secs ? { ...rest, secs } : rest;
        });
        emit();
      },
      async addChallenge(c) { data.challenges.push({ ...c, id: uid() }); emit(); },
      async updateChallenge(id, f) { data.challenges = data.challenges.map(c => c.id === id ? { ...c, ...f } : c); emit(); },
      async deleteChallenge(id) { data.challenges = data.challenges.filter(c => c.id !== id); emit(); },
    };
  }

  async function firebaseStore(conf) {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const { initializeApp } = await import(`${base}/firebase-app.js`);
    const fs = await import(`${base}/firebase-firestore.js`);
    const fa = await import(`${base}/firebase-auth.js`);
    const app = initializeApp(conf);
    const db = fs.getFirestore(app);
    const auth = fa.getAuth(app);

    let players = {}, teams = {}, activities = [], challenges = [], members = {}, claims = {};
    const ready = { p: false, t: false, a: false, c: false, m: false, k: false };
    const listeners = [];
    const emit = () => {
      if (Object.values(ready).every(Boolean)) listeners.forEach(f => f({ players, teams, activities, challenges, members, claims }));
    };
    const onErr = e => { console.error(e); toast("SYNC ERROR — CHECK FIRESTORE RULES", "bad"); setMode("ERROR", "bad"); };

    fs.onSnapshot(fs.collection(db, "players"), snap => {
      players = {}; snap.forEach(d => { players[d.id] = d.data(); }); ready.p = true; emit();
    }, onErr);
    fs.onSnapshot(fs.collection(db, "teams"), snap => {
      teams = {}; snap.forEach(d => { teams[d.id] = d.data(); }); ready.t = true; emit();
    }, onErr);
    fs.onSnapshot(fs.collection(db, "activities"), snap => {
      activities = snap.docs.map(d => ({ id: d.id, ...d.data() })); ready.a = true; emit();
    }, onErr);
    fs.onSnapshot(fs.collection(db, "challenges"), snap => {
      challenges = snap.docs.map(d => ({ id: d.id, ...d.data() })); ready.c = true; emit();
    }, onErr);
    fs.onSnapshot(fs.collection(db, "members"), snap => {
      members = {}; snap.forEach(d => { members[d.id] = d.data(); }); ready.m = true; emit();
    }, onErr);
    fs.onSnapshot(fs.collection(db, "claims"), snap => {
      claims = {}; snap.forEach(d => { claims[d.id] = d.data(); }); ready.k = true; emit();
    }, onErr);

    return {
      mode: "online",
      subscribe(f) { listeners.push(f); emit(); },
      onAuth: f => fa.onAuthStateChanged(auth, f),
      signIn: () => fa.signInWithPopup(auth, new fa.GoogleAuthProvider()),
      signOut: () => fa.signOut(auth),
      // the claim and the membership are written together so a slot can't end up half-taken
      claimPlayer(uid, playerId) {
        const b = fs.writeBatch(db);
        b.set(fs.doc(db, "claims", playerId), { uid });
        b.set(fs.doc(db, "members", uid), { playerId });
        return b.commit();
      },
      releasePlayer(playerId, uid) {
        const b = fs.writeBatch(db);
        b.delete(fs.doc(db, "claims", playerId));
        b.delete(fs.doc(db, "members", uid));
        return b.commit();
      },
      savePlayer: (id, p) => fs.setDoc(fs.doc(db, "players", id), p, { merge: true }),
      saveTeam: (id, t) => fs.setDoc(fs.doc(db, "teams", id), t, { merge: true }),
      addActivity: a => fs.addDoc(fs.collection(db, "activities"), a),
      deleteActivity: id => fs.deleteDoc(fs.doc(db, "activities", id)),
      setActivityTime: (id, secs) => fs.updateDoc(fs.doc(db, "activities", id), { secs: secs || fs.deleteField() }),
      addChallenge: c => fs.addDoc(fs.collection(db, "challenges"), c),
      updateChallenge: (id, f) => fs.updateDoc(fs.doc(db, "challenges", id), f),
      deleteChallenge: id => fs.deleteDoc(fs.doc(db, "challenges", id)),
    };
  }

  // ---------- derived data ----------
  function teamRoster() {
    return (CFG.teams || []).map(t => {
      const o = state.teams[t.id] || {};
      return { ...t, name: o.name || t.name, color: o.color || t.color };
    });
  }

  function roster() {
    const teams = Object.fromEntries(teamRoster().map(t => [t.id, t]));
    return CFG.players.map(p => {
      const o = state.players[p.id] || {};
      const team = teams[o.team] ? o.team : p.team;
      return { ...p, name: o.name || p.name, color: o.color || p.color, avatar: safeImg(o.avatar), team, teamInfo: teams[team] };
    });
  }

  // "completed" = the challenged player did it; "failed" = the bettor wins
  function betWinner(c) {
    return c.status === "completed" ? c.to : c.status === "failed" ? c.from : null;
  }

  function betResults(id) {
    let net = 0, wins = 0;
    state.challenges.forEach(c => {
      const winner = betWinner(c);
      if (!winner || (c.from !== id && c.to !== id)) return;
      if (winner === id) { net += betValue(c); wins++; } else net -= betValue(c);
    });
    return { net, wins };
  }

  function computeTeams(stats) {
    return teamRoster().map(t => {
      const members = stats.filter(s => s.team === t.id);
      return { ...t, members, pts: members.reduce((s, m) => s + m.pts, 0) };
    }).sort((a, b) => b.pts - a.pts);
  }

  const teamChip = t => t ? `<span class="teamchip" style="--t:${esc(t.color)}">${esc(t.name)}</span>` : "";

  function computeStats() {
    return roster().map(p => {
      const acts = state.activities.filter(a => a.playerId === p.id && TYPES[a.type]);
      const raw = Object.fromEntries(Object.keys(TYPES).map(t => [t, 0]));
      let pts = 0;
      acts.forEach(a => { raw[a.type] += a.km; pts += points(a); });
      const { net: bets, wins: betWins } = betResults(p.id);
      pts += bets;
      const progress = Math.max(0, pts); // debt keeps you parked at Land's End
      const bigBet = state.challenges.some(c => c.from === p.id && betValue(c) >= 10 && c.status !== "cancelled");
      const level = Math.floor(progress / CFG.kmPerLevel) + 1;
      const title = TITLES.filter(([l]) => level >= l).pop()[1];
      const pos = progress % GOAL;
      const next = CFG.route.checkpoints.find(c => c.km > pos);
      return {
        ...p, acts, raw, pts, bets, level, title,
        debt: pts < 0,
        xp: (progress % CFG.kmPerLevel) / CFG.kmPerLevel,
        lap: Math.floor(progress / GOAL) + 1,
        pos, next,
        badges: BADGES.filter(b => b.test({ acts, raw, pts, betWins, bigBet })),
      };
    }).sort((a, b) => b.pts - a.pts);
  }

  const passedCheckpoints = pts => {
    pts = Math.max(0, pts);
    const lap = Math.floor(pts / GOAL);
    return lap * CFG.route.checkpoints.length + CFG.route.checkpoints.filter(c => c.km <= pts % GOAL).length;
  };

  // ---------- rendering ----------
  function avatarHTML(p, cls = "") {
    const img = p.avatar
      ? `<img src="${p.avatar}" alt="">`
      : `<span>${esc((p.name || "?").trim().slice(0, 2).toUpperCase())}</span>`;
    return `<span class="avatar ${cls}" style="--c:${esc(p.color)}">${img}</span>`;
  }

  function renderBoard(stats) {
    const squad = stats.reduce((s, p) => s + p.pts, 0);
    $("#squadTotal").textContent = `SQUAD: ${fmt(squad, 0)}`;
    $("#board").innerHTML = stats.map((p, i) => {
      const raw = Object.keys(TYPES).filter(t => !TYPES[t].flat || p.raw[t]).map(t =>
        TYPES[t].flat
          ? `<span title="Golf with Friends wins">${TYPES[t].icon} ${p.raw[t]}W</span>`
          : `<span title="${TYPES[t].label} (raw)">${TYPES[t].icon} ${p.raw[t].toFixed(1)}</span>`).join("") +
        (p.bets ? `<span class="${p.bets > 0 ? "up" : "down"}" title="Challenge winnings">🎲 ${p.bets > 0 ? "+" : ""}${p.bets.toFixed(1)}</span>` : "");
      const nextTxt = p.debt
        ? `IN DEBT: run off ${fmt(-p.pts)} to get moving`
        : p.next ? `NEXT: ${esc(p.next.name)} in ${fmt(p.next.km - p.pos, 0)}` : "";
      return `
        <li class="entry ${p.pts > 0 ? `rank-${i + 1}` : ""}" style="--c:${esc(p.color)}">
          <div class="rank">${i + 1}</div>
          ${avatarHTML(p, "lg")}
          <div class="info">
            <div class="name">${esc(p.name)} ${teamChip(p.teamInfo)}<span class="lvl">LV ${p.level}</span><span class="ptitle">${p.title}</span>${p.lap > 1 ? `<span class="lapchip">LAP ${p.lap}</span>` : ""}${p.debt ? `<span class="debtchip">IN DEBT</span>` : ""}</div>
            <div class="xp" title="${Math.round(p.xp * 100)}% to LV ${p.level + 1}"><i style="width:${(p.xp * 100).toFixed(1)}%"></i></div>
            <div class="meta">${raw}<span class="next">${nextTxt}</span></div>
            ${p.badges.length ? `<div class="badges">${p.badges.map(b => `<span class="badge" title="${esc(b.tip)}">${b.label}</span>`).join("")}</div>` : ""}
          </div>
          <div class="score ${p.debt ? "neg" : ""}">${p.pts.toFixed(1)}<small>KM</small></div>
        </li>`;
    }).join("");
  }

  function renderTeams(teams) {
    const panel = $("#teamsPanel");
    panel.hidden = teams.length < 2;
    if (panel.hidden) return;
    const total = teams.reduce((s, t) => s + Math.max(0, t.pts), 0);
    const leading = teams[0].pts > teams[1].pts;
    // keep config order in the tug bar so it doesn't flip sides when the lead changes
    const ordered = [...teams].sort((a, b) => CFG.teams.findIndex(t => t.id === a.id) - CFG.teams.findIndex(t => t.id === b.id));
    const tug = ordered.map(t =>
      `<i style="--t:${esc(t.color)};flex-grow:${total ? Math.max(t.pts, total * 0.04) : 1}"></i>`).join("");
    const cards = ordered.map(t => {
      const lead = leading && t.id === teams[0].id;
      const progress = Math.max(0, t.pts);
      const pos = progress % GOAL, lap = Math.floor(progress / GOAL) + 1;
      const next = CFG.route.checkpoints.find(c => c.km > pos);
      return `
        <div class="team-card ${lead ? "lead" : ""}" style="--t:${esc(t.color)}">
          <div class="team-name">${lead ? "♛ " : ""}${esc(t.name)}</div>
          <div class="team-score">${t.pts.toFixed(1)}<small>KM</small></div>
          <div class="team-members">${t.members.map(m => avatarHTML(m, "sm")).join("") || `<span class="dim">NO PLAYERS</span>`}</div>
          <div class="team-prog"><i style="width:${(pos / GOAL * 100).toFixed(1)}%"></i></div>
          <div class="team-meta">${lap > 1 ? `LAP ${lap} · ` : ""}${next ? `NEXT: ${esc(next.name)} in ${fmt(next.km - pos, 0)}` : ""}</div>
        </div>`;
    });
    $("#teams").innerHTML = `<div class="tug">${tug}</div><div class="team-cards">${cards.join(`<div class="vs">VS</div>`)}</div>`;
  }

  // ---------- world map (side-scroller) ----------
  // Land's End is on the left, John o' Groats on the right. The camera follows one player
  // (you, or the leader for viewers) and you can drag, swipe or tap the mini-map to look around.
  // The sea west of Land's End is where anyone in debt sinks, deeper the more they owe.
  const MAP = {
    pxPerKm: 10,
    sea: 520,        // px of ocean before km 0
    tail: 420,       // px of land after the finish
    blk: 80,         // terrain block width
    ground: 92,      // base ground height
    step: 22,        // height of one terrain step
    surface: 80,     // sea level
    gemEvery: 20,    // km between gems
  };
  const mapX = km => MAP.sea + km * MAP.pxPerKm;
  const worldW = () => mapX(GOAL) + MAP.tail;
  const zoneAt = km => CFG.route.zones.findIndex(z => km >= z.fromKm && km < z.toKm);
  const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  // Rolling stepped hills, rising into the Highlands. Neighbouring blocks differ by one step at most.
  let terrain = null;
  function terrainLevels() {
    if (terrain) return terrain;
    const n = Math.ceil((worldW() - MAP.sea) / MAP.blk);
    terrain = [];
    for (let i = 0; i < n; i++) {
      const km = (i * MAP.blk) / MAP.pxPerKm;
      const scot = km >= 820 ? Math.min(2, (km - 820) / 120) : 0;
      let lv = Math.round(1.4 + 1.2 * Math.sin(km / 53) + 0.8 * Math.sin(km / 17 + 2) + scot + (scot ? Math.sin(km / 29) : 0));
      lv = Math.max(0, Math.min(6, lv));
      if (i < 2 || km > GOAL) lv = Math.min(lv, 1); // flat at the start line and the finish
      if (i) lv = Math.max(terrain[i - 1] - 1, Math.min(terrain[i - 1] + 1, lv));
      terrain.push(lv);
    }
    return terrain;
  }
  const groundAt = km => {
    const i = Math.floor((Math.max(0, km) * MAP.pxPerKm) / MAP.blk);
    const t = terrainLevels();
    return MAP.ground + MAP.step * t[Math.min(i, t.length - 1)];
  };

  function buildWorld() {
    const t = terrainLevels();
    let html = `
      <div class="sea" style="width:${MAP.sea}px;height:${MAP.surface}px">
        <span>THE ATLANTIC</span><i class="shark" aria-hidden="true" hidden>🦈</i>
      </div>`;
    t.forEach((lv, i) => {
      const left = MAP.sea + i * MAP.blk;
      const km = (i * MAP.blk) / MAP.pxPerKm;
      const z = Math.max(0, zoneAt(Math.min(km, GOAL - 0.01)));
      const h = MAP.ground + MAP.step * lv;
      html += `<div class="blk z${z}" style="left:${left}px;width:${MAP.blk}px;height:${h}px"></div>`;
      const r = hash(i);
      const deco = z === 0 ? (r < .22 ? "🌳" : r < .3 ? "🐑" : r < .34 ? "🏠" : "") : (r < .26 ? "🌲" : r < .32 ? "🦌" : r < .36 ? "🏰" : "");
      if (deco && i > 1 && km < GOAL - 10) html += `<span class="deco" style="left:${left + 10 + hash(i + 99) * 40}px;bottom:${h - 4}px">${deco}</span>`;
    });
    CFG.route.zones.forEach((z, i) => {
      if (i) html += `<div class="zgate" style="left:${mapX(z.fromKm) - 4}px;bottom:${groundAt(z.fromKm)}px"><span>${esc(z.name)}</span></div>`;
    });
    for (let km = MAP.gemEvery; km < GOAL; km += MAP.gemEvery) {
      html += `<i class="gem" data-km="${km}" style="left:${mapX(km) - 7}px;bottom:${groundAt(km) + 64}px"></i>`;
    }
    CFG.route.checkpoints.forEach((c, i, arr) => {
      const cls = i === 0 ? "start" : i === arr.length - 1 ? "finish" : "";
      html += `
        <div class="cp ${cls} ${i % 2 ? "alt" : ""}" data-km="${c.km}" style="left:${mapX(c.km)}px;bottom:${groundAt(c.km)}px">
          <i class="pole"></i><i class="flag"></i>
          <span class="sign">${esc(c.name)}<small>${fmt(c.km, 0)}</small></span>
        </div>`;
    });
    return `
      <div class="sky"></div><div class="para far"></div><div class="para mid"></div>
      <div class="vp" id="mapVp"><div class="world" style="width:${worldW()}px">${html}<div class="markers" id="markers"></div></div></div>
      <div class="hud"><div class="hud-me" id="hudMe"></div><div class="hud-zone" id="hudZone"></div><div class="hud-follow" id="hudFollow"></div></div>
      <div class="mini" id="mini" title="Jump along the route"><i class="mini-view" id="miniView"></i><div id="miniDots"></div></div>`;
  }

  const cam = { id: null, x: null, dragged: false };

  function followed(stats) {
    const id = state.follow && stats.some(p => p.id === state.follow) ? state.follow : access.me || stats[0]?.id;
    return stats.find(p => p.id === id);
  }

  function centerOn(x, smooth) {
    const vp = $("#mapVp");
    if (!vp || !vp.clientWidth) return;
    vp.scrollTo({ left: Math.max(0, x - vp.clientWidth * 0.4), behavior: smooth ? "smooth" : "auto" });
  }

  function onMapScroll() {
    const vp = $("#mapVp");
    if (!vp) return;
    const track = $("#track");
    track.style.setProperty("--sx", vp.scrollLeft);
    const km = (vp.scrollLeft + vp.clientWidth / 2 - MAP.sea) / MAP.pxPerKm;
    const z = CFG.route.zones[zoneAt(km)];
    $("#hudZone").textContent = km < 0 ? "THE ATLANTIC" : z ? z.name : "THE END OF THE ROAD";
    const W = worldW();
    $("#miniView").style.cssText = `left:${(vp.scrollLeft / W) * 100}%;width:${(vp.clientWidth / W) * 100}%`;
  }

  function wireMap() {
    const vp = $("#mapVp");
    let raf = 0;
    vp.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; onMapScroll(); }); }, { passive: true });
    // mouse drag to pan (touch already scrolls natively)
    let drag = null;
    vp.addEventListener("pointerdown", e => {
      if (e.pointerType !== "mouse") return;
      drag = { x: e.clientX, left: vp.scrollLeft };
      cam.dragged = false;
    });
    window.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 4) { cam.dragged = true; vp.classList.add("dragging"); }
      vp.scrollLeft = drag.left - dx;
    });
    window.addEventListener("pointerup", () => { drag = null; vp.classList.remove("dragging"); });
    vp.addEventListener("click", e => {
      const m = e.target.closest("[data-mk]");
      if (m && !cam.dragged) setFollow(m.dataset.mk);
    });
    $("#hudFollow").addEventListener("click", e => {
      const b = e.target.closest("[data-follow]");
      if (b) setFollow(b.dataset.follow);
    });
    $("#mini").addEventListener("click", e => {
      const r = $("#mini").getBoundingClientRect();
      vp.scrollTo({ left: ((e.clientX - r.left) / r.width) * worldW() - vp.clientWidth / 2, behavior: "smooth" });
    });
    window.addEventListener("resize", () => { if (cam.x !== null) centerOn(cam.x, false); });
  }

  function setFollow(id) {
    state.follow = id;
    ls.set("gbg-follow", id);
    cam.id = null; // force the camera to fly over
    renderTrack(computeStats());
  }

  function renderTrack(stats, { recenter = false } = {}) {
    const track = $("#track");
    if (!$("#mapVp")) { track.innerHTML = buildWorld(); wireMap(); }

    const debtors = stats.filter(p => p.debt);
    const deepest = Math.max(10, ...debtors.map(p => -p.pts));
    const far = Math.max(0, ...stats.map(p => p.pos));
    const me = followed(stats);
    $(".shark", track).hidden = !debtors.length;
    track.querySelectorAll(".gem").forEach(g => g.classList.toggle("got", +g.dataset.km <= far));
    track.querySelectorAll(".cp").forEach(c => c.classList.toggle("reached", !!me && !me.debt && +c.dataset.km <= me.pos));

    // where everyone stands; players at the same spot stand on each other's heads
    const spots = stats.map(p => {
      if (p.debt) {
        const i = debtors.indexOf(p);
        return { p, x: MAP.sea - 90 - i * 80, y: MAP.surface - 34 - (-p.pts / deepest) * (MAP.surface - 46) };
      }
      return { p, x: mapX(p.pos), y: groundAt(p.pos) };
    }).sort((a, b) => a.x - b.x);
    let base = null, stack = 0;
    spots.forEach(s => {
      if (!s.p.debt && base && s.x - base.x < 40) { stack++; s.x = base.x; s.y = base.y + stack * 56; }
      else { base = s; stack = 0; }
    });

    const layer = $("#markers");
    const seen = new Set();
    spots.forEach(({ p, x, y }) => {
      seen.add(p.id);
      let el = layer.querySelector(`[data-mk="${p.id}"]`);
      if (!el) { el = document.createElement("div"); el.dataset.mk = p.id; layer.appendChild(el); }
      const moved = el.dataset.x && +el.dataset.x !== x;
      el.dataset.x = x;
      el.className = `marker ${p.debt ? "sunk" : ""} ${me && p.id === me.id ? "me" : ""} ${moved ? "walk" : ""}`;
      el.style.cssText = `left:${x}px;bottom:${y}px;--c:${p.color};--t:${p.teamInfo?.color || p.color}`;
      el.title = `${p.name}${p.teamInfo ? ` (${p.teamInfo.name})` : ""}: ${fmt(p.pts)}${p.debt ? " (IN DEBT)" : ""}`;
      el.innerHTML = `
        <span class="mk-name">${p.debt ? p.pts.toFixed(1) : esc(p.name)}</span>
        ${avatarHTML(p)}
        ${p.lap > 1 ? `<span class="lap">L${p.lap}</span>` : ""}`;
      if (moved) setTimeout(() => el.classList.remove("walk"), 1300);
    });
    layer.querySelectorAll("[data-mk]").forEach(el => { if (!seen.has(el.dataset.mk)) el.remove(); });

    // HUD
    if (me) {
      $("#hudMe").innerHTML = `${avatarHTML(me, "sm")}<div><b style="color:${esc(me.color)}">${esc(me.name)}</b> ${fmt(me.pts)}
        <small>${me.debt ? `IN THE SEA: ${fmt(-me.pts)} TO SWIM OFF` : me.next ? `NEXT: ${esc(me.next.name)} in ${fmt(me.next.km - me.pos, 0)}` : "AT THE FINISH"}</small></div>`;
    }
    $("#hudFollow").innerHTML = stats.map(p =>
      `<button type="button" data-follow="${esc(p.id)}" class="${me && p.id === me.id ? "on" : ""}" title="Follow ${esc(p.name)}">${avatarHTML(p, "sm")}</button>`).join("");
    const W = worldW();
    $("#miniDots").innerHTML =
      CFG.route.checkpoints.map(c => `<i class="mini-cp" style="left:${(mapX(c.km) / W) * 100}%"></i>`).join("") +
      spots.map(({ p, x }) => `<i class="mini-dot" style="left:${(x / W) * 100}%;--c:${esc(p.color)}"></i>`).join("");

    // camera: fly to the followed player when they move or the target changes
    const target = spots.find(s => me && s.p.id === me.id);
    if (target && (recenter || cam.id !== me.id || cam.x !== target.x)) {
      const smooth = cam.id !== null && !recenter;
      cam.id = me.id; cam.x = target.x;
      requestAnimationFrame(() => centerOn(target.x, smooth));
    }
    requestAnimationFrame(onMapScroll);
  }

  const localDate = ts => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const shortDate = iso => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  function renderFeed() {
    const players = Object.fromEntries(roster().map(p => [p.id, p]));
    const items = [
      ...state.activities
        .filter(a => players[a.playerId] && TYPES[a.type])
        .map(a => ({ kind: "act", date: a.date || "", ts: a.createdAt || 0, a })),
      ...state.challenges
        .filter(c => betWinner(c) && players[c.from] && players[c.to])
        .map(c => ({ kind: "bet", date: localDate(c.resolvedAt || c.createdAt || 0), ts: c.resolvedAt || 0, c })),
    ].sort((x, y) => y.date.localeCompare(x.date) || y.ts - x.ts);
    const more = items.length > state.feedLimit;
    items.length = Math.min(items.length, state.feedLimit);

    if (!items.length) {
      $("#feed").innerHTML = `<li class="empty">NO QUESTS YET. INSERT COIN.</li>`;
      return;
    }
    $("#feed").innerHTML = items.map(({ kind, a, c }) => {
      if (kind === "bet") {
        const w = players[betWinner(c)], l = players[betWinner(c) === c.to ? c.from : c.to];
        return `
        <li class="feed-item bet" style="--c:${esc(w.color)}">
          ${avatarHTML(w, "sm")}
          <div class="feed-body">
            <div>🎲 <b>${esc(w.name)}</b> won the bet vs <b style="color:${esc(l.color)}">${esc(l.name)}</b>
              <span class="gain">+${betValue(c).toFixed(1)}</span> <span class="loss">−${betValue(c).toFixed(1)}</span></div>
            <div class="feed-meta">${shortDate(localDate(c.resolvedAt || 0))} · “${esc(c.desc)}”${c.proof ? ` · ${esc(c.proof)}` : ""}</div>
          </div>
        </li>`;
      }
      const p = players[a.playerId];
      const d = new Date(a.date + "T00:00:00");
      // only the player themselves can time their own activity (golf wins have no time)
      const canTime = !TYPES[a.type].flat && (access.local || access.me === a.playerId);
      const editing = canTime && state.timeEdit?.id === a.id;
      return `
        <li class="feed-item" style="--c:${esc(p.color)}">
          ${avatarHTML(p, "sm")}
          <div class="feed-body">
            <div><b>${esc(p.name)}</b> ${TYPES[a.type].verb}${TYPES[a.type].flat ? "" : ` ${fmt(a.km)}`}${a.secs > 0 ? ` in <b class="time">${fmtTime(a.secs)}</b>` : ""} ${TYPES[a.type].icon}
              <span class="gain">+${points(a).toFixed(1)}</span></div>
            <div class="feed-meta">${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}${a.note ? ` · “${esc(a.note)}”` : ""}
              ${canTime && !editing ? `<button class="tbtn" type="button" data-time="${esc(a.id)}">${a.secs ? "EDIT TIME" : "+ ADD TIME"}</button>` : ""}</div>
            ${editing ? `
              <form class="time-edit" data-id="${esc(a.id)}">
                <input class="time-input" maxlength="9" placeholder="30:12" value="${esc(state.timeEdit.value)}" aria-label="Time">
                <button class="btn sm primary" type="submit">SAVE</button>
                <button class="btn sm ghost" type="button" data-time-cancel>CANCEL</button>
              </form>` : ""}
          </div>
          ${access.owns(a.playerId) ? `<button class="del" data-id="${esc(a.id)}" type="button" title="Delete">✕</button>` : ""}
        </li>`;
    }).join("") + (more ? `<li><button class="btn sm ghost more" type="button" data-more>SHOW MORE</button></li>` : "");
  }

  // Bet flow: pending -> active -> (claimed -> confirmed | disputed) -> completed / failed.
  // A player can settle straight away in their opponent's favour, but a win they claim for
  // themselves needs the other side to confirm. The admin referees bets they're not part of.
  const OPEN_BET = ["active", "claimed", "disputed"];

  // the bettor can reword or withdraw a bet until it's accepted; the admin can fix or remove any bet
  const canEditBet = c => access.admin || (access.me === c.from && c.status === "pending");

  function challengeCard(c, P) {
    const f = P[c.from], t = P[c.to];
    const stake = fmt(betValue(c));
    const overdue = c.deadline && c.deadline < today() && (c.status === "pending" || OPEN_BET.includes(c.status));
    const me = access.me, isTo = me === c.to, isFrom = me === c.from;
    const referee = access.admin && !isTo && !isFrom;
    const btn = (act, label, cls = "") => `<button type="button" class="btn sm ${cls}" data-act="${act}">${label}</button>`;
    const confirmBtn = (act, label, cls = "") => `<button type="button" class="btn sm ${cls}" data-act="${act}" data-confirm>${label}</button>`;
    const proof = `<input class="ch-proof" maxlength="60" placeholder="Proof / time (optional)">`;
    const refereeBtns = proof + confirmBtn("completed", `✔ ${esc(t.name)} DID IT`, "win") +
      confirmBtn("failed", "✖ FAILED", "lose") + confirmBtn("cancel", "VOID", "ghost");
    let status = "", actions = "", note = "";
    if (c.status === "pending") {
      status = `AWAITING ${esc(t.name)}`;
      if (isTo || referee) actions += btn("accept", "ACCEPT", "primary") + confirmBtn("decline", "DECLINE");
    } else if (c.status === "active") {
      status = overdue ? "OVERDUE" : "● LIVE";
      if (isTo) actions = proof + confirmBtn("claim", "✔ I DID IT", "win") + confirmBtn("failed", "✖ I FAILED", "lose");
      else if (isFrom) actions = proof + confirmBtn("claim", "✖ THEY FAILED", "lose") + confirmBtn("completed", "✔ THEY DID IT", "win");
      else if (referee) actions = refereeBtns;
    } else if (c.status === "claimed") {
      const claimer = P[c.claimedBy], other = c.claimedBy === c.to ? f : t;
      status = "⏳ AWAITING CONFIRM";
      note = `${esc(claimer.name)} says ${esc(t.name)} ${c.claim === "completed" ? "DID IT" : "FAILED"}. Waiting for ${esc(other.name)} to confirm.`;
      if ((isTo || isFrom) && me !== c.claimedBy) actions = confirmBtn("confirm", "✔ CONFIRM", "win") + confirmBtn("dispute", "⚠ DISPUTE", "lose");
      else if (referee) actions = refereeBtns;
    } else if (c.status === "disputed") {
      status = "⚠ DISPUTED";
      note = "The admin will settle this one, or either side can back down.";
      if (isTo) actions = confirmBtn("failed", "✖ OK, I FAILED", "lose");
      else if (isFrom) actions = confirmBtn("completed", "✔ OK, THEY DID IT", "win");
      else if (referee) actions = refereeBtns;
    } else {
      const w = P[betWinner(c)];
      status = `${esc(w.name)} WON`;
    }
    if (canEditBet(c)) actions += btn("edit", "EDIT", "ghost") + confirmBtn("delete", "DELETE", "ghost");
    const payout = betWinner(c) ? "" : `
      <div class="ch-payout">
        <span>DOES IT: <b style="color:${esc(t.color)}">${esc(t.name)} +${stake}</b> · ${esc(f.name)} −${stake}</span>
        <span>FAILS: <b style="color:${esc(f.color)}">${esc(f.name)} +${stake}</b> · ${esc(t.name)} −${stake}</span>
      </div>`;
    return `
      <div class="ch-card ch-${esc(c.status)} ${overdue ? "overdue" : ""}" data-id="${esc(c.id)}" style="--f:${esc(f.color)};--t:${esc(t.color)}">
        <div class="ch-head">
          ${avatarHTML(f, "sm")}<span class="ch-vs">VS</span>${avatarHTML(t, "sm")}
          <span class="ch-status">${status}</span>
          <span class="ch-stake">${stake}</span>
        </div>
        <p class="ch-text"><b style="color:${esc(f.color)}">${esc(f.name)}</b> bets ${stakeText(c)}${TYPES[c.type] && rate(c.type) !== 1 ? ` (${stake})` : ""} that
          <b style="color:${esc(t.color)}">${esc(t.name)}</b> can't <q>${esc(c.desc)}</q></p>
        ${c.deadline || c.proof ? `<div class="ch-meta">${c.deadline ? `⏱ BY ${shortDate(c.deadline)}` : ""}${c.proof ? ` · PROOF: ${esc(c.proof)}` : ""}</div>` : ""}
        ${note ? `<div class="ch-note">${note}</div>` : ""}
        ${payout}
        ${actions ? `<div class="ch-actions">${actions}</div>` : ""}
      </div>`;
  }

  function renderChallenges() {
    const P = Object.fromEntries(roster().map(p => [p.id, p]));
    const cs = state.challenges.filter(c => P[c.from] && P[c.to]);
    const newest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
    const live = cs.filter(c => OPEN_BET.includes(c.status)).sort(newest);
    const pending = cs.filter(c => c.status === "pending").sort(newest);
    const done = cs.filter(c => betWinner(c)).sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0)).slice(0, 4);
    const section = (title, list) => list.length ? `<h3 class="ch-group">${title} <span>${list.length}</span></h3>${list.map(c => challengeCard(c, P)).join("")}` : "";
    $("#chCount").textContent = live.length + pending.length ? `${live.length} LIVE · ${pending.length} PENDING` : "";
    document.querySelectorAll("[data-bets-badge]").forEach(b => {
      b.textContent = live.length + pending.length;
      b.hidden = !(live.length + pending.length);
    });
    $("#challenges").innerHTML =
      section("LIVE", live) + section("PENDING", pending) + section("RECENT RESULTS", done) ||
      `<p class="empty">NO BETS ON THE TABLE. CALL SOMEONE OUT.</p>`;
  }

  const PB_TYPES = Object.keys(TYPES).filter(t => CFG.milestones?.[t]?.length);
  function renderPBs() {
    if (!PB_TYPES.includes(state.pbType)) state.pbType = PB_TYPES[0];
    const type = state.pbType;
    if (!type) { $("#pbs").innerHTML = ""; return; }
    const players = roster();
    const best = personalBests(type);
    const rows = CFG.milestones[type].map(m => {
      const times = players.map(p => best[p.id]?.[m.label]);
      const top = Math.min(...times.filter(Boolean).map(t => t.secs));
      return `<tr><th>${esc(m.label)}</th>${times.map((t, i) => t
        ? `<td class="${t.secs === top ? "fastest" : ""}" style="--c:${esc(players[i].color)}" title="${esc(players[i].name)} · ${shortDate(t.date)}${t.secs === top ? " · FASTEST" : ""}">${fmtTime(t.secs)}</td>`
        : `<td class="none">—</td>`).join("")}</tr>`;
    }).join("");
    $("#pbs").innerHTML = `
      <div class="pb-head"><h3>PB BOARD</h3>
        <div class="pb-tabs">${PB_TYPES.map(t => `<button type="button" data-pb="${t}" class="${t === type ? "on" : ""}">${TYPES[t].icon} ${TYPES[t].label}</button>`).join("")}</div>
      </div>
      <table class="pb-table">
        <thead><tr><th></th>${players.map(p => `<th title="${esc(p.name)}">${avatarHTML(p, "sm")}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="pb-hint">Add a time when you log a ${TYPES[type].label.toLowerCase()} to set a PB. Know their times before you bet.</p>`;
  }

  $("#pbs").addEventListener("click", e => {
    const b = e.target.closest("[data-pb]");
    if (!b) return;
    state.pbType = b.dataset.pb;
    ls.set("gbg-pb", state.pbType);
    renderPBs();
  });

  function renderRules() {
    $("#rules").innerHTML = `<h3>MULTIPLIERS</h3><div class="mults">` +
      Object.keys(TYPES).map(t => `<span>${TYPES[t].icon} ${TYPES[t].label} <b>${typeRate(t)}</b></span>`).join("") + `</div>`;
  }

  // players can only act as themselves; the admin (and local mode) can pick anyone
  const selectablePlayers = () => roster().filter(p => access.admin || p.id === access.me);

  // everyone logs only as their own player, admin included (local mode has no accounts, so it can pick)
  function renderPlayerSelect() {
    const sel = $("#fPlayer");
    const cur = access.local ? sel.value || ls.get("gbg-last-player", CFG.players[0].id) : access.me;
    sel.innerHTML = roster().filter(p => access.local || p.id === access.me)
      .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    if (cur) sel.value = cur;
    sel.disabled = !access.local;
  }

  function gateHTML(what) {
    return state.user
      ? `<p>PICK YOUR PLAYER TO ${what}</p><button class="btn primary" type="button" data-auth="claim">CHOOSE PLAYER</button>`
      : `<p>SIGN IN TO ${what}</p><button class="btn primary" type="button" data-auth="in">SIGN IN WITH GOOGLE</button>`;
  }

  function renderAccess() {
    const P = Object.fromEntries(roster().map(p => [p.id, p]));
    const role = access.local ? "" : access.admin ? "ADMIN" : access.me ? "PLAYER" : state.user ? "NO PLAYER YET" : "VIEWER";
    const roleEl = $("#role");
    roleEl.hidden = access.local;
    roleEl.textContent = access.me ? `${P[access.me].name} · ${role}` : role;
    roleEl.className = `pill role ${access.admin ? "admin" : access.me ? "player" : ""}`;
    roleEl.dataset.auth = state.user && !access.me ? "claim" : "";

    const authBtn = $("#authBtn");
    authBtn.hidden = access.local;
    authBtn.textContent = state.user ? "SIGN OUT" : "SIGN IN";
    authBtn.dataset.auth = state.user ? "out" : "in";

    $("#squadBtn").hidden = !access.member && !access.admin;
    $("#squadBtn").textContent = access.admin ? "EDIT SQUAD" : "EDIT PROFILE";

    $("#logForm").hidden = !access.member;
    $("#logGate").hidden = access.member;
    $("#chBtn").hidden = !access.member;
    $("#betGate").hidden = access.member;
    if (!access.member) {
      $("#logGate").innerHTML = gateHTML("LOG QUESTS");
      $("#betGate").innerHTML = gateHTML("MAKE AND TAKE BETS");
    }
  }

  function openClaim() {
    const free = roster().filter(p => !state.claims[p.id]);
    $("#claimList").innerHTML = roster().map(p => {
      const taken = !!state.claims[p.id];
      return `
        <button type="button" class="claim-slot" data-claim="${esc(p.id)}" style="--c:${esc(p.color)}" ${taken ? "disabled" : ""}>
          ${avatarHTML(p, "lg")}<span>${esc(p.name)}</span><small>${taken ? "TAKEN" : "AVAILABLE"}</small>
        </button>`;
    }).join("");
    $("#claimEmpty").hidden = free.length > 0;
    if (!$("#claimDlg").open) $("#claimDlg").showModal();
  }

  // prompt a freshly signed-in account to pick a slot (once per page load if they close it)
  function maybeClaim() {
    if (state.ready && state.user && !access.me && !access.local && !state.claimDismissed && !$("#claimDlg").open) openClaim();
  }

  function render() {
    const stats = computeStats();
    renderTeams(computeTeams(stats));
    renderBoard(stats);
    renderTrack(stats);
    renderChallenges();
    renderPBs();
    renderFeed();
    renderPlayerSelect();
    renderAccess();
    updatePreview();
  }

  // ---------- UI bits ----------
  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.classList.add("out"), 2600);
    setTimeout(() => el.remove(), 3100);
  }

  function setMode(text, kind) {
    const m = $("#mode");
    m.textContent = text;
    m.className = `pill ${kind || ""}`;
  }

  function selectedType() {
    return $("#fTypes input:checked")?.value || "run";
  }

  function updatePreview() {
    const type = selectedType(), flat = !!TYPES[type].flat;
    $("#distField").hidden = flat;
    $("#fDist").required = !flat;
    const t = $("#fTime").value.trim();
    $("#fTime").setCustomValidity(t && !parseTime(t) ? "Use mm:ss or h:mm:ss" : "");
    const v = parseFloat($("#fDist").value);
    if (!flat && !(v > 0)) { $("#preview").textContent = ""; return; }
    $("#preview").textContent = `= +${fmt(points({ type, km: v }))} ADJUSTED`;
  }

  function resizeImage(file, size = 160) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const s = Math.min(img.width, img.height);
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // ---------- squad editor ----------
  const pending = {};
  function openSquad() {
    Object.keys(pending).forEach(k => delete pending[k]);
    const admin = access.admin;
    const teams = admin ? teamRoster() : [];
    $("#squadTitle").textContent = admin ? "EDIT SQUAD" : "EDIT PROFILE";
    $("#accounts").hidden = !admin || access.local;
    if (admin && !access.local) {
      $("#accounts").innerHTML = `<h3>ACCOUNTS</h3>` + roster().map(p => {
        const claim = state.claims[p.id];
        return `
          <div class="acct" style="--c:${esc(p.color)}">
            <b>${esc(p.name)}</b>
            <span>${claim ? (state.user && claim.uid === state.user.uid ? "LINKED (YOU)" : "LINKED") : "UNCLAIMED"}</span>
            ${claim ? `<button type="button" class="btn sm ghost" data-release="${esc(p.id)}">RESET</button>` : ""}
          </div>`;
      }).join("");
    }
    $("#teamEdit").innerHTML = teams.map(t => `
      <div class="team-edit" data-id="${esc(t.id)}" style="--t:${esc(t.color)}">
        <label class="field grow"><span>TEAM NAME</span><input class="tm-name" maxlength="20" value="${esc(t.name)}"></label>
        <label class="field"><span>COLOUR</span><input class="tm-color" type="color" value="${esc(t.color)}"></label>
      </div>`).join("");
    const teamOpts = sel => teams.map(t => `<option value="${esc(t.id)}" ${t.id === sel ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    $("#squadCards").innerHTML = roster().filter(p => access.owns(p.id)).map(p => `
      <div class="squad-card" data-id="${esc(p.id)}" style="--c:${esc(p.color)}">
        <label class="pic" title="Upload pic">${avatarHTML(p, "xl")}<input type="file" accept="image/*" hidden><span class="pic-hint">UPLOAD</span></label>
        <button type="button" class="btn sm ghost pic-clear" ${p.avatar ? "" : "hidden"}>REMOVE PIC</button>
        <label class="field"><span>NAME</span><input class="sq-name" maxlength="16" value="${esc(p.name)}"></label>
        <label class="field"><span>COLOUR</span><input class="sq-color" type="color" value="${esc(p.color)}"></label>
        ${teams.length ? `<label class="field"><span>TEAM</span><select class="sq-team">${teamOpts(p.team)}</select></label>` : ""}
      </div>`).join("");
    $("#squadDlg").showModal();
  }

  $("#squadCards").addEventListener("change", async e => {
    const card = e.target.closest(".squad-card");
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.type === "file" && e.target.files[0]) {
      try {
        const url = await resizeImage(e.target.files[0]);
        pending[id] = { ...pending[id], avatar: url };
        card.querySelector(".avatar").innerHTML = `<img src="${url}" alt="">`;
        card.querySelector(".pic-clear").hidden = false;
      } catch { toast("COULDN'T READ THAT IMAGE", "bad"); }
    }
    if (e.target.classList.contains("sq-color")) card.style.setProperty("--c", e.target.value);
  });

  // clearing a pic saves an empty avatar, which falls back to the player's initials
  $("#squadCards").addEventListener("click", e => {
    const btn = e.target.closest(".pic-clear");
    if (!btn) return;
    const card = btn.closest(".squad-card");
    const id = card.dataset.id;
    pending[id] = { ...pending[id], avatar: "" };
    const name = card.querySelector(".sq-name").value || roster().find(p => p.id === id).name;
    card.querySelector(".avatar").innerHTML = `<span>${esc(name.trim().slice(0, 2).toUpperCase())}</span>`;
    card.querySelector("input[type=file]").value = "";
    btn.hidden = true;
  });

  $("#squadSave").addEventListener("click", async () => {
    const btn = $("#squadSave");
    btn.disabled = true;
    try {
      for (const row of $("#teamEdit").children) {
        const id = row.dataset.id;
        const name = row.querySelector(".tm-name").value.trim().toUpperCase() || id.toUpperCase();
        await state.store.saveTeam(id, { name, color: row.querySelector(".tm-color").value });
      }
      for (const card of $("#squadCards").children) {
        const id = card.dataset.id;
        const name = card.querySelector(".sq-name").value.trim().toUpperCase() || id.toUpperCase();
        const color = card.querySelector(".sq-color").value;
        const teamSel = card.querySelector(".sq-team");
        await state.store.savePlayer(id, { name, color, ...(teamSel ? { team: teamSel.value } : {}), ...pending[id] });
      }
      $("#squadDlg").close();
      toast(access.admin ? "SQUAD SAVED" : "PROFILE SAVED", "good");
    } catch (e) {
      console.error(e);
      toast("SAVE FAILED", "bad");
    } finally {
      btn.disabled = false;
    }
  });

  $("#accounts").addEventListener("click", async e => {
    const btn = e.target.closest("[data-release]");
    if (!btn) return;
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      btn.textContent = "SURE?";
      setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "RESET"; }, 3000);
      return;
    }
    const playerId = btn.dataset.release;
    try {
      await state.store.releasePlayer(playerId, state.claims[playerId].uid);
      toast("SLOT RESET — IT CAN BE CLAIMED AGAIN", "good");
      $("#squadDlg").close();
    } catch (err) {
      console.error(err);
      toast("RESET FAILED", "bad");
    }
  });

  // ---------- sign-in & claiming a player ----------
  document.addEventListener("click", async e => {
    const el = e.target.closest("[data-auth]");
    if (!el || !el.dataset.auth) return;
    const action = el.dataset.auth;
    if (action === "claim") { state.claimDismissed = false; openClaim(); return; }
    try {
      if (action === "in") await state.store.signIn();
      if (action === "out") { await state.store.signOut(); toast("SIGNED OUT"); }
    } catch (err) {
      console.error(err);
      if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
      toast(err.code === "auth/unauthorized-domain" ? "THIS SITE ISN'T AUTHORISED IN FIREBASE YET" : "SIGN-IN FAILED", "bad");
    }
  });

  $("#claimList").addEventListener("click", async e => {
    const btn = e.target.closest("[data-claim]");
    if (!btn || !state.user) return;
    btn.disabled = true;
    try {
      await state.store.claimPlayer(state.user.uid, btn.dataset.claim);
      $("#claimDlg").close();
      const p = roster().find(x => x.id === btn.dataset.claim);
      toast(`WELCOME, ${p.name}!`, "lvl");
    } catch (err) {
      console.error(err);
      toast("SOMEONE GOT THERE FIRST — PICK ANOTHER", "bad");
      openClaim();
    }
  });
  $("#claimClose").addEventListener("click", () => { state.claimDismissed = true; $("#claimDlg").close(); });

  // ---------- form ----------
  function setupForm() {
    $("#fTypes").innerHTML = Object.keys(TYPES).map((t, i) => `
      <label class="type-opt"><input type="radio" name="type" value="${t}" ${i === 0 ? "checked" : ""}>
        <span><i>${TYPES[t].icon}</i>${TYPES[t].label}<small>${typeRate(t)}</small></span></label>`).join("");
    $("#fDate").value = today();
    $("#fDate").max = today();
    ["input", "change"].forEach(ev => $("#logForm").addEventListener(ev, updatePreview));

    $("#logForm").addEventListener("submit", async e => {
      e.preventDefault();
      const playerId = $("#fPlayer").value;
      const type = selectedType();
      const v = parseFloat($("#fDist").value);
      if (!TYPES[type].flat && !(v > 0)) return;
      const km = TYPES[type].flat ? 1 : Math.round(v * 1000) / 1000;
      const gained = points({ type, km });
      const secs = TYPES[type].flat ? null : parseTime($("#fTime").value);
      const milestone = secs && milestoneFor(type, km);
      const oldPB = milestone && personalBests(type)[playerId]?.[milestone.label];

      const statsBefore = computeStats();
      const before = statsBefore.find(s => s.id === playerId);
      const teamsBefore = computeTeams(statsBefore);
      const btn = e.submitter || $("#logForm button[type=submit]");
      btn.disabled = true;
      try {
        await state.store.addActivity({
          playerId, type, km,
          date: $("#fDate").value || today(),
          note: $("#fNote").value.trim().slice(0, 80),
          createdAt: Date.now(),
          ...(secs ? { secs } : {}),
        });
        ls.set("gbg-last-player", playerId);
        toast(`+${fmt(gained)} ${TYPES[type].icon}`, "good");
        if (milestone && (!oldPB || secs < oldPB.secs)) toast(`NEW PB! ${milestone.label} ${TYPES[type].label} ${fmtTime(secs)}`, "lvl");

        const afterPts = before.pts + gained;
        if (Math.floor(afterPts / CFG.kmPerLevel) + 1 > before.level) toast(`LEVEL UP! LV ${Math.floor(afterPts / CFG.kmPerLevel) + 1}`, "lvl");
        if (passedCheckpoints(afterPts) > passedCheckpoints(before.pts)) {
          const pos = afterPts % GOAL;
          const cp = [...CFG.route.checkpoints].reverse().find(c => c.km <= pos);
          toast(Math.floor(afterPts / GOAL) > Math.floor(before.pts / GOAL) ? "ROUTE COMPLETE! LAP UP!" : `CHECKPOINT: ${cp.name.toUpperCase()}`, "cp");
        }
        const myTeam = teamsBefore.find(t => t.id === before.team);
        const rival = teamsBefore.filter(t => t !== myTeam).reduce((m, t) => Math.max(m, t.pts), 0);
        if (myTeam && myTeam.pts <= rival && myTeam.pts + gained > rival) toast(`${myTeam.name} TAKES THE LEAD!`, "lvl");
        $("#fDist").value = "";
        $("#fTime").value = "";
        $("#fNote").value = "";
        updatePreview();
      } catch (err) {
        console.error(err);
        toast("UPLOAD FAILED", "bad");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // delete with double-click confirm
  $("#feed").addEventListener("click", async e => {
    if (e.target.closest("[data-more]")) { state.feedLimit += 30; renderFeed(); return; }
    const timeBtn = e.target.closest("[data-time]");
    if (timeBtn) {
      const a = state.activities.find(x => x.id === timeBtn.dataset.time);
      state.timeEdit = { id: a.id, value: a.secs ? fmtTime(a.secs) : "" };
      renderFeed();
      $("#feed .time-input")?.focus();
      return;
    }
    if (e.target.closest("[data-time-cancel]")) { state.timeEdit = null; renderFeed(); return; }
    const btn = e.target.closest(".del");
    if (!btn) return;
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      btn.textContent = "SURE?";
      setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "✕"; }, 3000);
      return;
    }
    try { await state.store.deleteActivity(btn.dataset.id); toast("DELETED"); }
    catch { toast("DELETE FAILED", "bad"); }
  });

  // keep what's typed if the feed re-renders mid-edit (someone else logs something)
  $("#feed").addEventListener("input", e => {
    if (e.target.classList.contains("time-input") && state.timeEdit) state.timeEdit.value = e.target.value;
  });

  // adding a time to an old activity; an empty box removes the time
  $("#feed").addEventListener("submit", async e => {
    const form = e.target.closest(".time-edit");
    if (!form) return;
    e.preventDefault();
    const a = state.activities.find(x => x.id === form.dataset.id);
    if (!a) return;
    const raw = form.querySelector(".time-input").value.trim();
    const secs = raw ? parseTime(raw) : null;
    if (raw && !secs) { toast("USE MM:SS OR H:MM:SS", "bad"); return; }
    const milestone = secs && milestoneFor(a.type, a.km);
    const oldPB = milestone && personalBests(a.type)[a.playerId]?.[milestone.label];
    form.querySelectorAll("button").forEach(b => { b.disabled = true; });
    try {
      await state.store.setActivityTime(a.id, secs);
      state.timeEdit = null;
      renderFeed();
      toast(secs ? `TIME SAVED: ${fmtTime(secs)}` : "TIME REMOVED", "good");
      if (milestone && (!oldPB || secs < oldPB.secs)) toast(`NEW PB! ${milestone.label} ${TYPES[a.type].label} ${fmtTime(secs)}`, "lvl");
    } catch (err) {
      console.error(err);
      toast("COULDN'T SAVE THE TIME", "bad");
      form.querySelectorAll("button").forEach(b => { b.disabled = false; });
    }
  });

  // ---------- challenges ----------
  let editingBet = null; // id of the bet the dialog is editing, or null for a new one

  function updateBetPreview() {
    const type = $("#cType").value, flat = !!TYPES[type]?.flat;
    $("#cStakeLabel").textContent = flat ? "STAKE (WINS)" : "STAKE (KM)";
    $("#cStake").step = flat ? "1" : "0.1";
    $("#cStake").min = flat ? "1" : "0.1";
    const v = parseFloat($("#cStake").value);
    $("#cPreview").textContent = v > 0 ? `= ${fmt(v * rate(type))} ADJUSTED, WON OR LOST` : "";
  }
  ["input", "change"].forEach(ev => $("#chForm").addEventListener(ev, updateBetPreview));

  function openChallenge(bet = null) {
    editingBet = bet?.id || null;
    const opts = list => list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    const from = $("#cFrom"), to = $("#cTo");
    from.innerHTML = opts(bet ? roster() : selectablePlayers());
    to.innerHTML = opts(roster());
    $("#cType").innerHTML = Object.keys(TYPES).map(t =>
      `<option value="${t}">${TYPES[t].icon} ${TYPES[t].label} (${typeRate(t)})</option>`).join("");
    $("#cType").value = TYPES[bet?.type] ? bet.type : "run";
    if (bet) {
      from.value = bet.from;
      to.value = bet.to;
      $("#cStake").value = bet.stake;
      $("#cDesc").value = bet.desc;
      $("#cDeadline").value = bet.deadline || "";
    } else {
      from.value = access.admin ? ls.get("gbg-last-player", CFG.players[0].id) : access.me;
      to.value = CFG.players.find(p => p.id !== from.value).id;
      $("#cStake").value = $("#cDesc").value = $("#cDeadline").value = "";
    }
    from.disabled = !!bet || !access.admin;
    to.disabled = !!bet;
    $("#cDeadline").min = bet ? "" : today();
    $("#chTitle").textContent = bet ? "EDIT CHALLENGE" : "ISSUE A CHALLENGE";
    $("#chSubmit").textContent = bet ? "✔ SAVE CHANGES" : "⚔ SEND CHALLENGE";
    $("#chRules").hidden = !!bet;
    updateBetPreview();
    $("#chDlg").showModal();
  }

  $("#chBtn").addEventListener("click", () => openChallenge());
  $("#chClose").addEventListener("click", () => $("#chDlg").close());

  $("#chForm").addEventListener("submit", async e => {
    e.preventDefault();
    const from = $("#cFrom").value, to = $("#cTo").value;
    if (from === to) { toast("YOU CAN'T BET AGAINST YOURSELF", "bad"); return; }
    const type = $("#cType").value;
    const v = parseFloat($("#cStake").value);
    const stake = TYPES[type].flat ? Math.round(v) : Math.round(v * 1000) / 1000;
    if (!(stake > 0)) { toast("STAKE MUST BE MORE THAN 0", "bad"); return; }
    const desc = $("#cDesc").value.trim().slice(0, 100);
    if (!desc) return;
    const btn = e.submitter || $("#chForm button[type=submit]");
    btn.disabled = true;
    if (editingBet) {
      try {
        await state.store.updateChallenge(editingBet, { type, stake, desc, deadline: $("#cDeadline").value || "" });
        $("#chDlg").close();
        toast("BET UPDATED", "good");
      } catch (err) {
        console.error(err);
        toast("COULDN'T SAVE THE BET", "bad");
      } finally {
        btn.disabled = false;
      }
      return;
    }
    try {
      await state.store.addChallenge({
        from, to, type, stake, desc,
        deadline: $("#cDeadline").value || "",
        status: "pending",
        createdAt: Date.now(),
      });
      $("#chDlg").close();
      $("#cStake").value = $("#cDesc").value = $("#cDeadline").value = "";
      setView("side", "bets");
      const P = Object.fromEntries(roster().map(p => [p.id, p]));
      toast(`${P[from].name} CALLS OUT ${P[to].name}!`, "lvl");
    } catch (err) {
      console.error(err);
      toast("COULDN'T SEND CHALLENGE", "bad");
    } finally {
      btn.disabled = false;
    }
  });

  $("#challenges").addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.hasAttribute("data-confirm") && !btn.classList.contains("armed")) {
      const label = btn.innerHTML;
      btn.classList.add("armed");
      btn.textContent = "SURE?";
      setTimeout(() => { btn.classList.remove("armed"); btn.innerHTML = label; }, 3000);
      return;
    }
    const card = btn.closest(".ch-card");
    const c = state.challenges.find(x => x.id === card.dataset.id);
    if (!c) return;
    const P = Object.fromEntries(roster().map(p => [p.id, p]));
    const act = btn.dataset.act;
    if (act === "edit") { openChallenge(c); return; }
    if (act === "delete") {
      btn.disabled = true;
      try { await state.store.deleteChallenge(c.id); toast("BET DELETED"); }
      catch (err) { console.error(err); toast("DELETE FAILED", "bad"); btn.disabled = false; }
      return;
    }
    const fields = {
      accept: { status: "active" },
      decline: { status: "declined" },
      cancel: { status: "cancelled" },
      completed: { status: "completed" },
      failed: { status: "failed" },
      claim: { status: "claimed", claim: access.me === c.to ? "completed" : "failed", claimedBy: access.me },
      confirm: { status: c.claim },
      dispute: { status: "disputed" },
    }[act];
    const proof = (card.querySelector(".ch-proof")?.value || "").trim().slice(0, 60);
    if (proof) fields.proof = proof;
    if (fields.status === "completed" || fields.status === "failed") fields.resolvedAt = Date.now();
    btn.disabled = true;
    try {
      await state.store.updateChallenge(c.id, fields);
      if (act === "accept") toast(`${P[c.to].name} ACCEPTS! GAME ON`, "cp");
      else if (fields.status === "completed") toast(`${P[c.to].name} WINS +${fmt(betValue(c))}`, "good");
      else if (fields.status === "failed") toast(`${P[c.from].name} WINS +${fmt(betValue(c))}`, "good");
      else if (act === "claim") toast(`CLAIM SENT — WAITING FOR ${P[access.me === c.to ? c.from : c.to].name}`, "cp");
      else if (act === "dispute") toast("DISPUTED — THE ADMIN WILL SETTLE IT", "bad");
      else toast(act === "decline" ? "CHALLENGE DECLINED" : "BET CANCELLED");
    } catch (err) {
      console.error(err);
      toast("UPDATE FAILED", "bad");
      btn.disabled = false;
    }
  });

  // ---------- navigation ----------
  // view: which screen phones show (home | side | map); tab: which side panel is open (log | bets | feed)
  function setView(view, tab) {
    if (view) { state.view = view; ls.set("gbg-view", view); }
    if (tab) { state.tab = tab; ls.set("gbg-tab", tab); }
    document.body.dataset.view = state.view;
    document.body.dataset.tab = state.tab;
    document.querySelectorAll(".tabs [data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === state.tab));
    document.querySelectorAll(".bottom-nav button").forEach(b =>
      b.classList.toggle("active", b.dataset.view === state.view && (!b.dataset.tab || b.dataset.tab === state.tab)));
  }

  $(".tabs").addEventListener("click", e => {
    const b = e.target.closest("[data-tab]");
    if (b) setView(null, b.dataset.tab);
  });
  $(".bottom-nav").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    setView(b.dataset.view, b.dataset.tab);
    if (b.dataset.view === "map") renderTrack(computeStats(), { recenter: true }); // the map was hidden, so point the camera now it has a size
    window.scrollTo(0, 0);
  });

  $("#squadBtn").addEventListener("click", openSquad);

  // ---------- boot ----------
  async function boot() {
    $("#title").textContent = CFG.title;
    $("#routeName").textContent = `${CFG.route.name} · ${fmt(GOAL, 0)}`;
    document.title = CFG.title;
    setView();
    setupForm();
    renderRules();

    if (CFG.firebase) {
      try {
        state.store = await firebaseStore(CFG.firebase);
        setMode("● ONLINE", "good");
      } catch (e) {
        console.error(e);
        toast("FIREBASE FAILED — LOCAL MODE", "bad");
      }
    }
    if (!state.store) {
      state.store = localStore();
      setMode("LOCAL MODE", "warn");
      $("#mode").title = "Data is only saved in this browser. Add Firebase config in config.js to share.";
    }

    state.store.subscribe(({ players, teams, activities, challenges, members, claims }) => {
      state.players = players || {};
      state.teams = teams || {};
      state.challenges = challenges || [];
      state.activities = activities || [];
      state.members = members || {};
      state.claims = claims || {};
      state.ready = true;
      render();
      maybeClaim();
    });
    let authSeen = false; // the first callback is just the restored session, so don't toast it
    state.store.onAuth(user => {
      const wasSignedIn = !!state.user;
      state.user = user ? { uid: user.uid, name: user.displayName || "" } : null;
      if (user && !wasSignedIn && authSeen) toast(`SIGNED IN${user.displayName ? ` AS ${user.displayName.toUpperCase()}` : ""}`, "good");
      authSeen = true;
      render();
      maybeClaim();
    });
    render();
  }

  boot();
})();
