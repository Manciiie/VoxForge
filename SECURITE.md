# Rapport de sécurité — VoxForge 1.7.0

Date : 6 octobre 2026

## Contrôles effectués
| Contrôle | Résultat |
|---|---|
| Tests de sécurité (`npm test`) | 33 tests, 0 échec (dont archives piégées réelles, coffre, rendu Markdown, validation IPC) |
| Scan statique (`npm run securite -- --complet`) | 0 bloquant (voir avertissements ci-dessous) |
| Dépendances (`npm audit --omit=dev`) | 0 vulnérabilité (simple-git forcé en 4.0.2) |
| Lancement développement (`verifier-lancement.js`) | ✓ fenêtre et interface sans erreur |
| Scénarios de bout en bout (`piloter.js tests/e2e/voxforge.js`) | ✓ en développement et sur la version compilée |
| IA locale sur la version compilée (`tests/e2e/ia.js`) | ✓ processus IA, mesure « Origine IA » |
| Transcription audio (régression) | ✓ 6,8 % de mots faux sur l'échantillon de référence, identique à la 1.6.0 |
| Mises à jour (`tester-maj.js`) | ✓ 5 scénarios : disponible, fichier corrompu refusé, version ignorée, à jour, hors ligne |
| Fuses de l'exécutable | RunAsNode activé (voir exceptions), options Node et --inspect désactivées, cookies chiffrés |

## Protections en place
- Fenêtre isolée : `contextIsolation`, `sandbox`, pas de Node dans l'interface, DevTools coupés en production.
- CSP stricte (`script-src 'self'`, `object-src 'none'`, `base-uri 'none'`), navigation et nouvelles fenêtres bloquées sur toute page, permissions refusées sauf micro (dictée) et copie.
- 71 canaux internes déclarés avec `canal()` / `canalEvenement()` ; tous les arguments validés (identifiants au format strict, chemins sans caractère nul, structures bornées en taille et sans `__proto__`, données audio binaires bornées). Liste blanche du preload vérifiée par `tests/securite/ipc.test.js`.
- Liens externes : https uniquement.
- Clé d'API du serveur IA dans un coffre DPAPI (`secrets.dat`) ; l'interface ne reçoit que « clé enregistrée oui/non » ; migration automatique de l'ancienne clé en clair.
- Journal : chaque ligne passe par le masquage des secrets (clés, jetons, secrets déclarés).

## Spécifique à ce logiciel
- Pack carte graphique (.zip) : extraction à plat dans un dossier imposé (nom de base, `cheminSousDossier`), tailles annoncées contrôlées avant écriture et octets réels comptés (bombes refusées). Prouvé avec une archive piégée `../../evil.dll`.
- Modèles de reconnaissance (.tar.bz2) : nom de base seulement, liste blanche de fichiers, taille totale bornée. Prouvé avec une archive piégée.
- Téléchargements de modèles depuis Hugging Face / GitHub en HTTPS ; fichiers GGUF vérifiés par leur signature, pack GPU par SHA-256.
- Textes produits par l'IA : affichés via un rendu Markdown qui échappe tout HTML (pas de lien, pas d'attribut). 222 points d'affichage relus : 3 corrigés, aucun exploitable.
- ffmpeg lancé sans shell, avec tableau d'arguments ; nvidia-smi via `execFile`.

## Points restants / exceptions justifiées
- **Fuse RunAsNode activé** : node-llama-cpp teste son binaire carte graphique (Vulkan) dans un sous-processus qui en a besoin. Désactivé, l'IA locale ne démarre plus (vérifié : NoBinaryFoundError). Risque résiduel : quelqu'un qui peut déjà lancer des programmes sur le PC peut utiliser VoxForge.exe comme Node.
- **Pas d'app.asar** (et donc pas de validation d'intégrité asar) : les modules natifs et leurs DLL (sherpa-onnx, node-llama-cpp, CUDA) sont chargés depuis `node_modules`. L'intégrité de l'installeur est vérifiée par SHA-256 à l'assemblage.
- **94 avertissements « innerHTML »** : l'interface construit son HTML avec des gabarits ; toutes les valeurs variables passent par `esc()` (audit manuel complet, 3 oublis corrigés). Passer à `textContent` partout serait une réécriture de l'interface.
- **`style-src 'unsafe-inline'`** : nécessaire aux styles dynamiques (barres, jauges) ; les scripts restent interdits en ligne.
- **Mises à jour non configurées dans cette version** : aucun jeton de lecture fourni au build. Cette version s'installe à la main ; la première version construite avec un jeton devra aussi l'être une dernière fois.
- Non testable hors Windows : le remplacement réel de l'exe par l'installeur NSIS lors d'une mise à jour, et le chiffrement DPAPI (testé avec un faux `safeStorage` et le stockage basique de Linux).
