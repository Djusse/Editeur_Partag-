# Infrastructure

Une seule pile CloudFormation ([`template.yaml`](template.yaml)) déployée en `eu-north-1`.

---

## Free Tier : quelle taille d'instance ?

Le plan v7 visait `t3.large` (2 vCPU / 8 Gio) pour tenir C5 — 12 000 connexions
WebSocket avec l'état des documents **en mémoire**. Ce n'est pas une exigence du
code, mais une exigence de **capacité**.

Le piège : `t3.large` **n'est pas éligible au Free Tier**, et un compte neuf
échoue à la création avec :

```
Resource handler returned message: "The specified instance type is not eligible
for Free Tier. … (Service: Ec2, Status Code: 400) (HandlerErrorCode: InvalidRequest)"
```

**La solution retenue : `m7i-flex.large`**, éligible au Free Tier **et** doté de
8 Gio. On conserve donc la **mémoire** de la cible initiale sans quitter le
gratuit.

⚠️ **Mais 8 Gio de RAM ne suffisent pas à garantir C5.** Deux différences
subsistent avec `t3.large` :

| Point | `t3.large` (plan v7) | `m7i-flex.large` | Effet sur C5 |
| - | - | - | - |
| CPU | 2 vCPU **burstable**, crédits Standard (24/h) | 2 vCPU **non burstable**, pleine puissance en continu | à la charge : `m7i-flex` est **meilleur** (pas d'épuisement de crédits) |
| Débit réseau | jusqu'à 5 Gbit/s | **jusqu'à 12,5 Gbit/s** | à la charge : `m7i-flex` est **meilleur** |
| Mémoire | 8 Gio | 8 Gio | identique |
| **EBS** | **baseline 3 000 IOPS** garantis | baseline plus faible, dépend du volume | **point faible** : peu d'écritures ici (250 ms de tick), impact limité |
| Coût si facturé | ~0,0832 $/h | ~0,1008 $/h | sans objet en Free Tier |

Ce qui **n'est pas** garanti : 15 000 clics + 300 rédacteurs au même instant.
C5 est une contrainte de **débit mesuré**, pas une spécification de machine.
Seul le scénario S5 le dira.

| Taille | vCPU | RAM | Free Tier | Usage |
| - | - | - | - | - |
| `m7i-flex.large` | 2 | **8 Gio** | **oui** | **défaut : même mémoire que la cible** |
| `t3.micro` | 2 (burstable) | 1 Gio | oui | trop juste (OOM probable) |
| `t3.small` | 2 (burstable) | 2 Gio | oui | repli si `m7i-flex` indisponible |
| `t3.medium` | 2 | 4 Gio | non | compromis |
| `t3.large` | 2 | 8 Gio | non | référence du plan v7 (EBS garanti) |
| `t3.xlarge` | 4 | 16 Gio | non | marge confortable |

`CreditSpecification` est appliqué **conditionnellement** aux familles
burstable : l'envoyer pour `m7i-flex` (qui ne l'accepte pas) fait échouer la
création avec `InvalidParameterCombination`.

L'éligibilité **dépend du compte et de la région** : elle ne se devine pas, elle
s'interroge. [`deploy.sh`](../scripts/deploy.sh) le fait désormais avant de créer
la pile, au lieu d'attendre l'échec après plusieurs minutes.

Pour lister les types éligibles sur ton compte :

```bash
aws ec2 describe-instance-types --region eu-north-1 \
  --filters "Name=free-tier-eligible,Values=true" \
  --query "InstanceTypes[].[InstanceType,VCpuInfo.DefaultVCpus,MemoryInfo.SizeInMiB]" \
  --output table
```

### Autres limites du Free Tier

| Ressource | Limite gratuite | État dans ce template |
| - | - | - |
| EBS gp3 | **30 Gio** au total | 20 Gio → conforme |
| Elastic IP | 1 par compte, gratuite **si attachée** | 1, attachée → conforme |
| DynamoDB | 25 Gio ; `PAY_PER_REQUEST` facturé à l'usage | quelques centimes |
| S3 | 5 Gio | PDF et snapshots, négligeable |
| SQS | 1 M requêtes/mois | conforme |

**Si `m7i-flex.large` n'est pas éligible sur ton compte**, la démarche honnête
est de descendre en `t3.small` et d'assumer la limite :

1. **valider le fonctionnel** (C1, C2, C3, C4, C6) — tout passe : claim exact,
   convergence, PDF, crédit, blocage, notification SES ;
2. **mesurer C5 avec un plafond explicite** : k6 avec un nombre de connexions
   que l'instance tient réellement, et publier le chiffre obtenu plutôt qu'un
   seuil théorique non mesuré ;
3. **changer de taille** pour la soutenance, en acceptant la facturation
   (quelques centimes par heure).

