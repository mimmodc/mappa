# Test della versione web

Test automatici dei moduli JavaScript della versione web. Non richiedono
dipendenze per la parte di geometria e di parsing degli identificativi; i test
che usano `DOMParser` o il WFS richiedono invece quanto indicato sotto.

## Esecuzione

```bash
node tests/all.test.mjs
```

Alcuni test vengono **saltati (SKIP)** se manca quanto serve:

| Test | Cosa serve |
|---|---|
| Geometria (area, perimetro, centroide) | accesso a Internet (scarica GeographicLib dal CDN; poi la tiene in cache nella cartella temporanea) |
| Parsing delle risposte GML | `DOMParser`, assente in Node: `npm install @xmldom/xmldom` |
| Risposte vuote memorizzate | `DOMParser`; la richiesta di rete è **simulata**, quindi non serve né rete né proxy. Riproduce il caso in cui il WFS restituisce una collezione vuota e verifica che il ritentativo vari l'URL per non ripescare la risposta vuota dalla cache |
| Client WFS | un proxy CORS attivo, indicato in `MAPPA_PROXY_URL` |

Esempio completo:

```bash
npm install @xmldom/xmldom                 # crea node_modules (ignorato da git)

node proxy/local-proxy.mjs &               # proxy CORS su :8787

MAPPA_TEST_DEPS="$PWD" \
MAPPA_PROXY_URL='http://localhost:8787/?url={url}' \
node tests/all.test.mjs
```

Variabili riconosciute:

- `MAPPA_TEST_DEPS` — cartella che contiene i `node_modules` con
  `@xmldom/xmldom` (utile se il pacchetto è installato altrove).
- `MAPPA_PROXY_URL` — modello di URL del proxy CORS, con il segnaposto `{url}`.

## Contenuto

- `fixtures/wfs_pavia_g388.xml` — risposta reale del WFS catastale (Pavia,
  foglio 1, particella 1) usata per verificare il parsing GML, compresi i
  poligoni con buchi (`gml:interior`).

I valori di riferimento per area e perimetro dei test di geometria sono stati
calcolati con GeographicLib (Python), la stessa libreria usata dall'app
desktop, e coincidono con quelli della versione web.
