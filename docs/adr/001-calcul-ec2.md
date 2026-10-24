# ADR 001 — Une instance EC2, Node.js (Fastify + `ws` + Yjs)

**Statut :** accepté · **Date :** 2026-10-24 · **Remplace :** ADR 001 v6 (Lambda)

## Contexte

Deux contraintes éliminatoires reposent sur de l'**écriture concurrente** :

- C2 : 300 rédacteurs dans un même document, écriture au même endroit, aucune
  modification perdue, convergence ;
- C5 : 15 000 visiteurs au pic (80 % en 60 s) pendant que les rédacteurs écrivent.

Les quotas **mesurés dans le compte** (région `eu-north-1`) sont :

| Quota | Valeur | Conséquence |
| - | - | - |
| Concurrence Lambda | **400** | partagée entre claims, polling et écritures : serré pour C5 |
| vCPU EC2 (familles A, C, D, H, I, M, R, T, Z) | **16** | de la marge pour une instance applicative |

## Décision

Une **instance EC2** (`t3.large`, 2 vCPU / 8 Gio, crédits CPU **Standard**),
Amazon Linux 2023, derrière nginx, exécutant un processus Node.js 22 :

- **Fastify** pour le REST (`/api/*`) ;
- **`ws`** pour le WebSocket natif (`/ws`) ;
- **Yjs** pour la fusion CRDT, avec l'état des documents **en mémoire**.

## Justification

- **Écrivain unique par document** : un seul processus détient chaque document.
  Le compteur `seq` n'a donc aucune contention, alors qu'en Lambda deux
  exécutions concurrentes se disputeraient la même condition sur `Documents`.
- **WebSocket sans limite de service** : API Gateway WebSocket refuse les trames
  binaires (code 1003) et plafonne à 32 Ko, ce qui imposait Base64 et un plafond
  de 16 Ko. Ici, le plafond de 64 Ko demandé par l'interface est direct.
- **Diffusion groupée locale** : un tick de 250 ms diffuse **un seul** message à
  tous les clients, sans appel réseau par destinataire.
- **Vu en cours** : rôles d'instance, Security Groups, user data, IMDSv2,
  Elastic IP (TP 3 et 4), CloudFormation. Aucun service non étudié n'est requis.
- **Mesure possible** : `CPUCreditBalance`, charge CPU et retard de la boucle
  d'événements sont observables, ce qui rend le rapport de test défendable.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| Lambda + API Gateway | Concurrence 400 partagée ; WebSocket sans binaire ni trame > 32 Ko ; un appel `postToConnection` par destinataire |
| Spring Boot sur Lambda | Démarrages à froid JVM, pas de bibliothèque Yjs côté serveur |
| Plusieurs instances + load balancer | Le partage d'un document entre processus exigerait un bus de diffusion ; hors du temps disponible, et inutile pour la cible |

## Conséquences

- **Pas de haute disponibilité** : une instance = un point de panne. Parade :
  `Restart=always` (systemd), état reconstruit depuis DynamoDB, scénario S7
  (kill -9) dans le rapport. Limite écrite dans le dossier de conception.
- **Redémarrage** : les updates non acquittées sont renvoyées par les clients
  avec le **même** `opId`, donc dédupliquées ; rien n'est perdu ni débité deux fois.
- **Quotas système** : `LimitNOFILE=65536` (systemd) et
  `worker_rlimit_nofile 65536` (nginx) pour tenir 12 000+ connexions.
- **Crédits CPU `t3`** : à surveiller pendant les tests ; le type d'instance est
  un paramètre du template, donc le changement se fait sans redéploiement du code.
