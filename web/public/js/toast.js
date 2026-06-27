(function() {
  // Inject toast container styles globally
  const style = document.createElement('style');
  style.innerHTML = `
    #toast-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }
    
    .yatv-toast {
      background: #2a2e33;
      color: #e0e6ed;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2);
      font-family: 'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 14px;
      font-weight: 500;
      opacity: 0;
      transform: translateY(-20px) scale(0.95);
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      pointer-events: auto;
      border-left: 4px solid #6fdeee;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 350px;
      word-wrap: break-word;
    }

    .yatv-toast.toast-error {
      border-left-color: #ff4d4d;
    }

    .yatv-toast.toast-success {
      border-left-color: #39b54a;
    }

    .yatv-toast.show {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .yatv-toast.hide {
      opacity: 0;
      transform: translateY(-20px) scale(0.95);
      transition: all 0.3s ease-in;
    }

    .yatv-toast-icon {
      font-size: 18px;
    }
  `;
  document.head.appendChild(style);

  window.showToast = function(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'yatv-toast';
    
    let icon = 'ℹ️';
    if (message.toLowerCase().includes('ошибка') || type === 'error') {
      toast.classList.add('toast-error');
      icon = '❌';
    } else if (message.toLowerCase().includes('успешно') || message.toLowerCase().includes('скопирована') || type === 'success') {
      toast.classList.add('toast-success');
      icon = '✅';
    }

    toast.innerHTML = `<span class="yatv-toast-icon">${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    // Trigger reflow for animation
    void toast.offsetWidth;
    toast.classList.add('show');

    // Remove after 3 seconds
    setTimeout(() => {
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 3000);
  };

  // Override native alert globally
  window.alert = function(message) {
    window.showToast(message);
  };
})();
