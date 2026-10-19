# Proxy CORS per il WFS catastale

La versione web deve leggere le geometrie delle particelle dal WFS
dell'Agenzia delle Entrate:

```
https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php
```

Quel servizio **non invia gli header CORS**, quindi un browser non può
interrogarlo direttamente. Serve un piccolo ponte che riceva la richiesta,
la inoltri al WFS e restituisca la risposta aggiungendo gli header CORS.

Sono incluse due versioni:

| File | Quando usarlo |
|---|---|
| `cloudflare-worker.js` | Per il sito pubblico su GitHub Pages (gratuito). |
| `local-proxy.mjs` | Solo per provare l'app sul proprio computer. |

> **Nota**: il progetto ha già un Worker attivo —
> `https://mappa-proxy.mimmodc.workers.dev/?url={url}` — impostato come
> predefinito in `web/config.js`, quindi il sito pubblicato funziona già.
> Quanto segue serve per pubblicarne uno **proprio** (ad esempio su un altro
> account Cloudflare).

---

## 1. Cloudflare Worker (consigliato, ~5 minuti)

Serve un account Cloudflare gratuito (nessuna carta di credito).

1. Vai su <https://dash.cloudflare.com> → **Workers & Pages** → **Create** →
   **Worker** → scegli un nome, ad esempio `mappa-proxy`.
2. **Deploy** del Worker di esempio.
3. **Edit code**: cancella il contenuto e incolla tutto il contenuto di
   `cloudflare-worker.js`. Premi **Deploy**.
4. Copia l'indirizzo del Worker, del tipo:
   `https://mappa-proxy.TUONOME.workers.dev`
5. Indica il proxy all'app web, impostando `CONFIG.wfsProxy` in
   `web/config.js`:

   ```
   https://mappa-proxy.TUONOME.workers.dev/?url={url}
   ```

   Le graffe `{url}` sono obbligatorie: l'app sostituirà quell'ultima parte
   con l'indirizzo del WFS codificato.

   In alternativa, senza modificare i file, si può aprire la pagina passando il
   proxy come parametro, ad esempio:

   ```
   https://mimmodc.github.io/mappa/?proxy=https%3A%2F%2Fmappa-proxy.TUONOME.workers.dev%2F%3Furl%3D%7Burl%7D
   ```

   L'indirizzo del proxy deve essere **https://**: la pagina pubblicata su
   GitHub Pages è in HTTPS e il browser bloccherebbe una richiesta in HTTP
   (contenuto misto).

Se la verifica dà esito positivo, il Worker resterà attivo e gratuito (il piano
gratuito prevede 100.000 richieste al giorno, ben oltre il necessario).

### In alternativa: dal terminale (più rapido)

Se la dashboard dà problemi, la stessa cosa si fa con lo strumento ufficiale
Cloudflare; l'unico passaggio manuale è autorizzare l'accesso nel browser:

```bash
cd proxy
npx wrangler@3 login     # si apre il browser: premi «Allow»
npx wrangler@3 deploy    # pubblica il Worker
```

Al termine il comando stampa l'indirizzo del Worker (punto 5 qui sopra).
Serve Node.js ≥ 18; con Node.js 20 si deve usare `wrangler@3`, perché
`wrangler@4` richiede Node.js ≥ 22. La configurazione è in `wrangler.toml`.

### Se la verifica fallisce

Il Worker risponde con un messaggio di errore JSON: il testo indica la causa.
Le possibilità più comuni:

- **Host non consentito**: hai modificato l'elenco `ALLOWED_HOSTS`, oppure
  l'app sta chiamando un servizio diverso.
- **Il WFS non è raggiungibile dal Worker**: la rete dell'Agenzia delle
  Entrate potrebbe non accettare le connessioni dai data center. In quel caso
  hai due alternative:
  1. provare un altro host gratuito (Deno Deploy, Vercel, Netlify Functions)
     con lo stesso codice, adattato alle loro API;
  2. usare il proxy locale (sotto) su un computer sempre acceso, esposto con
     `cloudflared tunnel` o simili.

---

## 2. Proxy locale (solo per prove)

```bash
node proxy/local-proxy.mjs          # resta in ascolto su http://localhost:8787
```

Poi servi la cartella del progetto e apri la pagina indicando il proxy:

```bash
python3 -m http.server 8123
```

```
http://localhost:8123/?proxy=http%3A%2F%2Flocalhost%3A8787%2F%3Furl%3D%7Burl%7D
```

Il parametro `?proxy=...` salva l'impostazione nel browser: dalle volte
successive ti basterà aprire `http://localhost:8123/`.

---

## Sicurezza del Worker

Il Worker applica tre filtri:

- **`ALLOWED_HOSTS`** — può inoltrare richieste **solo** verso gli host elencati
  (il WFS dell'Agenzia delle Entrate).
- **`ALLOWED_ORIGINS`** — accetta richieste **solo** dalle pagine dell'app
  (`https://mimmodc.github.io`, più `localhost`/`127.0.0.1`/`[::1]` per lo
  sviluppo locale). Le richieste da altre origini ricevono `403`, quindi il
  Worker non può essere usato come proxy aperto.
- **`RATE_LIMIT_MAX`** — massimo **120 richieste al minuto** per visitatore
  (indirizzo IP). Oltre il limite risponde `429` con `Retry-After`.

Se pubblichi l'app su un altro dominio, aggiungilo a `ALLOWED_ORIGINS` in
`cloudflare-worker.js` e ripubblica con `npx wrangler@3 deploy`.

Per cambiare il limite di velocità modifica `RATE_LIMIT_MAX` (e, se serve,
`RATE_LIMIT_WINDOW_MS`) in `cloudflare-worker.js`, poi ripubblica.
**Attenzione**: una singola vista della mappa costa ~12 richieste (fino a ~36
coi ritentativi), quindi un limite troppo basso bloccherebbe l'uso normale.

Il contatore usa la Cache API di Cloudflare: non serve alcun servizio o binding
aggiuntivo. **Il conteggio è per data center**: Cloudflare serve le richieste
dallo stesso visitatore da più data center (nei test: `MXP` e `FCO`), e ogni
data center ha la propria cache. Il limite effettivo può quindi risultare più
alto del valore nominale (grossomodo `RATE_LIMIT_MAX` × numero di data center
coinvolti). Il contatore ferma comunque flood e cicli accidentali; per un limite
esatto e globale servirebbero i *Durable Objects*. In caso di errore della
cache il Worker **non** blocca mai le richieste.

> Il controllo sull'origine scoraggia l'uso improprio ma può essere aggirato da
> client che falsificano gli header; il limite di velocità agisce comunque per
> indirizzo IP. Per una protezione ancora più forte puoi attivare il **Rate
> limiting** dal pannello Cloudflare (Workers & Pages → il tuo Worker).

---

## Perché non un proxy pubblico?

Sono stati provati diversi proxy pubblici gratuiti: rispondono con errori
(429/522/401) e non sono affidabili per un uso reale. Il Worker proprio è
gratuito, stabile e non dipende da servizi di terzi.
