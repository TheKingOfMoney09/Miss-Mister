# Miss & Mister — votare Balul Bobocilor

Aplicație de votare mobile-first: publicul votează un Mister + un Miss (pot fi din cupluri diferite), adminul controlează votarea și dezvăluirea câștigătorilor, iar proiectorul arată rezultatele live, fără cifre.

## Cerințe

- Node.js 18+

## Configurare

```powershell
Copy-Item .env.example .env
# editează .env: PORT, ADMIN_PASSWORD, SESSION_SECRET, IP_SALT
```

| Variabilă | Descriere |
|---|---|
| `PORT` | portul serverului (default 3000) |
| `ADMIN_PASSWORD` | parola pentru `/admin` |
| `SESSION_SECRET` | secret sesiuni admin (șir lung aleatoriu) |
| `IP_SALT` | salt pentru hash-ul IP-urilor |
| `IP_HOURLY_CAP` | max voturi / IP / oră — sala împarte un singur IP pe WiFi, default 500; crește dacă ai public mare |

## Rulare

```powershell
npm install
npm start
```

Apoi:

- Votare (QR public): `http://<ip-tău>:3000/`
- Proiector: `http://<ip-tău>:3000/projector` (vezi mai jos)
- Rezultate simple: `http://<ip-tău>:3000/results`
- Admin: `http://<ip-tău>:3000/admin`

> Pentru ca telefoanele din sală să ajungă la server, toate trebuie să fie în aceeași rețea WiFi, iar firewall-ul trebuie să permită portul (ex. `PORT=3000`).

## Testare cu mai multe dispozitive

Fiecare dispozitiv primește automat un token unic (cookie + localStorage + IndexedDB) — un dispozitiv = un vot. Pentru test:

1. Deschide `/admin`, autentifică-te, apasă **Deschide votarea**.
2. Votează de pe telefon + laptop + fereastră incognito (fiecare contează separat).
3. Al doilea vot de pe același dispozitiv → ești trimis la „Mulțumim" (serverul răspunde 409).
4. Test automat cu ~200 voturi false + verificare realtime + 409 + CSV:

```powershell
$env:ADMIN_PASSWORD="parola-ta"
node test-votes.mjs http://localhost:3000 $env:ADMIN_PASSWORD
```

Scriptul curăță la final (ascunde dezvăluirile, șterge voturile) — baza rămâne proaspătă pentru eveniment.

## Flux admin (seara evenimentului)

1. În `/admin`, secțiunea **📽️ Proiector**: apasă **Detectează IP-ul meu**, apoi **Salvează + arată QR** — pe `/projector` apare mare „SCANEAZĂ CA SĂ VOTEZI".
2. **Deschide votarea** → publicul votează.
3. **Ascunde QR** (opțional) + **Închide votarea** când se termină.
4. **🏆 Dezvăluie câștigătorii** — pe proiector rulează un countdown (secunde configurabile), apoi apar Miss și Mister side-by-side, cu confetti.
4. **Export CSV** pentru evidență.

### Permite revotarea („uită cine a votat")

- **Un singur dispozitiv:** în `/admin`, secțiunea **Voturi recente** → **Uită** lângă votul respectiv. Votul se șterge, iar telefonul poate vota din nou (pagina de vot întreabă serverul, deci nu trebuie șters nimic de pe telefon).
- **Toată sala:** **Reset voturi** (confirmă cu RESET) — șterge toate voturile.

## Note tehnice

- SQLite (`data.sqlite`), un vot per `device_token` (UNIQUE), IP-urile doar ca hash SHA256 + salt, cap soft 150 voturi / IP / oră (WiFi comun în sală).
- SSE: `/api/events` (public, doar stare + câștigători — niciodată cifre), `/api/admin/events` (statistici complete).
- Poze: `Participants/` → `public/photos/` la `npm start` (redimensionate max 800px). Pozele încărcate din admin ajung în `uploads/` (ignorat de git).
