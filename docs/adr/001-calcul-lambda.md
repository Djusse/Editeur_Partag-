# ADR 001 — Calcul sur Lambda (Node.js 20 / TypeScript)

**Statut :** accepté · **Date :** 2026-10-24

## Contexte

Le sujet impose un pic brutal : 15 000 visiteurs en quelques minutes, dont 80 % dans la
première minute, pendant que 300 rédacteurs continuent d'écrire. Le trafic est donc
extrêmement asymétrique : quelques minutes de charge intense, puis un régime très faible
pendant des semaines.

## Décision

Tout le calcul applicatif est exécuté par des fonctions **AWS Lambda** (Node.js 20,
TypeScript, architecture arm64), déployées par AWS SAM. Les handlers restent très fins :
la logique vit dans des bibliothèques pures (`backend/src/lib`), testables hors du cloud.

## Justification

- **Paiement à l'usage** : une capacité dimensionnée pour un pic d'une minute coûterait
  24 h/24 sur EC2/ECS, pour un usage réel de quelques minutes.
- **Mise à l'échelle automatique** : la concurrence Lambda absorbe le pic sans
  dimensionnement manuel. Le seul risque est le quota de concurrence d'un compte neuf,
  vérifié en phase 0 et documenté dans le README.
- **Un seul langage** : Yjs, le comptage des updates et le front sont en JavaScript ;
  partager le langage supprime les reprises de format entre client et serveur.
- **Handlers fins** : la logique de claim et de crédit est testée en local (26 tests
  unitaires) sans déployer quoi que ce soit.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| EC2 / ECS (conteneur toujours actif) | Coût fixe, capacité à dimensionner pour un pic de 60 s, patching à gérer |
| Spring Boot sur Lambda | Démarrages à froid de la JVM, pas de bibliothèque Yjs côté serveur |
| Serveur Node unique (y-websocket auto-hébergé) | État en mémoire, difficile à scaler ; point de défaillance unique |

## Conséquences

- Démarrages à froid : mitigés par des bundles esbuild (39 ko pour le handler WebSocket)
  et un cache de secrets SSM en variable de module.
- Le temps d'exécution est plafonné : la génération PDF est donc **asynchrone**
  (ADR 005), jamais dans la requête du visiteur.
- La concurrence doit être surveillée : `ReservedConcurrentExecutions` n'est pas posé,
  pour laisser l'échelle libre, mais les quotas sont vérifiés en phase 0.
