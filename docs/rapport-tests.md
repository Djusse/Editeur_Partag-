# Rapport de tests et de coûts

Ce document rassemble les résultats **mesurés** du projet : ce qui a été exécuté,
avec quels chiffres, et ce qui ne l'a pas été. Il complète le
[dossier de conception](conception/conception.pdf) et le
[journal des défauts](journal.md).

Les chiffres de ce rapport proviennent tous d'une exécution réelle contre le
déploiement `http://13.53.160.209`. Aucun n'est estimé, sauf mention explicite.

---

## 1. Synthèse

| Contrainte | État | Preuve |
| - | - | - |
| **C1** — exactement N téléchargements | **prouvée** | S1 en charge : 500 réservations exactement, 16 753 requêtes, 0 erreur serveur |
| **C2** — aucune modification perdue | **prouvée** | S2 palier 50 : 2 296 acquittés, 0 sans ack ; journal contigu, 0 trou |
| **C3** — document tel qu'il est à T1 | **prouvée** | 11 tests unitaires ; le claim fige le `seq`, une génération par version |
| **C4** — jamais plus que son crédit | **prouvée** | 17 tests unitaires ; scénario d'épuisement de bout en bout |
| **C5** — 15 000 clics + rédacteurs | **partiellement** | S1 prouve le pic visiteur seul ; S5 écrit mais non exécuté |
| **C6** — dernier exemplaire, vite | **prouvée** | 9 tests unitaires ; état épuisé monotone et mis en cache |

Les deux contraintes **éliminatoires** (C1 et C2) sont prouvées en production.
C5 n'est prouvée que sur sa moitié visiteur : c'est la limite principale de ce
rapport, et elle est assumée plus bas.

---

## 2. Tests unitaires et d'intégration

### 2.1 Suite unitaire

```
code           : backend/
commande       : npm test
framework      : Vitest
résultat       : 45 tests, 4 fichiers, tous verts (~11 s)
```

| Fichier | Tests | Objet |
| - | - | - |
| `test/claim.test.ts` | 11 | **C1** : N exact, 50 claims concurrents pour N=20, idempotence par `visitorId`, ticket renvoyé après épuisement, T1 figée, un seul job PDF par version |
| `test/credit.test.ts` | 18 | **C4** : débit exact, plafond, multi-connexions, `opId` rejoué, même contenu sous un autre `opId`, suppressions facturées, séquence contiguë, restauration gratuite, blocage au 4ᵉ refus, doublons internes acquittés, borne de 100 items |
| `test/yjs-update.test.ts` | 7 | comptage sur de vrais updates Yjs : insertions, suppressions, update complet, unicode, update corrompu |
| `test/email.test.ts` | 9 | **C6** : envoi au seul dernier exemplaire, idempotence, panne SES sans impact visiteur, relâchement du verrou, échappement HTML, pluriel |

Aucun test n'appelle un service AWS : le stockage, la file, le courriel, la base
et les secrets sont injectés ou doublés.

### 2.2 Scripts d'intégration, en local

Serveur local démarré (`npm run local`), sans AWS.

| Script | Résultat | Objet |
| - | - | - |
| `e2e-local.mjs` | 24/24 | session, document, WebSocket natif, écriture, crédit, repli HTTP, lien, claim, PDF, échéance, supervision, contrôle d'accès, préflight CORS |
| `test-credit-exhaustion.mjs` | 19/19 | décompte jusqu'à zéro, refus explicite, non-journalisation, `readOnly` à la reconnexion, blocage au 4ᵉ refus |
| `test-link-real.mjs` | 13/13 | contrat d'URL du parcours visiteur, de bout en bout jusqu'au PDF |
| `test-visitor-routes.mjs` | 7/7 | non-régression : `/d/…` à la racine, `/api/d/…` en 404 |
| `test-versions.mjs` | 11/11 | enregistrement, liste, restauration |
| `test-persistence.mjs` | 7/7 | reprise après redémarrage |
| `verify-client-bundle.mjs` | 8/8 et 4/4 | le bundle client vise la bonne API, en dev et en production |

> Le script `e2e-local.mjs` suppose un serveur **fraîchement démarré** : il crée un
> document puis épuise son lien. Lancé deux fois sans redémarrage, la seconde passe
> échoue sur le quota déjà consommé.

---

## 3. Tests de charge

### 3.1 Moyens

| Élément | Valeur |
| - | - |
| Générateur | k6 v2.3.0, sur une EC2 dédiée dans la même région |
| Cible | `http://13.53.160.209`, instance `m7i-flex.large` (2 vCPU / 8 Gio) |
| Comptes de charge | 4 adresses distinctes, membres du document, crédit frais |

**Pourquoi une machine de charge séparée.** Depuis un poste local, on mesure le
réseau, pas l'application. Et depuis l'instance applicative, le générateur
concurrencerait le serveur qu'il mesure.

