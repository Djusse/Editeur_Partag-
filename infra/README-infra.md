# Infrastructure

Une seule pile CloudFormation ([`template.yaml`](template.yaml)) déployée en `eu-north-1`.

| Ressource | Rôle |
| - | - |
| `Instance` (EC2 t3.large) | Node.js : Fastify (REST) + `ws` (WebSocket) + Yjs, état en mémoire |
| `ElasticIp` | URL stable (l'IP publique change après arrêt/démarrage) |
| `SecurityGroup` | 80 ouvert, 22 limité à `AdminCidr` |
| `InstanceRole` | Moindre privilège : tables nommées, préfixe S3, file SQS, SES filtré, `/editeur/*` en SSM |
| `Bucket` | PDF, snapshots, versions, artefacts ; public bloqué, chiffré, HTTPS obligatoire |
| 10 tables DynamoDB | Documents, Members, Updates, Credits, OpIds, Abuse, Links, Tickets, PdfCache, Versions |
| `PdfQueue` + DLQ | Génération PDF asynchrone, 3 essais puis lettre morte |
| `AppLogGroup` | /editeur/app, rétention 7 jours |

Le user data installe nginx (avec micro-cache de `/status` et proxy WebSocket),
systemd (`editeur-app`, `editeur-worker`, `Restart=always`, `LimitNOFILE=65536`)
et écrit `/opt/editeur/app.env`. **Aucun secret n'y figure** : ils sont lus dans
SSM par le rôle d'instance.

Les secrets `/editeur/jwt-secret` et `/editeur/admin-key` sont créés par
`scripts/deploy.sh`, jamais par le template : ils n'apparaissent donc ni dans le
dépôt, ni dans l'historique CloudFormation.
