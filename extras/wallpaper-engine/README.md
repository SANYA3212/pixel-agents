# Pixel Office for Wallpaper Engine

A Wallpaper Engine **web wallpaper** that shows your live office as the desktop background.

1. Run the office server on a fixed port, e.g. at logon: `pixel-agents --port 47100`.
2. Copy this folder to `<Steam>\steamapps\common\wallpaper_engine\projects\myprojects\pixel-office\` (add any `preview.jpg`), then pick **Pixel Office — AI agents** in Wallpaper Engine.

The page opens `http://127.0.0.1:47100/?wallpaper=1` without a token, so it is a read-only view: no toolbar, no sounds, office fitted to the screen. It shows a "waking up" splash until the server answers and reconnects on its own.

Wallpaper properties: **Show agent labels** and **Zoom** (0 = fit screen). The office page also accepts `labels=0` and `zoom=N` directly.