**Pourquoi plusieurs comptes.** Le crédit est de 10 000 caractères par jour et
par **adresse**, pas par connexion. Avec un seul jeton, 50 rédacteurs épuisent
le quota en quelques secondes et le test mesure le blocage, pas la convergence.

### 3.2 S1 — C1 : quota exact sous pic

```
scénario         : 15 000 visiteurs, lien de 500 exemplaires, 80 % du pic en 60 s
requêtes totales : 16 753
réservations     : 500  — exactement le quota
pic de débit     : 200 requêtes/s
erreurs 5xx      : 0
refus « épuisé » : explicites (410), jamais des erreurs
```

**Verdict : C1 tenue.** $N$ réservations pour un lien de $N$ exemplaires, ni
$N-1$ ni $N+1$, sous un pic de 15 000 visiteurs.

### 3.3 S2 — C2 : rédacteurs simultanés

```
palier           : 50 rédacteurs, 45 s, cadence 1 update/s
updates émis     : ~2 296
updates acquittés: 2 296
sans ack         : 0
refus explicites : 0
latence ack p95  : 301 ms   (tick d'écriture : 250 ms)
diffusion        : 6 845 messages (~137 par VU, un par tick)
```

**Verdict : C2 tenue.** Chaque modification émise a reçu son acquittement, et
aucune n'est restée sans réponse.

La vérification du **contenu**, que k6 ne peut pas faire, a été menée
indépendamment :

```json
{ "seqServeur": 138, "entreesJournal": 138, "trous": 0,
  "longueurFinale": 2297, "seqCoherent": true,
  "reconstructionStable": true, "verdict": "CONVERGENCE OK" }
```

Le recoupement fait la preuve : k6 compte **2 296** acquittements côté client,
le vérificateur dénombre **138 entrées de journal** contenant chacune ~16,6
updates, et la longueur reconstruite vaut **2 297** (2 296 + le caractère
préexistant). Deux outils indépendants, trois chemins de calcul, le même nombre.

### 3.4 Ce qui n'a pas été exécuté

| Scénario | État | Raison |
| - | - | - |
| S2 paliers 100 et 300 | écrit, validé au banc, **non exécuté** | temps disponible |
| S5 — pic complet (visiteurs + rédacteurs simultanés) | écrit, validé au banc, **non exécuté** | temps disponible |
| S7 — robustesse (`kill -9` en pleine écriture) | écrit, **non exécuté** | temps disponible |

Ces scénarios sont versionnés dans [`tests/k6/`](../tests/k6/) et documentés dans
[`tests/k6/README.md`](../tests/k6/README.md). Les présenter comme exécutés
serait faux ; les annoncer comme disponibles et reproductibles est exact.

**Conséquence sur C5.** La contrainte porte sur le pic *complet* : 15 000 clics
**pendant** que 300 rédacteurs écrivent. S1 prouve la moitié visiteur, S2 prouve
la tenue de l'écriture à 50 rédacteurs, mais leur **combinaison** n'a pas été
mesurée. C5 est donc partiellement prouvée.

---

## 4. Défauts révélés par la campagne de charge

La campagne a échoué deux fois avant de passer. Chaque échec a révélé un défaut
que les tests unitaires ne pouvaient pas voir — c'est le résultat le plus utile
de cette phase.

### 4.1 Premier échec — 2 292 updates émis, 106 acquittés

Le scénario envoyait à **tous** les VUs le même payload. Or le serveur
déduplique par empreinte du contenu : les updates identiques étaient écartés du
lot, et leurs expéditeurs n'obtenaient jamais d'acquittement. Le `continue` qui
les retirait était **muet**.

Deux défauts, pas un. Le test était faux — cinquante rédacteurs insérant le même
caractère produisent *une* opération CRDT, pas cinquante. Et le serveur avait un
angle mort : un client réel dont l'update est dédupliqué restait bloqué sur
« N modifications en attente », sans erreur affichée.

### 4.2 Second échec — 227 884 messages d'erreur, 0 acquittement

Ce n'était pas 227 884 refus mais **~5 000 messages par seconde** : une tempête
de réessais. Le lot échouait à chaque tick, était remis en file, la file
grossissait, et chaque tick réémettait une erreur pour tout ce qu'elle
contenait — croissance quadratique.

Cause : `TransactWriteItems` plafonne à **100 éléments**. Une transaction
comprend 1 `Update` sur `Documents`, 1 `Put` sur `Updates`, 2 `Put` par update,
et **1 `Update` par auteur distinct** sur `Credits`. Avec 50 rédacteurs
différents, cela fait 50 lignes de crédit — et **146 items mesurés pour 50
updates**, et non les 103 estimés.

### 4.3 La leçon méthodologique

Le double en mémoire de DynamoDB **n'imposait aucune limite** sur `transact`.
C'est la **quatrième** fois qu'il se révélait plus permissif que le vrai service,
après l'arithmétique entre valeurs, les mots réservés et maintenant la taille de
transaction.

