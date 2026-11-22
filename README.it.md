<div align="center">

# 🧠 Capito

**L'AI scrive il codice. Qualcuno lo capisce davvero?**

Capito è una GitHub Action che misura e riduce il *debito di comprensione* nel codice scritto con l'AI.<br>
Fa domande da 60 secondi sul codice scritto dai tuoi agenti, **con risposte verificate eseguendo i tuoi test**,<br>
e tiene una mappa delle parti del repository che una persona ha davvero capito.

[Inizia subito](#inizia-subito) · [Come funziona](#come-funziona) · [Comandi](#comandi) · [La mappa](#la-mappa-della-comprensione) · [Configurazione](#configurazione) · [English 🇬🇧](README.md)

</div>

---

## Il problema

Gli agenti AI scrivono ormai buona parte del codice che finisce in produzione, e di solito il codice *funziona*. Quello che sparisce in silenzio è la comprensione umana: il **debito di comprensione**, cioè la distanza tra quanto codice c'è in un sistema e quanto di quel codice qualcuno capisce davvero ([Addy Osmani](https://addyosmani.com/blog/comprehension-debt/)).

- In un esperimento controllato di Anthropic, chi programmava con l'assistenza dell'AI ha ottenuto **circa il 50% contro il 67%** in un quiz sul codice appena scritto, con il distacco più grande sul *debugging* ([Anthropic, 2026](https://www.anthropic.com/research/AI-assistance-coding-skills)).
- Nello stesso studio, chi **faceva generare il codice e poi faceva domande per capirlo** ha ottenuto l'**86%**, più di chi scriveva a mano.
- Nessuna metrica classica (velocità, DORA, copertura dei test) vede questo debito. Si vede dopo, quando c'è un incidente che nessuno sa risolvere.

Capito trasforma l'abitudine «genera, poi capisci» in qualcosa che tutto il team fa gratis, proprio dove il codice entra.

## Come appare

Quando una pull request contiene commit scritti con l'AI, Capito modifica il codice nuovo in alcuni modi piccoli e realistici, **esegue i tuoi test su ogni versione** e fa una domanda:

> ### 🧠 Capito? 60 secondi per capire il codice di questa PR
> Questa PR contiene codice scritto con l'AI (rilevato: `Co-Authored-By: Claude`). Ho modificato il codice in 3 piccoli modi e **ho eseguito i tuoi test** su ogni versione.
>
> **Quali di queste modifiche fanno fallire i test?**
>
> **A** · `src/cart.js:17` — La variabile viene aggiornata al contrario: invece di «+=» fa «-=».
> ```diff
> - subtotal += item.price * item.qty * (1 - bulkDiscount(item.qty));
> + subtotal -= item.price * item.qty * (1 - bulkDiscount(item.qty));
> ```
> **B** · `src/cart.js:10` — Il confronto diventa più severo: quando i due valori sono uguali, ora dà la risposta opposta.
> ```diff
> - if (subtotal >= FREE_SHIPPING_THRESHOLD || isMember) return 0;
> + if (subtotal > FREE_SHIPPING_THRESHOLD || isMember) return 0;
> ```
> **C** · `src/cart.js:23` — Il confronto diventa più permissivo: quando i due valori sono uguali, ora dà la risposta opposta.
> ```diff
> - return items.length > 0 && !!user && !user.banned;
> + return items.length >= 0 && !!user && !user.banned;
> ```
> **Rispondi** con un commento: `/capito A C` oppure `/capito nessuna`.

Chiunque nel team risponde con un commento. Capito spiega cosa succede davvero e segnala i **buchi nei test** trovati lungo la strada:

> 🟡 @ada **1/3.** Ecco cosa succede davvero:
>
> | | Modifica | Hai detto | Cosa succede davvero |
> |---|---|---|---|
> | ❌ **A** | `src/cart.js:17` `+=` → `-=` | i test passano lo stesso | 🔴 i test falliscono |
> | ❌ **B** | `src/cart.js:10` `>=` → `>` | i test falliscono | 🟢 i test passano lo stesso |
> | ✔️ **C** | `src/cart.js:23` `>` → `>=` | i test falliscono | 🔴 i test falliscono |
>
> 🕳️ **Buco nei test:** **B** (`src/cart.js:10`) sopravvive: nessun test se ne accorge.

Ogni risposta alimenta la **mappa della comprensione** del repository, e ogni lunedì Capito apre un **ripasso da 5 minuti** sugli angoli più bui del codice scritto dall'AI.

## Perché è diverso

Esistono già bot che bloccano il merge finché non rispondi a domande generate da un LLM. Capito fa tre scelte diverse:

| | Quiz sulle PR tipico | Capito |
|---|---|---|
| Chi sa la risposta giusta? | Un LLM (che può aver capito male il codice) | **I tuoi test.** Ogni risposta è calcolata eseguendo davvero il codice modificato |
| Ti blocca? | Sì, è un cancello sul merge | **Mai.** Niente da aggirare |
| Cosa resta dopo la PR? | Niente | Una **mappa della comprensione** con decadimento, zone buie e ripasso settimanale |
| Valore extra | — | Ogni quiz è anche un piccolo **mutation test**: trova comportamenti non testati |
| Costo | Chiamate a un'API AI | **Zero.** Niente AI, niente servizi esterni, niente chiavi. Gira nelle tue Actions |

## Inizia subito

**1. Aggiungi il workflow.** Copia [`examples/workflows/capito.yml`](examples/workflows/capito.yml) in `.github/workflows/capito.yml` nel tuo repository e imposta `lang: it`:

```yaml
      - uses: M1GKORE1234/capito@v1
        with:
          test-command: npm test
          lang: it
          secret: ${{ secrets.CAPITO_SECRET }} # facoltativo
```

**2. (Facoltativo) aggiungi un segreto.** Crea un *repository secret* chiamato `CAPITO_SECRET` con una stringa casuale qualsiasi. Serve a cifrare le risposte giuste in modo che nessuno possa leggerle dal sorgente della pagina. Senza, Capito funziona lo stesso.

**3. Apri una pull request** con codice scritto da Claude Code, Copilot, Codex, Cursor, Devin, Jules, Aider, Lovable... Capito riconosce da solo le loro firme nei commit.

> **Requisito:** i test devono passare sulla pull request (serve una base verde per sapere cosa significa «fallire»). Oggi sono supportati JavaScript e TypeScript, con qualsiasi test runner (Jest, Vitest, Mocha, `node --test`, Playwright...).

## Come funziona

1. **Riconosce il codice scritto dall'AI** dalle firme nei commit (`Co-Authored-By: Claude`, `Copilot`, `Codex`...), dalle note «Generated with» e dagli account bot degli agenti. Puoi aggiungere le tue regole con `ai-markers`, oppure usare `treat-all-as-ai` per il codice di strumenti che non lasciano traccia.
2. **Crea mutazioni** sulle righe modificate: confronti più severi o più permissivi, uguaglianze invertite, `&&` ↔ `||`, `!` tolto, operazioni scambiate, booleani invertiti, numeri sbagliati di uno. Stringhe, commenti, tipi ed enum non vengono mai toccati.
3. **Esegue i test** una volta sul codice originale (deve passare), poi una volta per ogni mutazione. Ogni mutazione viene **scoperta** (i test falliscono) oppure **sopravvive** (i test passano). Il file originale viene sempre ripristinato.
4. **Fa la domanda** scegliendo 2-4 modifiche su righe diverse, mescolando scoperte e sopravvissute, e spiega ogni modifica in linguaggio semplice. Le risposte giuste sono cifrate (AES-256-GCM) dentro il commento.
5. **Corregge e insegna.** `/capito A C` riceve subito un voto esatto, la spiegazione di ogni modifica e l'elenco dei buchi nei test.
6. **Ricorda.** Le risposte finiscono in `ledger.json` su un branch dedicato, `capito-data`: niente database, niente servizi esterni. La mappa si ricostruisce da lì.

## Comandi

Scrivili in qualsiasi commento di pull request o issue:

| Comando | Cosa fa |
|---|---|
| `/capito A C` | Risponde all'ultimo quiz della discussione. Funziona anche `/capito A e C` |
| `/capito nessuna` | Nessuna modifica fa fallire i test |
| `/capito quiz` | Nuovo quiz sul codice di questa pull request* |
| `/capito quiz src/fatture.ts` | Quiz su un file preciso* |
| `/capito mappa` | Risponde con la mappa della comprensione |
| `/capito` | Aiuto |

\* I quiz su richiesta eseguono codice, quindi sono disponibili solo a chi ha accesso in scrittura e solo su branch dello stesso repository (mai su fork).

## La mappa della comprensione

Capito aggiorna `CAPITO.md` sul branch `capito-data`:

- **Righe AI per file**, da `git blame` e dal riconoscimento descritto sopra.
- **Prove**: ogni risposta vale al massimo una prova per ciascun file su cui verteva, in proporzione alle opzioni giuste. Le prove **perdono metà del valore ogni 90 giorni**, perché anche la comprensione svanisce.
- **Punteggio** = `100 × prove / ⌈righe AI ÷ 40⌉`, massimo 100. Una risposta recente e tutta giusta copre 40 righe scritte dall'AI.
- **Zona buia**: un file con almeno 10 righe AI e un punteggio sotto 30.
- **Indice di comprensione**: la media dei punteggi pesata per righe AI.
- **Chi lo capisce**: le persone le cui prove su quel file valgono ancora qualcosa. È il tuo *bus factor della comprensione*.

La mappa alimenta altre due funzioni:

- **Ripasso settimanale**: una sola issue con un quiz sui file più bui, con priorità ai file citati nelle issue aperte. Il ripasso della settimana prima si chiude da solo.
- **Avvisi sulle zone buie**: quando una nuova issue cita un file che nessuno ha dimostrato di capire (basta `src/cart.js:23` in uno stack trace), Capito lo segnala, elenca i test collegati e suggerisce `/capito quiz` *prima* che qualcuno, o qualche agente, inizi a correggere.

Tutte le soglie sono configurabili.

## Configurazione

| Parametro | Predefinito | Descrizione |
|---|---|---|
| `test-command` | `npm test` | Comando che esegue i test. Deve passare sul codice attuale. |
| `lang` | `en` | Lingua dei commenti: `en` o `it`. |
| `secret` | | Chiave che rende indecifrabili le risposte (usa `secrets.CAPITO_SECRET`). |
| `max-mutants` | `8` | Modifiche testate per quiz (2-20). Ognuna esegue i test una volta. |
| `options` | `3` | Opzioni per domanda (2-4). |
| `timeout-seconds` | automatico | Timeout di ogni esecuzione dei test. Predefinito: 3 volte la prima esecuzione, almeno 30 s. |
| `ai-only` | `true` | Fa domande solo sulle PR con commit scritti dall'AI. |
| `ai-markers` | | Espressioni regolari aggiuntive (una per riga) che identificano un commit come scritto dall'AI. |
| `treat-all-as-ai` | `false` | Considera ogni riga come scritta dall'AI. |
| `include` | tutti i JS/TS | Glob dei file sorgente da considerare. |
| `exclude` | | Glob aggiuntivi da ignorare. Test, `dist`, `build`, `node_modules`, `*.d.ts` e file di configurazione sono sempre ignorati. |
| `review-files` | `2` | File coperti dal ripasso settimanale (1-5). |
| `alert-on-issues` | `true` | Commenta le nuove issue che toccano zone buie. |
| `include-drafts` | `false` | Fa domande anche sulle PR in bozza. |
| `anonymous` | `false` | Salva pseudonimi invece dei nomi utente. |
| `data-branch` | `capito-data` | Dove vivono il registro e la mappa. |
| `half-life-days` | `90` | Giorni dopo i quali una prova vale la metà. |
| `lines-per-proof` | `40` | Righe AI coperte da una prova. |
| `min-ai-lines` | `10` | I file più piccoli non sono mai zone buie. |
| `dark-threshold` | `30` | Punteggio sotto il quale un file è una zona buia. |
| `mode` | `auto` | `auto` reagisce all'evento; `review` esegue subito il ripasso; `map` aggiorna solo la mappa. |

**Output:** `outcome`, `quiz-id`, `comprehension-index`, `dark-zones`.

## Sicurezza e privacy

- **Niente esce da GitHub.** Nessuna chiamata a servizi AI, nessuna telemetria, nessun servizio esterno: l'Action gira nel tuo runner con il tuo token.
- **Il codice non fidato non gira mai con permessi di scrittura.** Capito rifiuta `pull_request_target`. Le PR da fork girano con il token in sola lettura di GitHub: il quiz finisce nel riepilogo del job invece che in un commento. I quiz su richiesta (`/capito quiz`) girano solo per chi ha accesso in scrittura e solo su branch dello stesso repository.
- **Le risposte sono cifrate** con AES-256-GCM. Con `CAPITO_SECRET` solo il workflow può decifrarle e il quiz non si può modificare (cambiare un file o una riga lo invalida). Senza, la chiave deriva dal nome del repository: va bene per uno strumento che non blocca mai nulla.
- **Token personali:** se passi un PAT come `github-token`, i quiz vengono pubblicati da un account utente; imposta `CAPITO_SECRET` perché Capito possa fidarsi (i quiz con chiave pubblica sono accettati solo se pubblicati da un bot).
- **Cosa viene salvato:** per ogni risposta, il nome utente, l'id del quiz, i file e le righe interessati e se ogni opzione era giusta. Nei repository pubblici questo branch è pubblico; con `anonymous: true` vengono salvati pseudonimi. Cancella il branch `capito-data` per azzerare tutto.
- **I tuoi file vengono sempre ripristinati** dopo i test di mutazione, anche se un'esecuzione va in crash o in timeout.

## Usalo in locale

Lo stesso motore funziona dal terminale, senza GitHub:

```bash
npx github:M1GKORE1234/capito quiz --lang it                    # quiz su quello che hai cambiato rispetto a main
npx github:M1GKORE1234/capito quiz --lang it --file src/cart.ts # quiz su un file
npx github:M1GKORE1234/capito map --lang it                     # la tua mappa della comprensione
```

## Domande frequenti

**Rallenta le mie pull request?** Gira in un job separato e non blocca mai il merge. Con `max-mutants: 8` esegue i test 9 volte: con una suite di unit test veloce è meno di un minuto. Usa in `test-command` la tua suite più veloce.

**E se i test sono lenti o instabili?** Usa un `test-command` più veloce (per esempio solo gli unit test), abbassa `max-mutants` o imposta `timeout-seconds`. Le mutazioni che vanno in timeout non vengono mai usate nelle domande.

**Il mio repository non ha test.** Allora ogni modifica «sopravvive» e Capito non può fare una domanda sensata; te lo dice. È già un risultato.

**Si può barare?** Non c'è nessun blocco, quindi non conviene. Conta solo la prima risposta di ogni persona.

**Perché non far scrivere le domande a un LLM?** Perché un LLM può sbagliare con sicurezza proprio sul codice, che è esattamente il problema. Le risposte di Capito vengono dall'esecuzione, quindi sono sempre giuste per il codice così com'è.

**Quali linguaggi?** JavaScript e TypeScript (anche JSX/TSX). Python è il prossimo.

## Capito controlla sé stesso

Capito è stato scritto con un agente AI, quindi l'abbiamo fatto girare su sé stesso (il workflow è in [`examples/workflows/capito-self-check.yml`](examples/workflows/capito-self-check.yml)). La prima volta che è stato eseguito su `src/core/map.ts`, tutte e tre le modifiche provate sono **sopravvissute**: nessun test controllava i confini esatti dei colori della mappa, la regola «almeno 10 righe AI» o che i file capiti a metà finiscano nel ripasso. Ora quei test esistono ([`test/core.test.ts`](test/core.test.ts)) e le stesse mutazioni vengono scoperte.

## Licenza

[MIT](LICENSE) © 2026 Alessio Kore
