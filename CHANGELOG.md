# Changelog

Tutte le modifiche rilevanti di questo progetto sono annotate in questo file.
Il formato segue il principio di [Keep a Changelog](https://keepachangelog.com/it/1.1.0/).

## [2.0.6] - 2026-10-19

### Sicurezza
- **Limite di velocità nel Worker** (`RATE_LIMIT_MAX`): massimo **120 richieste
  al minuto per visitatore** (per indirizzo IP). Oltre il limite risponde `429`
  con `Retry-After`. Il valore è alto abbastanza da non disturbare l'uso
  normale (una vista costa ~12 richieste, fino a ~36 coi ritentativi) ma ferma
  gli abusi del proxy.
- Il contatore usa la Cache API di Cloudflare: nessun servizio o binding
  aggiuntivo; in caso di errore della cache il Worker non blocca le richieste.
- **Limite noto**: il conteggio è per data center (Cloudflare serve lo stesso
  visitatore da più data center, es. `MXP` e `FCO`), quindi il limite effettivo
  può essere più alto del valore nominale. Verificato in produzione.
- Aggiunto un test automatico del Worker (limite di velocità e controllo
  origine) con cache simulata.

## [2.0.5] - 2026-10-18

### Sicurezza
- **SRI (Subresource Integrity)** su Leaflet (CSS e JS) e GeographicLib caricati
  dal CDN: il browser rifiuta la risorsa se il contenuto non corrisponde
  all'hash `sha384` atteso.
- **Worker CORS ristretto per origine** (`ALLOWED_ORIGINS`): accetta solo
  richieste provenienti dalle pagine dell'app, quindi non è più utilizzabile
  come proxy aperto. Worker aggiornato e ripubblicato su Cloudflare.
- Documentate la limitazione dell'SRI per DuckDB-WASM (import dinamico ESM,
  versione fissata a `1.29.0`) e la possibilità di attivare il Rate limiting
  Cloudflare.

## [2.0.4] - 2026-10-18

### Modificato
- **Rimossa dall'interfaccia la sezione 5 «Impostazioni (proxy WFS)»**: la
  configurazione del proxy non è più mostrata agli utenti. Il funzionamento
  della web resta invariato: il proxy predefinito è in `web/config.js`
  (`CONFIG.wfsProxy`) e si può indicarne un altro con il parametro `?proxy=...`.
- Messaggi di stato e di errore relativi ai confini catastali semplificati (non
  rimandano più a una sezione di impostazioni non più presente).
- `README.md` e `proxy/README.md` aggiornati di conseguenza.

## [2.0.3] - 2026-10-18

### Corretto
- **Area delle particelle con «buchi» (`gml:interior`)**: la versione web usava
  solo l'anello esterno e ne sovrastimava l'area. Ora l'area degli anelli
  interni viene sottratta (`geometryMeasure`), come nella versione desktop.
- **Validazione del nome del file regionale** in `web/catasto.js`: il valore
  letto dall'indice OnData viene verificato (solo `[A-Za-z0-9_-]+.parquet`)
  prima di essere usato nella query, per difendersi da SQL injection — come già
  avveniva nella versione desktop.
- Refuso in `web/catasto.js` (due istruzioni sulla stessa riga).

### Aggiunto
- Test di regressione per `sanitizeRegionFile` in `tests/all.test.mjs`.

## [2.0.2] - 2026-10-18

### Modificato
- Questo repository pubblica ora **solo la versione web** (HTML + Leaflet):
  i file della versione desktop (`mappa_campo_agricolo.py`, `run.sh`,
  `requirements.txt`) sono stati spostati in un repository separato e rimossi da
  qui, insieme alla cronologia che li conteneva. La versione web e la sua
  pubblicazione su GitHub Pages restano invariate.
- `README.md` riscritto per la sola versione web; screenshot desktop rimosso da
  `doc/`.
- `.gitignore` limitato a quanto serve alla versione web (Node per i test,
  cache del proxy, file esportati).

## [2.0.1] - 2026-10-17

### Aggiunto
- **Proxy CORS pubblico del progetto**, ora predefinito in `web/config.js`:

  ```
  https://mappa-proxy.mimmodc.workers.dev/?url={url}
  ```

  È il Worker Cloudflare (`proxy/cloudflare-worker.js`, piano gratuito) già
  pubblicato e verificato contro il WFS reale: il sito su GitHub Pages funziona
  quindi senza che l'utente debba configurare nulla.

