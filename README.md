# Control Cult for Decky

Control Cult's panel for the Steam Deck's Quick Access menu. [Control Cult](https://controlcult.com) builds and tunes your Steam Input controller layout while you talk to it, from your phone or right on the Deck, and applies the changes live while the game runs.

The panel is Control Cult in Game Mode:

- Installs Control Cult, with no trip to Desktop Mode.
- Shows Control Cult's status, the game and the layout in use.
- Pairs your phone with a QR code.
- Shows your controller layout, and widgets that stay over the game while you play.
- Settings: Solo voice, mic and speaker, hotkeys, widgets, usage.
- Your license: enter a code, or get free goats (Control Cult's credits) by email, no card needed.

## What Install does

The panel itself is small. Control Cult is a separate app, and the panel's **Install** button installs it. Here is exactly what that does:

1. Downloads Control Cult's setup script from Control Cult's server (`https://noobdeity.kill-dano.workers.dev/deck/setup.sh`) and runs it as your user, never as root.
2. The script downloads the app, about 90 MB with its own copy of Node.js, into `~/.local/share/steam-input-assistant`.
3. Adds a systemd **user** service (`noobdeity.service`), so Control Cult starts with the Deck and runs in Game Mode.
4. Turns on Steam's local debug connection, which takes effect the next time Steam starts. Control Cult uses it to read and switch your controller layouts. It stays on the Deck.
5. Adds "connect a phone" and "Uninstall" entries to Desktop Mode's app menu.

Control Cult never edits your own layout files. Every change is a new layout version you can undo.

**Uninstall** in the panel removes the app, its service and its menu entries. Steam's debug connection stays on while Decky Loader is installed, because Decky uses it too.

## Requirements

- Steam Deck (SteamOS) with Decky Loader.
- An internet connection. Control Cult's assistant runs on Control Cult's servers.
- A Control Cult license, or free goats from the panel or [controlcult.com](https://controlcult.com).

## Source

This repository is the panel's source, published from Control Cult's own repository with each release. The release zip is built from it with `npm ci && npx rollup -c`.

Found a problem? Report it from the Feedback tab in Control Cult, or open an issue here.

## License

Copyright (c) 2026 Control Cult. All rights reserved. See [LICENSE](LICENSE).
