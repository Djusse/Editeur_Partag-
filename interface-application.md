\# Éditeur de documents partagé — Spécification de l'interface  
   
\*\*Destinataire de ce document :\*\* un développeur ou un assistant IA de code qui doit implémenter le front \*\*sans avoir à deviner\*\*. Tout ce qui n'est pas écrit ici est \*\*hors périmètre\*\* (voir section 13). En cas de doute, ne pas inventer : appliquer la règle la plus simple décrite ici.  
   
Les éléments marqués \*\*(optionnel)\*\* sont les premiers à couper si le temps manque. Tout le reste est obligatoire. Les éléments marqués ⚠ \*\*ajoutent\*\* quelque chose à l'API du plan d'exécution v7 : ils sont regroupés en section 4.  
   
\*\*Révision 2 (alignée sur le plan v7)\*\* : application servie par nginx sur une instance EC2, en HTTP sans domaine ; WebSocket natif (\`ws\`) ; update Yjs indécoupable ; état initial du document ; rejet de texte refusé ; ordre d'appels du visiteur ; règles de création des versions.  
   
\---  
   
\## 1. Préférences de design (obligatoires)  
   
\### 1.1 Thème : clair et épuré, jamais sombre  
   
\- \*\*Un seul thème : clair.\*\* Pas de mode sombre, pas de bascule de thème, pas de \`prefers-color-scheme: dark\`. Déclarer \`color-scheme: light\` sur \`:root\`.  
\- Fond blanc ou presque blanc, beaucoup d'espace vide, peu de bordures, une seule couleur d'accent (bleu). Aucun dégradé, aucune ombre lourde, aucune animation décorative.  
\- Style sobre et moderne : coins arrondis modérés, textes lisibles, hiérarchie claire.  
   
\### 1.2 Jetons de design (variables CSS sur \`:root\`)  
   
| Variable | Valeur | Usage |  
| - | - | - |  
| \`--bg\` | \`#FFFFFF\` | fond des pages et du papier d'édition |  
| \`--bg-subtle\` | \`#F7F8FA\` | fond d'application, panneaux latéraux |  
| \`--border\` | \`#E5E7EB\` | bordures et séparateurs (1 px) |  
| \`--text\` | \`#111827\` | texte principal |  
| \`--text-muted\` | \`#6B7280\` | texte secondaire, légendes |  
| \`--primary\` | \`#2563EB\` | boutons principaux, liens, focus |  
| \`--primary-hover\` | \`#1D4ED8\` | survol du bouton principal |  
| \`--primary-soft\` | \`#EFF6FF\` | fond léger d'élément actif |  
| \`--success\` / \`--success-soft\` | \`#15803D\` / \`#F0FDF4\` | état positif |  
| \`--warning\` / \`--warning-soft\` | \`#B45309\` / \`#FFFBEB\` | avertissement |  
| \`--danger\` / \`--danger-soft\` | \`#B91C1C\` / \`#FEF2F2\` | erreur, état épuisé/bloqué |  
| \`--radius\` | \`8px\` | boutons, champs |  
| \`--radius-lg\` | \`12px\` | cartes, modales |  
| \`--shadow\` | \`0 1px 2px rgba(17,24,39,.06)\` | seule ombre autorisée (modales : \`0 8px 24px rgba(17,24,39,.12)\`) |  
   
\*\*Typographie :\*\* pile système uniquement, aucune police externe :  
\`font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\`  
   
| Rôle | Taille / graisse |  
| - | - |  
| Titre de page (h1) | 24 px / 600 |  
| Titre de section (h2) | 18 px / 600 |  
| Texte courant | 15 px / 400, interligne 1,5 |  
| Texte secondaire | 13 px / 400, couleur \`--text-muted\` |  
| Texte de l'éditeur | 16 px / 400, interligne 1,7 |  
   
\*\*Espacements :\*\* multiples de 4 px. Marge latérale des pages : 24 px (16 px sur mobile).  
   
\*\*Boutons (3 variantes seulement) :\*\*  
\- \*Principal\* : fond \`--primary\`, texte blanc, hauteur 40 px, padding horizontal 16 px, \`--radius\`.  
\- \*Secondaire\* : fond blanc, bordure \`--border\`, texte \`--text\`.  
\- \*Discret\* : sans fond ni bordure, texte \`--primary\`.  
\- Désactivé : opacité 0,5, curseur \`not-allowed\`. Focus clavier : contour 2 px \`--primary\`, décalage 2 px.  
   
\*\*Champs :\*\* hauteur 40 px, bordure \`--border\`, \`--radius\`, fond \`--bg\`. Focus : bordure \`--primary\`. Erreur : bordure \`--danger\` et message \`--danger\` 13 px sous le champ.  
   
\*\*Couleurs de présence\*\* (hash de l'e-mail modulo 8) :  
\`#2563EB, #DB2777, #059669, #D97706, #7C3AED, #0891B2, #DC2626, #4D7C0F\`  
   
\### 1.3 Pastilles d'état  
   
Forme arrondie complète, 12 px, padding 2 px 8 px. \`Actif\` : fond \`--success-soft\`, texte \`--success\`. \`Épuisé\` et \`Bloqué\` : fond \`--danger-soft\`, texte \`--danger\`.  
   
\---  
   
\## 2. Cadre technique du front  
   
\### 2.1 Contexte de déploiement (conditionne le code)  
   
L'application est servie par \*\*nginx sur une instance EC2, en HTTP, sans nom de domaine ni certificat\*\* (Elastic IP). La page n'est donc \*\*pas\*\* un « contexte sécurisé » du navigateur. Les API suivantes sont \*\*interdites\*\* car elles n'existent pas hors HTTPS : \`crypto.randomUUID()\`, \`navigator.clipboard\`, les service workers.  
   
| Besoin | Règle obligatoire |  
| - | - |  
| Identifiants aléatoires (\`visitorId\`, \`opId\`) | fonction \`uuidv4()\` bâtie sur \`crypto.getRandomValues\` (2.4) |  
| Bouton « Copier » | fonction \`copyText()\` avec \`document.execCommand('copy')\` et un champ caché (2.4) |  
| URL de l'API REST | \*\*chemin relatif\*\* : \`NEXT_PUBLIC_API_BASE=/api\` (même origine) |  
| URL WebSocket | \*\*déduite de \`location\`\*\*, jamais écrite en dur (2.5) ; chemin \`/ws\` |  
| URL absolue d'un lien de téléchargement | \*\*construite côté front\*\* : \`location.origin + '/d?token=' + token\` |  
   
\*\*Configuration nginx exigée\*\* (à reporter dans le README) : \`try_files \$uri \$uri.html \$uri/ =404;\` pour que \`/doc?id=…\`, \`/d?token=…\`, \`/documents\` et \`/admin\` trouvent leur fichier \`.html\` ; \`/api\` et \`/ws\` proxifiés vers Node (en-têtes \`Upgrade\` et \`Connection\` transmis pour le WebSocket).  
   
\### 2.2 Choix techniques (à ne pas changer)  
   
| Sujet | Décision |  
| - | - |  
| Framework | Next.js, \*\*export statique\*\* (\`output: 'export'\`), TypeScript |  
| Routage | pages classiques avec paramètres d'URL : \`/doc?id=…\`, \`/d?token=…\` (lecture via \`URLSearchParams\` côté client uniquement) |  
| Style | CSS Modules + variables CSS de 1.2. \*\*Pas de Tailwind, pas de bibliothèque de composants\*\* |  
| Éditeur | CodeMirror 6 + \`yjs\` + \`y-codemirror.next\` (texte brut, \`Y.Text\` nommé \`"content"\`) |  
| Langue | français uniquement (textes en section 12) |  
| Dates | \`Intl.DateTimeFormat('fr-FR')\` et \`Intl.RelativeTimeFormat('fr')\`, fuseau du navigateur |  
   
\### 2.3 Stockage navigateur (\`localStorage\`, clés exactes)  
   
| Clé | Contenu |  
| - | - |  
| \`session\` | \`{ "token": "\<jwt>", "name": "...", "email": "..." }\` |  
| \`visitorId:\<token-du-lien>\` | identifiant (\`uuidv4()\`) généré à la première visite de ce lien |  
| \`claimed:\<token-du-lien>\` | \`"1"\` une fois qu'un \`claim\` a abouti (réponse \`ready\` ou \`waiting\`) |  
| \`pendingOps:\<documentId>:\<email>\` | file des updates non acquittés \`\[ { opId, update } \]\` (Base64) |  
   
Toute lecture/écriture de \`localStorage\` est dans un \`try/catch\` ; si le stockage échoue, \`visitorId\` reste en mémoire pour la page et \`claimed\` est ignoré.  
   
\### 2.4 Utilitaires obligatoires  
   
\`\`\`ts  
// uuidv4 sans crypto.randomUUID (fonctionne en HTTP)  
export function uuidv4(): string {  
  const b = new Uint8Array(16);  
  crypto.getRandomValues(b);  
  b\[6\] = (b\[6\] & 0x0f) | 0x40;  
  b\[8\] = (b\[8\] & 0x3f) | 0x80;  
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');  
  return \`\${h.slice(0, 8)}-\${h.slice(8, 12)}-\${h.slice(12, 16)}-\${h.slice(16, 20)}-\${h.slice(20)}\`;  
}  
   
// copie sans navigator.clipboard (fonctionne en HTTP)  
export function copyText(text: string): boolean {  
  const el = document.createElement('textarea');  
  el.value = text;  
  el.setAttribute('readonly', '');  
  el.style.position = 'fixed';  
  el.style.opacity = '0';  
  document.body.appendChild(el);  
  el.select();  
  let ok = false;  
  try { ok = document.execCommand('copy'); } catch { ok = false; }  
  document.body.removeChild(el);  
  return ok;  
}  
\`\`\`  
   
Si \`copyText\` renvoie \`false\`, le bouton affiche « Sélectionnez et copiez manuellement » et sélectionne le texte de l'adresse.  
   
\### 2.5 URL du WebSocket  
   
\`\`\`ts  
export function wsUrl(ticket: string, documentId: string): string {  
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';  
  return \`\${scheme}//\${location.host}/ws?ticket=\${encodeURIComponent(ticket)}&documentId=\${encodeURIComponent(documentId)}\`;  
}  
\`\`\`  
   
\### 2.6 Garde d'accès  
   
Les pages du rédacteur (\`/documents\`, \`/doc\`) vérifient \`session\` au chargement. Absente ou expirée (réponse 401) : suppression de \`session\` et redirection vers \`/\`. Les pages \`/d\` et \`/admin\` n'exigent pas de session.  
   
\---  
   
\## 3. Contrat d'API utilisé par l'interface  
   
En-tête des appels du rédacteur : \`Authorization: Bearer \<token>\`. Tous les chemins REST sont préfixés par \`/api\`.  
   
\### 3.1 REST  
   
| Appel | Requête | Réponse succès | Erreurs gérées |  
| - | - | - | - |  
| \`POST /session\` | \`{name, email}\` | \`200 {token, user:{name,email}}\` | \`400 {error:"INVALID_INPUT", field}\` |  
| \`GET /documents\` | — | \`200 {documents:\[{id,title,ownerName,ownerEmail,updatedAt}\]}\` | \`401\` |  
| \`POST /documents\` | \`{title}\` | \`201 {id,title}\` | \`400\`, \`401\` |  
| \`GET /documents/{id}\` | — | \`200 {id,title,ownerEmail,members:\[{email,name}\]}\` | \`403\`, \`404\` |  
| ⚠ \`GET /documents/{id}/state\` | — | \`200 {seq, state}\` (état Yjs complet, Base64) | \`403\`, \`404\` |  
| \`POST /documents/{id}/members\` | \`{email}\` | \`200 {members:\[{email,name}\]}\` | \`400\`, \`403\`, \`404\` |  
| \`GET /documents/{id}/versions\` | — | \`200 {versions:\[{n,createdAt,authorName}\]}\` | \`403\`, \`404\` |  
| \`POST /documents/{id}/versions/{n}/restore\` | — | \`200 {seq}\` | \`403\`, \`404\` |  
| \`POST /documents/{id}/links\` | \`{maxDownloads}\` (entier 1 à 100 000) | \`201 {token,maxDownloads,remaining,status,createdAt}\` | \`400\`, \`403\` |  
| ⚠ \`GET /documents/{id}/links\` | — | \`200 {links:\[{token,maxDownloads,remaining,status,createdAt}\]}\` | \`403\`, \`404\` |  
| \`GET /me/credit\` | — | \`200 {limit:10000,used,remaining,blockedUntil,resetsAt}\` (\`blockedUntil\` : \`null\` ou date ISO UTC ; \`resetsAt\` : prochain minuit UTC) | \`401\` |  
| \`GET /admin/state\` | en-tête \`X-Admin-Key\` | \`200 {openDocuments:\[{docId,title,connections}\], activeLinks:\[{token,docId,title,maxDownloads,remaining}\], blocked:\[{email,blockedUntil}\]}\` | \`401\`/\`403\` |  
   
\`GET /documents/{id}\` ne renvoie pas \`seq\` : le point de départ de la synchronisation vient de \`GET /documents/{id}/state\`.  
   
\### 3.2 Visiteur (sans identité)  
   
| Appel | Requête | Réponses |  
| - | - | - |  
| \`GET /d/{token}/status\` | — | \`200 {status:"active"\\|"exhausted", title}\` ⚠ (\`title\` ajouté) ; \`404\` |  
| \`POST /d/{token}/claim\` | \`{visitorId}\` | \`200 {state:"ready", url}\` ; \`202 {state:"waiting", retryAfter}\` (secondes) ; \`410 {state:"exhausted"}\` ; \`404\` |  
| \`GET /d/{token}/file?visitorId=…\` | — | mêmes réponses que \`claim\` |  
   
\*\*Règle serveur impérative (4.2) :\*\* \`claim\` cherche le ticket du \`visitorId\` \*\*avant\*\* de répondre \`exhausted\`.  
   
\### 3.3 WebSocket (messages JSON)  
   
Toute mise à jour Yjs est encodée en \*\*Base64\*\* dans un champ JSON. \*\*Taille maximale : 64 Ko de binaire\*\* par update. Un update Yjs est un bloc binaire \*\*indécoupable\*\* : le client ne le scinde jamais. Dans la pratique, un update dépasse rarement quelques Ko, car le crédit limite l'insertion à 10 000 caractères par jour.  
   
| Sens | Message | Rôle |  
| - | - | - |  
| client → serveur | \`{"type":"join","documentId":"…","sinceSeq":123}\` | rejoindre le document ; \`sinceSeq\` = \`seq\` de \`GET …/state\` ou du dernier \`ack\`/\`update\` reçu |  
| client → serveur | \`{"type":"update","opId":"…","documentId":"…","payload":"\<base64>"}\` | envoyer une modification |  
| client ↔ serveur | \`{"type":"awareness","documentId":"…","payload":"\<base64>"}\` | \*(optionnel)\* curseurs : \`payload\` = update du protocole \`y-protocols/awareness\` encodé en Base64 (pas un JSON \`{cursor}\`) |  
| serveur → client | \`{"type":"update","seq":123,"documentId":"…","payload":"\<base64>"}\` | modification fusionnée à appliquer au \`Y.Doc\` (un message par tick du serveur). \*\*Aucun champ \`author\`\*\* : impossible en diffusion fusionnée |  
| serveur → client | \`{"type":"ack","opIds":\["…"\],"seq":123,"creditRemaining":7420}\` | modifications acceptées ; \`opIds\` est une \*\*liste\*\* (plan v7) ; \`creditRemaining\` ⚠ ajouté (miroir en mémoire du serveur) |  
| serveur → client | \`{"type":"presence","users":\[{"email","name"}\]}\` | liste des présents |  
| serveur → client | \`{"type":"error","code":"CREDIT_EXHAUSTED"\\|"BLOCKED"\\|"FORBIDDEN"\\|"PAYLOAD_TOO_LARGE","opId"?:"…"}\` | refus ; \`PAYLOAD_TOO_LARGE\` ⚠ ajouté |  
   
Un \`ack\` pour un \`opId\` déjà traité (renvoi) reprend le \`seq\` d'origine : le client le traite comme un \`ack\` normal.  
   
Le ticket à usage unique est obtenu par \`POST /ws-ticket\` (corps \`{documentId}\`, réponse \`{ticket}\`), puis passé à l'ouverture avec \`wsUrl()\` (2.5).  
   
\*\*Repli HTTP (si le WebSocket n'est pas utilisable) :\*\* \`POST /documents/{id}/updates\` (\`{opId, update}\` en Base64, limite 64 Ko) et \`GET /documents/{id}/updates?since={seq}\` toutes les secondes. Même logique côté client (file, \`opId\`, rattrapage). L'interface reste \*\*identique\*\* pour l'utilisateur.  
   
\---  
   
\## 4. Impacts sur le plan v7 et le serveur (à reporter)  
   
\### 4.1 Ajouts d'API et de données demandés par l'interface  
   
| Élément | Raison |  
| - | - |  
| \`GET /documents/{id}/state\` → \`{seq, state}\` | état initial complet du document avant \`join\` |  
| \`GET /documents/{id}/links\` | la modale liste les liens existants |  
| \`title\` dans \`GET /d/{token}/status\` | titre de la page visiteur |  
| \`creditRemaining\` dans \`ack\` | mise à jour de la jauge sans appel supplémentaire (valable car instance unique) |  
| erreur \`PAYLOAD_TOO_LARGE\` | update au-delà de 64 Ko |  
| \`Documents.updatedAt\` | colonne « Modifié … » de la liste |  
| table \`Memberships\` ou index secondaire sur les membres | lister les documents d'un membre (la table \`Documents\` ne se lit que par \`docId\`) |  
| \`ticket\` : \`POST /ws-ticket\` avec \`{documentId}\` | vérifier l'accès au document dès l'émission du ticket |  
| retrait de \`url\` des réponses sur les liens | le front construit l'adresse (2.1) |  
   
La resynchronisation par state vector toutes les 30 s (plan v7, 2.3 point 9) n'est \*\*pas\*\* spécifiée côté interface : si elle est implémentée, il faudra définir un message dédié.  
   
\### 4.2 Corrections à faire dans le plan v7  
   
1\. \*\*Ordre dans le claim (2.3, étape 3).\*\* Aujourd'hui l'étape a (\`exhausted\` en mémoire → \`410\`) passe avant l'étape b (recherche du ticket). Un visiteur qui a déjà son exemplaire recevrait \`410\` après épuisement du lien. \*\*Inverser\*\* : chercher le ticket d'abord, depuis une table en mémoire chargée à l'ouverture du lien, puis seulement appliquer le court-circuit \`exhausted\`.  
2\. \*\*Délai de C6.\*\* Le micro-cache nginx de \`status\` (1 s) s'ajoute au sondage du client (3 s ± 25 %, soit 3,75 s au plus) : pire cas \*\*4,75 s\*\*, juste sous l'objectif de 5 s. Soit passer le micro-cache à 0,5 s, soit assouplir l'objectif à 8 s dans le plan.  
3\. \*\*Versions.\*\* Le plan prévoit un snapshot « toutes les K entrées du journal et à la demande », mais aucun bouton ne crée de version. Fixer la règle : \*\*une version toutes les 50 entrées du journal ou toutes les 2 minutes d'activité\*\*, selon ce qui arrive en premier, et \*\*un snapshot du texte actuel avant chaque restauration\*\* (sinon « le texte actuel reste dans l'historique » est faux).  
4\. \*\*Mise à jour de l'\`ack\`\*\* dans la description d'API : \`ack {opIds, seq, creditRemaining}\`.  
   
\---  
   
\## 5. Carte des pages et navigation  
   
| Page | Route | Accès |  
| - | - | - |  
| Entrée | \`/\` | public |  
| Mes documents | \`/documents\` | rédacteur |  
| Éditeur | \`/doc?id=…\` | rédacteur membre |  
| Téléchargement | \`/d?token=…\` | visiteur |  
| Administration | \`/admin\` | clé admin |  
   
\*\*Navigation :\*\* \`/\` vers \`/documents\` après connexion ; \`/documents\` vers \`/doc?id=…\` en cliquant une ligne ; \`/doc\` vers \`/documents\` par « ← Mes documents ». Pas de menu latéral global.  
   
\---  
   
\## 6. Composants partagés (pages du rédacteur)  
   
\### 6.1 Barre supérieure (\`TopBar\`)  
   
Hauteur 56 px, fond \`--bg\`, bordure basse 1 px \`--border\`. De gauche à droite :  
1\. « \*\*Éditeur partagé\*\* » (16 px / 600), cliquable vers \`/documents\`.  
2\. Espace flexible.  
3\. \*\*Jauge de crédit\*\* (6.2).  
4\. Nom de la personne connectée (15 px) et, dessous, son e-mail (13 px \`--text-muted\`, masqué sur mobile).  
5\. Bouton discret « \*\*Changer d'identité\*\* » : supprime \`session\` et redirige vers \`/\`.  
   
\### 6.2 Jauge de crédit (\`CreditMeter\`)  
   
\- Texte : « \`{restant} / 10 000 caractères\` » (espace fine dans les nombres, ex. \`7 420\`).  
\- Barre de 4 px de haut, 120 px de large, fond \`--border\`, remplissage proportionnel au crédit \*\*restant\*\*. Couleur : \`--primary\` si restant ≥ 30 % ; \`--warning\` de 1 % à 29 % ; \`--danger\` à 0.  
\- Infobulle au survol ou au toucher : « Recharge à {heure locale de resetsAt} (minuit UTC) ».  
\- Source : \`GET /me/credit\` au chargement de chaque page rédacteur ; ensuite \`creditRemaining\` de chaque \`ack\`.  
   
\### 6.3 Bandeau de connexion (\`ConnectionBanner\`)  
   
Dans l'éditeur seulement, sous la barre supérieure, 32 px de haut, 13 px.  
   
| État | Texte | Style |  
| - | - | - |  
| Connecté | \*(aucun bandeau, point vert « Connecté » dans la barre d'outils)\* | — |  
| Connexion en cours / perdue | « Reconnexion… » | fond \`--warning-soft\`, texte \`--warning\` |  
| Hors ligne | « Hors ligne — vos modifications sont conservées et seront envoyées au retour du réseau » | idem |  
   
\### 6.4 Notifications (\`Toast\`)  
   
En bas à droite (centré en bas sur mobile), 320 px max, disparaît après 4 s, fermable, 3 empilées au plus. Variantes succès (\`--success-soft\`) et erreur (\`--danger-soft\`).  
   
\### 6.5 Modale (\`Modal\`)  
   
Voile \`rgba(17,24,39,.4)\`, boîte blanche \`--radius-lg\`, largeur 480 px (plein écran moins 16 px de marge sur mobile), padding 24 px, titre h2, « × » en haut à droite. Fermeture par Échap ou clic sur le voile. Focus piégé dans la modale et rendu au bouton d'origine.  
   
\---  
   
\## 7. Page d'entrée (\`/\`)  
   
\*\*Mise en page :\*\* fond \`--bg-subtle\`, carte blanche centrée (400 px, padding 32 px, \`--radius-lg\`, \`--shadow\`).  
   
\*\*Contenu :\*\*  
1\. h1 : « Éditeur de documents partagé ».  
2\. Sous-titre (\`--text-muted\`) : « Entrez votre nom et votre e-mail pour écrire avec les autres rédacteurs. »  
3\. Champ « \*\*Nom\*\* » (placeholder « Votre nom »).  
4\. Champ « \*\*Adresse e-mail\*\* » (placeholder « vous@exemple.com », type \`email\`).  
5\. Bouton principal pleine largeur « \*\*Entrer\*\* ».  
   
\*\*Validation (clic ou touche Entrée) :\*\*  
\- Nom : 1 à 60 caractères après suppression des espaces aux extrémités. Erreur : « Entrez votre nom (60 caractères maximum). »  
\- E-mail : format valide, 254 caractères maximum. Erreur : « Adresse e-mail invalide. » Converti en minuscules avant envoi.  
   
\*\*Action :\*\* \`POST /session\`. Pendant l'appel : bouton désactivé, libellé « Connexion… ». Succès : écrire \`session\`, rediriger vers \`/documents\`. Erreur : « Connexion impossible. Réessayez dans un instant. » sous le bouton.  
   
Si une \`session\` valide existe déjà, redirection immédiate vers \`/documents\`.  
   
\---  
   
\## 8. Mes documents (\`/documents\`)  
   
\`TopBar\`, puis conteneur centré de 880 px maximum, fond \`--bg-subtle\`.  
   
\*\*En-tête :\*\* h1 « Mes documents », bouton principal « \*\*+ Nouveau document\*\* » à droite.  
   
\*\*Liste :\*\* carte blanche (\`--radius-lg\`, \`--shadow\`) en lignes de 64 px séparées par 1 px \`--border\`, cliquables en entier (survol \`--bg-subtle\`) :  
\- titre (15 px / 500) ;  
\- dessous (13 px \`--text-muted\`) : « Propriétaire : moi » ou « Partagé par {ownerName} » ;  
\- à droite (13 px \`--text-muted\`) : « Modifié {date relative} ».  
   
Tri : du plus récemment modifié au plus ancien.  
   
\*\*Créer :\*\* le bouton ouvre une modale « Nouveau document » : champ « Titre » (1 à 120 caractères, focus automatique), boutons « Annuler » (secondaire) et « Créer » (principal). Erreur : « Donnez un titre au document. » Succès : \`POST /documents\` puis redirection vers \`/doc?id={id}\`.  
   
\*\*États :\*\* chargement = 3 lignes squelettes grises ; liste vide = « Aucun document pour l'instant. » et bouton principal « Créer le premier document » ; erreur = « Impossible de charger vos documents. » et bouton secondaire « Réessayer ».  
   
\---  
   
\## 9. Éditeur (\`/doc?id=…\`)  
   
\### 9.1 Mise en page  
   
\`\`\`  
┌────────────────────────────────────────────────────────────────────┐  
│ TopBar (56 px)                                                      │  
├────────────────────────────────────────────────────────────────────┤  
│ ConnectionBanner (si nécessaire)                                    │  
├────────────────────────────────────────────────────────────────────┤  
│ ← Mes documents    Titre du document        ● Connecté              │  
│                       \[Partager\] \[Versions\] \[Liens de téléchargement\]│  
├──────────────────────────────────────────────┬─────────────────────┤  
│                                              │ Présents (3)        │  
│   Zone d'écriture (papier blanc)             │ ● Christian (vous)  │  
│                                              │ ● Awa               │  
│                                              │ ● Paul              │  
└──────────────────────────────────────────────┴─────────────────────┘  
\`\`\`  
   
\- \*\*Barre d'outils\*\* (56 px, fond \`--bg\`, bordure basse) : à gauche « ← Mes documents » (discret) et le titre (18 px / 600, non modifiable) ; à droite le témoin de connexion puis trois boutons secondaires \*\*Partager\*\*, \*\*Versions\*\*, \*\*Liens de téléchargement\*\*.  
\- \*\*Corps :\*\* fond \`--bg-subtle\`. À gauche le « papier » : carte blanche de 760 px maximum, centrée, marges 32 px, hauteur minimale \`calc(100vh - 200px)\`, padding 40 px, \`--shadow\`. À droite le panneau \*\*Présents\*\* de 240 px, fond \`--bg\`, bordure gauche 1 px.  
\- \*\*Mobile (< 768 px) :\*\* Présents devient une ligne de pastilles (initiales) au-dessus du papier ; les trois boutons passent dans un menu « ⋯ » ; le papier prend toute la largeur (padding 16 px).  
   
\### 9.2 Chargement et accès (ordre exact)  
   
1\. Lire \`id\` dans l'URL ; absent : « Document introuvable. » avec bouton « ← Mes documents ».  
2\. \`GET /documents/{id}\` : \`403\` → « Vous n'avez pas accès à ce document. » ; \`404\` → « Document introuvable. » (avec le bouton de retour).  
3\. Pendant le chargement : papier avec lignes squelettes grises.  
4\. \`GET /documents/{id}/state\` → \`{seq, state}\`. Créer un \`Y.Doc\` et lui appliquer \`state\` (\`Y.applyUpdate\`).  
5\. \*\*Rejouer localement \`pendingOps\`\*\* : appliquer chaque update de \`pendingOps:\<documentId>:\<email>\` au \`Y.Doc\` (\`Y.applyUpdate\` est idempotent : un update déjà dans \`state\` ne change rien). Sans cette étape, l'utilisateur ne revoit pas ses frappes non acquittées après un rechargement.  
6\. Afficher le document dans CodeMirror.  
7\. Obtenir un ticket (\`POST /ws-ticket\`), ouvrir le WebSocket, envoyer \`join\` avec \`sinceSeq\` = \`seq\` de l'étape 4.  
8\. Renvoyer les updates de \`pendingOps\` avec leur \`opId\` d'origine, dans l'ordre.  
   
\### 9.3 Zone d'écriture  
   
\- CodeMirror 6 en \*\*texte brut\*\* : pas de numéros de ligne, pas de barre de formatage, pas de coloration, retour à la ligne automatique. Placeholder : « Commencez à écrire… ».  
\- Les modifications locales s'appliquent immédiatement au \`Y.Doc\` ; celles des autres s'appliquent dès réception.  
\- \*\*Aucun bouton « Enregistrer »\*\* : tout est automatique.  
   
\### 9.4 Envoi des modifications (règles précises)  
   
1\. Les frappes sont \*\*regroupées\*\* en un update Yjs toutes les \`BATCH_MS\` = \*\*300 ms\*\* (constante unique ; 1 s sous forte charge selon le plan).  
2\. Chaque update reçoit un \`opId\` unique (\`'op\_' + uuidv4()\`) et est ajouté à la file \`pendingOps\` (aussi écrite dans \`localStorage\`).  
3\. \*\*Aucun découpage\*\* : un update est envoyé entier. Au-delà de \*\*64 Ko\*\* binaires, ne pas l'envoyer : appliquer la procédure de rejet (9.5) avec « Cette modification est trop volumineuse et n'a pas été enregistrée. »  
4\. L'update reste dans la file jusqu'à ce qu'un \`ack\` contienne son \`opId\`.  
5\. \*\*Sans \`ack\`\*\* (coupure, délai de 10 s) : renvoi avec le \*\*même \`opId\`\*\* ; délais 1 s, 2 s, 4 s, 8 s, puis 8 s en boucle, avec ± 25 % de variation aléatoire.  
6\. À la reconnexion : renvoyer \`pendingOps\` dans l'ordre, puis \`join\` avec le dernier \`seq\` connu (dernier \`ack\` ou \`update\` reçu).  
7\. Un \`ack\` retire de la file tous les \`opIds\` listés et met à jour la jauge (\`creditRemaining\`).  
   
\### 9.5 Procédure de rejet (crédit, blocage, update trop gros)  
   
Un update refusé est déjà affiché chez l'utilisateur mais \*\*invisible pour les autres\*\*. L'interface \*\*reconstruit donc le document depuis le serveur\*\* :  
   
1\. Cesser d'envoyer ; \*\*vider\*\* \`pendingOps\` (mémoire et \`localStorage\`).  
2\. \`GET /documents/{id}/state\` → créer un \*\*nouveau\*\* \`Y.Doc\` avec cet état et le rebrancher à CodeMirror (le texte refusé disparaît).  
3\. Lecture seule pour \`CREDIT_EXHAUSTED\`, \`BLOCKED\`, \`FORBIDDEN\`. Pour \`PAYLOAD_TOO_LARGE\`, l'écriture \*\*reste possible\*\*.  
4\. Toast d'erreur : « \*\*Vos dernières modifications n'ont pas été enregistrées.\*\* » (pour \`PAYLOAD_TOO_LARGE\` : « Cette modification est trop volumineuse et n'a pas été enregistrée. »).  
5\. Bandeau correspondant (9.6) pour \`CREDIT_EXHAUSTED\` et \`BLOCKED\`.  
   
| Message reçu | Écriture | Bandeau / toast |  
| - | - | - |  
| \`CREDIT_EXHAUSTED\` | lecture seule | bandeau crédit épuisé + toast |  
| \`BLOCKED\` | lecture seule | bandeau bloqué + toast |  
| \`FORBIDDEN\` | lecture seule | « Vous n'avez plus accès à ce document. » |  
| \`PAYLOAD_TOO_LARGE\` | reste active | toast « Cette modification est trop volumineuse… » |  
   
\### 9.6 Crédit et blocage : lecture seule  
   
CodeMirror en \`readOnly\` (curseur et sélection possibles pour copier), réception et présence toujours actives. Bandeau juste au-dessus du papier, fond \`--danger-soft\`, texte \`--danger\`, 14 px, padding 12 px 16 px, \`--radius\` :  
\- Crédit épuisé : « \*\*Crédit du jour épuisé.\*\* Vous pourrez de nouveau écrire à {heure locale de resetsAt}. »  
\- Bloqué : « \*\*Écriture bloquée\*\* jusqu'à {heure locale de blockedUntil}. Vous pouvez toujours lire ce document. »  
   
Au chargement, si \`GET /me/credit\` indique \`remaining = 0\` ou \`blockedUntil\` non nul, l'éditeur s'ouvre directement en lecture seule avec le bandeau correspondant. L'écriture n'est réactivée qu'après un rechargement de la page une fois l'heure atteinte.  
   
\### 9.7 Panneau « Présents »  
   
\- Titre « Présents ({n}) ». Lignes de 40 px : pastille ronde de 24 px (couleur du hash de l'e-mail) avec l'\*\*initiale\*\*, puis le nom. Soi-même en premier, « (vous) » en \`--text-muted\`.  
\- Mis à jour à chaque message \`presence\`.  
\- \*\*Curseurs distants\*\* \*\*(optionnel)\*\* : trait vertical de 2 px de la couleur de la personne, avec une étiquette (nom, 12 px, texte blanc sur sa couleur). Via \`y-codemirror.next\` et \`y-protocols/awareness\` : les messages \`awareness\` transportent l'update d'awareness en \*\*Base64\*\*. Version minimale si coupé : liste des présents seulement.  
   
\### 9.8 Modale « Partager »  
   
Titre « Partager « {titre} » ».  
1\. Champ « Ajouter un rédacteur » (e-mail) + bouton principal « Ajouter ».  
2\. Liste « Membres » : nom (si connu) et e-mail ; le propriétaire porte la mention « Propriétaire » en \`--text-muted\`.  
   
E-mail validé comme en section 7 et converti en minuscules. Déjà membre : « Cette personne a déjà accès. » Succès : liste mise à jour et toast « {email} ajouté. » Erreur : « Impossible d'ajouter cette personne. Réessayez. » Tout membre peut ajouter un membre.  
   
\### 9.9 Modale « Versions »  
   
Titre « Versions de « {titre} » ». \`GET /documents/{id}/versions\` à l'ouverture.  
   
\- Liste de la plus récente à la plus ancienne. Ligne : « \*\*Version {n}\*\* » (15 px / 500), « {date et heure locales} — {authorName} » (13 px \`--text-muted\`), bouton secondaire « \*\*Restaurer\*\* » à droite.  
\- Liste vide : « Aucune version enregistrée pour l'instant. »  
\- Aide en bas (13 px, \`--text-muted\`) : « Une version est enregistrée automatiquement pendant l'écriture. » \*\*Aucun bouton ne crée de version\*\* (règle serveur en 4.2).  
\- \*\*Restaurer :\*\* confirmation dans la même modale : « Remplacer le texte actuel par la version {n} ? Le texte actuel reste dans l'historique. » avec « Annuler » et « Restaurer » (principal). Succès : \`POST …/restore\` (le serveur enregistre d'abord un snapshot du texte actuel), fermeture, toast « Version {n} restaurée. » ; le nouveau texte arrive par le flux normal des modifications. La restauration est \*\*gratuite\*\* : la jauge ne bouge pas.  
\- Aperçu d'une version \*\*(optionnel)\*\* : non demandé en version minimale.  
   
\### 9.10 Modale « Liens de téléchargement »  
   
Titre « Liens de téléchargement ». \`GET /documents/{id}/links\` à l'ouverture.  
   
\*\*Créer un lien :\*\*  
\- Champ numérique « Nombre de téléchargements autorisés » (entier 1 à 100 000, défaut 500) et bouton principal « Créer le lien ».  
\- Erreur : « Entrez un nombre entier entre 1 et 100 000. »  
\- Succès : le lien apparaît en tête de liste, toast « Lien créé. »  
   
\*\*Liens existants :\*\* une carte par lien, du plus récent au plus ancien :  
\- adresse complète \*\*construite par le front\*\* (\`location.origin + '/d?token=' + token\`), 13 px, coupée avec des points de suspension si trop longue ;  
\- bouton secondaire « \*\*Copier\*\* » : appelle \`copyText()\` (2.4), puis le libellé devient « Copié ✓ » pendant 2 s ; en cas d'échec : « Sélectionnez et copiez manuellement » ;  
\- « Restants : \*\*{remaining} / {maxDownloads}\*\* » et pastille \`Actif\` ou \`Épuisé\` ;  
\- liste vide : « Aucun lien pour ce document. »  
   
Rafraîchissement du nombre restant toutes les 5 s tant que la modale est ouverte.  
   
Aide en bas (13 px, \`--text-muted\`) : « Le lien fournit la version du document au moment où le visiteur demande le téléchargement. Vous serez prévenu par e-mail quand le dernier exemplaire sera distribué. »  
   
\---  
   
\## 10. Page de téléchargement (\`/d?token=…\`)  
   
\*\*Public :\*\* visiteur anonyme, aucune identité demandée. Pas de barre du rédacteur.  
   
\*\*Mise en page :\*\* fond \`--bg-subtle\`, carte blanche centrée (440 px, padding 32 px, \`--radius-lg\`, \`--shadow\`), contenu centré. Pied de page discret (13 px \`--text-muted\`) : « Éditeur de documents partagé ».  
   
\### 10.1 Logique exacte (machine à états)  
   
1\. Lire \`token\` dans l'URL ; absent : état « Lien invalide ».  
2\. Lire ou créer \`visitorId:\<token>\` (\`uuidv4()\`).  
3\. \*\*Si \`claimed:\<token>\` existe dans \`localStorage\`\*\* : appeler \*\*directement \`POST /d/{token}/claim\`\*\*, avant tout \`status\`, et traiter la réponse comme à l'étape 6. Un visiteur qui possède déjà son exemplaire ne doit jamais voir « Épuisé » au rechargement.  
4\. Sinon : \`GET /d/{token}/status\`. \`404\` → « Lien invalide » ; \`status = "exhausted"\` → état \*\*Épuisé\*\* (aucun \`claim\`).  
5\. Sinon : état \*\*Prêt à réserver\*\* (bouton), \*\*sans consommer\*\* d'exemplaire. L'exemplaire n'est réservé qu'au \*\*clic\*\* sur « Télécharger ». Ce flux en deux temps est volontaire : les aperçus de liens et les robots qui chargent la page ne consomment aucun exemplaire.  
6\. Au clic : \`POST /d/{token}/claim\` avec \`{visitorId}\`.  
   - \`200 ready\` → écrire \`claimed:\<token>\` = \`"1"\` ; état \*\*Prêt\*\*, téléchargement lancé.  
   - \`202 waiting\` → écrire \`claimed:\<token>\` = \`"1"\` ; état \*\*Patienter\*\*, puis interrogation de \`GET /d/{token}/file?visitorId=…\`.  
   - \`410 exhausted\` → état \*\*Épuisé\*\*.  
   - \`404\` → état \*\*Lien invalide\*\*.  
   - Erreur réseau, \`5xx\` ou \`429\` : \*\*jamais d'erreur brute\*\* ; rester dans l'état courant avec « Connexion lente, nouvelle tentative… » et réessayer (10.2).  
7\. En état \*\*Patienter\*\*, interroger \`GET /d/{token}/file\` aux intervalles de 10.2 jusqu'à \`ready\` ou \`exhausted\` (un \`exhausted\` reçu par un visiteur qui a un ticket est une anomalie serveur : afficher \*\*Épuisé\*\*).  
   
\### 10.2 Cadence d'interrogation  
   
\- Délai de base : \`retryAfter\` de la dernière réponse (secondes), sinon 2 s.  
\- À chaque tentative sans résultat : délai × 1,5, plafonné à 8 s.  
\- Variation aléatoire de ± 25 % sur chaque délai.  
\- Onglet masqué : 10 s.  
\- Pas de limite de durée tant que la page est ouverte.  
\- En état \*\*Prêt à réserver\*\*, interroger \`GET /d/{token}/status\` toutes les \*\*3 s\*\* (± 25 %, au plus 3,75 s) pour basculer vers \*\*Épuisé\*\* dès le dernier exemplaire distribué.  
   
\### 10.3 Les états à l'écran  
   
\*\*Prêt à réserver\*\*  
\- h1 : « {title} ».  
\- Texte : « Téléchargez votre exemplaire au format PDF. »  
\- Bouton principal pleine largeur « \*\*Télécharger le PDF\*\* ».  
   
\*\*Patienter\*\*  
\- Indicateur circulaire de 24 px (\`--primary\`).  
\- Titre : « Votre exemplaire est en préparation… »  
\- Texte : « Merci de patienter quelques secondes. Cette page se met à jour toute seule. »  
\- Pas de bouton.  
   
\*\*Prêt\*\*  
\- Coche \`--success\`.  
\- Titre : « Votre exemplaire est prêt. »  
\- Le téléchargement démarre automatiquement (navigation vers l'URL présignée). Bouton secondaire de secours : « Si rien ne se passe, cliquez ici ».  
\- Au rechargement, l'étape 3 (\`claimed:\<token>\`) redemande le même résultat avec le même \`visitorId\` : même ticket, aucun exemplaire en plus.  
   
\*\*Épuisé\*\*  
\- Titre : « Ce lien est épuisé. »  
\- Texte : « Tous les exemplaires ont été distribués. »  
\- Pas de bouton, plus d'appel réseau répété.  
   
\*\*Lien invalide\*\*  
\- Titre : « Ce lien n'existe pas ou n'est plus valide. » Pas de bouton.  
   
\---  
   
\## 11. Administration (\`/admin\`)  
   
\*\*Accès :\*\* carte centrée avec un champ « Clé d'administration » (type mot de passe) et un bouton principal « Accéder ». La clé reste en mémoire (variable), \*\*jamais\*\* dans \`localStorage\`. Clé invalide (\`401\`/\`403\`) : « Clé invalide. »  
   
\*\*Contenu :\*\* barre avec le titre « Administration » et un bouton secondaire « Actualiser ». Rafraîchissement automatique toutes les 10 s. Trois cartes empilées (960 px maximum) :  
   
1\. \*\*Documents ouverts\*\* : colonnes « Document », « Personnes connectées ». Vide : « Aucun document ouvert. »  
2\. \*\*Liens actifs\*\* : colonnes « Document », « Lien » (8 premiers caractères du token suivis de « … »), « Restants » (\`{remaining} / {maxDownloads}\`). Vide : « Aucun lien actif. »  
3\. \*\*Personnes bloquées\*\* : colonnes « E-mail », « Bloqué jusqu'à » (heure locale), pastille \`Bloqué\`. Vide : « Aucune personne bloquée. »  
   
\*\*(optionnel)\*\* Tableaux soignés. Version minimale si coupé : les trois blocs en listes simples.  
   
\---  
   
\## 12. Textes de l'interface (référence)  
   
À utiliser \*\*tels quels\*\*, sans reformulation.  
   
| Contexte | Texte |  
| - | - |  
| Bouton connexion | Entrer |  
| Création document | + Nouveau document / Créer / Annuler |  
| Retour | ← Mes documents |  
| Boutons éditeur | Partager / Versions / Liens de téléchargement |  
| Placeholder éditeur | Commencez à écrire… |  
| Connexion éditeur | Connecté / Reconnexion… |  
| Crédit | {n} / 10 000 caractères |  
| Rejet d'une modification | Vos dernières modifications n'ont pas été enregistrées. |  
| Update trop gros | Cette modification est trop volumineuse et n'a pas été enregistrée. |  
| Versions | Restaurer |  
| Liens | Créer le lien / Copier / Copié ✓ |  
| Visiteur | Télécharger le PDF |  
| Accès refusé | Vous n'avez pas accès à ce document. |  
| Introuvable | Document introuvable. |  
| Erreur générique | Une erreur est survenue. Réessayez dans un instant. |  
   
\---  
   
\## 13. Hors périmètre (ne pas implémenter)  
   
\- Thème sombre ou bascule de thème.  
\- Mise en forme riche, commentaires, suggestions, suppression ou renommage de documents.  
\- Comptes avec mot de passe, récupération de compte, vérification d'e-mail.  
\- Aperçu et comparaison de versions ; bouton de création manuelle d'une version.  
\- Édition du titre d'un document.  
\- Révocation d'un lien ou modification de son quota après création.  
\- Internationalisation (français uniquement).  
\- Notifications poussées, application mobile native, service worker, mode hors ligne complet.  
\- Découpage d'un update Yjs en plusieurs messages.  
   
\### 13.1 Limites assumées (à écrire dans le dossier de conception)  
   
\- \*\*HTTP sans TLS :\*\* le jeton de session (JWT), la clé d'administration et les adresses e-mail circulent \*\*en clair\*\*. Limite reconnue par le plan v7 ; piste d'amélioration : domaine et HTTPS (CloudFront).  
\- \*\*Instance unique :\*\* le miroir en mémoire (crédit restant, tickets, présence) ne vaut que pour une seule instance ; l'application n'est pas hautement disponible.  
\- \*\*Flux visiteur en deux temps :\*\* point positif à mettre en avant : les aperçus de liens et les robots n'épuisent pas les exemplaires.  
   
\---  
   
\## 14. Accessibilité et responsive  
   
\- Boutons et champs atteignables au clavier avec le contour de focus de 1.2 ; modales à focus piégé, fermées par Échap.  
\- Chaque champ a un \`label\` associé ; les erreurs de formulaire sont liées au champ (\`aria-describedby\`) et annoncées (\`role="alert"\`).  
\- Les changements d'état du visiteur sont annoncés dans une zone \`aria-live="polite"\`.  
\- Contraste texte/fond d'au moins 4,5:1 (les valeurs de 1.2 le respectent).  
\- Points de rupture : mobile < 768 px, ordinateur ≥ 768 px. Aucun défilement horizontal de la page.  
   
\---  
   
\## 15. Critères d'acceptation  
   
\- \[ \] Thème clair uniquement, jetons de 1.2 respectés, aucun mode sombre.  
\- \[ \] Aucun \`crypto.randomUUID\`, \`navigator.clipboard\` ni \`wss://\` écrit en dur ; l'application fonctionne en HTTP sur une IP nue.  
\- \[ \] Connexion par nom et e-mail, session conservée, garde d'accès sur les pages du rédacteur.  
\- \[ \] Liste de documents, création par modale, ouverture de l'éditeur.  
\- \[ \] À l'ouverture d'un document : état complet chargé, \`pendingOps\` rejouées localement, puis \`join\` avec le bon \`seq\`.  
\- \[ \] Deux navigateurs sur le même document voient les modifications de l'autre et finissent avec le même texte, y compris au même endroit.  
\- \[ \] Frappes regroupées toutes les 300 ms ; update non acquitté renvoyé avec le même \`opId\` ; file conservée après rechargement et visible à l'écran ; un \`ack\` retire tous ses \`opIds\`.  
\- \[ \] Aucun update découpé ; au-delà de 64 Ko, refus propre avec le bon message.  
\- \[ \] Après un refus (crédit, blocage, trop gros), document reconstruit depuis le serveur et message « Vos dernières modifications n'ont pas été enregistrées ».  
\- \[ \] Jauge de crédit à jour ; crédit épuisé ou blocage : lecture seule, bon bandeau, plus aucun envoi.  
\- \[ \] Modales Partager, Versions (avec restauration) et Liens fonctionnelles ; « Copier » fonctionne en HTTP.  
\- \[ \] Page visiteur : états Prêt à réserver, Patienter, Prêt, Épuisé, Lien invalide ; aucune erreur brute ; un exemplaire n'est réservé qu'au clic ; recharger après un claim réussi ne consomme rien et n'affiche pas « Épuisé ».  
\- \[ \] \`status\` interrogé toutes les 3 s en état « Prêt à réserver ».  
\- \[ \] Page admin : trois blocs, clé non stockée, rafraîchissement automatique.  
- \- \[ \] Rien de la section 13 n'est implémenté.  
