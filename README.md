# MyWallet

Application web personnelle pour collecter et historiser les soldes crypto de plusieurs comptes OKX, Kraken et Coinbase. Interface en francais, stockage SQLite local, deploiement Docker et donnees de demonstration separees.

## Demarrage avec Docker

Prerequis : Docker Desktop avec Compose et Node.js 22.13+ pour generer la configuration initiale (Node 24 recommande).

```sh
npm run setup
docker compose up --build -d
```

Ouvrir http://localhost:3080. Le mot de passe de connexion est la valeur `AUTH_PASSWORD` du fichier local `.env`, genere par la commande de configuration. [.env.example](.env.example) documente les variables sans contenir de secrets. Aucune cle API n'est necessaire au demarrage. Ajouter ensuite les comptes depuis l'interface.

Sans Node.js sur l'hote, generer la configuration depuis Docker :

```sh
docker run --rm --mount type=bind,source=.,target=/work -w /work node:24-bookworm-slim node scripts/setup.js
docker compose up --build -d
```

Le service est expose uniquement sur l'interface locale `127.0.0.1`. Pour un acces distant, utiliser un reverse proxy HTTPS, configurer `COOKIE_SECURE=true` et adapter l'exposition reseau explicitement. Ne pas exposer directement HTTP sur Internet. Application mono-utilisateur, pas un service multi-tenant.

## Apercu sans comptes reels

```sh
npm ci
npm run demo
```

Ouvrir http://localhost:3080. Le mode demo ne demande aucun mot de passe, contient 90 jours de valeurs fictives et interdit les modifications et appels prives aux exchanges. Sa base `data/demo.sqlite` est distincte de la base reelle. Ne pas l'exposer sur Internet. Les logos d'actifs et polices sont charges depuis CoinGecko et Google Fonts ; les donnees financieres et cles ne leur sont pas envoyees. Les graphiques et icones d'interface sont servis localement. Les polices et logos ont des alternatives si le reseau est indisponible.

## Utilisation reelle sans Docker

```sh
npm ci
npm run setup
npm start
```

`npm run setup` refuse d'ecraser une configuration existante. `npm run dev` active le redemarrage du serveur lors des modifications. La collecte s'execute au demarrage, toutes les 60 minutes par defaut, et sur demande. L'interface relit les donnees toutes les minutes.

## Cles API

Creer des cles **en lecture seule**, sans trading, transfert ni retrait. Restreindre les IP aux IP de sortie du serveur si la plateforme le permet. Les autorisations doivent etre configurees chez le fournisseur : l'application ne peut pas garantir ou reduire les droits d'une cle qui lui est fournie.

| Fournisseur | Identifiants | Perimetre initial |
| --- | --- | --- |
| OKX | Cle API, secret et passphrase | Compte trading spot, selon le mode de compte OKX |
| Kraken | Cle API et secret, permission de consultation des fonds | Soldes spot |
| Coinbase | Cle API CDP et cle privee **ECDSA** au format PEM, droits de lecture | Soldes accessibles par Coinbase Advanced via CCXT |

Pour Coinbase, le nom complet de cle peut avoir la forme `organizations/.../apiKeys/...`. Conserver les lignes PEM ; les retours a la ligne echappes `\n` sont aussi acceptes. Utiliser une cle ECDSA compatible CCXT, pas une cle Ed25519. Si necessaire, creer une cle par portefeuille/sous-compte.

La compatibilite depend des restrictions geographiques, modes de compte, permissions et evolutions d'API. Les connexions privees doivent etre verifiees avec vos propres cles : les tests locaux simulent les fournisseurs. Le staking, Earn, les wallets de financement OKX, les contrats a terme, les positions sur marge et les wallets on-chain **ne sont pas couverts**. Un solde vide expose par une API est enregistre comme zero.

## Calcul et historique

