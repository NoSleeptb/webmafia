# Mafia Night: game template

A host-moderated mafia-style game. Players join on their phones, read their
character, and tap buttons to use abilities. You (the host) run the night from
the host console: lock everything for discussion, open abilities one player at
a time, send private results, and run votes.

No database and no `npm install`; just Node.js 16+.

## 1. Install on your Ubuntu server

```bash
# Node 20 (Ubuntu's default apt Node can be too old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx

# copy this folder to the server, then:
sudo mkdir -p /opt/mafia-game
sudo cp -r ./* /opt/mafia-game/
sudo chown -R www-data:www-data /opt/mafia-game
```

Quick test without nginx:
```bash
cd /opt/mafia-game
HOST_PASSWORD=mysecret BIND=0.0.0.0 node server.js
# phones: http://SERVER-IP:3000      host: http://SERVER-IP:3000/host
```

## 2. Run it permanently

```bash
sudo cp deploy/mafia-game.service /etc/systemd/system/
sudo nano /etc/systemd/system/mafia-game.service   # set HOST_PASSWORD
sudo systemctl daemon-reload
sudo systemctl enable --now mafia-game
```

## 3. Put nginx in front

```bash
sudo cp deploy/nginx-mafia.conf /etc/nginx/sites-available/mafia
sudo ln -s /etc/nginx/sites-available/mafia /etc/nginx/sites-enabled/mafia
sudo nginx -t && sudo systemctl reload nginx
```

The `proxy_buffering off` lines matter. They make live updates instant.
If you already have a site on port 80, change `server_name`, or mount the
game under its own subdomain.

Players visit `http://your-server-ip/`. You visit `http://your-server-ip/host`.
This is plain HTTP on your home network, which is fine for a party game. To play
over the internet, add HTTPS (e.g. certbot) and don't reuse a real password.

## 4. Edit the game: `game.json`

Everything players read lives in `game.json`. After saving, press
**Reload game.json** on the host console. No restart needed.

| Field (per character) | What it does |
|---|---|
| `id` | Unique, lowercase, no spaces. |
| `name` | The character's name, shown big on the card. |
| `role` | Role title (Doctor, Mafia Boss...). |
| `team` | Key from `teams` (sets the stamp label and color). |
| `copies` | How many of this character a random deal creates. |
| `tagline` | One line under the name. |
| `personality` | How to play them. |
| `description` | Looks, age, job. |
| `story` | Backstory and what they want. |
| `secrets` | Private info (allies, win condition). |
| `extra` | Any number of `{ "title", "text" }` sections. Add whatever you like. |
| `abilities` | Buttons for this character (below). |

Text can use `\n` for new lines. To add a character, copy a block, give it a new `id`, and edit.

**Abilities**

| Field | Meaning |
|---|---|
| `id` | Unique within that character. |
| `label` | Button text. |
| `description` | Help text under the button. |
| `target` | `"none"`, `"alive"`, `"dead"` or `"any"`: who the player picks. |
| `allowSelf` | `true` lets them pick themselves. |
| `uses` | Max uses for the whole game, or `null` for unlimited. |
| `autoClose` | Set `false` to keep the button open after each use. Default: it closes. |

Top-level fields: `title`, `rules` (shown on the join screen), `phaseLabels`
(rename the phases), `teams`, and `defaultCharacterId` (who leftover players become).

## 5. Running a game

1. Open `/host`, enter the password. Players join and appear in the list (green dot = connected).
2. Press **Deal characters randomly**, or assign each person from their dropdown.
3. **Discussion** locks every ability button on every phone.
4. **Night/action** allows ability use, but only for abilities you open. Open them one player at a time with the Open button, or all of one character with the picker. Each ability closes itself after one use. The log shows what each player did and to whom.
5. Resolve the night yourself (you're the narrator). Use **Message** to send a player a private result (e.g. the Detective's answer), **Eliminate** to knock someone out, and **Announcement** to tell everyone what happened.
6. **Voting** shows each player a list; the tally appears on your console.
7. Switching to any other phase closes every ability automatically.

Other host tools: **+1 use** (shows when a limited ability is spent), **Reset device** (a player's phone died; they rejoin with the same name), **Kick**, and **New game, keep players**.

## 6. Changing the rules (code)

All the rules are in `server.js`:
- `abilityStatus()` decides when a button works.
- `useAbility()` handles a button press.
- `hostAction()` has every host control; add a new `case` for new host tools.
- To change the look, edit the variables at the top of `public/style.css`.

State is saved to `state.json`, so a server restart mid-game won't lose anything.
Delete that file for a clean slate.

## Troubleshooting

- Phones update slowly: the nginx `proxy_buffering off` lines are missing.
- `502 Bad Gateway`: check `sudo systemctl status mafia-game` and `journalctl -u mafia-game`.
- Can't save state: the `www-data` user needs write access to `/opt/mafia-game`.
