/* === 10-page-actions.js (lines 3110-3184) === */
document.addEventListener('DOMContentLoaded', () => {
  const userContextMenu = document.getElementById('user-context-menu');
  const chatMessages = document.getElementById('chat_text_field');
  const socket = io(); // Use the existing or new socket for these actions
  if (userContextMenu && chatMessages) {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.chat-username') && !e.target.closest('#user-context-menu')) {
        if (userContextMenu) userContextMenu.style.display = 'none';
      }
    });
  }
});

window.copyShareLink = function(shortname) {
  if (!shortname) return;
  const link = window.location.origin + '/' + shortname;
  
  function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        alert('Ссылка скопирована в буфер обмена!');
      } else {
        prompt("Скопируйте ссылку на канал:", text);
      }
    } catch (err) {
      prompt("Скопируйте ссылку на канал:", text);
    }
    document.body.removeChild(textArea);
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(link).then(() => {
      alert('Ссылка скопирована в буфер обмена!');
    }).catch(() => fallbackCopyTextToClipboard(link));
  } else {
    fallbackCopyTextToClipboard(link);
  }
};

window.editLiveTitle = function(shortname) {
  const newTitle = prompt('Введите новое название для текущей передачи:');
  if (newTitle !== null) {
    if (!newTitle.trim()) {
      alert('Название не может быть пустым');
      return;
    }
    fetch('/api/channel/live_title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortname, title: newTitle.trim() })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        const span = document.getElementById('current_live_title_span');
        if (span) span.innerText = newTitle.trim();
      } else {
        alert('Ошибка при сохранении: ' + (data.error || 'Неизвестная ошибка'));
      }
    })
    .catch(e => {
      console.error('Error editing live title:', e);
      alert('Ошибка соединения сервера');
    });
  }
};
