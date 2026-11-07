# Pixel Office for Wallpaper Engine

A Wallpaper Engine **web wallpaper** that shows your live office as the desktop background.

1. Run the office server on a fixed port, e.g. at logon: `pixel-agents --port 47100`.
2. Copy this folder to `<Steam>\steamapps\common\wallpaper_engine\projects\myprojects\pixel-office\` (add any `preview.jpg`), then pick **Pixel Office — AI agents** in Wallpaper Engine.

Wallpaper Engine only shows files from the wallpaper's own folder inside frames, so the page does not embed the office: it shows a "waking up" splash until the server answers and then navigates to `http://127.0.0.1:47100/?wallpaper=1&…`. No token is used, so it is a read-only view: no toolbar, no sounds, the office fitted to the screen. The office page keeps listening to Wallpaper Engine, so changed settings apply live.

## Settings

| Wallpaper Engine property             | Office URL parameter | Values                     |
| ------------------------------------- | -------------------- | -------------------------- |
| Claude skin (`claudeskin`)            | `claudeSkin`         | `new` / `classic` (square) |
| Show agent labels (`showlabels`)      | `labels`             | `1` / `0`                  |
| Binary chatter bubbles (`chatter`)    | `chatter`            | `1` / `0`                  |
| Vignette (`vignette`)                 | `vignette`           | `1` / `0`                  |
| Zoom (`zoom`)                         | `zoom`               | `0` = fit screen, `1`–`10` |
| Background colour (`backgroundcolor`) | `bg`                 | hex `RRGGBB`               |

If the server goes away, the office page keeps reconnecting by itself.
