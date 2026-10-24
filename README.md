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
| OKX | Cle API, secret et passphrase | Trading + financement (quantites) + Earn (valorisation globale OKX en EUR) |
| Kraken | Cle API et secret, permission de consultation des fonds | Soldes spot |
| Coinbase | Cle API CDP et cle privee **ECDSA** au format PEM, droits de lecture | Soldes accessibles par Coinbase Advanced via CCXT |
| GoMining | Consentement OAuth via le compte GoMining, sans cle API manuelle | Wallet virtuel via MCP, en lecture seule |
| MetaMask / Ethereum | Adresse publique `0x` suivie de 40 caracteres hexadecimaux | Ethereum principal : ETH et jetons ERC-20 indexes par Blockscout |
| ViaBTC | Cle API du compte ou sous-compte, sans secret pour cet appel | Soldes du pool exposes par l'API de compte |
| Gate.io (international) / Gate EU (Europe) | Cle API v4 et secret, permission Spot en lecture seule | Compte spot : fonds disponibles + bloques |

Pour Coinbase, le nom complet de cle peut avoir la forme `organizations/.../apiKeys/...`. Conserver les lignes PEM ; les retours a la ligne echappes `\n` sont aussi acceptes. Utiliser une cle ECDSA compatible CCXT, pas une cle Ed25519. Si necessaire, creer une cle par portefeuille/sous-compte.

