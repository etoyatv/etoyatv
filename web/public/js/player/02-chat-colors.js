/* === 02-chat-colors.js (lines 758-776) === */
  // --- Active Chat Users Colors & Reply Verification ---
  const chatUserColors = {};

  function registerUserColor(username, color) {
    if (!username) return;
    chatUserColors[username.toLowerCase()] = color || '#3b9cd9';
  }

  function initUserColorsMap() {
    document.querySelectorAll('.chat-username').forEach(el => {
      const username = el.getAttribute('data-username');
      const color = el.getAttribute('data-color') || el.style.color;
      registerUserColor(username, color);
    });
  }

  // Initialize colors from existing elements on load
  initUserColorsMap();