- Soldes `total` remontes par CCXT, incluant les fonds libres et bloques exposes par l'API.
- Quantites et prix en EUR enregistres a chaque collecte. Aucun historique retroactif reel n'est invente.
- Prix indicatifs publics Kraken : paire EUR directe, paire inverse, puis conversion USD/EUR. Un stablecoin n'est jamais assimile arbitrairement a 1 EUR ou 1 USD.
- Si un actif non nul n'a pas de prix disponible, **tout le releve du compte echoue** : aucune valorisation partielle n'est enregistree.
- En cas d'echec d'un compte, son dernier releve est conserve et signale comme ancien. Les autres comptes continuent a etre collectes.
- Le graphique global additionne les derniers releves connus a chaque instant ; ce ne sont pas necessairement des releves simultanes. Un nouveau compte commence a compter a son premier releve.
- Les variations representent une variation de solde, **pas une performance d'investissement** : depots, retraits et transferts les affectent.
- Les courbes individuelles sont accessibles par le selecteur de compte ou les boutons de comptes. Export CSV de tous les releves et pagination du journal.
- Supprimer un compte supprime definitivement ses cles et ses releves et recalcule l'historique global sans ce compte. Une confirmation est requise.

## Configuration

| Variable | Description |
| --- | --- |
| `AUTH_PASSWORD` | Mot de passe personnel, minimum 12 caracteres |
| `ENCRYPTION_KEY` | 32 octets aleatoires encodes en base64 ; chiffrement AES-256-GCM |
| `COLLECT_INTERVAL_MINUTES` | Intervalle de 5 a 10080 minutes ; defaut 60 |
| `COOKIE_SECURE` | `true` pour HTTPS ; defaut `false` pour localhost |
| `DATA_DIR` | Repertoire SQLite ; `./data` en local, `/app/data` dans Docker |
| `PORT` | Port local ; defaut 3080, fixe dans Compose |
| `HOST` | Adresse d'ecoute ; defaut `0.0.0.0` |
| `DEMO_MODE` | `true` active la demo publique en lecture seule ; desactive dans Compose |

Les cles sont chiffrees dans la base ; elles ne sont jamais renvoyees au navigateur. Les sessions sont en memoire, durent 12 heures et sont invalidees au redemarrage. Les cookies sont HttpOnly/SameSite Strict. Cinq echecs de connexion bloquent une adresse IP pendant 15 minutes. Les requetes de modification exigent du JSON et verifient l'origine.

## Sauvegarde

Sauvegarder **ensemble** le volume `wallet-data` et le fichier prive `.env` qui contient la cle de chiffrement. La perte de `ENCRYPTION_KEY` rend les identifiants existants indechiffrables. Ne jamais regenerer cette cle pour une base existante sans migration. Le mot de passe peut etre change dans `.env`, suivi d'un redemarrage.

Arreter le service avant de copier la base SQLite et ses fichiers WAL/SHM, ou utiliser l'API de sauvegarde SQLite. `docker compose down` conserve le volume ; `docker compose down -v` le supprime definitivement. Le CSV contient les valorisations mais ne remplace pas une sauvegarde de la base. La base n'est pas chiffree integralement ; les soldes restent lisibles pour un administrateur du disque. Proteger egalement les sauvegardes.

## Tests et architecture

```sh
npm test
```

Tests avec SQLite en memoire et APIs simulees : calcul global/individuel, non-chevauchement des collectes, echecs de prix, chiffrement authentifie, authentification, protection d'origine, export et suppression. Le build Docker execute aussi les tests avant de produire l'image finale.

- [server/providers.js](server/providers.js) : adaptateurs CCXT et conversion de prix. Point d'extension pour d'autres exchanges.
- [server/collector.js](server/collector.js) : collecte independante des fournisseurs, injectables pour de futurs comptes en ligne.
- [server/store.js](server/store.js) : comptes, releves, consolidation et stockage SQLite.
- [server/app.js](server/app.js) : API Express et authentification.
- [public/](public/) : interface JavaScript native, Chart.js et Lucide.

Pour un futur fournisseur non crypto, implementer une lecture de soldes et une valorisation compatibles avec le collecteur, puis declarer ses champs et sa validation dans l'API/interface. Il n'est pas necessaire de changer le schema historique.