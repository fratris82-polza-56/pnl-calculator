# Публикация дашборда «Звезда» во внешний интернет — параметры для админа

## Текущее состояние
- Приложение: контейнер `plan-zvezda` на ВМ `zvyagin-ai.polza.ru` (внутренний IP `10.230.0.118`), HTTP-порт **8080** (0.0.0.0:8080->8080/tcp).
- Протокол: обычный HTTP/1.1 JSON API + статика. **WebSocket нет**, SSE нет, загрузок файлов нет. Тело запросов/ответов — JSON, лимит ~1 МБ.
- Авторизация: Bearer-токен + HttpOnly-cookie `pz_sess`; сервер сам отдаёт `Secure` у cookie, когда видит `x-forwarded-proto: https`.
- Публичный доступ безопасен: без кода аноним видит только экран входа `/me.html` и `/api/health`; данные закрыты гейтом (401/403), есть анти-брутфорс на вход.

## Что нужно от админа
Публичная HTTPS-терминация перед `http://10.230.0.118:8080`.

### Вариант A — vhost на существующем nginx/Caddy (предпочтительно)
- Домен: любой выданный, например `zvezda.polza.ru` (приложение к домену не привязано, все редиректы относительные).
- TLS-сертификат: Let's Encrypt на стороне прокси.
- Проксирование:
  - обязательный заголовок `X-Forwarded-Proto: https` (от него зависит Secure-cookie);
  - `Host`, `X-Forwarded-For` — стандартно;
  - таймауты: 60 с достаточно (запросы < 1 с);
  - клиентский буфер/лимит тела: 2 МБ хватит.

Пример nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name zvezda.polza.ru;
  # ssl_certificate / ssl_certificate_key — Let's Encrypt

  location / {
    proxy_pass http://10.230.0.118:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 60s;
    client_max_body_size 2m;
  }
}
server { listen 80; server_name zvezda.polza.ru; return 301 https://$host$request_uri; }
```

Пример Caddy (TLS сам):

```
zvezda.polza.ru {
  reverse_proxy 10.230.0.118:8080
}
```

### Вариант B — Cloudflare Tunnel (белый IP и открытые порты не нужны)
На ВМ ставится `cloudflared`, туннель на `http://localhost:8080`, в Zero Trust назначается публичный hostname. HTTPS и сертификат — на стороне Cloudflare. Заголовок `X-Forwarded-Proto` cloudflared проставляет сам.

## Проверка после настройки (со стороны клиента)
1. `https://<домен>/api/health` → `{"ok":true,...}` (200).
2. Открыть `https://<домен>/me.html` → экран входа.
3. Открыть `https://<домен>/api/summary` без входа → 401 JSON (данные закрыты).
4. Войти с M-кодом руководителя → попадаешь на общий дашборд `https://<домен>/`.
5. DevTools → Application → Cookies: `pz_sess` с флагами HttpOnly и **Secure**.

## Чего делать НЕ нужно
- Ничего в приложении менять не требуется — оно proxy-agnostic.
- Открывать 8080 наружу напрямую (без TLS) не нужно — только через прокси.
- Firewall ВМ трогать не нужно, если прокси в той же сети видит 10.230.0.118:8080.
