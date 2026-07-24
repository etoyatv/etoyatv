# Sample media layout

Каталог имитирует структуру `MEDIA_STORAGE_PATH` (CDN / SMB).

```text
samples/media/
├── images/
│   ├── default_channel_logo.png
│   ├── default_user_avatar.png
│   ├── logo.svg
│   ├── avatars/          # аватары пользователей
│   └── design/           # оформление каналов
├── uploads/
│   ├── records/          # исходники записей
│   ├── hls/              # HLS VOD
│   └── ads/
├── tvsnapshots/          # превью эфиров
├── js/                   # копия player.js / toast.js для CDN
└── private/
    ├── exports/          # архивы экспорта профиля
    └── transfers/        # импорт/трансферы
```

## Локальный запуск без CDN

В `web/.env` и `rtmp/.env`:

```env
MEDIA_STORAGE_PATH=/absolute/path/to/repo/samples/media
CDN_BASE_URL=
```

Либо смонтируйте этот каталог в compose как `/mnt/smb_media/public`.

## Production

1. Создайте те же подкаталоги на сетевом диске.
2. Укажите `MEDIA_STORAGE_PATH` на хосте и в `.env`.
3. Отдайте корень диска через Nginx как CDN (`CDN_BASE_URL`).
4. После деплоя **синхронизируйте** `web/public/js/*.js` в `{MEDIA}/js/` — иначе CDN будет отдавать устаревший `player.js` / `toast.js`.
