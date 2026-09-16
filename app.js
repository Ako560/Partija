(() => {
  'use strict';

  const STORAGE = {
    players: 'karte-score.players.v1',
    active: 'karte-score.active.v1',
    history: 'karte-score.history.v1',
    settings: 'karte-score.settings.v1'
  };

  const RULES = {
    treseta: { label: 'Trešeta', basePoints: 11, lowWins: false, declarations: true, teams: true, minPlayers: 2, maxPlayers: 4 },
    kifameno: { label: 'Kifameno', basePoints: 11, lowWins: true, declarations: true, teams: false, kapot: -11 },
    briskula: { label: 'Briškula', basePoints: null, lowWins: false, declarations: false, teams: true, winnerPerRound: true, minPlayers: 2, maxPlayers: 4 },
    remi: { label: 'Remi', basePoints: null, lowWins: true, declarations: false, teams: false, manualRound: true, minPlayers: 2, maxPlayers: 6 }
  };

  const REMI_SCORES = [-2, -1, ...Array.from({ length: 20 }, (_, i) => i + 1)];
  const isAllowedRemiScore = (value) => REMI_SCORES.includes(Number(value));

  const defaults = {
    settings: { theme: 'light', haptics: true, confirmations: true }
  };

  let page = 'home';
  let setupGame = null;
  let setupSelectedPlayers = [];
  let setupPlayMode = null;
  let setupTeamNames = { a: '', b: '' };
  let modalAfterClose = null;

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const modalRoot = document.getElementById('modal-root');

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const nowIso = () => new Date().toISOString();
  const esc = (s) => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));

  function load(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getPlayers() { return load(STORAGE.players, []); }
  function setPlayers(v) { save(STORAGE.players, v); }
  function getHistory() { return load(STORAGE.history, []); }
  function setHistory(v) { save(STORAGE.history, v); }
  function getActive() { return load(STORAGE.active, null); }
  function setActive(v) { v ? save(STORAGE.active, v) : localStorage.removeItem(STORAGE.active); }
  function getSettings() { return { ...defaults.settings, ...load(STORAGE.settings, {}) }; }
  function setSettings(v) { save(STORAGE.settings, v); applyTheme(); }

  function applyTheme() {
    const settings = getSettings();
    document.documentElement.classList.toggle('light', settings.theme === 'light');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', settings.theme === 'light' ? '#ede6d8' : '#07100c');
  }

  function haptic(ms = 20) {
    if (getSettings().haptics && navigator.vibrate) navigator.vibrate(ms);
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 1700);
  }

  function formatDate(iso) {
    return new Intl.DateTimeFormat('hr-HR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));
  }

  function playerById(id) { return getPlayers().find(p => p.id === id); }
  function pName(id) { return playerById(id)?.name || 'Igrač'; }

  function getTeamForPlayer(game, playerId) {
    return (game.teams || []).find(t => (t.playerIds || []).includes(playerId));
  }

  function participantName(game, id) {
    if (game.teamMode) return game.teams?.find(t => t.id === id)?.name || 'Tim';
    return pName(id);
  }

  function scoreParticipantIds(game) {
    return game.teamOnly ? (game.teams || []).map(t => t.id) : (game.playerIds || []);
  }

  function scoreParticipantName(game, id) {
    return game.teamOnly ? participantName(game, id) : pName(id);
  }

  function scoreParticipantTotal(game, id) {
    return game.teamOnly ? teamTotal(game, id) : playerTotal(game, id);
  }

  function briskulaParticipants(game) {
    return game.teamMode
      ? (game.teams || []).map(t => ({ id: t.id, name: t.name }))
      : game.playerIds.map(id => ({ id, name: pName(id) }));
  }

  function ensureDraft(game) {
    if (!game.draft) game.draft = { scores: {}, autoAssignedId: null, events: [], winnerId: null };
    if (!game.draft.scores) game.draft.scores = {};
    if (!game.draft.events) game.draft.events = [];
    if (!Object.prototype.hasOwnProperty.call(game.draft, 'winnerId')) game.draft.winnerId = null;
    return game.draft;
  }

  function allEvents(game) {
    return (game.rounds || []).flatMap(r => r.events || []);
  }

  function playerTotal(game, playerId) {
    let total = 0;
    for (const round of game.rounds || []) total += Number(round.scores?.[playerId] ?? 0);
    for (const e of allEvents(game)) {
      if (e.playerId === playerId) total += Number(e.points || 0);
    }
    return total;
  }

  function teamTotal(game, teamId) {
    const team = (game.teams || []).find(t => t.id === teamId);
    if (!team) return 0;

    if (game.teamOnly) {
      let total = 0;
      for (const round of game.rounds || []) total += Number(round.scores?.[teamId] ?? 0);
      for (const e of allEvents(game)) {
        if (e.teamId === teamId) total += Number(e.points || 0);
      }
      return total;
    }

    let total = (team.playerIds || []).reduce((sum, pid) => sum + playerTotal(game, pid), 0);
    for (const e of allEvents(game)) {
      if (e.teamId === teamId && !e.playerId) total += Number(e.points || 0);
    }
    return total;
  }

  function briskulaScoreboard(game) {
    const participants = briskulaParticipants(game);
    const wins = Object.fromEntries(participants.map(p => [p.id, 0]));

    for (const round of game.rounds || []) {
      if (round.winnerId && Object.prototype.hasOwnProperty.call(wins, round.winnerId)) {
        wins[round.winnerId] += 1;
      } else if (!game.teamMode && round.scores) {
        // Podrška za eventualne stare Briškula partije iz prve verzije aplikacije.
        for (const p of participants) wins[p.id] += Number(round.scores[p.id] || 0);
      }
    }

    return participants
      .map(p => ({ id: p.id, name: p.name, score: wins[p.id] || 0 }))
      .sort((a, b) => b.score - a.score);
  }

  function scoreboard(game) {
    if (game.type === 'briskula') return briskulaScoreboard(game);

    const lowWins = RULES[game.type].lowWins;
    const items = game.teamMode
      ? game.teams.map(t => ({ id: t.id, name: t.name, score: teamTotal(game, t.id) }))
      : game.playerIds.map(pid => ({ id: pid, name: pName(pid), score: playerTotal(game, pid) }));

    return items.sort((a, b) => lowWins ? a.score - b.score : b.score - a.score);
  }

  function openModal(content, afterClose = null) {
    modalAfterClose = afterClose;
    modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-close="backdrop"><div class="modal" role="dialog" aria-modal="true">${content}</div></div>`;
  }

  function closeModal() {
    modalRoot.innerHTML = '';
    const fn = modalAfterClose;
    modalAfterClose = null;
    if (fn) fn();
  }

  function confirmAction(title, text, onConfirm, confirmLabel = 'Potvrdi') {
    if (!getSettings().confirmations) return onConfirm();
    openModal(`
      <h2>${esc(title)}</h2>
      <p>${esc(text)}</p>
      <div class="modal-actions">
        <button class="btn" data-modal-close="1">Odustani</button>
        <button class="btn danger" id="confirm-modal-action">${esc(confirmLabel)}</button>
      </div>
    `);
    document.getElementById('confirm-modal-action').onclick = () => {
      closeModal();
      onConfirm();
    };
  }

  function uiIcon(name, className = '') {
    const icons = {
      home: '<path d="M3 10.8 12 3l9 7.8v8.4a1.8 1.8 0 0 1-1.8 1.8h-4.8v-6.3H9.6V21H4.8A1.8 1.8 0 0 1 3 19.2z"/>',
      users: '<path d="M16 20v-1.4c0-2.4-2.3-4.3-5.2-4.3s-5.2 1.9-5.2 4.3V20"/><circle cx="10.8" cy="8.2" r="3.2"/><path d="M16.3 14.7c1.8.6 3.1 2 3.1 3.8V20M15.5 5.7a3 3 0 0 1 0 5.4"/>',
      history: '<path d="M4 5v5h5"/><path d="M5.2 16.7a8 8 0 1 0-1-8.8"/><path d="M12 7.5v5l3.3 2"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
      chevron: '<path d="m9 6 6 6-6 6"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      play: '<path d="m9 7 8 5-8 5z"/>',
      cards: '<rect x="5" y="5" width="10" height="14" rx="2" transform="rotate(-8 10 12)"/><rect x="9" y="4" width="10" height="14" rx="2" transform="rotate(8 14 11)"/>'
    };
    return `<svg class="ui-icon ${esc(className)}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.cards}</svg>`;
  }

  function gameMeta(key) {
    const meta = {
      treseta: { note: '2, 3 ili 4 igrača' },
      briskula: { note: '2, 3 ili 4 igrača' },
      remi: { note: '2 do 6 igrača' },
      kifameno: { note: '2, 3 ili 4 igrača' }
    };
    return meta[key] || { note: '' };
  }

  function gameVisual(key) {
    const symbols = {
      treseta: ['♣', '●', '✦'],
      briskula: ['♠', '⚔', '◆'],
      remi: ['♦', '●', '◇'],
      kifameno: ['♥', '◉', '◌']
    };
    const [main, second, third] = symbols[key] || symbols.treseta;
    return `<div class="game-motif motif-${esc(key)}" aria-hidden="true">
      <span class="motif-main">${main}</span>
      <span class="motif-second">${second}</span>
      <span class="motif-third">${third}</span>
    </div>`;
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || '?';
  }

  function formatHomeDate(iso) {
    if (!iso) return '';
    return new Intl.DateTimeFormat('hr-HR', { day: '2-digit', month: '2-digit' }).format(new Date(iso));
  }

  function shell(content, activeNav = page) {
    return `<div class="app-shell">
      ${content}
      <nav class="bottom-nav" aria-label="Glavna navigacija">
        <button class="nav-btn ${activeNav === 'home' ? 'active' : ''}" data-nav="home">${uiIcon('home')}<span>Početna</span></button>
        <button class="nav-btn ${activeNav === 'players' ? 'active' : ''}" data-nav="players">${uiIcon('users')}<span>Igrači</span></button>
        <button class="nav-btn ${activeNav === 'history' ? 'active' : ''}" data-nav="history">${uiIcon('history')}<span>Povijest</span></button>
        <button class="nav-btn ${activeNav === 'settings' ? 'active' : ''}" data-nav="settings">${uiIcon('settings')}<span>Postavke</span></button>
      </nav>
    </div>`;
  }

  function topbar(title, meta = '', back = null) {
    const isHomeBrand = !back && title === 'Partija';
    if (isHomeBrand) {
      return `<header class="topbar topbar-home">
        <div class="partija-brand" aria-label="Partija">
          <span class="brand-suit" aria-hidden="true">♣</span>
          <div><div class="partija-title">PARTIJA</div>${meta ? `<div class="partija-subtitle">${esc(meta)}</div>` : ''}</div>
          <span class="brand-suit" aria-hidden="true">♠</span>
        </div>
        <button class="icon-btn top-settings" data-nav="settings" aria-label="Postavke">${uiIcon('settings')}</button>
      </header>`;
    }

    return `<header class="topbar topbar-page">
      <div class="page-heading">
        ${back ? `<button class="icon-btn" data-nav="${esc(back)}" aria-label="Natrag">${uiIcon('back')}</button>` : ''}
        <div class="page-title-wrap">
          <div class="page-eyebrow">PARTIJA</div>
          <div class="brand">${esc(title)}${meta ? `<small>${esc(meta)}</small>` : ''}</div>
        </div>
      </div>
      ${getActive() && page !== 'game' ? `<button class="btn compact active-party-btn" data-nav="game">${uiIcon('play')}<span>Partija</span></button>` : ''}
    </header>`;
  }

  function renderHome() {
    const active = getActive();
    const players = getPlayers();
    const recent = getHistory().slice(0, 4);

    const playerFaces = players.slice(0, 5).map((p, i) => `<span class="mini-avatar avatar-${(i % 5) + 1}" title="${esc(p.name)}">${esc(initials(p.name))}</span>`).join('');

    const recentHtml = recent.length ? recent.map(g => {
      const board = g.finalBoard || scoreboard(g);
      const winner = board?.[0];
      const matchup = (board || []).slice(0, 3).map(x => `${esc(x.name)} <b>${x.score}</b>`).join('<span class="match-sep">·</span>');
      return `<div class="recent-game-row">
        <div class="recent-game-mark game-mark-${esc(g.type)}">${esc((RULES[g.type]?.label || '?').slice(0, 1))}</div>
        <div class="recent-game-main">
          <div class="recent-game-title">${matchup || esc(RULES[g.type]?.label || g.type)}</div>
          <div class="recent-game-meta">${esc(RULES[g.type]?.label || g.type)}${winner ? ` · ${esc(winner.name)}` : ''}</div>
        </div>
        <div class="recent-game-date">${formatHomeDate(g.finishedAt || g.createdAt)}</div>
      </div>`;
    }).join('') : `<div class="home-empty">Završene partije pojavit će se ovdje.</div>`;

    app.innerHTML = shell(`
      ${topbar('Partija', 'Dnevnik igara')}

      ${active ? `<button class="active-game-panel" data-nav="game">
        <span class="active-game-icon">${uiIcon('play')}</span>
        <span class="active-game-copy"><small>Aktivna partija</small><strong>${esc(RULES[active.type]?.label || active.type)}</strong></span>
        <span class="active-game-round">Runda ${(active.rounds?.length || 0) + 1}</span>
        ${uiIcon('chevron')}
      </button>` : ''}

      <div class="home-section-head">
        <div class="section-title">Nova runda</div>
      </div>
      <div class="game-grid premium-game-grid">
        ${Object.entries(RULES).map(([key, r]) => {
          const meta = gameMeta(key);
          return `
          <button class="game-card game-card-${key}" data-start-game="${key}" aria-label="Pokreni ${esc(r.label)}">
            <div class="game-card-copy">
              <strong>${r.label}</strong>
              <span class="game-card-note">${esc(meta.note)}</span>
            </div>
            <div class="game-card-art">${gameVisual(key)}</div>
            <span class="game-card-arrow" aria-hidden="true">${uiIcon('chevron')}</span>
          </button>`;
        }).join('')}
      </div>

      <div class="home-section-head">
        <div class="section-title">Moja ekipa</div>
        <button class="text-link" data-nav="players">Uredi ${uiIcon('chevron')}</button>
      </div>
      <button class="crew-card" data-nav="players">
        <div class="avatar-stack">${playerFaces || `<span class="mini-avatar avatar-empty">+</span>`}</div>
        <div class="crew-copy"><strong>${players.length ? `${players.length} spremljenih igrača` : 'Dodaj igrače'}</strong><span>${players.length ? players.slice(0, 4).map(p => esc(p.name)).join(' · ') : 'Spremi ekipu za brži početak partije'}</span></div>
        ${uiIcon('chevron')}
      </button>

      <div class="home-section-head">
        <div class="section-title">Posljednje partije</div>
        <button class="text-link" data-nav="history">Vidi sve ${uiIcon('chevron')}</button>
      </div>
      <div class="recent-games-card">${recentHtml}</div>
    `, 'home');
  }

  function renderPlayers() {
    const players = getPlayers();
    app.innerHTML = shell(`
      ${topbar('Igrači')}
      <div class="card">
        <form id="add-player-form" class="row">
          <input class="input" name="name" maxlength="24" placeholder="Ime igrača" autocomplete="off" />
          <button class="btn primary" type="submit">Dodaj</button>
        </form>
      </div>

      <div class="section-title">Spremljeni</div>
      ${players.length ? players.map(p => `
        <div class="card row">
          <strong>${esc(p.name)}</strong>
          <div class="row">
            <button class="btn compact" data-rename-player="${p.id}">Preimenuj</button>
            <button class="btn compact danger" data-delete-player="${p.id}">Obriši</button>
          </div>
        </div>
      `).join('') : `<div class="empty">Nema spremljenih igrača.</div>`}
    `, 'players');
  }

  function renderSetup() {
    if (!setupGame) return renderHome();

    const players = getPlayers();
    const rule = RULES[setupGame];
    const supportsTeamOnly = setupGame === 'treseta' || setupGame === 'briskula';
    const mode = supportsTeamOnly ? setupPlayMode : 'individual';
    const minPlayers = rule.minPlayers ?? 2;
    const maxPlayers = rule.maxPlayers ?? Infinity;
    const validPlayerCount = setupSelectedPlayers.length >= minPlayers && setupSelectedPlayers.length <= maxPlayers;
    const teamNamesValid = setupTeamNames.a.trim() && setupTeamNames.b.trim() && setupTeamNames.a.trim().toLowerCase() !== setupTeamNames.b.trim().toLowerCase();
    const canStart = mode === 'teams' ? Boolean(teamNamesValid) : mode === 'individual' ? validPlayerCount : false;

    app.innerHTML = shell(`
      ${topbar(rule.label, '', 'home')}

      ${supportsTeamOnly ? `
        <div class="section-title">Način igre</div>
        <div class="mode-grid">
          <button class="mode-card ${mode === 'individual' ? 'selected' : ''}" data-setup-mode="individual">
            <strong>Pojedinačno</strong>
          </button>
          <button class="mode-card ${mode === 'teams' ? 'selected' : ''}" data-setup-mode="teams">
            <strong>2 na 2</strong>
          </button>
        </div>
      ` : ''}

      ${mode === 'teams' ? `
        <div class="section-title">Timovi</div>
        <div class="card team-name-card">
          <label class="field">Prvi tim
            <input class="input team-name-input" data-team-name="a" maxlength="28" placeholder="Ime tima" value="${esc(setupTeamNames.a)}" autocomplete="off" />
          </label>
          <label class="field">Drugi tim
            <input class="input team-name-input" data-team-name="b" maxlength="28" placeholder="Ime tima" value="${esc(setupTeamNames.b)}" autocomplete="off" />
          </label>
        </div>
      ` : mode === 'individual' ? `
        <div class="section-title">Igrači</div>
        <div class="card">
          <div class="player-select">
            ${players.map(p => `<button class="player-chip ${setupSelectedPlayers.includes(p.id) ? 'selected' : ''}" data-setup-player="${p.id}">${esc(p.name)}</button>`).join('')}
          </div>
          ${!players.length ? `<div class="empty">Nema spremljenih igrača.</div><button class="btn full" data-nav="players" style="margin-top:10px">Dodaj igrače</button>` : ''}
        </div>
      ` : `
        <div class="setup-placeholder">Odaberi način igre.</div>
      `}

      <div style="height:14px"></div>
      <button class="btn primary full" id="create-game" ${canStart ? '' : 'disabled'}>Započni partiju</button>
    `, '');
  }

  function createGame() {
    const supportsTeamOnly = setupGame === 'treseta' || setupGame === 'briskula';
    const teamOnly = supportsTeamOnly && setupPlayMode === 'teams';
    if (supportsTeamOnly && !setupPlayMode) return toast('Odaberi način igre.');
    if (teamOnly) {
      const a = setupTeamNames.a.trim();
      const b = setupTeamNames.b.trim();
      if (!a || !b) return toast('Upiši oba imena tima.');
      if (a.toLowerCase() === b.toLowerCase()) return toast('Timovi moraju imati različita imena.');
    } else {
      const minPlayers = RULES[setupGame]?.minPlayers ?? 2;
      const maxPlayers = RULES[setupGame]?.maxPlayers ?? Infinity;
      if (setupSelectedPlayers.length < minPlayers || setupSelectedPlayers.length > maxPlayers) {
        return toast(`Odaberi ${minPlayers}${Number.isFinite(maxPlayers) ? `–${maxPlayers}` : '+'} igrača.`);
      }
    }

    if (getActive()) {
      return confirmAction(
        'Aktivna partija postoji',
        'Nova partija će zamijeniti trenutno aktivnu partiju.',
        () => { setActive(null); createGame(); },
        'Nova partija'
      );
    }

    const teams = teamOnly ? [
      { id: uid(), name: setupTeamNames.a.trim(), playerIds: [] },
      { id: uid(), name: setupTeamNames.b.trim(), playerIds: [] }
    ] : [];

    const game = {
      id: uid(),
      type: setupGame,
      playerIds: teamOnly ? [] : [...setupSelectedPlayers],
      teamMode: teamOnly,
      teamOnly,
      teams,
      rounds: [],
      draft: { scores: {}, autoAssignedId: null, events: [], winnerId: null },
      createdAt: nowIso()
    };

    setActive(game);
    page = 'game';
    setupGame = null;
    setupSelectedPlayers = [];
    setupPlayMode = null;
    setupTeamNames = { a: '', b: '' };
    render();
    toast('Partija započeta');
  }

  function draftBaseSum(game) {
    const d = ensureDraft(game);
    return Object.values(d.scores).reduce((sum, value) => sum + Number(value || 0), 0);
  }

  function remainingPoints(game) {
    const base = RULES[game.type].basePoints;
    if (base == null) return null;
    return base - draftBaseSum(game);
  }

  function selectableMaxFor(game, playerId) {
    const base = RULES[game.type].basePoints;
    const d = ensureDraft(game);
    const otherSum = Object.entries(d.scores)
      .filter(([id]) => id !== playerId && id !== d.autoAssignedId)
      .reduce((sum, [, value]) => sum + Number(value || 0), 0);
    const remaining = Math.max(0, base - otherSum);

    // U normalnoj rundi Kifamena pojedini igrač može imati najviše 10.
    // 11 znači Kapot i vodi se isključivo preko posebne Kapot akcije.
    return game.type === 'kifameno' ? Math.min(10, remaining) : remaining;
  }

  function setDraftScore(participantId, value) {
    const game = getActive();
    if (!game) return;
    const d = ensureDraft(game);
    const participantIds = scoreParticipantIds(game);
    if (!participantIds.includes(participantId)) return;

    if (game.type === 'kifameno' && Number(value) > 10) {
      return toast('U Kifamenu 11 znači Kapot.');
    }

    if (d.autoAssignedId === participantId) {
      return toast('Ovaj rezultat je izračunat automatski.');
    }

    if (d.autoAssignedId && d.autoAssignedId !== participantId) {
      delete d.scores[d.autoAssignedId];
      d.autoAssignedId = null;
    }

    d.scores[participantId] = Number(value);

    const unset = participantIds.filter(id => !Object.prototype.hasOwnProperty.call(d.scores, id));
    if (unset.length === 1) {
      const remain = RULES[game.type].basePoints - draftBaseSum(game);

      if (!(game.type === 'kifameno' && remain > 10)) {
        d.scores[unset[0]] = Math.max(0, remain);
        d.autoAssignedId = unset[0];
      }
    }

    setActive(game);
    haptic();
    renderGame();
  }

  function selectBriskulaWinner(winnerId) {
    const game = getActive();
    if (!game || game.type !== 'briskula') return;
    const d = ensureDraft(game);
    d.winnerId = winnerId;
    setActive(game);
    haptic();
    renderGame();
  }

  function addDraftEvent(event) {
    const game = getActive();
    if (!game) return;
    const d = ensureDraft(game);
    d.events.push({ id: uid(), createdAt: nowIso(), ...event });
    setActive(game);
    haptic();
    renderGame();
  }

  function removeDraftEvent(eventId) {
    const game = getActive();
    if (!game) return;
    const d = ensureDraft(game);
    d.events = d.events.filter(e => e.id !== eventId);
    setActive(game);
    renderGame();
  }

  function scoreEntryHtml(game, participantId) {
    const d = ensureDraft(game);
    const selected = Object.prototype.hasOwnProperty.call(d.scores, participantId) ? d.scores[participantId] : null;
    const isAuto = d.autoAssignedId === participantId;
    const max = selectableMaxFor(game, participantId);

    // Ako je ostao samo jedan igrač/tim, njegov rezultat je matematički određen.
    // Ne prikazujemo više beskorisne opcije 0..N nego samo automatski rezultat.
    const buttons = isAuto && selected !== null
      ? `<button class="score-btn selected auto auto-only" disabled>${selected}</button>`
      : Array.from({ length: max + 1 }, (_, i) => i)
          .map(v => `<button class="score-btn ${selected === v ? 'selected' : ''}" data-score-player="${participantId}" data-score-value="${v}">${v}</button>`)
          .join('');

    return `<div class="score-player ${isAuto ? 'auto-player' : ''}">
      <div class="score-header">
        <div>
          <div class="score-name">${esc(scoreParticipantName(game, participantId))}</div>
          <div class="muted tiny">${isAuto ? 'Automatski ostatak' : `Ukupno ${scoreParticipantTotal(game, participantId)}`}</div>
        </div>
        <div class="big-score ${selected !== null ? 'has-value' : ''}">${selected ?? '–'}</div>
      </div>
      <div class="score-buttons ${isAuto ? 'auto-score-buttons' : ''}">${buttons}</div>
    </div>`;
  }

  function remiScoreEntryHtml(game, pid) {
    const d = ensureDraft(game);
    const hasValue = Object.prototype.hasOwnProperty.call(d.scores, pid);
    const value = hasValue ? Number(d.scores[pid]) : null;

    return `<div class="score-player remi-player">
      <div class="score-header">
        <div>
          <div class="score-name">${esc(pName(pid))}</div>
          <div class="muted tiny">Ukupno ${playerTotal(game, pid)}</div>
        </div>
        <div class="big-score">${value ?? '–'}</div>
      </div>
      <div class="score-buttons remi-score-buttons">
        ${REMI_SCORES.map(score => `<button class="score-btn ${value === score ? 'selected' : ''} ${score < 0 ? 'negative' : ''}" data-remi-score-player="${pid}" data-remi-score-value="${score}">${score}</button>`).join('')}
      </div>
    </div>`;
  }

  function setRemiDraftScore(playerId, value) {
    const game = getActive();
    if (!game || game.type !== 'remi') return;
    if (!game.playerIds.includes(playerId) || !isAllowedRemiScore(value)) return;

    const d = ensureDraft(game);
    d.scores[playerId] = Number(value);
    setActive(game);
    haptic();
    renderGame();
  }

  function briskulaWinnerHtml(game) {
    const d = ensureDraft(game);
    const participants = briskulaParticipants(game);

    return `<div class="winner-grid">
      ${participants.map(p => `
        <button class="winner-btn ${d.winnerId === p.id ? 'selected' : ''}" data-briskula-winner="${p.id}">
          <span>${esc(p.name)}</span>
          <strong>${scoreboard(game).find(x => x.id === p.id)?.score || 0}</strong>
        </button>
      `).join('')}
    </div>`;
  }

  function currentScoreboardHtml(game) {
    const board = scoreboard(game);
    const label = game.type === 'briskula' ? 'pobjede' : 'bodovi';

    return `<div class="scoreboard">
      ${board.map((x, i) => `
        <div class="scoreboard-item ${i === 0 && game.rounds.length ? 'leader' : ''}">
          <div>
            <div class="name">${esc(x.name)}</div>
            <div class="muted tiny">${label}</div>
          </div>
          <div class="score">${x.score}</div>
        </div>
      `).join('')}
    </div>`;
  }

  function draftEventsHtml(game) {
    const d = ensureDraft(game);
    if (!d.events.length) return '';

    return `<div class="section-title">Dodano</div>
      ${d.events.map(e => `
        <div class="card row">
          <div>
            <strong>${esc(e.label)}</strong>
            <div class="muted tiny">${e.points > 0 ? '+' : ''}${e.points} · ${e.playerId ? esc(pName(e.playerId)) : esc(game.teams.find(t => t.id === e.teamId)?.name || '')}</div>
          </div>
          <button class="btn compact danger" data-remove-event="${e.id}">Obriši</button>
        </div>
      `).join('')}`;
  }

  function roundHistoryHtml(game) {
    const rounds = [...(game.rounds || [])].reverse();
    if (!rounds.length) return `<div class="empty">Nema spremljenih rundi.</div>`;

    return rounds.map((r, revIndex) => {
      const realIndex = game.rounds.length - 1 - revIndex;

      if (game.type === 'briskula') {
        return `<div class="history-round">
          <div class="row"><strong>Runda ${realIndex + 1}</strong><span class="muted tiny">${formatDate(r.createdAt)}</span></div>
          <div class="round-winner">${esc(participantName(game, r.winnerId))}</div>
          <div class="action-row" style="margin-top:10px">
            <button class="btn" data-edit-round="${r.id}">Uredi</button>
            <button class="btn danger" data-delete-round="${r.id}">Obriši</button>
          </div>
        </div>`;
      }

      const isKapotRound = r.special === 'kapot' || (r.events || []).some(e => e.type === 'kapot');
      const roundParticipants = scoreParticipantIds(game);
      return `<div class="history-round">
        <div class="row"><strong>Runda ${realIndex + 1}</strong><span class="muted tiny">${formatDate(r.createdAt)}</span></div>
        ${isKapotRound ? '' : `<div class="history-grid">${roundParticipants.map(id => `<span>${esc(scoreParticipantName(game, id))}</span><strong>${Number(r.scores?.[id] ?? 0)}</strong>`).join('')}</div>`}
        ${(r.events || []).map(e => `<div class="history-event">${esc(e.label)} · ${e.points > 0 ? '+' : ''}${e.points}${e.playerId ? ` · ${esc(pName(e.playerId))}` : e.teamId ? ` · ${esc(participantName(game, e.teamId))}` : ''}</div>`).join('')}
        <div class="action-row" style="margin-top:10px">
          ${isKapotRound ? '' : `<button class="btn" data-edit-round="${r.id}">Uredi</button>`}
          <button class="btn danger" data-delete-round="${r.id}">Obriši</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderGame() {
    const game = getActive();
    if (!game) {
      page = 'home';
      return renderHome();
    }

    const rule = RULES[game.type];
    const d = ensureDraft(game);
    const isBriskula = game.type === 'briskula';
    const isRemi = game.type === 'remi';
    const remain = remainingPoints(game);
    const roundParticipantIds = scoreParticipantIds(game);

    const allSet = roundParticipantIds.every(id => Object.prototype.hasOwnProperty.call(d.scores, id));
    const allFinite = roundParticipantIds.every(id => Number.isFinite(Number(d.scores[id])));
    const remiScoresValid = game.type !== 'remi' || roundParticipantIds.every(id => isAllowedRemiScore(d.scores[id]));
    const kifamenoScoresValid = game.type !== 'kifameno' || roundParticipantIds.every(id => Number(d.scores[id]) <= 10);
    const validRound = isBriskula
      ? Boolean(d.winnerId)
      : isRemi
        ? allSet && allFinite && remiScoresValid
        : allSet && draftBaseSum(game) === rule.basePoints && kifamenoScoresValid;

    app.innerHTML = shell(`
      ${topbar(rule.label, `Runda ${(game.rounds?.length || 0) + 1}`, 'home')}
      ${currentScoreboardHtml(game)}

      ${isBriskula ? `
        <div class="section-title">Pobjednik runde</div>
        ${briskulaWinnerHtml(game)}
      ` : isRemi ? `
        <div class="section-title">Bodovi runde</div>
        <div>${roundParticipantIds.map(pid => remiScoreEntryHtml(game, pid)).join('')}</div>
      ` : `
        <div class="remaining ${remain === 0 ? 'ok' : ''}">
          <span>Preostalo</span>
          <strong>${remain} / ${rule.basePoints}</strong>
        </div>
        <div>${roundParticipantIds.map(id => scoreEntryHtml(game, id)).join('')}</div>

        <div class="section-title">Dodaci</div>
        <div class="action-row">
          ${rule.declarations ? `<button class="btn" id="add-declaration">Zvanje</button>` : ''}
          <button class="btn" id="add-manual">Ručni bodovi</button>
        </div>
        ${game.type === 'kifameno' ? `<button class="btn danger full" id="add-kapot" style="margin-top:10px">Kapot -11</button>` : ''}
        ${draftEventsHtml(game)}
      `}

      <div class="section-title">Runda</div>
      <button class="btn primary full" id="save-round" ${validRound ? '' : 'disabled'}>Spremi rundu</button>
      <button class="btn ghost full" id="clear-draft" style="margin-top:8px">Očisti unos</button>

      <div class="section-title">Povijest rundi</div>
      ${roundHistoryHtml(game)}

      <div class="section-title">Partija</div>
      <div class="action-row">
        <button class="btn primary" id="finish-game">Završi partiju</button>
        <button class="btn danger" id="abandon-game">Obriši partiju</button>
      </div>
    `, '');
  }

  function saveRound() {
    const game = getActive();
    if (!game) return;
    const d = ensureDraft(game);
    const roundParticipantIds = scoreParticipantIds(game);

    if (game.type === 'briskula') {
      if (!d.winnerId) return toast('Odaberi pobjednika runde.');
      game.rounds.push({
        id: uid(),
        createdAt: nowIso(),
        winnerId: d.winnerId,
        scores: {},
        events: []
      });
    } else if (game.type === 'remi') {
      const allSet = roundParticipantIds.every(id => Object.prototype.hasOwnProperty.call(d.scores, id));
      const allFinite = roundParticipantIds.every(id => Number.isFinite(Number(d.scores[id])));
      const allAllowed = roundParticipantIds.every(id => isAllowedRemiScore(d.scores[id]));
      if (!allSet || !allFinite || !allAllowed) return toast('Odaberi bodove za sve igrače.');
      game.rounds.push({
        id: uid(),
        createdAt: nowIso(),
        scores: Object.fromEntries(roundParticipantIds.map(id => [id, Number(d.scores[id])])),
        events: []
      });
    } else {
      const rule = RULES[game.type];
      const allSet = roundParticipantIds.every(id => Object.prototype.hasOwnProperty.call(d.scores, id));
      const kifamenoScoresValid = game.type !== 'kifameno' || roundParticipantIds.every(id => Number(d.scores[id]) <= 10);
      const valid = allSet && draftBaseSum(game) === rule.basePoints && kifamenoScoresValid;
      if (!valid) return toast(game.type === 'kifameno' ? 'Rasporedi 11 bodova tako da nitko nema više od 10. Za 11 koristi Kapot.' : 'Runda nije ispravno popunjena.');
      game.rounds.push({
        id: uid(),
        createdAt: nowIso(),
        scores: Object.fromEntries(roundParticipantIds.map(id => [id, Number(d.scores[id])])),
        events: [...d.events]
      });
    }

    game.draft = { scores: {}, autoAssignedId: null, events: [], winnerId: null };
    setActive(game);
    haptic(35);
    renderGame();
    toast('Runda spremljena');
  }

  function clearDraft() {
    const game = getActive();
    if (!game) return;
    game.draft = { scores: {}, autoAssignedId: null, events: [], winnerId: null };
    setActive(game);
    renderGame();
  }

  function declarationModal() {
    const game = getActive();
    if (!game) return;

    const targets = game.teamOnly
      ? (game.teams || []).map(t => ({ kind: 'team', id: t.id, name: t.name }))
      : (game.playerIds || []).map(pid => ({ kind: 'player', id: pid, name: pName(pid) }));

    openModal(`
      <h2>Zvanje</h2>
      <p>${game.teamOnly ? 'Odaberi tim.' : 'Odaberi igrača.'}</p>
      <div class="option-list">
        ${targets.map(t => `<button class="option" data-declaration-target="${t.kind}:${t.id}">${esc(t.name)}</button>`).join('')}
      </div>
      <button class="btn ghost full" data-modal-close="1" style="margin-top:10px">Odustani</button>
    `);
  }

  function declarationChoice(kind, targetId) {
    const game = getActive();
    if (!game) return;
    const targetName = kind === 'team' ? participantName(game, targetId) : pName(targetId);

    openModal(`
      <h2>Zvanje · ${esc(targetName)}</h2>
      <label class="field">Naziv zvanja (opcionalno)
        <input class="input" id="declaration-label" maxlength="40" placeholder="Zvanje" />
      </label>
      <div class="section-title modal-section">Bodovi</div>
      <div class="points-grid">
        ${Array.from({ length: 11 }, (_, i) => i + 1).map(points => `<button class="score-btn" data-declaration-points="${points}">+${points}</button>`).join('')}
      </div>
      <input type="hidden" id="declaration-points" value="3" />
      <div class="modal-actions">
        <button class="btn" data-modal-close="1">Odustani</button>
        <button class="btn primary" id="save-declaration" data-kind="${kind}" data-target="${targetId}">Dodaj +3</button>
      </div>
    `);

    const defaultBtn = document.querySelector('[data-declaration-points="3"]');
    defaultBtn?.classList.add('selected');
  }

  function manualPointsModal() {
    const game = getActive();
    if (!game) return;

    const targets = [
      ...game.playerIds.map(pid => ({ kind: 'player', id: pid, name: pName(pid) })),
      ...(game.teamMode ? game.teams.map(t => ({ kind: 'team', id: t.id, name: t.name })) : [])
    ];

    openModal(`
      <h2>Ručni bodovi</h2>
      <label class="field">Kome
        <select class="input" id="manual-target">${targets.map(t => `<option value="${t.kind}:${t.id}">${esc(t.name)}</option>`).join('')}</select>
      </label>
      <label class="field" style="margin-top:10px">Bodovi
        <input class="input" id="manual-points" type="number" inputmode="numeric" value="1" />
      </label>
      <label class="field" style="margin-top:10px">Naziv (opcionalno)
        <input class="input" id="manual-label" placeholder="Ručni bodovi" />
      </label>
      <div class="modal-actions">
        <button class="btn" data-modal-close="1">Odustani</button>
        <button class="btn primary" id="save-manual">Dodaj</button>
      </div>
    `);
  }

  function kapotModal() {
    const game = getActive();
    if (!game) return;

    openModal(`
      <h2>Kapot</h2>
      <p>Odaberi igrača. Odabirom se runda odmah završava, svi uneseni bodovi te runde se odbacuju, a tom igraču se oduzima 11 bodova.</p>
      <div class="option-list">
        ${game.playerIds.map(pid => `<button class="option" data-kapot-player="${pid}">${esc(pName(pid))}<strong style="float:right">-11</strong></button>`).join('')}
      </div>
      <button class="btn ghost full" data-modal-close="1" style="margin-top:10px">Odustani</button>
    `);
  }

  function saveKapotRound(playerId) {
    const game = getActive();
    if (!game || game.type !== 'kifameno') return;
    if (!game.playerIds.includes(playerId)) return;

    // Kapot JE cijela runda. Sve što je eventualno bilo uneseno u trenutni
    // draft se odbacuje: u istoj rundi ne mogu postojati Kapot i obični bodovi.
    const kapotRound = {
      id: uid(),
      createdAt: nowIso(),
      scores: {},
      events: [{
        id: uid(),
        createdAt: nowIso(),
        type: 'kapot',
        playerId,
        points: RULES.kifameno.kapot,
        label: 'Kapot'
      }],
      special: 'kapot'
    };

    game.rounds.push(kapotRound);

    // Odmah otvaramo potpuno novu praznu rundu.
    game.draft = { scores: {}, autoAssignedId: null, events: [], winnerId: null };
    setActive(game);
    haptic(60);
    renderGame();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast(`${pName(playerId)} -11 · nova runda`);
  }

  function editRound(roundId) {
    const game = getActive();
    if (!game) return;
    const idx = game.rounds.findIndex(r => r.id === roundId);
    if (idx < 0) return;

    const round = game.rounds[idx];
    const doEdit = () => {
      game.rounds.splice(idx, 1);
      game.draft = game.type === 'briskula'
        ? { scores: {}, autoAssignedId: null, events: [], winnerId: round.winnerId || null }
        : { scores: { ...round.scores }, autoAssignedId: null, events: [...(round.events || [])], winnerId: null };
      setActive(game);
      renderGame();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('Runda vraćena u unos');
    };

    const d = ensureDraft(game);
    const hasDraft = Object.keys(d.scores).length || d.events.length || d.winnerId;
    if (hasDraft) {
      confirmAction('Zamijeniti trenutni unos?', 'Trenutni nespremljeni unos će biti zamijenjen.', doEdit, 'Uredi');
    } else {
      doEdit();
    }
  }

  function deleteRound(roundId) {
    confirmAction('Obrisati rundu?', 'Ukupni rezultat će se ponovno izračunati.', () => {
      const game = getActive();
      game.rounds = game.rounds.filter(r => r.id !== roundId);
      setActive(game);
      renderGame();
      toast('Runda obrisana');
    }, 'Obriši');
  }

  function finishGame() {
    const game = getActive();
    if (!game || !game.rounds.length) return toast('Prvo spremi barem jednu rundu.');
    const board = scoreboard(game);

    openModal(`
      <h2>Kraj partije</h2>
      <div class="scoreboard" style="margin-top:14px">
        ${board.map((x, i) => `<div class="scoreboard-item ${i === 0 ? 'leader' : ''}"><div class="name">${esc(x.name)}</div><div class="score">${x.score}</div></div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn" data-modal-close="1">Vrati se</button>
        <button class="btn primary" id="archive-game">Spremi i završi</button>
      </div>
    `);

    document.getElementById('archive-game').onclick = () => {
      const g = getActive();
      g.finishedAt = nowIso();
      g.finalBoard = scoreboard(g);
      const history = getHistory();
      history.unshift(g);
      setHistory(history);
      setActive(null);
      closeModal();
      page = 'history';
      render();
      toast('Partija spremljena');
    };
  }

  function renderHistory() {
    const history = getHistory();

    app.innerHTML = shell(`
      ${topbar('Povijest')}
      ${history.length ? history.map(g => {
        const winner = g.finalBoard?.[0];
        return `<div class="card history-game">
          <div class="row">
            <div>
              <strong>${esc(RULES[g.type]?.label || g.type)}</strong>
              <div class="muted tiny">${formatDate(g.finishedAt || g.createdAt)} · ${g.rounds?.length || 0} rundi</div>
            </div>
            <button class="btn compact danger" data-delete-history="${g.id}">Obriši</button>
          </div>
          ${winner ? `<div class="history-winner">${esc(winner.name)} <strong>${winner.score}</strong></div>` : ''}
          <div class="divider"></div>
          ${(g.finalBoard || []).map((x, i) => `<div class="row result-row"><span>${i + 1}. ${esc(x.name)}</span><strong>${x.score}</strong></div>`).join('')}
        </div>`;
      }).join('') : `<div class="empty">Nema završenih partija.</div>`}

      <div class="section-title">Statistika</div>
      ${statsHtml()}
    `, 'history');
  }

  function statsHtml() {
    const players = getPlayers();
    const history = getHistory();
    if (!players.length || !history.length) return `<div class="empty">Nema statistike.</div>`;

    return players.map(p => {
      const games = history.filter(g => g.playerIds?.includes(p.id));
      const wins = games.filter(g => {
        if (g.teamMode) {
          const team = (g.teams || []).find(t => t.playerIds.includes(p.id));
          return g.finalBoard?.[0]?.id === team?.id;
        }
        return g.finalBoard?.[0]?.id === p.id;
      }).length;
      const kapots = games.flatMap(g => allEvents(g)).filter(e => e.type === 'kapot' && e.playerId === p.id).length;
      const calls = games.flatMap(g => allEvents(g)).filter(e => e.type === 'declaration' && e.playerId === p.id).length;

      return `<div class="card row">
        <div>
          <strong>${esc(p.name)}</strong>
          <div class="muted tiny">${games.length} partija · ${wins} pobjeda</div>
        </div>
        <div class="tiny stats-right">Zvanja ${calls}<br>Kapot ${kapots}</div>
      </div>`;
    }).join('');
  }

  function renderSettings() {
    const s = getSettings();

    app.innerHTML = shell(`
      ${topbar('Postavke')}
      <div class="card">
        <div class="switch-row">
          <strong>Svijetla tema</strong>
          <label class="switch"><input type="checkbox" data-setting="theme" ${s.theme === 'light' ? 'checked' : ''}><span></span></label>
        </div>
        <div class="switch-row">
          <strong>Vibracija</strong>
          <label class="switch"><input type="checkbox" data-setting="haptics" ${s.haptics ? 'checked' : ''}><span></span></label>
        </div>
        <div class="switch-row">
          <strong>Potvrda prije brisanja</strong>
          <label class="switch"><input type="checkbox" data-setting="confirmations" ${s.confirmations ? 'checked' : ''}><span></span></label>
        </div>
      </div>

      <div class="section-title">Aplikacija</div>
      <button class="btn full" id="check-update">Provjeri novu verziju</button>

      <div class="section-title">Podaci</div>
      <button class="btn danger full" id="wipe-data">Obriši sve podatke</button>
    `, 'settings');
  }

  function render() {
    applyTheme();
    if (page === 'home') renderHome();
    else if (page === 'players') renderPlayers();
    else if (page === 'setup') renderSetup();
    else if (page === 'game') renderGame();
    else if (page === 'history') renderHistory();
    else if (page === 'settings') renderSettings();
    else renderHome();
  }

  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-modal-close]');
    if (close && (close.dataset.modalClose !== 'backdrop' || e.target.classList.contains('modal-backdrop'))) {
      closeModal();
      return;
    }

    const nav = e.target.closest('[data-nav]');
    if (nav) {
      page = nav.dataset.nav;
      render();
      return;
    }

    const start = e.target.closest('[data-start-game]');
    if (start) {
      setupGame = start.dataset.startGame;
      setupSelectedPlayers = [];
      setupPlayMode = (setupGame === 'treseta' || setupGame === 'briskula') ? null : 'individual';
      setupTeamNames = { a: '', b: '' };
      page = 'setup';
      render();
      return;
    }

    const setupMode = e.target.closest('[data-setup-mode]');
    if (setupMode) {
      setupPlayMode = setupMode.dataset.setupMode;
      setupSelectedPlayers = [];
      setupTeamNames = { a: '', b: '' };
      renderSetup();
      return;
    }

    const setupP = e.target.closest('[data-setup-player]');
    if (setupP) {
      const id = setupP.dataset.setupPlayer;
      if (setupSelectedPlayers.includes(id)) {
        setupSelectedPlayers = setupSelectedPlayers.filter(x => x !== id);
      } else {
        const maxPlayers = RULES[setupGame]?.maxPlayers ?? Infinity;
        if (setupSelectedPlayers.length >= maxPlayers) return toast(`${RULES[setupGame].label}: najviše ${maxPlayers} igrača.`);
        setupSelectedPlayers.push(id);
      }
      renderSetup();
      return;
    }

    if (e.target.closest('#create-game')) return createGame();

    const scoreBtn = e.target.closest('[data-score-player]');
    if (scoreBtn) return setDraftScore(scoreBtn.dataset.scorePlayer, Number(scoreBtn.dataset.scoreValue));

    const remiScoreBtn = e.target.closest('[data-remi-score-player]');
    if (remiScoreBtn) return setRemiDraftScore(remiScoreBtn.dataset.remiScorePlayer, Number(remiScoreBtn.dataset.remiScoreValue));

    const briskulaWinner = e.target.closest('[data-briskula-winner]');
    if (briskulaWinner) return selectBriskulaWinner(briskulaWinner.dataset.briskulaWinner);

    if (e.target.closest('#add-declaration')) return declarationModal();

    const decTarget = e.target.closest('[data-declaration-target]');
    if (decTarget) {
      const [kind, id] = decTarget.dataset.declarationTarget.split(':');
      return declarationChoice(kind, id);
    }

    const decPoints = e.target.closest('[data-declaration-points]');
    if (decPoints) {
      const points = Number(decPoints.dataset.declarationPoints);
      document.getElementById('declaration-points').value = String(points);
      document.querySelectorAll('[data-declaration-points]').forEach(btn => btn.classList.remove('selected'));
      decPoints.classList.add('selected');
      const saveBtn = document.getElementById('save-declaration');
      if (saveBtn) saveBtn.textContent = `Dodaj +${points}`;
      return;
    }

    const saveDeclaration = e.target.closest('#save-declaration');
    if (saveDeclaration) {
      const kind = saveDeclaration.dataset.kind;
      const targetId = saveDeclaration.dataset.target;
      const points = Number(document.getElementById('declaration-points').value);
      const customLabel = document.getElementById('declaration-label').value.trim();
      if (!Number.isFinite(points) || points <= 0) return;
      closeModal();
      addDraftEvent({
        type: 'declaration',
        points,
        label: customLabel || 'Zvanje',
        ...(kind === 'team' ? { teamId: targetId } : { playerId: targetId })
      });
      return;
    }

    if (e.target.closest('#add-manual')) return manualPointsModal();

    const saveManual = e.target.closest('#save-manual');
    if (saveManual) {
      const [kind, id] = document.getElementById('manual-target').value.split(':');
      const points = Number(document.getElementById('manual-points').value);
      const label = document.getElementById('manual-label').value.trim() || 'Ručni bodovi';
      if (!Number.isFinite(points)) return;
      closeModal();
      addDraftEvent({ type: 'manual', points, label, ...(kind === 'player' ? { playerId: id } : { teamId: id }) });
      return;
    }

    if (e.target.closest('#add-kapot')) return kapotModal();

    const kapotP = e.target.closest('[data-kapot-player]');
    if (kapotP) {
      const pid = kapotP.dataset.kapotPlayer;
      closeModal();
      saveKapotRound(pid);
      return;
    }

    const removeEvent = e.target.closest('[data-remove-event]');
    if (removeEvent) return removeDraftEvent(removeEvent.dataset.removeEvent);

    if (e.target.closest('#save-round')) return saveRound();
    if (e.target.closest('#clear-draft')) return confirmAction('Očistiti unos?', 'Briše se samo nespremljeni unos trenutne runde.', clearDraft, 'Očisti');

    const editR = e.target.closest('[data-edit-round]');
    if (editR) return editRound(editR.dataset.editRound);

    const delR = e.target.closest('[data-delete-round]');
    if (delR) return deleteRound(delR.dataset.deleteRound);

    if (e.target.closest('#finish-game')) return finishGame();
    if (e.target.closest('#abandon-game')) {
      return confirmAction('Obrisati aktivnu partiju?', 'Ovo se ne može vratiti.', () => {
        setActive(null);
        page = 'home';
        render();
      }, 'Obriši');
    }

    const rename = e.target.closest('[data-rename-player]');
    if (rename) {
      const p = playerById(rename.dataset.renamePlayer);
      openModal(`
        <h2>Preimenuj igrača</h2>
        <input class="input" id="rename-input" maxlength="24" value="${esc(p?.name || '')}">
        <div class="modal-actions">
          <button class="btn" data-modal-close="1">Odustani</button>
          <button class="btn primary" id="save-rename">Spremi</button>
        </div>
      `);
      document.getElementById('save-rename').onclick = () => {
        const name = document.getElementById('rename-input').value.trim();
        if (!name) return;
        const list = getPlayers();
        const item = list.find(x => x.id === rename.dataset.renamePlayer);
        if (item) item.name = name;
        setPlayers(list);
        closeModal();
        renderPlayers();
      };
      return;
    }

    const delP = e.target.closest('[data-delete-player]');
    if (delP) {
      return confirmAction('Obrisati igrača?', 'Igrač će biti maknut iz spremljenog popisa.', () => {
        setPlayers(getPlayers().filter(p => p.id !== delP.dataset.deletePlayer));
        renderPlayers();
      }, 'Obriši');
    }

    const delH = e.target.closest('[data-delete-history]');
    if (delH) {
      return confirmAction('Obrisati zapis?', 'Briše se ova završena partija.', () => {
        setHistory(getHistory().filter(g => g.id !== delH.dataset.deleteHistory));
        renderHistory();
      }, 'Obriši');
    }

    if (e.target.closest('#check-update')) {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration()
          .then(reg => reg?.update())
          .then(() => toast('Provjera završena.'));
      } else {
        toast('Update nije dostupan.');
      }
      return;
    }

    if (e.target.closest('#wipe-data')) {
      return confirmAction('Obrisati sve podatke?', 'Brišu se igrači, aktivna partija, povijest i postavke na ovom uređaju.', () => {
        Object.values(STORAGE).forEach(k => localStorage.removeItem(k));
        page = 'home';
        applyTheme();
        render();
        toast('Podaci obrisani');
      }, 'Obriši sve');
    }
  });

  document.addEventListener('input', (e) => {
    const teamKey = e.target.dataset?.teamName;
    if (!teamKey || !Object.prototype.hasOwnProperty.call(setupTeamNames, teamKey)) return;

    setupTeamNames[teamKey] = e.target.value;
    const createBtn = document.getElementById('create-game');
    if (createBtn) {
      const a = setupTeamNames.a.trim();
      const b = setupTeamNames.b.trim();
      createBtn.disabled = !(a && b && a.toLowerCase() !== b.toLowerCase());
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'add-player-form') return;
    e.preventDefault();

    const input = e.target.elements.name;
    const name = input.value.trim();
    if (!name) return;

    const players = getPlayers();
    players.push({ id: uid(), name, createdAt: nowIso() });
    setPlayers(players);
    input.value = '';
    renderPlayers();
    toast('Igrač dodan');
  });

  document.addEventListener('change', (e) => {
    const setting = e.target.dataset.setting;
    if (!setting) return;

    const s = getSettings();
    if (setting === 'theme') s.theme = e.target.checked ? 'light' : 'dark';
    else s[setting] = e.target.checked;
    setSettings(s);
    renderSettings();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        await reg.update();
      } catch (err) {
        console.warn('PWA registracija nije uspjela:', err);
      }
    });
  }

  applyTheme();
  render();
})();
