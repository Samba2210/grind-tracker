(() => {
  "use strict";

  const CFG = window.APP_CONFIG;
  const GOAL = CFG.route.totalKm;
  const KM_PER_MI = 1.609344;
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
  ];

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
    unit: ls.get("gbg-unit", "mi"),
    players: {},      // overrides from store
    teams: {},
    activities: [],
    store: null,
  };

  const toUnit = km => state.unit === "mi" ? km / KM_PER_MI : km;
  const fmt = (km, dp = 1) => `${toUnit(km).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })} ${state.unit.toUpperCase()}`;

  // ---------- stores ----------
  function localStore() {
    const KEY = "gbg-data-v1";
    const data = ls.get(KEY, { players: {}, activities: [] });
    data.teams = data.teams || {};
    const listeners = [];
    const snap = () => ({ players: data.players, teams: data.teams, activities: [...data.activities] });
    const emit = () => { ls.set(KEY, data); listeners.forEach(f => f(snap())); };
    return {
      mode: "local",
      subscribe(f) { listeners.push(f); f(snap()); },
      async savePlayer(id, p) { data.players[id] = { ...data.players[id], ...p }; emit(); },
      async saveTeam(id, t) { data.teams[id] = { ...data.teams[id], ...t }; emit(); },
      async addActivity(a) { data.activities.push({ ...a, id: uid() }); emit(); },
      async deleteActivity(id) { data.activities = data.activities.filter(a => a.id !== id); emit(); },
    };
  }

  async function firebaseStore(conf) {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const { initializeApp } = await import(`${base}/firebase-app.js`);
    const fs = await import(`${base}/firebase-firestore.js`);
    const db = fs.getFirestore(initializeApp(conf));

    let players = {}, teams = {}, activities = [];
    const ready = { p: false, t: false, a: false };
    const listeners = [];
    const emit = () => { if (ready.p && ready.t && ready.a) listeners.forEach(f => f({ players, teams, activities })); };
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

    return {
      mode: "online",
      subscribe(f) { listeners.push(f); emit(); },
      savePlayer: (id, p) => fs.setDoc(fs.doc(db, "players", id), p, { merge: true }),
      saveTeam: (id, t) => fs.setDoc(fs.doc(db, "teams", id), t, { merge: true }),
      addActivity: a => fs.addDoc(fs.collection(db, "activities"), a),
      deleteActivity: id => fs.deleteDoc(fs.doc(db, "activities", id)),
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
      const level = Math.floor(pts / CFG.kmPerLevel) + 1;
      const title = TITLES.filter(([l]) => level >= l).pop()[1];
      const pos = pts % GOAL;
      const next = CFG.route.checkpoints.find(c => c.km > pos);
      return {
        ...p, acts, raw, pts, level, title,
        xp: (pts % CFG.kmPerLevel) / CFG.kmPerLevel,
        lap: Math.floor(pts / GOAL) + 1,
        pos, next,
        badges: BADGES.filter(b => b.test({ acts, raw, pts })),
      };
    }).sort((a, b) => b.pts - a.pts);
  }

  const passedCheckpoints = pts => {
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
        `<span title="${TYPES[t].label} (raw)">${TYPES[t].icon} ${toUnit(p.raw[t]).toFixed(1)}</span>`).join("");
      const nextTxt = p.next ? `NEXT: ${esc(p.next.name)} in ${fmt(p.next.km - p.pos, 0)}` : "";
      return `
        <li class="entry ${p.pts > 0 ? `rank-${i + 1}` : ""}" style="--c:${esc(p.color)}">
          <div class="rank">${i + 1}</div>
          ${avatarHTML(p, "lg")}
          <div class="info">
            <div class="name">${esc(p.name)} ${teamChip(p.teamInfo)}<span class="lvl">LV ${p.level}</span><span class="ptitle">${p.title}</span>${p.lap > 1 ? `<span class="lapchip">LAP ${p.lap}</span>` : ""}</div>
            <div class="xp" title="${Math.round(p.xp * 100)}% to LV ${p.level + 1}"><i style="width:${(p.xp * 100).toFixed(1)}%"></i></div>
            <div class="meta">${raw}<span class="next">${nextTxt}</span></div>
            ${p.badges.length ? `<div class="badges">${p.badges.map(b => `<span class="badge" title="${esc(b.tip)}">${b.label}</span>`).join("")}</div>` : ""}
          </div>
          <div class="score">${toUnit(p.pts).toFixed(1)}<small>${state.unit.toUpperCase()}</small></div>
        </li>`;
    }).join("");
  }

  function renderTeams(teams) {
    const panel = $("#teamsPanel");
    panel.hidden = teams.length < 2;
    if (panel.hidden) return;
    const total = teams.reduce((s, t) => s + t.pts, 0);
    const leading = teams[0].pts > teams[1].pts;
    // keep config order in the tug bar so it doesn't flip sides when the lead changes
    const ordered = [...teams].sort((a, b) => CFG.teams.findIndex(t => t.id === a.id) - CFG.teams.findIndex(t => t.id === b.id));
    const tug = ordered.map(t =>
      `<i style="--t:${esc(t.color)};flex-grow:${total ? Math.max(t.pts, total * 0.04) : 1}"></i>`).join("");
    const cards = ordered.map(t => {
      const lead = leading && t.id === teams[0].id;
      const pos = t.pts % GOAL, lap = Math.floor(t.pts / GOAL) + 1;
      const next = CFG.route.checkpoints.find(c => c.km > pos);
      return `
        <div class="team-card ${lead ? "lead" : ""}" style="--t:${esc(t.color)}">
          <div class="team-name">${lead ? "♛ " : ""}${esc(t.name)}</div>
          <div class="team-score">${toUnit(t.pts).toFixed(1)}<small>${state.unit.toUpperCase()}</small></div>
          <div class="team-members">${t.members.map(m => avatarHTML(m, "sm")).join("") || `<span class="dim">NO PLAYERS</span>`}</div>
          <div class="team-prog"><i style="width:${(pos / GOAL * 100).toFixed(1)}%"></i></div>
          <div class="team-meta">${lap > 1 ? `LAP ${lap} · ` : ""}${next ? `NEXT: ${esc(next.name)} in ${fmt(next.km - pos, 0)}` : ""}</div>
        </div>`;
    });
    $("#teams").innerHTML = `<div class="tug">${tug}</div><div class="team-cards">${cards.join(`<div class="vs">VS</div>`)}</div>`;
  }

  function renderTrack(stats) {
    const pct = km => (km / GOAL) * 100;
    let html = "";
    CFG.route.zones.forEach((z, i) => {
      html += `<div class="zone z${i}" style="bottom:${pct(z.fromKm)}%;height:${pct(z.toKm - z.fromKm)}%"><span>${esc(z.name)}</span></div>`;
    });
    html += `<div class="rail"></div>`;
    const leader = stats[0];
    if (leader) html += `<div class="rail-fill" style="height:${pct(Math.min(leader.pts, GOAL))}%"></div>`;
    CFG.route.checkpoints.forEach((c, i, arr) => {
      const cls = i === 0 ? "start" : i === arr.length - 1 ? "finish" : "";
      html += `<div class="cp ${cls}" style="bottom:${pct(c.km)}%"><span class="cp-dot"></span><span class="cp-label">${esc(c.name)}<small>${fmt(c.km, 0)}</small></span></div>`;
    });

    // markers: cluster nearby players side-by-side
    const sorted = [...stats].sort((a, b) => a.pos - b.pos);
    let clusterStart = -99, off = 0;
    sorted.forEach(p => {
      const at = pct(p.pos);
      if (at - clusterStart < 5) off++; else { clusterStart = at; off = 0; }
      html += `
        <div class="marker" style="bottom:${at}%;--off:${off};--c:${esc(p.color)};--t:${esc(p.teamInfo?.color || p.color)}" title="${esc(p.name)}${p.teamInfo ? ` (${esc(p.teamInfo.name)})` : ""}: ${fmt(p.pts)}">
          ${avatarHTML(p)}
          ${p.lap > 1 ? `<span class="lap">L${p.lap}</span>` : ""}
          <span class="mk-name">${esc(p.name)}</span>
        </div>`;
    });
    $("#track").innerHTML = html;
  }

  function renderFeed() {
    const players = Object.fromEntries(roster().map(p => [p.id, p]));
    const acts = [...state.activities]
      .filter(a => players[a.playerId] && TYPES[a.type])
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 30);
    if (!acts.length) {
      $("#feed").innerHTML = `<li class="empty">NO QUESTS YET. INSERT COIN.</li>`;
      return;
    }
    $("#feed").innerHTML = acts.map(a => {
      const p = players[a.playerId];
      const d = new Date(a.date + "T00:00:00");
      return `
        <li class="feed-item" style="--c:${esc(p.color)}">
          ${avatarHTML(p, "sm")}
          <div class="feed-body">
            <div><b>${esc(p.name)}</b> ${TYPES[a.type].verb} ${fmt(a.km)} ${TYPES[a.type].icon}
              <span class="gain">+${toUnit(a.km * mult(a.type)).toFixed(1)}</span></div>
            <div class="feed-meta">${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}${a.note ? ` · “${esc(a.note)}”` : ""}</div>
          </div>
          <button class="del" data-id="${esc(a.id)}" type="button" title="Delete">✕</button>
        </li>`;
    }).join("");
  }

  function renderRules() {
    $("#rules").innerHTML = `<h3>MULTIPLIERS</h3><div class="mults">` +
      Object.keys(TYPES).map(t => `<span>${TYPES[t].icon} ${TYPES[t].label} <b>×${mult(t)}</b></span>`).join("") + `</div>`;
  }

  function renderPlayerSelect() {
    const sel = $("#fPlayer");
    const cur = sel.value || ls.get("gbg-last-player", CFG.players[0].id);
    sel.innerHTML = roster().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    sel.value = cur;
  }

  function render() {
    const stats = computeStats();
    $("#unitBtn").textContent = state.unit.toUpperCase();
    renderTeams(computeTeams(stats));
    renderBoard(stats);
    renderTrack(stats);
    renderFeed();
    renderPlayerSelect();
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
    const km = $("#fUnit").value === "mi" ? v * KM_PER_MI : v;
    $("#preview").textContent = `= +${fmt(km * mult(selectedType()))} ADJUSTED`;
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
    const teams = teamRoster();
    $("#teamEdit").innerHTML = teams.map(t => `
      <div class="team-edit" data-id="${esc(t.id)}" style="--t:${esc(t.color)}">
        <label class="field grow"><span>TEAM NAME</span><input class="tm-name" maxlength="20" value="${esc(t.name)}"></label>
        <label class="field"><span>COLOUR</span><input class="tm-color" type="color" value="${esc(t.color)}"></label>
      </div>`).join("");
    const teamOpts = sel => teams.map(t => `<option value="${esc(t.id)}" ${t.id === sel ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    $("#squadCards").innerHTML = roster().map(p => `
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
      toast("SQUAD SAVED", "good");
    } catch (e) {
      console.error(e);
      toast("SAVE FAILED", "bad");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- form ----------
  function setupForm() {
    $("#fTypes").innerHTML = Object.keys(TYPES).map((t, i) => `
      <label class="type-opt"><input type="radio" name="type" value="${t}" ${i === 0 ? "checked" : ""}>
        <span><i>${TYPES[t].icon}</i>${TYPES[t].label}<small>×${mult(t)}</small></span></label>`).join("");
    $("#fDate").value = today();
    $("#fDate").max = today();
    $("#fUnit").value = state.unit;
    ["input", "change"].forEach(ev => $("#logForm").addEventListener(ev, updatePreview));

    $("#logForm").addEventListener("submit", async e => {
      e.preventDefault();
      const playerId = $("#fPlayer").value;
      const type = selectedType();
      const v = parseFloat($("#fDist").value);
      if (!(v > 0)) return;
      const km = Math.round(($("#fUnit").value === "mi" ? v * KM_PER_MI : v) * 1000) / 1000;

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

  $("#unitBtn").addEventListener("click", () => {
    state.unit = state.unit === "mi" ? "km" : "mi";
    ls.set("gbg-unit", state.unit);
    $("#fUnit").value = state.unit;
    render();
  });
  $("#squadBtn").addEventListener("click", openSquad);

  // ---------- boot ----------
  async function boot() {
    $("#title").textContent = CFG.title;
    $("#routeName").textContent = `${CFG.route.name} · ${fmt(GOAL, 0)}`;
    document.title = CFG.title;
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

    state.store.subscribe(({ players, teams, activities }) => {
      state.players = players || {};
      state.teams = teams || {};
      state.activities = activities || [];
      render();
    });
    render();
  }

  boot();
})();
