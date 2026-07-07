(function () {
  "use strict";

  const FEST = window.FESTIVAL;
  const STORAGE_KEY = "slot_marks_v1";

  // --- config ---
  const DAY_START_HOUR = 6;      // times before this are treated as "late night" of the same day
  const DEFAULT_DUR = 60;        // assumed event length (min) — source lists start times only
  const PX_PER_MIN = 1.25;       // vertical scale of the calendar

  const CATEGORIES = [
    { id: "Koncerty", label: "Koncerty", varName: "--c-koncerty" },
    { id: "Pokazy", label: "Pokazy", varName: "--c-pokazy" },
    { id: "Miejscówki", label: "Miejscówki", varName: "--c-miejscowki" },
    { id: "Spotkania", label: "Spotkania", varName: "--c-spotkania" },
  ];
  const CAT_VAR = {};
  CATEGORIES.forEach(c => (CAT_VAR[c.id] = `var(${c.varName})`));

  const STATUS_META = {
    plan:  { label: "Idę",  icon: "✓", css: "--s-plan" },
    maybe: { label: "Może", icon: "★", css: "--s-maybe" },
    no:    { label: "Nie",  icon: "✕", css: "--s-no" },
  };

  const DOW = {
    "2026-07-08": "Środa",
    "2026-07-09": "Czwartek",
    "2026-07-10": "Piątek",
    "2026-07-11": "Sobota",
    "2026-07-12": "Niedziela",
  };

  // --- storage ---
  function loadMarks() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveMarks(m) { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); }
  let MARKS = loadMarks();
  const getStatus = url => MARKS[url] || null;
  function setStatus(url, status) {
    if (!status) delete MARKS[url];
    else MARKS[url] = status;
    saveMarks(MARKS);
  }

  // --- state ---
  const state = {
    view: "program",
    day: FEST.dates[0],
    cats: new Set(CATEGORIES.map(c => c.id)),
    search: "",
    statuses: new Set(["plan", "maybe"]),
    openUrl: null,
  };

  // --- time helpers ---
  function toMin(time) {
    if (!time) return null;
    const [h, m] = time.split(":").map(Number);
    let mins = h * 60 + m;
    if (h < DAY_START_HOUR) mins += 24 * 60; // push late-night to end of the day
    return mins;
  }
  function fmt(mins) {
    let m = mins % (24 * 60);
    const h = Math.floor(m / 60), mm = m % 60;
    return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  }

  // --- DOM refs ---
  const $ = sel => document.querySelector(sel);
  const dayTabs = $("#dayTabs");
  const catChips = $("#categoryChips");
  const statusChips = $("#statusChips");
  const calendar = $("#calendar");
  const alldayRow = $("#alldayRow");
  const emptyState = $("#emptyState");
  const planSummary = $("#planSummary");
  const searchInput = $("#searchInput");

  // ================= build controls =================
  function buildDayTabs() {
    dayTabs.innerHTML = "";
    FEST.dates.forEach(date => {
      const b = document.createElement("button");
      b.className = "day-tab" + (date === state.day ? " is-active" : "");
      const dom = date.slice(8, 10);
      b.innerHTML = `<span class="dow">${(DOW[date] || "").slice(0, 3)}</span>
        <span class="dom">${dom}</span>
        <span class="cnt" data-date="${date}"></span>`;
      b.addEventListener("click", () => { state.day = date; render(); });
      dayTabs.appendChild(b);
    });
  }

  function buildCatChips() {
    catChips.innerHTML = "";
    CATEGORIES.forEach(c => {
      const b = document.createElement("button");
      b.className = "chip" + (state.cats.has(c.id) ? " is-active" : "");
      b.style.setProperty("--cat", CAT_VAR[c.id]);
      b.innerHTML = `<span class="dot"></span>${c.label}`;
      b.addEventListener("click", () => {
        if (state.cats.has(c.id)) state.cats.delete(c.id);
        else state.cats.add(c.id);
        b.classList.toggle("is-active", state.cats.has(c.id));
        render();
      });
      catChips.appendChild(b);
    });
  }

  function buildStatusChips() {
    statusChips.innerHTML = "";
    ["plan", "maybe", "no"].forEach(s => {
      const meta = STATUS_META[s];
      const b = document.createElement("button");
      b.className = "chip" + (state.statuses.has(s) ? " is-active" : "");
      b.style.setProperty("--cat", `var(${meta.css})`);
      b.innerHTML = `<span class="dot"></span>${meta.label}`;
      b.addEventListener("click", () => {
        if (state.statuses.has(s)) state.statuses.delete(s);
        else state.statuses.add(s);
        b.classList.toggle("is-active", state.statuses.has(s));
        render();
      });
      statusChips.appendChild(b);
    });
  }

  function buildLegend() {
    const legend = $("#legend");
    let html = "";
    CATEGORIES.forEach(c => {
      html += `<span class="li"><span class="sw" style="background:${CAT_VAR[c.id]}"></span>${c.label}</span>`;
    });
    html += `<span class="li"><span class="sw round" style="background:var(--s-plan)"></span>Idę</span>`;
    html += `<span class="li"><span class="sw round" style="background:var(--s-maybe)"></span>Może</span>`;
    legend.innerHTML = html;
  }

  // ================= layout engine =================
  function prepareTimed(events) {
    // use the exact start/end scraped from each event page; end times after
    // midnight are pushed past the start so late-night blocks render correctly.
    const timed = events.filter(e => e.time).map(e => {
      const start = toMin(e.time);
      let end = null;
      if (e.end) {
        end = toMin(e.end);
        if (end <= start) end += 24 * 60; // crosses midnight
      }
      return { ev: e, start, end };
    });

    // fallback (only for any event missing an explicit end): assume DEFAULT_DUR,
    // clamped to the next event at the same location.
    if (timed.some(t => t.end == null)) {
      const byLoc = {};
      timed.forEach(t => (byLoc[t.ev.location] = byLoc[t.ev.location] || []).push(t));
      Object.values(byLoc).forEach(list => {
        list.sort((a, b) => a.start - b.start);
        list.forEach((t, i) => {
          if (t.end != null) return;
          const nextStart = i + 1 < list.length ? list[i + 1].start : Infinity;
          t.end = Math.min(t.start + DEFAULT_DUR, nextStart);
          if (t.end <= t.start) t.end = t.start + 30;
        });
      });
    }
    return timed;
  }

  function packColumns(timed) {
    timed.sort((a, b) => a.start - b.start || a.end - b.end);
    let cluster = [];
    let clusterEnd = -1;

    const finalize = group => {
      const colEnds = [];
      group.forEach(t => {
        let placed = false;
        for (let c = 0; c < colEnds.length; c++) {
          if (colEnds[c] <= t.start) { t.col = c; colEnds[c] = t.end; placed = true; break; }
        }
        if (!placed) { t.col = colEnds.length; colEnds.push(t.end); }
      });
      group.forEach(t => (t.cols = colEnds.length));
    };

    timed.forEach(t => {
      if (cluster.length && t.start >= clusterEnd) { finalize(cluster); cluster = []; clusterEnd = -1; }
      cluster.push(t);
      clusterEnd = Math.max(clusterEnd, t.end);
    });
    if (cluster.length) finalize(cluster);
    return timed;
  }

  function markConflicts(timed) {
    // flag time clashes between events the user plans to attend ("Idę")
    const plan = timed.filter(t => getStatus(t.ev.url) === "plan");
    plan.forEach(t => (t.conflict = false));
    let clashes = 0;
    for (let i = 0; i < plan.length; i++) {
      for (let j = i + 1; j < plan.length; j++) {
        if (plan[i].start < plan[j].end && plan[j].start < plan[i].end) {
          plan[i].conflict = plan[j].conflict = true;
          clashes++;
        }
      }
    }
    return clashes;
  }

  // ================= filtering =================
  function currentEvents() {
    let evs = FEST.events.filter(e => e.date === state.day);
    if (state.view === "program") {
      evs = evs.filter(e => state.cats.has(e.category));
      if (state.search) {
        const q = state.search.toLowerCase();
        evs = evs.filter(e =>
          e.name.toLowerCase().includes(q) || (e.location || "").toLowerCase().includes(q));
      }
    } else {
      evs = evs.filter(e => {
        const s = getStatus(e.url);
        return s && state.statuses.has(s);
      });
    }
    return evs;
  }

  // ================= rendering =================
  function render() {
    // toggle controls
    $("#programControls").hidden = state.view !== "program";
    $("#planControls").hidden = state.view !== "plan";
    document.querySelectorAll(".view-btn").forEach(b =>
      b.classList.toggle("is-active", b.dataset.view === state.view));
    document.querySelectorAll(".day-tab").forEach((b, i) =>
      b.classList.toggle("is-active", FEST.dates[i] === state.day));

    updateDayCounts();

    const evs = currentEvents();
    const allday = evs.filter(e => !e.time);
    const timed = markLayout(evs);

    renderAllday(allday);
    renderGrid(timed);
    renderPlanSummary();

    const nothing = timed.timed.length === 0 && allday.length === 0;
    emptyState.hidden = !nothing;
    calendar.hidden = timed.timed.length === 0;
    if (nothing) {
      emptyState.innerHTML = state.view === "plan"
        ? `<div class="big">🗓️</div>Brak zaznaczonych wydarzeń tego dnia.<br>Przejdź do <b>Programu</b> i oznacz, na co chcesz iść.`
        : `<div class="big">🔍</div>Brak wydarzeń dla wybranych filtrów.`;
    }
  }

  function markLayout(evs) {
    const timed = prepareTimed(evs);
    packColumns(timed);
    const clashes = state.view === "plan" ? markConflicts(timed) : 0;
    return { timed, clashes };
  }

  function updateDayCounts() {
    FEST.dates.forEach(date => {
      const el = document.querySelector(`.cnt[data-date="${date}"]`);
      if (!el) return;
      let n;
      if (state.view === "plan") {
        n = FEST.events.filter(e => e.date === date && (() => {
          const s = getStatus(e.url); return s && state.statuses.has(s);
        })()).length;
      } else {
        n = FEST.events.filter(e => e.date === date && state.cats.has(e.category)).length;
      }
      el.textContent = n ? `${n}` : "";
    });
  }

  function statusClass(url) {
    const s = getStatus(url);
    return s ? " status-" + s : "";
  }
  function badgeChar(url) {
    const s = getStatus(url);
    return s ? STATUS_META[s].icon : "";
  }

  function renderAllday(items) {
    if (!items.length) { alldayRow.hidden = true; return; }
    alldayRow.hidden = false;
    let html = `<h3>Całodniowe / bez godziny</h3><div class="allday-items">`;
    items.forEach(e => {
      html += `<button class="pill${statusClass(e.url)}" style="--cat:${CAT_VAR[e.category]}" data-url="${encodeURIComponent(e.url)}">
        ${escapeHtml(e.name)} <span style="opacity:.7">· ${escapeHtml(e.location || "")}</span></button>`;
    });
    html += `</div>`;
    alldayRow.innerHTML = html;
    alldayRow.querySelectorAll(".pill").forEach(p =>
      p.addEventListener("click", () => openSheet(decodeURIComponent(p.dataset.url))));
  }

  function renderGrid(layout) {
    const timed = layout.timed;
    if (!timed.length) { calendar.innerHTML = ""; return; }

    const minStart = Math.min(...timed.map(t => t.start));
    const maxEnd = Math.max(...timed.map(t => t.end));
    const baseMin = Math.floor(minStart / 60) * 60;
    const topMin = Math.ceil(maxEnd / 60) * 60;
    // small bottom buffer so a horizontal scrollbar never clips the last events
    const height = (topMin - baseMin) * PX_PER_MIN + 16;

    // gutter
    let gutter = `<div class="time-gutter" style="height:${height}px">`;
    for (let m = baseMin; m <= topMin; m += 60) {
      const top = (m - baseMin) * PX_PER_MIN;
      gutter += `<span class="time-label" style="top:${top}px">${fmt(m)}</span>`;
    }
    gutter += `</div>`;

    // grid inner
    const maxCols = Math.max(1, ...timed.map(t => t.cols || 1));
    const colMinPx = 158;
    const innerWidth = `max(100%, ${maxCols * colMinPx}px)`;

    let inner = `<div class="grid-scroll"><div class="grid-inner" style="height:${height}px; width:${innerWidth}">`;
    for (let m = baseMin; m <= topMin; m += 30) {
      const top = (m - baseMin) * PX_PER_MIN;
      inner += `<div class="hour-line${m % 60 ? " half" : ""}" style="top:${top}px"></div>`;
    }

    const gap = 4;
    timed.forEach(t => {
      const e = t.ev;
      const top = (t.start - baseMin) * PX_PER_MIN;
      const h = Math.max(24, (t.end - t.start) * PX_PER_MIN - 2);
      const wPct = 100 / t.cols;
      const left = t.col * wPct;
      const conflict = t.conflict ? " conflict" : "";
      inner += `<div class="event${statusClass(e.url)}${conflict}"
          style="--cat:${CAT_VAR[e.category]}; top:${top}px; height:${h}px;
                 left:calc(${left}% + ${gap}px); width:calc(${wPct}% - ${gap * 2}px);"
          data-url="${encodeURIComponent(e.url)}">
        <span class="ev-badge">${badgeChar(e.url)}</span>
        <span class="ev-time">${e.time}${e.end ? "–" + e.end : ""}</span>
        <span class="ev-name">${escapeHtml(e.name)}</span>
        <span class="ev-loc">${escapeHtml(e.location || "")}</span>
        ${t.conflict ? '<span class="ev-conflict">! kolizja</span>' : ""}
      </div>`;
    });
    inner += `</div></div>`;

    calendar.innerHTML = gutter + inner;
    calendar.querySelectorAll(".event").forEach(el =>
      el.addEventListener("click", () => openSheet(decodeURIComponent(el.dataset.url))));
  }

  function renderPlanSummary() {
    if (state.view !== "plan") return;
    const dayEvents = FEST.events.filter(e => e.date === state.day);
    const plan = dayEvents.filter(e => getStatus(e.url) === "plan");
    const maybe = dayEvents.filter(e => getStatus(e.url) === "maybe");
    const timed = markLayout(FEST.events.filter(e => e.date === state.day &&
      getStatus(e.url) === "plan"));
    const conflicting = timed.timed.filter(t => t.conflict).length;
    let html = `<span><b>${plan.length}</b> Idę</span><span><b>${maybe.length}</b> Może</span>`;
    if (conflicting) html += `<span class="conflict-pill">⚠ ${conflicting} w kolizji</span>`;
    planSummary.innerHTML = html;
  }

  // ================= detail sheet =================
  function openSheet(url) {
    const e = FEST.events.find(x => x.url === url);
    if (!e) return;
    state.openUrl = url;
    const sheet = $("#sheet");
    const back = $("#sheetBackdrop");
    const cur = getStatus(url);
    const timeStr = e.time ? (e.end ? e.time + "–" + e.end : e.time) : "całodniowe";

    const desc = Array.isArray(e.desc) ? e.desc : [];
    const descHtml = desc.length
      ? desc.map(p => `<p>${escapeHtml(p)}</p>`).join("")
      : `<p class="s-nodesc">Brak opisu dla tego wydarzenia.</p>`;

    sheet.style.setProperty("--cat", CAT_VAR[e.category]);
    sheet.innerHTML = `
      <button class="s-close" aria-label="Zamknij">✕</button>
      <div class="s-head">
        <span class="s-cat"><span class="dot"></span>${e.category}</span>
        <h2>${escapeHtml(e.name)}</h2>
        <div class="s-meta">
          <span>🕒 <b>${timeStr}</b></span>
          <span>📅 <b>${DOW[e.date]} ${e.date.slice(8, 10)}.07</b></span>
          <span>📍 ${escapeHtml(e.location || "—")}</span>
        </div>
      </div>
      <div class="s-body">
        <div class="s-desc">${descHtml}</div>
        <a class="s-link" href="${e.url}" target="_blank" rel="noopener">Zobacz na slot.art.pl ↗</a>
      </div>
      <div class="s-foot">
        <div class="status-buttons">
          ${["plan", "maybe", "no"].map(s => `
            <button data-status="${s}" class="${cur === s ? "on" : ""}">
              <span class="ic">${STATUS_META[s].icon}</span>${STATUS_META[s].label}
            </button>`).join("")}
        </div>
        <button class="s-clear">Wyczyść oznaczenie</button>
      </div>
    `;
    sheet.hidden = false;
    back.hidden = false;

    sheet.querySelector(".s-close").addEventListener("click", closeSheet);
    sheet.querySelector(".s-clear").addEventListener("click", () => {
      setStatus(url, null); closeSheet(); render();
    });
    sheet.querySelectorAll(".status-buttons button").forEach(b =>
      b.addEventListener("click", () => {
        const s = b.dataset.status;
        setStatus(url, cur === s ? null : s);
        closeSheet();
        render();
      }));
  }
  function closeSheet() {
    $("#sheet").hidden = true;
    $("#sheetBackdrop").hidden = true;
    state.openUrl = null;
  }

  // ================= utils =================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ================= init =================
  function init() {
    const hash = location.hash.replace("#", "");
    if (hash === "plan") state.view = "plan";
    buildDayTabs();
    buildCatChips();
    buildStatusChips();
    buildLegend();

    document.querySelectorAll(".view-btn").forEach(b =>
      b.addEventListener("click", () => { state.view = b.dataset.view; render(); }));

    searchInput.addEventListener("input", () => { state.search = searchInput.value.trim(); render(); });
    $("#sheetBackdrop").addEventListener("click", closeSheet);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

    render();

    if (hash.startsWith("event=")) {
      const target = decodeURIComponent(hash.slice(6));
      const ev = FEST.events.find(x => x.url === target);
      if (ev) { state.day = ev.date; render(); openSheet(ev.url); }
    }
  }

  init();
})();
