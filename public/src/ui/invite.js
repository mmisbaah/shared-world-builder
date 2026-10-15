const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export function normalizeInviteCode(value) {
  return String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function inviteLink(code) {
  const url = new URL(window.location.pathname, window.location.origin);
  url.hash = 'join=' + code;
  return url.toString();
}

export function enterRoom() {
  const gate = document.getElementById('invite-gate');
  const form = document.getElementById('invite-form');
  const input = document.getElementById('invite-code');
  const error = document.getElementById('invite-error');
  const button = document.getElementById('invite-submit');
  const linked = new URLSearchParams(window.location.hash.slice(1)).get('join');
  if (linked) input.value = normalizeInviteCode(linked);

  return new Promise((resolve) => {
    async function submit() {
      const code = normalizeInviteCode(input.value);
      if (!CODE_PATTERN.test(code)) {
        error.textContent = 'Enter the 8-character code from your friend.';
        input.focus();
        return;
      }
      button.disabled = true;
      error.textContent = 'Checking code…';
      try {
        const response = await fetch('/api/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        if (!response.ok) {
          error.textContent = response.status === 403
            ? 'That code is not valid for this world.'
            : 'Could not join right now. Try again.';
          return;
        }
        window.history.replaceState(null, '', inviteLink(code));
        gate.classList.add('gone');
        resolve(code);
      } catch {
        error.textContent = 'Cannot reach the game server. Try again.';
      } finally {
        button.disabled = false;
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submit();
    });
    if (linked) void submit();
    else input.focus();
  });
}
