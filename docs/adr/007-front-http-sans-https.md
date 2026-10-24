# ADR 007 — Front statique servi par nginx, en HTTP sur une IP nue

**Statut :** accepté, avec limite assumée · **Date :** 2026-10-24

## Contexte

Le compte ne dispose **pas de nom de domaine**. Or un certificat ACM exige un
domaine, donc HTTPS n'est pas directement possible sur une Elastic IP. Le jury
doit néanmoins pouvoir tester l'application par une URL stable.

## Décision

- **Elastic IP** : l'adresse IPv4 publique change après un arrêt/démarrage
  (cours, TP 3) ; une EIP est la seule manière de fournir une URL stable.
- **nginx** sert le front statique (`out/` de Next.js) et proxifie `/api` et
  `/ws` vers Node sur `127.0.0.1:3000` : le processus applicatif ne traite aucun
  fichier.
- **Micro-cache** de `/d/{token}/status` (1 s tant qu'actif, 60 s une fois
  épuisé via `X-Accel-Expires`) : c'est ce qui absorbce le pic de sondage (C5) et
  accélère l'annonce d'épuisement (C6).
- **HTTP en clair**, limite documentée.

## Conséquences techniques imposées par l'absence de HTTPS

Une page servie en HTTP sur une IP nue **n'est pas un contexte sécurisé** : les
API suivantes du navigateur n'existent pas et lèveraient une exception.
L'interface s'interdit donc explicitement :

| API interdite | Remplacement retenu |
| - | - |
| `crypto.randomUUID()` | `uuidv4()` bâti sur `crypto.getRandomValues` |
| `navigator.clipboard` | `copyText()` avec `document.execCommand('copy')` |
| Service workers | Aucun ; pas de mode hors ligne complet (hors périmètre) |
| `wss://` en dur | `wsUrl()` déduit de `location` (`ws:` ou `wss:`) |
| URL absolue de l'API | Chemin relatif `/api` (même origine) |

Ces quatre points sont des **critères d'acceptation** vérifiables et sont
couvertes par un contrôle automatique dans le dépôt.

## Justification

- **Une URL stable est un prérequis du test du jury** : sans EIP, l'adresse
  change à chaque redémarrage.
- **nginx devant Node** évite que le processus applicatif serve des fichiers
  statiques et fournit le micro-cache, ce qui est décisif pour C5.
- **Pas de dépendance à un domaine** : le déploiement reste en une commande.

## Alternatives écartées

| Alternative | Raison du rejet |
| - | - |
| CloudFront + certificat | Exige un domaine : hors périmètre du compte |
| Certificat auto-signé | Avertissement navigateur chez le jury, inacceptable |
| Next.js en SSR sur l'instance | Un serveur de plus, pour aucun besoin (le front est statique) |
| Laisser Node servir le front | Perte du micro-cache et du proxy WebSocket optimisé |

## Limites assumées (à écrire dans le dossier de conception)

- **Jetons et e-mails en clair** sur le réseau : le JWT de session, la clé
  d'administration et les adresses e-mail circulent sans chiffrement. Piste
  d'amélioration : domaine + HTTPS (CloudFront ou certificat ACM + Route 53).
- **Instance unique** : pas de haute disponibilité ; redémarrage automatique par
  systemd et état reconstruit depuis DynamoDB. Piste : répartir les documents par
  `docId` sur plusieurs instances, avec un répartiteur.
- **Port 22 limité** à `AdminCidr` (`/32` recommandé) ; Session Manager reste
  disponible en repli si l'IP du poste change.
