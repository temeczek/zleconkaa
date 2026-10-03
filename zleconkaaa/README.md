# Zlecenka

Serwer bez zależności (Node.js 22.13+, wbudowany SQLite).

    BASE_URL=https://twojadomena.pl ADMIN_TOKEN=... STRIPE_SECRET_KEY=sk_... STRIPE_WEBHOOK_SECRET=whsec_... NODE_ENV=production node server.js

- `PORT` (domyślnie 3000), `DB_FILE` (domyślnie zlecenka.db): rób kopie zapasowe tego pliku.
- Za serwerem ustaw HTTPS (np. Caddy lub nginx) i przekazuj nagłówek `X-Forwarded-For`.
- **Stripe:** w panelu dodaj webhook `https://twojadomena.pl/api/stripe-webhook` ze zdarzeniem `checkout.session.completed` i wklej sekret do `STRIPE_WEBHOOK_SECRET`. Metody płatności (BLIK, Przelewy24) włączasz w panelu Stripe.
- **Zwroty:** `curl -H "x-admin-token: $ADMIN_TOKEN" https://twojadomena.pl/api/admin/reports` pokazuje zgłoszenia, a `curl -X POST -H "x-admin-token: $ADMIN_TOKEN" -d '{"approve":true}' https://twojadomena.pl/api/admin/reports/ID` zwraca punkty (`false` odrzuca).
- **Dokumenty:** uzupełnij pola w `public/legal.html` i usuń czerwoną ramkę.
- Nie ma jeszcze: resetu hasła i weryfikacji e-maila (wymagają wysyłki maili) oraz panelu administratora w przeglądarce.

## E-maile (reset hasła i potwierdzenie adresu)

Serwer wysyła maile przez API Resend (bez zależności): ustaw `RESEND_API_KEY` i `MAIL_FROM="Zlecenka <no-reply@twojadomena.pl>"` (domena musi być zweryfikowana w Resend). Bez klucza potwierdzanie adresu jest wyłączone, a reset hasła niedostępny. Do lokalnych testów użyj `MAIL_DEV=1`, wtedy maile (z linkami) wypisują się w konsoli.

## Panel administratora

`https://twojadomena.pl/admin`: wpisz `ADMIN_TOKEN` i zatwierdzaj lub odrzucaj zgłoszenia zwrotów punktów.