La compatibilite depend des restrictions geographiques, modes de compte, permissions et evolutions d'API. Les connexions privees doivent etre verifiees avec vos propres cles : les tests locaux simulent les fournisseurs. Pour Kraken, les soldes exposes par `BalanceEx` avec les suffixes `.S` (staking), `.M`, `.B`, `.F` (recompenses) et `.P` (parachain) sont additionnes au symbole de base avant valorisation : par exemple, 10 ADA + 20 ADA.S deviennent 30 ADA. Cette valorisation utilise le cours de l'actif sous-jacent ; elle ne signifie pas que les fonds bloques sont disponibles au retrait. Les suffixes inconnus et `.T` (actifs tokenises) ne sont pas assimiles au symbole de base. Aucun appel supplementaire aux APIs staking/Earn n'est effectue et aucun ancien releve n'est modifie. Voir les [suffixes historiques Kraken](https://support.kraken.com/articles/360039879471-what-is-asset-s-and-asset-m-) et la [documentation BalanceEx](https://docs.kraken.com/api/docs/rest-api/get-extended-balance/).

Le symbole historique Kraken `ETH2.S` est valorise et regroupe comme `ETH`, car il represente de l'Ether stake ([explication officielle](https://support.kraken.com/en-it/articles/360052734432)). Cette exception est propre a Kraken et a ce symbole exact.

Les positions Kraken staking/Earn absentes des soldes renvoyes, les contrats a terme, les positions sur marge et les wallets on-chain **ne sont pas couverts**. Un solde vide expose par une API est enregistre comme zero.

### OKX : trading, financement et Earn

Les comptes OKX existants collectent automatiquement ces trois perimetres avec les memes identifiants et le meme domaine regional. Utiliser une cle avec les droits **Read** ; aucun droit de trading, transfert, souscription ou retrait n'est requis.

- Trading : `GET /api/v5/account/balance` via CCXT.
- Financement : `GET /api/v5/asset/balances` via CCXT. Les quantites totales, y compris les fonds geles, sont additionnees au trading par crypto et valorisees via CoinGecko.
- Earn : `GET /api/v5/asset/asset-valuation?ccy=EUR`. Seul `details.earn` est ajoute. `totalBal`, `details.trading` et `details.funding` ne sont jamais additionnes, car ils recouvrent les soldes deja collectes.

Earn est presente comme une ligne **OKX Earn (valorisation)**, en EUR, sans quantite de jetons. Il ne s'agit pas d'un solde de liquidites en euros : les produits Earn ne sont pas detailles ni supposes disponibles au retrait. La couverture et l'estimation sont celles exposees par OKX pour ce compte et sa region, tous produits Earn confondus dans cette categorie. Les soldes ETH/SOL staking globaux ne sont pas ajoutes separement, car ils peuvent deja inclure trading et financement.

Si une partie de la collecte echoue, ou si la valorisation Earn est absente/malformee, aucun nouveau releve partiel n'est ecrit. Le dernier releve complet est conserve et l'erreur apparait dans Mes comptes. Un montant Earn explicitement egal a `0` est valide ; un champ absent n'est pas interprete comme zero.

Aucune recreation du compte ni modification du `.env` n'est necessaire. Apres fusion et deploiement du code, cliquer sur **Actualiser**. Les anciens releves sont conserves tels quels : le premier total elargi peut creer une hausse due au changement de perimetre, pas a une performance. Les captures SQLite stockent la valorisation Earn avec un type explicite, sans migration du schema SQL. Les tests simulent les reponses OKX ; l'acces reel des endpoints regionaux reste a confirmer avec votre compte.

Reference : [documentation officielle OKX, Funding / Get account asset valuation](https://www.okx.com/docs-v5/en/#funding-account-rest-api-get-account-asset-valuation).

#### LYUSDC : estimation et rapprochement avec OKX

LYUSDC est le recu OKX Europe representant des USDC places en DeFi Earn, recompenses reinvesties incluses. OKX indique un remboursement nominal de 1 LYUSDC pour 1 USDC, soumis aux conditions du protocole ([annonce officielle](https://www.okx.com/en-eu/help/lyusdc-defi-earn-eea)). Ce n'est pas une cotation de marche ni une garantie de remboursement.

MyWallet conserve le nom et la quantite **LYUSDC**, avec une estimation utilisant le cours **USDC/EUR** de CoinGecko. Cette correspondance ne s'applique qu'au symbole exact `LYUSDC` chez OKX : aucune regle generique n'est appliquee aux noms terminant par USDC, et aucun cours fixe de 1 USD n'est utilise.

Quand des LYUSDC sont presents, le champ Earn ne permet pas d'identifier si le recu est deja represente dans son montant. MyWallet ne suppose donc ni inclusion ni exclusion. Il utilise `totalBal` en EUR renvoye par OKX comme reference du total du compte et affiche, si necessaire, une ligne signee **Ajustement au total OKX**. Cette ligne vaut `total OKX - (estimation des cryptos trading/financement + valorisation Earn)`. Ainsi le recu ne gonfle pas le total par addition aveugle avec Earn. L'ajustement peut aussi refleter des differences de cours, d'heure de capture ou de perimetre avec la valorisation globale OKX ; il n'est pas une mesure exacte du chevauchement Earn/LYUSDC.

Le total d'un compte contenant LYUSDC suit donc la valorisation globale fournie par OKX, plutot qu'un total exclusivement CoinGecko. Comparer avec le total global de l'app OKX affiche en euros au meme moment, pas uniquement avec le sous-total Earn. La ligne d'ajustement n'a ni quantite de jetons ni pourcentage de repartition. Si `totalBal` manque ou est invalide, le nouveau releve est refuse et le dernier complet est conserve. Les comptes sans LYUSDC gardent le calcul trading + financement + Earn precedent. Aucune donnee historique n'est reecrite.

## Calcul et historique

- Soldes `total` remontes par CCXT, incluant les fonds libres et bloques exposes par l'API.
- Quantites et prix en EUR enregistres a chaque collecte. Aucun historique retroactif reel n'est invente.
- Prix en EUR via **CoinGecko** (API simple/price). Cle optionnelle `COINGECKO_API_KEY` (type `demo` ou `pro`). Sans cle, l'API publique est utilisee avec des limites plus strictes. Cache local d'environ 60 secondes.
- Pour les exchanges et ViaBTC, si un actif non nul n'a pas de prix disponible, **tout le releve du compte echoue** : aucune valorisation partielle n'est enregistree. Pour Ethereum, les jetons sans cotation sont au contraire listes comme **non valorises** et le total est explicitement marque **partiel** (voir ci-dessous).
- En cas d'echec d'un compte, son dernier releve est conserve et signale comme ancien. Les autres comptes continuent a etre collectes.
- Le graphique global additionne les derniers releves connus a chaque instant ; ce ne sont pas necessairement des releves simultanes. Un nouveau compte commence a compter a son premier releve.
- Les variations representent une variation de solde, **pas une performance d'investissement** : depots, retraits et transferts les affectent.
- Les courbes individuelles sont accessibles par le selecteur de compte ou les boutons de comptes. Export CSV de tous les releves et pagination du journal.
- Supprimer un compte supprime definitivement ses cles et ses releves et recalcule l'historique global sans ce compte. Une confirmation est requise.

## Configuration

### Suivre une adresse MetaMask sur Ethereum

Dans **Ajouter un compte**, choisir **MetaMask / Ethereum**, saisir un nom et l'adresse publique `0x...`, puis **Suivre cette adresse**. Aucun branchement a l'extension MetaMask, signature, mot de passe, cle privee ou phrase de recuperation n'est necessaire. Aucune nouvelle variable `.env` ou cle API n'est obligatoire. Une meme adresse ne peut etre ajoutee deux fois dans ce perimetre. Les adresses ENS ne sont pas resolues ; la validation verifie le format hexadecimal, pas la somme de controle EIP-55.

Le connecteur ne suit que le **reseau principal Ethereum** (chain ID 1), meme si la meme adresse existe sur d'autres reseaux. Base, Arbitrum, Polygon, BNB Chain, les reseaux de test, les NFT et les positions DeFi sans jeton representatif dans le wallet ne sont pas inclus.

- Lecture du solde ETH et de toutes les pages de jetons ERC-20 via l'API publique de [Blockscout Ethereum](https://eth.blockscout.com). L'adresse publique est transmise a cet explorateur ; ce sont des soldes indexes, qui peuvent avoir un delai par rapport a MetaMask. Une adresse dont le solde n'est pas encore indexe est signalee en erreur et n'est pas supposee vide.
- Les quantites brutes sont converties avec les decimales propres a chaque contrat. Si les decimales sont indisponibles, la quantite affichee est **Indisponible** et la quantite brute reste conservee dans le releve ; aucune hypothese de 18 decimales n'est faite.
- Valorisation ETH via CoinGecko ; ERC-20 par **adresse de contrat Ethereum**, jamais par le seul symbole. Les prix sont regroupes par lots de 50 contrats et utilisent la configuration CoinGecko deja existante. CoinGecko recoit les contrats, pas l'adresse du wallet. Deux jetons portant le meme symbole restent distincts et affichent un extrait de leur contrat.
- Un jeton sans cours EUR disponible reste visible avec **Non valorise**. Le solde total, la carte du compte, l'historique et les donnees API signalent la valorisation partielle ; ces jetons sont exclus du sous-total chiffre, pas assimiles a des actifs valant zero. Le CSV ajoute la colonne `valuation_status` (`complete` ou `partial`). Les jetons distribues sans sollicitation peuvent donc apparaitre, sans leur attribuer le cours d'un jeton homonyme.
- Une erreur reseau, un refus/une limite API, une reponse de solde malformee ou une pagination incomplete fait echouer la collecte et conserve le dernier releve. La lecture est limitee a 20 pages de jetons ; une limite atteinte est une erreur explicite, jamais un total tronque silencieusement. Les nouvelles captures ne sont pas garanties au meme bloc pour ETH et tous les jetons.

Les quantites et valorisations sont stockees en nombres JavaScript pour l'affichage et les graphiques, et peuvent etre arrondies. Aucune transaction on-chain n'est generee. Les donnees precedentes des exchanges et leur comportement de collecte sont conserves. Apres fusion et deploiement, actualiser la page puis ajouter le wallet dans l'interface.

References : [API Blockscout](https://github.com/blockscout/blockscout-api-v2-swagger/blob/main/swagger.yaml), [prix CoinGecko par contrat](https://docs.coingecko.com/demo/reference/simple-token-price).

### Ajouter ViaBTC

Dans ViaBTC, ouvrir **Account Management > API Management**, creer ou recuperer la **cle API du compte ou sous-compte souhaite**, puis configurer la liste blanche avec l'**IP publique de sortie du serveur MyWallet**. Ce n'est ni l'IP locale `192.168...`, ni necessairement l'IP du domaine Cloudflare utilise pour acceder a MyWallet. La configuration de liste blanche est requise par la documentation ViaBTC.

Apres fusion et deploiement, choisir **Ajouter un compte > ViaBTC**, saisir un nom puis la cle API. Le secret API n'est ni demande ni conserve : l'appel documente `GET /res/openapi/v1/account` ne necessite pas de signature. La cle est chiffree dans SQLite comme les autres identifiants et n'est jamais renvoyee au navigateur. Aucun changement de `.env` n'est necessaire.

Le connecteur lit uniquement la liste `data.balance` (`coin`, `amount`) du compte associe a la cle, sur `https://www.viabtc.com`. Les soldes de toutes les monnaies renvoyees sont valorises via le moteur CoinGecko existant. Les profits cumules, estimations de revenus, historiques de paiements, adresses de retrait, statistiques de hashrate et workers ne sont pas ajoutes au patrimoine. L'objectif est de suivre les soldes restants exposes par le pool, sans additionner de nouveau les revenus deja verses dans un wallet ou exchange suivi ailleurs. Les captures des differents fournisseurs restent prises a des instants differents.

Les sous-comptes ne sont pas enumeres ni additionnes automatiquement ; ajouter un compte MyWallet avec sa propre cle pour chaque sous-compte a suivre. Une meme cle ne peut pas etre ajoutee deux fois. Ne pas ajouter deux cles distinctes du meme compte comme s'il s'agissait de deux patrimoines independants.

Les erreurs de cle (`12001`) et d'IP (`12004`) sont expliquees dans Mes comptes. Une reponse absente, malformee, un refus API ou une erreur de prix conserve le dernier releve complet ; un tableau de soldes explicitement vide est accepte comme un solde nul. Les messages bruts du fournisseur, qui pourraient contenir des donnees de compte, ne sont pas enregistres dans les erreurs. Les redirections HTTP sont refusees afin de ne pas transmettre la cle a un autre domaine. Aucun appel de retrait, transfert ou modification n'est effectue.

References : [configuration des cles ViaBTC](https://support.viabtc.com/hc/en-us/articles/7207443487887-What-is-API-and-How-to-Set-Up), [API de compte](https://github.com/viabtc/viapool_api/wiki/acquire_account_info), [authentification](https://github.com/viabtc/viapool_api/wiki/api_authentication), [codes d'erreur](https://github.com/viabtc/viapool_api/wiki/error_code). Les tests simulent les reponses authentifiees ; verifier les montants avec le compte ViaBTC reel apres deploiement.

### Ajouter Gate.io ou Gate EU

Creer une **cle API v4** et son **secret** sur la plateforme ou votre compte est ouvert, avec la permission **Spot / Read-only**. Aucun droit de trading, retrait ou transfert n'est requis. Si une liste blanche IP est configuree, autoriser l'IP publique de sortie du serveur MyWallet. Gate indique que les modifications de permissions peuvent prendre jusqu'a cinq minutes pour s'appliquer.

Dans **Ajouter un compte**, choisir la plateforme correspondant a la creation de la cle :

- **Gate.io (international)** : API `https://api.gateio.ws/api/v4`.
- **Gate EU (Europe)** : API `https://api.gateeu.com/api/v4`.

Ce choix depend du compte, pas de l'emplacement du serveur. Saisir un nom, la cle et le secret dans MyWallet ; aucune passphrase ni modification du `.env` n'est necessaire. Les identifiants sont chiffres comme ceux des autres exchanges et ne sont pas renvoyes au navigateur.

Le connecteur utilise la signature APIv4 de CCXT pour un seul appel prive, **GET /spot/accounts**. Il additionne `available` et `locked` pour chaque monnaie, puis valorise via CoinGecko. Le GT est associe explicitement a l'identifiant CoinGecko `gatechain-token`. Il n'effectue ni decouverte du statut de compte unifie ni appel a d'autres groupes de permissions. Cette version ne couvre pas Earn, marge, futures, contrats ou soldes du compte unifie distincts du spot.

Les erreurs de cle, signature, liste blanche IP et horodatage sont traduites en messages explicites sans recopier les messages bruts du fournisseur. Une liste de soldes absente ou malformee, des monnaies dupliquees, des quantites invalides, une erreur reseau ou un cours manquant refusent le nouveau releve et conservent le precedent. Seul un tableau de soldes explicitement vide est accepte comme zero. Les captures existantes ne sont pas modifiees.

References : [API Gate internationale et permissions](https://www.gate.com/docs/developers/apiv4/en/), [endpoint spot](https://www.gate.com/docs/developers/apiv4/en/spot/), [API Gate EU](https://www.gate.com/en-eu/docs/developers/apiv4/), [identifiant GT CoinGecko](https://www.coingecko.com/en/coins/gatetoken). Les tests utilisent le vrai signataire CCXT avec des reponses simulees ; verifier les soldes avec le compte reel apres deploiement.

### Variables

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
| `OKX_HOSTNAME` | Domaine API OKX : `eea.okx.com` pour les comptes europeens, `us.okx.com` pour les Etats-Unis, `www.okx.com` ailleurs (defaut si absent) |
| `DEMO_MODE` | `true` active la demo publique en lecture seule ; desactive dans Compose |

Les cles sont chiffrees dans la base ; elles ne sont jamais renvoyees au navigateur. Les sessions sont en memoire, durent 12 heures et sont invalidees au redemarrage. Les cookies sont HttpOnly/SameSite Strict. Cinq echecs de connexion bloquent une adresse IP pendant 15 minutes. Les requetes de modification exigent du JSON et verifient l'origine.

### OKX : erreur 50119 (API key doesn't exist)

MyWallet utilisait uniquement le domaine mondial `www.okx.com`. Une cle d'un compte europeen peut donc etre refusee meme si elle est valide. [La FAQ officielle OKX](https://www.okx.com/help/api-faq) demande le domaine `eea.okx.com` pour l'EEE et `us.okx.com` pour les Etats-Unis.

Pour un compte europeen, ajouter dans le fichier `.env` existant :

```dotenv
OKX_HOSTNAME=eea.okx.com
```

Puis reconstruire et recreer le conteneur avec `docker compose up -d --build` (ou redemarrer `npm start` en local), et cliquer sur **Actualiser**. Les comptes et leur historique sont conserves ; il n'est pas necessaire de recreer le compte dans MyWallet. Ne pas remplacer le fichier `.env` existant ni sa cle `ENCRYPTION_KEY`.

Le domaine correspond au compte OKX, pas a l'emplacement du serveur MyWallet. Si l'erreur persiste avec le domaine approprie, verifier que la cle est toujours active et qu'elle appartient au compte reel attendu.

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

#### Prix des tokens Gate

Les cours des actifs Gate proviennent des tickers spot de la plateforme choisie (international ou EU), sans recherche du token par symbole sur CoinGecko. Priorite aux paires EUR, puis USDT, USDC, BTC et ETH ; le dernier cours est converti en EUR avec le prix CoinGecko de la devise de cotation (sans supposer USDT = USD). Une seule requete publique `/spot/tickers` par compte et collecte, aucune permission supplementaire.

Un token sans paire exploitable reste visible avec sa quantite et la mention « Non valorise ». Il est exclu du total valorise, explicitement partiel dans l'interface et les exports. Une panne reseau ou une reponse de cours invalide conserve le dernier releve au lieu de produire un total incomplet silencieux. Le dernier cours peut differer du prix de vente effectif, notamment pour les tokens peu liquides.