### Corretto
- **Senza proxy l'app sembrava bloccata**: lo stato restava su «Recupero del
  confine della particella…» per alcuni secondi (il WFS risponde lentamente e le
  richieste falliscono per CORS) prima di spiegare il problema. Ora l'avviso
  compare immediatamente all'avvio, appena l'indice dei comuni è pronto.

## [2.0] - 2026-10-17

### Corretto
- **I confini delle particelle catastali sparivano quando si cambiava lo zoom.**
  L'overlay viene ora diviso in due gruppi indipendenti (vedi «Aggiunto»): le
  particelle del campo selezionato restano quindi visibili a **qualunque**
  zoom, mentre prima venivano cancellate appena lo zoom scendeva sotto 16.
- **Zone estese non mostravano alcuna particella.** Il WFS dell'Agenzia delle
  Entrate non restituisce elementi quando la bounding box supera ~0.017° di
  lato (filtro di scala lato server): la nuova `fetch_area()` suddivide l'area
  in riquadri di lato ≤ `WFS_TILE_SPAN` (0.012°) e unisce i risultati senza
  duplicati, così l'overlay si popola anche su viste ampie.
- **Errori transitori del WFS** non lasciano più l'overlay vuoto: le richieste
  vengono ripetute (2 tentativi con attesa crescente) prima di arrendersi.
- **Particelle disegnate due volte** (confine più marcato del dovuto) quando il
  gruppo «vista» terminava il caricamento prima del gruppo «campo»: in quel
  momento l'elenco delle particelle del campo non era ancora noto. Ora il
  gruppo «vista» viene ripulito dai duplicati appena l'elenco del campo è
  completo (in entrambe le versioni), e cambiando campo la «vista» viene
  ricaricata.
- Se una richiesta per il gruppo «vista» fallisce, i confini di zone diverse da
  quella osservata non restano più disegnati sulla mappa.

### Aggiunto
- **Gruppo «campo»**: particelle del campo selezionato/disegnato e di quelle
  confinanti (margine minimo ~130 m), caricate **sempre**, a qualunque zoom.
  È il riferimento principale per individuare e selezionare i campi.
- **Gruppo «vista»**: particelle della porzione di mappa attualmente visibile,
  aggiornate solo a zoom ≥ 16 (`PARCEL_VIEW_MIN_ZOOM`).
- Le particelle già disegnate come gruppo «campo» non vengono ridisegnate dal
  gruppo «vista».
- `APP_VERSION` (2.0), mostrata nel titolo della finestra e in `--help`.
- Nuovo passo 5 del `--selftest`, che verifica `fetch_area()` e che il campo
  selezionato sia incluso tra le particelle restituite.
- `.gitignore` e questo `CHANGELOG.md`.

### Versione web (nuova)
- **Applicazione web** (`index.html` + `web/`) pubblicabile su GitHub Pages:
  mappa Leaflet con quattro sfondi, ricerca Comune/Foglio/Particella, selezione
  e disegno del campo, overlay catastale nei due gruppi «campo» e «vista»,
  calcolo geodetico di area/perimetro/centroide ed esportazione GeoJSON.
- La ricerca per attributi usa **DuckDB-WASM** sui Parquet di OnData, letti via
  HTTP: essendo ordinati per comune, il browser scarica solo i blocchi
  necessari.
- **Proxy CORS** incluso in `proxy/`: `cloudflare-worker.js` per il sito
  pubblico e `local-proxy.mjs` per le prove locali (il WFS catastale non invia
  header CORS, quindi senza proxy le geometrie non sono leggibili dal browser).
- Un riquadro che il WFS restituisce **vuoto** viene ritentato (fino a 3
  tentativi per il gruppo «campo»), e le richieste verso il servizio catastale
  vengono **serializzate e distanziate** di 120 ms. Il motivo, verificato sul
  servizio reale: il WFS risponde a volte con una collezione vuota per una bbox
  che contiene invece particelle, e la cache davanti al servizio ripete quella
  risposta vuota identica per lo stesso URL. Il ritentativo **varia quindi
  leggermente l'URL**, altrimenti ripeterebbe la risposta vuota; senza questo
  accorgimento i confini attorno al campo restavano a volte assenti.
- **Test automatici** in `tests/`: geometria geodetica (valori identici alla
  versione desktop), parsing GML (compresi i poligoni con buchi) e client WFS,
  con la risposta reale del WFS come campione in `tests/fixtures/`.
- Aggancio di diagnostica `mappaApp` disponibile nella console del browser.

## [1.0]

- Prima versione: mappa OpenStreetMap, selezione e disegno dei campi, ricerca
  Comune/Foglio/Particella, overlay delle particelle catastali nella vista,
  calcolo di area/perimetro/centroide ed esportazione in GeoJSON.
