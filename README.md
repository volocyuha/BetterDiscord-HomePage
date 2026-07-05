# Home Page for BetterDiscord

Home Page adds a native-style dashboard to Discord for browsing servers, folders, favorites, recent activity, unread messages, mentions, voice activity, and live Stage events.

It replaces the Direct Messages home action with a server dashboard while keeping Discord's native sidebar, title bar, window controls, colors, typography, and navigation behavior.

## Requirements

- [BetterDiscord](https://betterdiscord.app/)
- **BDFDB Library** (`0BDFDB.plugin.js`) — required for Home Page to run

Download BDFDB from the [official BDFDB library page]([https://mwittrien.github.io/BetterDiscordAddons/Library/0BDFDB.plugin.js](https://github.com/master3395/BetterDiscord-Collections/tree/main/Plugins/0BDFDB)) and enable it before enabling Home Page.

## Features

- Native-looking Home entry in the Direct Messages sidebar
- Search across server names, folders, and descriptions
- Favorite Servers with drag-and-drop ordering
- Recent Servers with automatic or fixed card counts
- Native Discord server folders with expandable contents
- All Servers grid with server icons and descriptions
- Online and total member counts
- Unread and mention indicators with separate filters
- In Voice and On Stage filters
- Optional voice participant avatars
- Sorting by Discord order, recent activity, name, unread status, or mentions
- Cached descriptions for faster loading and fewer Discord API requests
- Native Discord window controls and compatibility with plugin popovers
- Dark-theme colors inherited from the active Discord theme

## Installation

1. Install [BetterDiscord](https://betterdiscord.app/) if it is not already installed.
2. Download the required [BDFDB Library](https://mwittrien.github.io/BetterDiscordAddons/Library/0BDFDB.plugin.js).
3. Download `HomePage.plugin.js` from the latest GitHub release.
4. Open Discord and go to **User Settings → BetterDiscord → Plugins**.
5. Click **Open Plugins Folder**.
6. Move both `0BDFDB.plugin.js` and `HomePage.plugin.js` into that folder.
7. Enable **BDFDB** first, then enable **Home Page**.

You can then open the dashboard using Discord's logo/Home button or the Home item above Friends.

## Settings

### General

- **Show Home button** — Adds Home above Friends in the Direct Messages sidebar.

### Home sections

- **Show Recent Servers** — Displays servers opened most recently.
- **Recent Servers count** — Automatically fits cards to the window or uses a fixed amount.
- **Show Folders** — Displays native Discord server folders.

### Favorites

- **Enable Favorites** — Enables favorite stars and drag-and-drop favorites.
- **Show Favorites by default** — Opens Home on Favorite Servers instead of Recent Servers.

### Server cards

- **Show server descriptions** — Displays available Discord server profile descriptions.
- **Show member counts** — Displays total members beside online members.
- **Show voice activity** — Displays detected voice participants on server cards.

### Activity and filters

- **Show unread status** — Displays unread dots and the Unread filter.
- **Show mention counts** — Displays mention badges and the Mentions filter.

### Advanced

- **Debug logging** — Writes additional diagnostic information to Discord's developer console.

## Using Favorites

- Click a star on any server card to add or remove that server from Favorites.
- Drag a server card into Favorite Servers to add it.
- Drag favorite cards to reorder them.
- Use the **Favorites** and **Recent Servers** tabs below search to switch collections.

## Description and activity data

Server descriptions and approximate member counts come from Discord data available to the client. Descriptions are cached locally for up to 30 days and remain available if a later request fails or returns no description.

Voice and Stage information depends on what Discord has loaded into the client. Activity for some large or inactive servers may not be available until Discord has subscribed to that guild's live state.

## Privacy

Home Page does not use an external analytics service and does not upload your settings or server list to the author.

Plugin preferences, favorite server IDs, recent server IDs, and cached descriptions are stored locally through BetterDiscord's data storage.

Do not publish your personal `HomePage.config.json`, because it can contain server IDs and local preferences.

## Troubleshooting

### Home does not appear

- Confirm that BDFDB is installed and enabled.
- Confirm that Home Page is enabled.
- Disable and re-enable the plugin.
- Reload Discord with `Ctrl+R`.

### A server does not open

Discord must provide at least one accessible channel for that server. Check that the server is available and that your account can access a text channel.

### Descriptions are missing

Some servers do not define a public description. Use the reload icon beside **All Servers** to request fresh data while retaining cached descriptions.

### Voice or Stage filters are empty

Discord loads live voice data lazily. Open the relevant server once, return Home, and try the filter again.

### Discord changed and the plugin stopped working

BetterDiscord plugins depend on Discord's internal client structure. A Discord update can temporarily break navigation, stores, or layout selectors. Check the repository for a newer release or open an issue with screenshots and console errors.

## Compatibility

- BetterDiscord desktop client
- Windows, macOS, and Linux where BetterDiscord is supported
- Designed for Discord's current native dark-theme variables

Compatibility with every theme or plugin cannot be guaranteed. Home Page intentionally keeps a lower content-layer priority so floating islands, menus, and popovers from other plugins can appear above it.

## Reporting issues

When opening an issue, include:

- Home Page version
- Discord and BetterDiscord versions
- Operating system
- Steps to reproduce the problem
- A screenshot or short recording
- Relevant developer-console errors
- Whether the issue occurs with other plugins disabled

Repository: [BetterDiscord Home Page](https://github.com/volocyuha/BetterDiscord-HomePage)

## Release

Current public release: **v1.0.0**

## Author

Created by [volocyuha](https://github.com/volocyuha?tab=repositories).

- [Website](https://volocyuha.com/)
- [GitHub](https://github.com/volocyuha?tab=repositories)
- [Donate with PayPal](https://paypal.me/volocyuha)

## Disclaimer

Home Page is an unofficial BetterDiscord plugin. It is not affiliated with Discord Inc. or BetterDiscord.
