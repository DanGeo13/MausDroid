# MausDroid always-on website (relay)

A tiny free Cloudflare Worker that lets you open MausDroid from any browser
(PC, tablet), even when you're not on the same Wi-Fi. It doesn't store your
chats or keys; it only passes requests to your phone. Your phone still checks
the QR pairing and your password for every device.

## Deploy once (about 5 minutes)

You need a free Cloudflare account and Node.js on a computer.

1. Open a terminal in this `relay` folder.
2. Sign in to Cloudflare:

   ```bash
   npx wrangler login
   ```

3. Deploy:

   ```bash
   npx wrangler deploy
   ```

4. Copy the address it prints (like `https://mausdroid-relay.<you>.workers.dev`).
5. On your phone: MausDroid → Settings → **Website & devices** → paste the
   address, choose a password, tap **Turn on**.
6. Tap **Show QR code** and scan it with your PC's camera (or phone camera
   pointed at the PC screen in reverse). The page opens, links the device and
   asks for your password.

The first phone to connect to an address owns it; nobody else can take it over.