Un faux service qui n'imite que les succès laisse passer du code cassé.

---

## 5. Coûts

Relevé le 26/10 à 05h20 UTC, sur la période du 24 au 27 octobre, via
`aws ce get-cost-and-usage`.

### 5.1 Total

**0,00 USD.** Tous les services consommés restent dans le quota gratuit du
compte. Le seul montant non nul est négatif (`−0,0000012 USD`) : c'est un crédit
ou un arrondi de facturation, pas une dépense.

| Service | Montant |
| - | - |
| Amazon Elastic Compute Cloud — Compute | 0,00 USD |
| Amazon DynamoDB | 0,00 USD |
| Amazon Simple Storage Service | 0,00 USD |
| Amazon Simple Queue Service | 0,00 USD |
| Amazon Simple Email Service | 0,00 USD |
| Amazon Virtual Private Cloud | 0,00 USD |
| AWS CloudFormation · CloudWatch · KMS | 0,00 USD |
| AWS Data Transfer · EC2 — Other | −0,0000012 USD |
| **Total** | **0,00 USD** |

### 5.2 Ce que ce total valide

Le type d'instance. `t3.large`, choisi au départ, avait dû être abandonné dès le
premier déploiement : la création de pile échouait avec « The specified instance
type is not eligible for Free Tier ». Le `m7i-flex.large` retenu à la place
(2 vCPU / 8 Gio) est éligible — et c'est ce qui explique un total à zéro. Une
seule instance hors quota aurait fait basculer toute la facture.

### 5.3 Ce que cette mesure ne dit pas

**Trou de mesure de 36 heures.** Cost Explorer renvoie `Estimated: true` et
laisse les journées du **25 et du 26 vides** : la facturation a environ 24 h de
retard, donc la campagne de la nuit n'y figure pas. Un total à 0,00 USD signifie
« rien de facturé selon les données disponibles », et non « rien consommé ».

**Le groupement par balise ne mesure rien.** `Type=TAG,Key=Projet` renvoie une
clé vide et un montant nul. AWS ne rétro-applique pas les balises : les
ressources détruites lors des redéploiements successifs échappent au calcul.

### 5.4 Volume réel, calculé à partir des compteurs

Les métriques d'usage donnent la consommation réelle, indépendamment du retard de
facturation.

| Poste | Volume | Lecture |
| - | - | - |
| DynamoDB écriture | ~14 000 WCU | 138 transactions × ~100 items. Négligeable. |
| DynamoDB lecture | quelques milliers de LRU | `/state` et les claims |
| EC2 applicative | ~6 h | `m7i-flex.large`, éligible Free Tier |
| EC2 de charge | quelques heures | arrêtée après usage |
| S3 | quelques Mo | PDF et snapshots |
| SQS | 1 message par version de PDF | négligeable |
| SES | quelques unités | notification de fin de quota |

Ordre de grandeur : **les tests de charge eux-mêmes coûtent quelques centimes**.
L'essentiel de la dépense est le temps d'instance allumée, pas les requêtes.

### 5.5 Coût résiduel après les tests

Une instance **arrêtée** ne coûte plus de calcul, mais pas zéro.

| Ressource | `stop` de l'instance | `./scripts/destroy.sh` |
| - | - | - |
| EC2 applicative | plus de calcul facturé | supprimée |
| Disque EBS | **facturé** | supprimé |
| Elastic IP | **facturée** | libérée |
| VM de charge | plus de calcul, IPv4 toujours due | à `terminate` séparément |

Depuis février 2024, toute adresse IPv4 publique est payante, y compris une
Elastic IP attachée à une instance **arrêtée**. Pour arrêter toute dépense :

```bash
./scripts/destroy.sh --yes
```

Si l'application doit rester accessible au jury, laisser la pile coûte quelques
dollars par mois, essentiellement le stockage et l'adresse.

---

## 6. Ce que ce rapport ne couvre pas

| Manque | Conséquence |
| - | - |
| Paliers 100 et 300 | le nombre maximal de rédacteurs simultanés tenus n'est pas établi au-delà de 50 |
| S5 (pic complet) | **C5 n'est que partiellement prouvée** : visiteurs et rédacteurs n'ont pas été mesurés ensemble |
| S7 (`kill -9`) | la reprise après arrêt brutal est écrite mais non mesurée |
| Métriques système | CPU et mémoire de pointe non relevés sur CloudWatch ; le dimensionnement est justifié par le type d'instance, pas par une mesure de charge |
| Facturation après le 26/10 | le coût exact de la campagne de charge n'apparaîtra qu'après le délai de 24 h |

Ces manques sont reportés ici plutôt que corrigés par une estimation. Un chiffre
annoncé sans mesure vaut moins qu'un chiffre absent.
