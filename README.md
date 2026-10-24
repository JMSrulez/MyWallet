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
| GoMining | Consentement OAuth via le compte GoMining, sans cle API manuelle | Wallet virtuel via MCP, en lecture seule |

Pour Coinbase, le nom complet de cle peut avoir la forme `organizations/.../apiKeys/...`. Conserver les lignes PEM ; les retours a la ligne echappes `\n` sont aussi acceptes. Utiliser une cle ECDSA compatible CCXT, pas une cle Ed25519. Si necessaire, creer une cle par portefeuille/sous-compte.

La compatibilite depend des restrictions geographiques, modes de compte, permissions et evolutions d'API. Les connexions privees doivent etre verifiees avec vos propres cles : les tests locaux simulent les fournisseurs. Pour Kraken, les soldes exposes par `BalanceEx` avec les suffixes `.S` (staking), `.M`, `.B`, `.F` (recompenses) et `.P` (parachain) sont additionnes au symbole de base avant valorisation : par exemple, 10 ADA + 20 ADA.S deviennent 30 ADA. Cette valorisation utilise le cours de l'actif sous-jacent ; elle ne signifie pas que les fonds bloques sont disponibles au retrait. Les suffixes inconnus et `.T` (actifs tokenises) ne sont pas assimiles au symbole de base. Aucun appel supplementaire aux APIs staking/Earn n'est effectue et aucun ancien releve n'est modifie. Voir les [suffixes historiques Kraken](https://support.kraken.com/articles/360039879471-what-is-asset-s-and-asset-m-) et la [documentation BalanceEx](https://docs.kraken.com/api/docs/rest-api/get-extended-balance/).

Les positions staking/Earn absentes des soldes renvoyes, les wallets de financement OKX, les contrats a terme, les positions sur marge et les wallets on-chain **ne sont pas couverts**. Un solde vide expose par une API est enregistre comme zero.

## Calcul et historique

- Soldes `total` remontes par CCXT, incluant les fonds libres et bloques exposes par l'API.
- Quantites et prix en EUR enregistres a chaque collecte. Aucun historique retroactif reel n'est invente.
- Prix en EUR via **CoinGecko** (API simple/price). Cle optionnelle `COINGECKO_API_KEY` (type `demo` ou `pro`). Sans cle, l'API publique est utilisee avec des limites plus strictes. Cache local d'environ 60 secondes.
- Si un actif non nul n'a pas de prix disponible, **tout le releve du compte echoue** : aucune valorisation partielle n'est enregistree. Les logs serveur indiquent le symbole concerne.
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
| `PUBLIC_URL` | Origine du navigateur pour OAuth GoMining ; defaut `http://localhost:3080` (ou le port local configure), HTTPS pour un acces distant |
| `GOMINING_GRAM_COINGECKO_ID` | Identifiant CoinGecko du GRAM du wallet, uniquement apres verification de l'actif ; sans valeur, un solde GRAM non nul fait echouer le releve plutot que deviner son prix |
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

- [server/providers.js](server/providers.js) : adaptateurs CCXT (soldes) et prix CoinGecko. Point d'extension pour d'autres exchanges.
- [server/collector.js](server/collector.js) : collecte independante des fournisseurs, injectables pour de futurs comptes en ligne.
- [server/store.js](server/store.js) : comptes, releves, consolidation et stockage SQLite.
- [server/app.js](server/app.js) : API Express et authentification.
- [public/](public/) : interface JavaScript native, Chart.js et Lucide.

Pour un futur fournisseur non crypto, implementer une lecture de soldes et une valorisation compatibles avec le collecteur, puis declarer ses champs et sa validation dans l'API/interface. Il n'est pas necessaire de changer le schema historique.

## Prix (CoinGecko)

Les valorisations en EUR passent par l'API CoinGecko, plus complete que les seuls marches Kraken.

| Variable | Description |
| --- | --- |
| COINGECKO_API_KEY | Cle API (demo gratuite ou pro). Optionnelle. |
| COINGECKO_API_TYPE | `demo` (defaut) ou `pro` |

Sans cle, les appels publics restent possibles mais sont plus limites. Avec une cle demo, le header `x-cg-demo-api-key` est envoye. Les prix sont caches environ 60 secondes en memoire. Les symboles courants sont mappes explicitement ; les autres sont resolus via `/coins/list`.

## Compte GoMining (MCP et OAuth)

1. Ouvrir MyWallet a l'origine `PUBLIC_URL` configuree. Par exemple `http://localhost:3080`, ou `https://wallet.example.com` derriere un reverse proxy HTTPS. Une origine HTTP distante est refusee. Ne pas utiliser `127.0.0.1` dans le navigateur si `PUBLIC_URL` utilise `localhost`.
2. Se connecter a MyWallet, puis choisir **Ajouter un compte > GoMining**, saisir un nom et continuer vers le consentement. Se connecter directement chez GoMining ; ne jamais saisir de seed phrase, cle privee ou mot de passe GoMining dans MyWallet.
3. Le serveur MCP utilise est fixe : `https://mcp.gomining.com/mcp`. Le SDK officiel decouvre le serveur OAuth et enregistre dynamiquement le client. Le retour est `PUBLIC_URL/oauth/gomining/callback`.
4. Apres le consentement, MyWallet verifie l'etat OAuth, la session locale, PKCE et l'emetteur avec le SDK. Il se reconnecte sur un transport neuf, decouvre les outils et verifie le schema de `get_virtual_wallet_balances` avant de l'appeler. Le compte n'est cree qu'apres une reponse de wallet valide, puis une premiere collecte est declenchee.

Le SDK gere le renouvellement des jetons. Les jetons d'acces, refresh tokens et informations du client OAuth restent chiffres dans SQLite avec `ENCRYPTION_KEY` ; ils ne sont jamais renvoyes a l'interface ni journalises par le connecteur. Le retour navigateur transporte seulement un code temporaire et un etat OAuth, retires de l'URL avant l'echange. Conserver `PUBLIC_URL` et la cle de chiffrement entre les redemarrages. Les consentements en cours expirent apres 10 minutes et sont perdus au redemarrage ; il suffit de recommencer la connexion. Si la session MyWallet expire pendant le consentement, recommencer depuis une nouvelle session.

Dans **Mes comptes**, le bouton avec l'icone de lien renouvelle l'autorisation du compte existant sans supprimer son historique. La suppression locale efface les jetons et releves ; pour revoquer aussi l'acces chez GoMining, retirer MyWallet des applications autorisees dans GoMining si cette option est proposee. Le mode demo interdit les connexions reelles.

### Perimetre et valorisation

- Seul `get_virtual_wallet_balances` est appele. `get_account_summary`, miners/NFT, staking, carte et recompenses ne sont pas additionnes : cela evite d'inventer une valorisation ou de compter deux fois des soldes.
- Les actifs documentes sont BTC, GMT, USDT, USDC, ETH, BNB, SOL et GRAM. Le GMT de ce fournisseur est normalise en **GOMINING**, avec le prix CoinGecko `gmt-token`, et n'est pas confondu avec le GMT de STEPN.
- GRAM est ambigu dans les catalogues publics. Configurer `GOMINING_GRAM_COINGECKO_ID` seulement apres confirmation de son identite ; sinon la collecte conserve le dernier releve connu et affiche une erreur si le wallet contient du GRAM non nul.
- Un outil qui exige des arguments inconnus, un resultat MCP en erreur ou un format de solde non reconnu est refuse. Seuls des soldes JSON explicites sont acceptes (contenu structure ou bloc texte JSON, dictionnaire d'actifs ou tableau de lignes avec actif et quantite). Une reponse inconnue n'est pas transformee en zero. Les schemas JSON Schema draft-07 et 2020-12 sont pris en charge.
- Les champs exacts du serveur GoMining ne sont pas publies dans sa documentation. Les tests utilisent des fixtures et le SDK reel contre un serveur simule, pas un compte GoMining reel. La compatibilite du consentement, des schemas et du format de reponse doit etre confirmee avec votre compte ; si le schema differe, le connecteur echoue explicitement et doit etre adapte.

Le client n'utilise aucun modele de langage et n'appelle aucun outil d'ecriture, meme si de futurs outils MCP le permettent. Sources : [documentation officielle GoMining](https://docs.gomining.com/en/product/ai/mcp-server), [OAuth du SDK officiel MCP](https://ts.sdk.modelcontextprotocol.io/v2/clients/oauth.html). Implementation : [server/gomining.js](server/gomining.js), tests : [test/gomining.test.js](test/gomining.test.js).
