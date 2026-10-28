(() => {
  "use strict";

  const CFG = window.APP_CONFIG;
  const GOAL = CFG.route.totalKm;
  const FIREBASE_VERSION = "10.12.2";

  const TYPES = {
    run:   { label: "RUN",   icon: "🏃", verb: "ran" },
    cycle: { label: "CYCLE", icon: "🚴", verb: "cycled" },
    swim:  { label: "SWIM",  icon: "🏊", verb: "swam" },
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
      async addChallenge(c) { data.challenges.push({ ...c, id: uid() }); emit(); },
      async updateChallenge(id, f) { data.challenges = data.challenges.map(c => c.id === id ? { ...c, ...f } : c); emit(); },
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
      addChallenge: c => fs.addDoc(fs.collection(db, "challenges"), c),
      updateChallenge: (id, f) => fs.updateDoc(fs.doc(db, "challenges", id), f),
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
      if (winner === id) { net += c.stake; wins++; } else net -= c.stake;
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
      const raw = { run: 0, cycle: 0, swim: 0 };
      let pts = 0;
      acts.forEach(a => { raw[a.type] += a.km; pts += a.km * mult(a.type); });
      const { net: bets, wins: betWins } = betResults(p.id);
      pts += bets;
      const progress = Math.max(0, pts); // debt keeps you parked at Land's End
      const bigBet = state.challenges.some(c => c.from === p.id && c.stake >= 10 && c.status !== "cancelled");
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
      const raw = Object.keys(TYPES).map(t =>
        `<span title="${TYPES[t].label} (raw)">${TYPES[t].icon} ${p.raw[t].toFixed(1)}</span>`).join("") +
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

  // The bottom slice of the map is the sea off Land's End. Anyone in debt sinks into it,
  // deeper the more they owe (the biggest debtor, or 10 km of debt, sits on the sea bed).
  const OCEAN_PCT = 15;

  function renderTrack(stats) {
    const pct = km => OCEAN_PCT + (km / GOAL) * (100 - OCEAN_PCT);
    const debtors = stats.filter(p => p.debt);
    const deepest = Math.max(10, ...debtors.map(p => -p.pts));
    const depthPct = p => OCEAN_PCT - 4 - (-p.pts / deepest) * (OCEAN_PCT - 8);

    let html = `
      <div class="ocean" style="height:${OCEAN_PCT}%">
        <span>THE ATLANTIC</span>
        ${debtors.length ? `<i class="shark" aria-hidden="true">🦈</i>` : ""}
      </div>`;
    CFG.route.zones.forEach((z, i) => {
      html += `<div class="zone z${i}" style="bottom:${pct(z.fromKm)}%;height:${pct(z.toKm) - pct(z.fromKm)}%"><span>${esc(z.name)}</span></div>`;
    });
    html += `<div class="rail" style="bottom:${OCEAN_PCT}%"></div>`;
    const leader = stats[0];
    if (leader) html += `<div class="rail-fill" style="bottom:${OCEAN_PCT}%;height:${pct(Math.min(Math.max(0, leader.pts), GOAL)) - OCEAN_PCT}%"></div>`;
    CFG.route.checkpoints.forEach((c, i, arr) => {
      const cls = i === 0 ? "start" : i === arr.length - 1 ? "finish" : "";
      html += `<div class="cp ${cls}" style="bottom:${pct(c.km)}%"><span class="cp-dot"></span><span class="cp-label">${esc(c.name)}<small>${fmt(c.km, 0)}</small></span></div>`;
    });

    // markers: cluster nearby players side-by-side
    // markers closer than one marker-height apart sit side-by-side (the map is hidden on some phone tabs, so fall back to 600px)
    const near = 62 / ($("#track").clientHeight || 600) * 100;
    const placed = stats.map(p => ({ p, at: p.debt ? depthPct(p) : pct(p.pos) })).sort((a, b) => a.at - b.at);
    let clusterStart = -99, off = 0;
    placed.forEach(({ p, at }) => {
      if (at - clusterStart < near) off++; else { clusterStart = at; off = 0; }
      html += `
        <div class="marker ${p.debt ? "sunk" : ""}" style="bottom:${at}%;--off:${off};--c:${esc(p.color)};--t:${esc(p.teamInfo?.color || p.color)}" title="${esc(p.name)}${p.teamInfo ? ` (${esc(p.teamInfo.name)})` : ""}: ${fmt(p.pts)}${p.debt ? " (IN DEBT)" : ""}">
          ${avatarHTML(p)}
          ${p.lap > 1 ? `<span class="lap">L${p.lap}</span>` : ""}
          <span class="mk-name">${p.debt ? p.pts.toFixed(1) : esc(p.name)}</span>
        </div>`;
    });
    $("#track").innerHTML = html;
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
    ].sort((x, y) => y.date.localeCompare(x.date) || y.ts - x.ts).slice(0, 30);

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
              <span class="gain">+${c.stake.toFixed(1)}</span> <span class="loss">−${c.stake.toFixed(1)}</span></div>
            <div class="feed-meta">${shortDate(localDate(c.resolvedAt || 0))} · “${esc(c.desc)}”${c.proof ? ` · ${esc(c.proof)}` : ""}</div>
          </div>
        </li>`;
      }
      const p = players[a.playerId];
      const d = new Date(a.date + "T00:00:00");
      return `
        <li class="feed-item" style="--c:${esc(p.color)}">
          ${avatarHTML(p, "sm")}
          <div class="feed-body">
            <div><b>${esc(p.name)}</b> ${TYPES[a.type].verb} ${fmt(a.km)} ${TYPES[a.type].icon}
              <span class="gain">+${(a.km * mult(a.type)).toFixed(1)}</span></div>
            <div class="feed-meta">${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}${a.note ? ` · “${esc(a.note)}”` : ""}</div>
          </div>
          ${access.owns(a.playerId) ? `<button class="del" data-id="${esc(a.id)}" type="button" title="Delete">✕</button>` : ""}
        </li>`;
    }).join("");
  }

  // Bet flow: pending -> active -> (claimed -> confirmed | disputed) -> completed / failed.
  // A player can settle straight away in their opponent's favour, but a win they claim for
  // themselves needs the other side to confirm. The admin referees bets they're not part of.
  const OPEN_BET = ["active", "claimed", "disputed"];

  function challengeCard(c, P) {
    const f = P[c.from], t = P[c.to];
    const stake = fmt(c.stake);
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
      if (isFrom || referee) actions += confirmBtn("cancel", "CANCEL BET", "ghost");
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
        <p class="ch-text"><b style="color:${esc(f.color)}">${esc(f.name)}</b> bets ${stake} that
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

  function renderRules() {
    $("#rules").innerHTML = `<h3>MULTIPLIERS</h3><div class="mults">` +
      Object.keys(TYPES).map(t => `<span>${TYPES[t].icon} ${TYPES[t].label} <b>×${mult(t)}</b></span>`).join("") + `</div>`;
  }

  // players can only act as themselves; the admin (and local mode) can pick anyone
  const selectablePlayers = () => roster().filter(p => access.admin || p.id === access.me);

  function renderPlayerSelect() {
    const sel = $("#fPlayer");
    const cur = access.admin ? sel.value || ls.get("gbg-last-player", CFG.players[0].id) : access.me;
    sel.innerHTML = selectablePlayers().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    if (cur) sel.value = cur;
    sel.disabled = !access.admin;
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

    $("#squadBtn").hidden = !access.member;
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
    const v = parseFloat($("#fDist").value);
    if (!(v > 0)) { $("#preview").textContent = ""; return; }
    $("#preview").textContent = `= +${fmt(v * mult(selectedType()))} ADJUSTED`;
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
      } catch { toast("COULDN'T READ THAT IMAGE", "bad"); }
    }
    if (e.target.classList.contains("sq-color")) card.style.setProperty("--c", e.target.value);
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
        <span><i>${TYPES[t].icon}</i>${TYPES[t].label}<small>×${mult(t)}</small></span></label>`).join("");
    $("#fDate").value = today();
    $("#fDate").max = today();
    ["input", "change"].forEach(ev => $("#logForm").addEventListener(ev, updatePreview));

    $("#logForm").addEventListener("submit", async e => {
      e.preventDefault();
      const playerId = $("#fPlayer").value;
      const type = selectedType();
      const v = parseFloat($("#fDist").value);
      if (!(v > 0)) return;
      const km = Math.round(v * 1000) / 1000;

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
        });
        ls.set("gbg-last-player", playerId);
        toast(`+${fmt(km * mult(type))} ${TYPES[type].icon}`, "good");

        const afterPts = before.pts + km * mult(type);
        if (Math.floor(afterPts / CFG.kmPerLevel) + 1 > before.level) toast(`LEVEL UP! LV ${Math.floor(afterPts / CFG.kmPerLevel) + 1}`, "lvl");
        if (passedCheckpoints(afterPts) > passedCheckpoints(before.pts)) {
          const pos = afterPts % GOAL;
          const cp = [...CFG.route.checkpoints].reverse().find(c => c.km <= pos);
          toast(Math.floor(afterPts / GOAL) > Math.floor(before.pts / GOAL) ? "ROUTE COMPLETE! LAP UP!" : `CHECKPOINT: ${cp.name.toUpperCase()}`, "cp");
        }
        const myTeam = teamsBefore.find(t => t.id === before.team);
        const rival = teamsBefore.filter(t => t !== myTeam).reduce((m, t) => Math.max(m, t.pts), 0);
        if (myTeam && myTeam.pts <= rival && myTeam.pts + km * mult(type) > rival) toast(`${myTeam.name} TAKES THE LEAD!`, "lvl");
        $("#fDist").value = "";
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

  // ---------- challenges ----------
  function openChallenge() {
    const opts = list => list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    const from = $("#cFrom"), to = $("#cTo");
    from.innerHTML = opts(selectablePlayers());
    to.innerHTML = opts(roster());
    from.value = access.admin ? ls.get("gbg-last-player", CFG.players[0].id) : access.me;
    from.disabled = !access.admin;
    to.value = CFG.players.find(p => p.id !== from.value).id;
    $("#cDeadline").min = today();
    $("#chDlg").showModal();
  }

  $("#chBtn").addEventListener("click", openChallenge);
  $("#chClose").addEventListener("click", () => $("#chDlg").close());

  $("#chForm").addEventListener("submit", async e => {
    e.preventDefault();
    const from = $("#cFrom").value, to = $("#cTo").value;
    if (from === to) { toast("YOU CAN'T BET AGAINST YOURSELF", "bad"); return; }
    const v = parseFloat($("#cStake").value);
    const stake = Math.round(v * 1000) / 1000;
    if (!(stake > 0)) { toast("STAKE MUST BE MORE THAN 0", "bad"); return; }
    const desc = $("#cDesc").value.trim().slice(0, 100);
    if (!desc) return;
    const btn = e.submitter || $("#chForm button[type=submit]");
    btn.disabled = true;
    try {
      await state.store.addChallenge({
        from, to, stake, desc,
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
      else if (fields.status === "completed") toast(`${P[c.to].name} WINS +${fmt(c.stake)}`, "good");
      else if (fields.status === "failed") toast(`${P[c.from].name} WINS +${fmt(c.stake)}`, "good");
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
    if (b.dataset.view === "map") renderTrack(computeStats()); // re-space markers now the map has a real height
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
