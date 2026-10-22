# Conscious for iPhone and Android

One chat with your Conscious. Answers are written out as they come, you see what it is doing while it works, it can react to your messages, photos go both ways, and reminders wait for you in the chat. Light and dark follow the phone.

<p>
<img src="docs/connect.png" width="220" alt="Connect screen">
<img src="docs/chat.png" width="220" alt="A chat">
<img src="docs/working-dark.png" width="220" alt="Searching the web, in dark mode">
</p>

It talks to the Conscious you run, over a WebSocket, and nothing else. There is no Conscious cloud in between.

## Run it

1. On the computer Conscious runs on: `pnpm app` in the repository root. It prints an address and an access code.
2. Here:

   ```bash
   cd mobile
   npm install
   npx expo start
   ```

3. Scan the QR code with [Expo Go](https://expo.dev/go) on a phone on the same Wi-Fi, and enter the address and code.

Everything the app uses ships in Expo Go, so no Xcode or Android Studio is needed to try it. For an app of your own on the home screen, build it with EAS: `npx eas-cli@latest build --profile preview`.

`npx expo start --web` opens it in a browser too, which is handy for working on the layout.

## How it is built

- Expo SDK 58, React Native, Expo Router (`src/app/`), Reanimated for motion, `react-native-svg` for the icons.
- `src/chat/useConscious.ts` holds the connection: it signs in with the code, reconnects with backoff (and at once when the app comes back to the front), keeps messages in an outbox until the socket is ready, and marks a message that may not have arrived so you can resend it.
- `src/protocol.ts` mirrors the server's message types in `src/channels/app.ts`. Change both together.
- `src/chat/Markdown.tsx` reads the Markdown the agent writes, including WhatsApp-style `*bold*`.
- The address and code are kept in the phone's secure storage.