Le changement se fait par `INSTANCE_TYPE=…`. L'instance est alors **remplacée**,
mais l'Elastic IP est réattachée : l'adresse publique reste stable.

| Ressource | Rôle |
| - | - |
| `Instance` (EC2 `m7i-flex.large`) | Node.js : Fastify (REST) + `ws` (WebSocket) + Yjs, état en mémoire |
| `ElasticIp` | URL stable (l'IP publique change après arrêt/démarrage) |
| `SecurityGroup` | 80 ouvert ; 22 **seulement** si `AdminCidr` est une vraie plage |
| `InstanceRole` | Moindre privilège : tables nommées, préfixe S3, file SQS, SES filtré, `/editeur/*` en SSM |
| `Bucket` | PDF, snapshots, versions, artefacts ; public bloqué, chiffré, HTTPS obligatoire |
| 10 tables DynamoDB | Documents, Members, Updates, Credits, OpIds, Abuse, Links, Tickets, PdfCache, Versions |
| `PdfQueue` + DLQ | Génération PDF asynchrone, 3 essais puis lettre morte |
| `AppLogGroup` | /editeur/app, rétention 7 jours |

Le user data installe nginx (avec micro-cache de `/d/{token}/status` et proxy
WebSocket), systemd (`editeur-app`, `editeur-worker`, `Restart=always`,
`LimitNOFILE=65536`) et écrit `/opt/editeur/app.env`. **Aucun secret n'y figure** :
ils sont lus dans SSM par le rôle d'instance.

Les secrets `/editeur/jwt-secret` et `/editeur/admin-key` sont créés par
`scripts/deploy.sh`, jamais par le template : ils n'apparaissent donc ni dans le
dépôt, ni dans l'historique CloudFormation.

---

## Défauts révélés par le premier déploiement réel

Aucun test unitaire ne pouvait les attraper : ils n'existent qu'au contact de
l'environnement cible. Tous sont corrigés, et chacun a laissé une trace dans le
code sous forme de commentaire.

| # | Symptôme | Cause réelle | Correction |
| - | - | - | - |
| 1 | `The specified instance type is not eligible for Free Tier` | `t3.large` n'est pas éligible sur un compte neuf | `m7i-flex.large` (2 vCPU / 8 Gio, éligible) |
| 2 | `is in ROLLBACK_COMPLETE state and can not be updated` | une pile ayant échoué à sa création n'accepte plus aucune mise à jour | `deploy.sh` la supprime puis recrée |
| 3 | `Received FAILURE signal` sans raison | `cfn-signal -e 1` sans `--reason` ; `set -e` tuait le script à la première erreur | user data instrumenté : étapes nommées, `--reason "etape=… code=…"`, codes `exit` explicites |
| 4 | `nginx: [emerg] mkdir() "/var/cache/nginx/editeur" failed` | **`/var/cache/nginx` n'existe pas sur AL2023** — le paquet ne le crée pas, à la différence de l'image `nginx:alpine` | `mkdir -p` + `chown` avant `nginx -t` |
| 5 | `npm error Invalid: lock file's @types/node@20… does not satisfy @types/node@22` | `package-lock.json` du frontend antérieur au passage à `@types/node@22` | lockfile régénéré |
| 6 | `ENOSPC: no space left on device` en fin de build | CloudShell plafonne `$HOME` à 1 Gio ; `node_modules` et le cache npm s'y accumulaient | libération au fur et à mesure dans `deploy.sh` (pic ramené de ~880 à 665 Mio) + purge du cache npm |
| 7 | `X-Cache-Status` absent au diagnostic | `add_header` ne s'applique pas aux 404 sans le mot-clé `always` | `add_header … always` |

Les défauts 3 et 4 sont les plus instructifs : sans instrumentation, un échec de
user data ne renvoie qu'un `FAILURE signal` anonyme, et l'on perd des heures. Le
diagnostic n'a été possible qu'en **conservant l'instance** (`--on-failure
DO_NOTHING`) puis en lisant `/var/log/editeur-init.log` par SSM.

Le défaut 4 illustre une limite du test en conteneur : la configuration nginx
avait été validée dans `nginx:alpine`, qui fournit `/var/cache/nginx`. Tester
dans une image `amazonlinux:2023` aurait révélé le problème avant le déploiement.

---

## Routage nginx

Fastify expose **deux familles de routes**, et nginx doit les proxifier toutes les deux :

| Chemin | Origine | Traitement nginx |
| - | - | - |
| `/`, `/doc.html`, `/documents.html`… | export statique Next.js | `try_files` sur `/opt/editeur/public` |
| `/d/{token}/status` | `registerVisitorRoutes`, **à la racine** | proxy + **micro-cache** (`MYCACHE`) |
| `/d/{token}/claim`, `/d/{token}/file` | `registerVisitorRoutes`, **à la racine** | proxy simple |
| `/api/*` | routes du rédacteur (préfixe `/api`) | proxy simple |
| `/ws` | WebSocket | proxy avec `Upgrade` |

Trois pièges corrigés, tous invisibles en test local (les tests interrogent Node
directement sur le port 4000, sans passer par nginx) :

1. **`nginx.conf` incomplet.** `sendfile`, `keepalive_timeout` et surtout
   `proxy_cache_path` ne sont valides que dans un bloc `http`. Un fichier sans
   `events {}` ni `http {}` empêche nginx de démarrer ; avec `set -e`, tout le
   user data s'arrêtait et l'instance restait sans application.
2. **Mauvais préfixe pour le cache.** La regex visait `^/api/d/…/status$`, alors
   que le client appelle `/d/…/status` (voir `VISITOR_BASE` dans
   `frontend/src/lib/api.ts`). Résultat : le micro-cache n'était jamais utilisé et
   chaque visiteur frappait Node.
3. **`claim` et `file` non proxifiés.** Seul `/status` avait une `location`. Les
   deux autres tombaient dans le `try_files` du front statique et renvoyaient 404 :
   le bouton « Télécharger » et la réservation d'exemplaire étaient cassés en
   production.

---

## Vérifications avant de déployer

```bash
# 1. Syntaxe YAML (les balises !Ref/!Sub exigent un loader permissif)
python3 -c "
import yaml
class L(yaml.SafeLoader): pass
def m(l,s,n):
    return l.construct_scalar(n) if isinstance(n,yaml.ScalarNode) else (
           l.construct_sequence(n) if isinstance(n,yaml.SequenceNode) else l.construct_mapping(n))
L.add_multi_constructor('!',m)
d=yaml.load(open('infra/template.yaml'),Loader=L); print(len(d['Resources']),'ressources')"

# 2. Configuration nginx réelle (extrait les here-doc du user data)
#    Remplacer listen 80 par 8080 et 127.0.0.1:3000 par host.docker.internal:3000,
#    puis :
docker run --rm \
  -v /tmp/ngxtest/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v /tmp/ngxtest/conf.d:/etc/nginx/conf.d:ro \
  nginx:alpine nginx -t

# 3. Routage réel, avec un backend factice sur le port 3000
curl -s http://127.0.0.1:8080/d/tok/claim        # doit atteindre Node, pas 404
curl -sI http://127.0.0.1:8080/d/tok/status | grep X-Cache-Status   # HIT au 2ᵉ appel
```

Après déploiement, sur l'Elastic IP :

```bash
curl -s  http://$IP/d/<token>/status
curl -s -X POST http://$IP/d/<token>/claim -H 'content-type: application/json' \
     -d '{"visitorId":"v_test_0001"}'
curl -sI http://$IP/d/<token>/status | grep X-Cache-Status
```

---

## Points connus

- **`CreationPolicy`** : la pile n'est déclarée terminée que si `cfn-signal`
  répond. Le paquet `aws-cfn-bootstrap` est donc installé en première ligne du user
  data (`dnf install -y aws-cfn-bootstrap`). Sans lui, aucun signal n'est envoyé et
  CloudFormation fait un rollback au bout de 25 minutes, **en supprimant
  l'instance**. Pour déboguer un échec, recréer la pile avec
  `aws cloudformation create-stack --disable-rollback`.
- **Suppression** : `DeletionPolicy: Delete` ne vide pas un bucket versionné, donc
  `delete-stack` échoue tant qu'il contient des objets. Les paramètres SSM
  `/editeur/*` et la paire de clés sont hors pile et subsistent après suppression.
  Un `destroy.sh` est nécessaire (vider le bucket **versions comprises**, supprimer
  la pile, les paramètres et la clé).
- **Remplacement d'instance** : l'AMI est résolue à chaque déploiement
  (`{{resolve:ssm:…al2023-ami…}}`). Si Amazon publie une nouvelle AMI entre deux
  `deploy`, l'instance est remplacée et l'IP change. Faire le dernier déploiement
  **avant** les tests de charge, puis ne plus y toucher.
- **`app.env` n'est écrit qu'au premier démarrage.** Modifier `CreditPerDay`,
  `MaxUpdateBytes`, `BatchMs` ou `TickMs` exige un remplacement d'instance, pas
  seulement un `deploy.sh`.
- **CloudWatch** : l'agent n'est plus installé (il l'était sans configuration, ce
  qui laissait `AppLogGroup` vide). Les journaux restent dans
  `/var/log/editeur/*.log`.
- **SES en bac à sable** : seules les adresses vérifiées reçoivent les e-mails. Sans
  accès production, les notifications de fin de quota n'iront pas aux adresses du
  jury.
