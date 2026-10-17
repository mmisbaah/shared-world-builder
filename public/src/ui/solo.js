import { SOLO_BOTS, soloTeam } from '../../../shared/soloBots.js';

const STORE_KEY = 'swb-solo-games-v1';
const GAME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function savedGames() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((game) => GAME_ID.test(game?.gameId) && soloTeam(game?.teamIds));
  } catch {
    return [];
  }
}

function saveGames(games) {
  localStorage.setItem(STORE_KEY, JSON.stringify(games));
}

async function startGame(game) {
  const response = await fetch('/api/solo/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(game),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? 'Could not start the game');
  }
  return game;
}

export function enterSoloGame() {
  const gate = document.getElementById('solo-gate');
  const roster = document.getElementById('solo-roster');
  const saved = document.getElementById('solo-saves');
  const count = document.getElementById('solo-count');
  const start = document.getElementById('solo-start');
  const error = document.getElementById('solo-error');
  const chosen = [];
  const games = savedGames();

  // Old friend links open the solo selector; they cannot connect to another player.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  gate.hidden = false;

  return new Promise((resolve) => {
    const finish = (game) => {
      gate.hidden = true;
      resolve(game);
    };
    const fail = (message) => { error.textContent = message; };

    function renderCards() {
      roster.replaceChildren();
      for (const bot of SOLO_BOTS) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'solo-bot';
        card.setAttribute('aria-pressed', String(chosen.includes(bot.id)));
        const swatch = document.createElement('span');
        swatch.className = 'solo-bot-swatch';
        swatch.style.backgroundColor = bot.color;
        const details = document.createElement('span');
        details.className = 'solo-bot-details';
        const name = document.createElement('strong');
        name.textContent = bot.name;
        const caption = document.createElement('small');
        caption.textContent = bot.blurb;
        details.append(name, caption);
        card.append(swatch, details);
        card.addEventListener('click', () => {
          const index = chosen.indexOf(bot.id);
          if (index >= 0) chosen.splice(index, 1);
          else if (chosen.length < 3) chosen.push(bot.id);
          error.textContent = '';
          count.textContent = chosen.length + ' / 3 selected';
          start.disabled = chosen.length !== 3;
          renderCards();
        });
        roster.append(card);
      }
    }

    function renderSaves() {
      saved.replaceChildren();
      if (!games.length) {
        saved.hidden = true;
        return;
      }
      saved.hidden = false;
      for (const game of [...games].reverse()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'solo-save';
        const names = game.teamIds.map((id) => SOLO_BOTS.find((bot) => bot.id === id)?.name).join(', ');
        const date = new Date(game.createdAt || Date.now()).toLocaleDateString();
        button.textContent = 'Continue · ' + names + ' · ' + date;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            finish(await startGame(game));
          } catch (cause) {
            fail(cause.message);
            button.disabled = false;
          }
        });
        saved.append(button);
      }
    }

    start.addEventListener('click', async () => {
      if (chosen.length !== 3) return;
      start.disabled = true;
      error.textContent = 'Creating your world…';
      const game = {
        gameId: crypto.randomUUID(),
        teamIds: [...chosen],
        createdAt: new Date().toISOString(),
      };
      try {
        await startGame(game);
        games.push(game);
        saveGames(games);
        finish(game);
      } catch (cause) {
        fail(cause.message);
        start.disabled = false;
      }
    });

    renderCards();
    renderSaves();
  });
}
