# Weblate для ЭтоЯTV

Weblate **не обязателен**, чтобы сайт заработал. UI-переводы уже лежат в `web/locales/*.json` (`ru`, `en`, `uk`, `be`, …) и подхватываются приложением при старте (с hot-reload при изменении файлов).

Weblate нужен, если хотите:

- дать переводчикам веб-UI без правки JSON руками;
- принимать community-переводы;
- показывать ссылку «Weblate» в футере сайта (`WEBLATE_URL`).

## Как это стыкуется с сайтом

```text
Переводчики → Weblate → коммит/PR в git (web/locales/*.json) → деплой web
                                                      ↘ fs.watch hot-reload
```

Приложение **не ходит в Weblate API** за строками в рантайме. Оно читает только файлы в `web/locales/`. Weblate — отдельный сервис для людей.

## Поднятие (официальный Docker)

Рекомендуемый путь — upstream-репозиторий Weblate:

```bash
git clone https://github.com/WeblateOrg/docker-compose.git weblate-docker
cd weblate-docker
```

1. Скопируйте и отредактируйте `environment` / override под себя:
   - `WEBLATE_SITE_DOMAIN=weblate.yourdomain.com`
   - `WEBLATE_ADMIN_EMAIL` / `WEBLATE_ADMIN_PASSWORD` (свои!)
   - SMTP при необходимости
   - `WEBLATE_ALLOWED_HOSTS=*`
   - за reverse-proxy: `WEBLATE_SECURE_PROXY_SSL_HEADER=HTTP_X_FORWARDED_PROTO,https`
2. Пробросьте порт (часто `80→8080`) или повесьте Nginx на контейнер.
3. Запуск:

```bash
docker compose up -d
```

Документация: https://docs.weblate.org/en/latest/admin/install/docker.html

## Nginx (пример)

```nginx
server {
    server_name weblate.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8080;  # порт из вашего compose
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    listen 443 ssl;
    # ssl_certificate ...;
}
```

## Проект в Weblate

1. Создайте проект/компонент, указывающий на git-репозиторий ЭтоЯTV.  
2. Файлы переводов: `web/locales/*.json` (формат JSON).  
3. Базовый язык обычно `ru`.  
4. Настройте push в git (или PR), чтобы изменения попадали в рабочую копию / CI.  
5. После появления новых JSON на сервере web либо сделайте `docker compose restart app`, либо дождитесь `fs.watch` (если каталог смонтирован в контейнер).

## Связь с `web/.env`

```env
WEBLATE_URL=https://weblate.yourdomain.com/
```

Пустая/`не задана` — в футере ссылки не будет (или останется дефолт из кода — лучше задать явно свой URL или отключить по желанию).

## Что Weblate НЕ переводит

Пользовательский контент (чат, описания, комменты) идёт через **машинный перевод** (`/api/translate`):

1. `LIBRETRANSLATE_URL` — свой LibreTranslate (предпочтительно);  
2. иначе MyMemory + опционально `TRANSLATE_EMAIL` для большего бесплатного лимита.

См. раздел LibreTranslate в основном README.
