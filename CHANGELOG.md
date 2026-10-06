# Journal des modifications

## 1.7.0 — 6 octobre 2026
### Nouveautés
- Mises à jour automatiques : VoxForge recherche une nouvelle version au démarrage, vous la propose avec ses nouveautés, et ne télécharge rien sans votre accord. Le fichier est vérifié avant installation ; vous choisissez « Redémarrer maintenant » ou l'installation à la fermeture. Réglage dans Paramètres › Mises à jour.
- La clé d'API d'un serveur IA (LM Studio, Ollama, service en ligne) est désormais rangée dans un coffre chiffré par Windows. Elle n'est plus jamais affichée ; votre ancienne clé y est déplacée automatiquement.

### Sécurité
- Interface isolée (sandbox) : elle n'a plus aucun accès direct au système.
- Chaque échange entre l'interface et le moteur passe par une liste blanche, avec des arguments vérifiés (identifiants, chemins, tailles).
- Archives téléchargées (pack carte graphique, modèles) : protection contre les chemins piégés et les « bombes » de décompression.
- Les secrets n'apparaissent jamais dans le journal.
- Politique de contenu renforcée et nouvelles pages bloquées.
- Une dépendance vulnérable du moteur IA a été remplacée (simple-git).
- Trois affichages qui n'échappaient pas une valeur (langue d'un toast, langues de traduction dans l'historique) ont été corrigés.

### Corrections
- La page d'impression PDF est elle aussi isolée.

## 1.6.0 — 6 octobre 2026
### Nouveautés
- Onglet « Origine IA » pour les textes importés : indice 0–100, indices de style, mesure par le modèle IA local, analyse passage par passage.

## 1.5.9 — 5 octobre 2026
### Nouveautés
- IA plus rapide : jusqu'à 4 parties rédigées en même temps sur la carte graphique (résumé, fiche, nettoyage, traduction).
- Modèles Gemma 4 (E4B recommandé, 12B pour les cartes de 12 Go ou plus).
