# DevilutionX Thor

*[English below](#english)*

Une version de DevilutionX pour l'**AYN Thor** et son double écran : le jeu sur
l'écran du haut, et sur l'écran du bas (1240 × 1080), en direct :

- **Carte** de l'étage exploré (style automap), votre position, les monstres en vue
  (avec barre de vie), les objets au sol, coffres, autels, escaliers, PNJ en ville.
  Pincer pour zoomer, glisser pour déplacer, double tap pour recentrer ;
- **Perso** : vie, mana, XP jusqu'au prochain niveau, attributs, armure, toucher,
  dégâts, résistances, sort prêt ;
- **Objets** : équipement avec durabilité (alerte quand elle est basse), ceinture,
  nombre de potions ;
- **Quêtes** en cours / terminées ;
- en **français et en anglais** (selon la langue du système, modifiable dans ⚙).

Toucher l'écran du bas ne retire pas le focus au jeu : la manette continue de
contrôler Diablo.

## Installation

1. Télécharger `devilutionx-thor.apk` depuis le workflow GitHub Actions
   **AYN Thor** (onglet *Actions* → dernier run réussi → *Artifacts*) et
   l'installer.
2. L'appli s'appelle **DevilutionX Thor** et s'installe *à côté* du DevilutionX
   habituel (identifiant `org.diasurgical.devilutionx.thor`). Elle a donc son
   propre dossier de données :
   `Android/data/org.diasurgical.devilutionx.thor/files/`
   Y copier `DIABDAT.MPQ` (et `hellfire.mpq`, etc. si vous en avez), ou utiliser
   l'écran d'import de l'appli. Pour reprendre vos sauvegardes, copier les fichiers
   `*.sv` depuis `Android/data/org.diasurgical.devilutionx/files/`.
3. Lancer **DevilutionX Thor** : l'écran du bas s'allume automatiquement.

## Réglages

- **Réglages → Network → Second Screen** : active ou désactive l'écran du bas.
- Dans cette version, *Pause Game When Window Loses Focus* est désactivé par défaut.
- Dans ⚙ sur l'écran du bas : langue, affichage des noms et des objets sur la
  carte, quêtes non découvertes.

## Fonctionnement technique

- `Source/companion/` : le jeu publie un instantané JSON de son état (personnage,
  carte explorée, entités du niveau, quêtes) sur un mini serveur HTTP en lecture
  seule, local à l'appareil (`127.0.0.1:8642`) : `/api/state`, `/api/map`.
- `android-project/.../SecondScreen.java` : détecte l'écran secondaire et y affiche
  l'interface (`android-project/app/src/main/companion-assets/companion/`, HTML/JS
  sans dépendance) dans une fenêtre `Presentation` non focalisable ; si le système
  la refuse, une activité est lancée sur cet écran à la place.
- Options `diablo.ini`, section `[Network]` : `Companion Server` (écran du bas),
  `Companion Port` (8642), `Companion Allow Remote` (0 ; à 1, l'interface est
  aussi accessible depuis un autre appareil du Wi-Fi :
  `.../companion/index.html?server=http://<ip>:8642`).
- L'interface peut être développée dans un navigateur de bureau en lançant
  DevilutionX sur PC et en ouvrant
  `android-project/app/src/main/companion-assets/companion/index.html`.

## Signature des APK

Pour que chaque nouvelle version s'installe comme une mise à jour (sans
désinstaller, donc sans perdre données et sauvegardes), toutes les APK doivent être
signées avec la même clé. Ajouter dans le dépôt GitHub les secrets
`THOR_KEYSTORE_BASE64`, `THOR_KEYSTORE_PASSWORD`, `THOR_KEY_ALIAS` et
`THOR_KEY_PASSWORD` (voir `.github/workflows/AYN_Thor.yml`).

---

## English

A DevilutionX build for the dual-screen **AYN Thor**: the game runs on the top
screen while the bottom screen (1240 × 1080) shows, live, the explored **map**
(automap style, visible monsters with health bars, ground items, chests, shrines,
stairs, town NPCs; pinch to zoom, drag to pan, double tap to recenter), the
**character** (life, mana, XP to next level, attributes, armor, to-hit, damage,
resistances), **items** (equipment durability with alerts, belt, potion count) and
**quests**, in English or French. Touching the bottom screen does not take the
input focus (or the gamepad) away from the game.

Install `devilutionx-thor.apk` from the **AYN Thor** GitHub Actions workflow. It
installs as **DevilutionX Thor** (`org.diasurgical.devilutionx.thor`) next to the
regular app, with its own data folder
`Android/data/org.diasurgical.devilutionx.thor/files/` for `DIABDAT.MPQ` and saves.
Toggle the bottom screen in **Settings → Network → Second Screen**. See the French
section above for the technical overview and APK signing secrets.
